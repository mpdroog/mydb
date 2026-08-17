// Package sshtun dials an SSH server and hands out tunneled net.Conn's.
// There is deliberately no local listening port: the MySQL driver dials
// straight through the ssh.Client, so nothing else on this box can ride
// the tunnel.
package sshtun

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/mpdroog/mydb/config"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
	"golang.org/x/crypto/ssh/knownhosts"
)

// ErrUnknownHost is returned when the hostkey is not in ~/.ssh/known_hosts.
// We never offer trust-on-first-use, run `ssh host` once instead.
var ErrUnknownHost = errors.New("sshtun: unknown host key")

// Client is an ssh.Client plus the keepalive goroutine watching it.
type Client struct {
	ssh  *ssh.Client
	done chan struct{}
	name string
	once sync.Once
}

// expandHome turns a leading ~/ into the real home-directory.
func expandHome(p string) (string, error) {
	if !strings.HasPrefix(p, "~/") {
		return p, nil
	}
	home, e := os.UserHomeDir()
	if e != nil {
		return "", fmt.Errorf("sshtun.expandHome: %w", e)
	}
	return filepath.Join(home, p[2:]), nil
}

// knownHostsCallback builds a strict hostkey-checker from ~/.ssh/known_hosts.
func knownHostsCallback() (ssh.HostKeyCallback, error) {
	home, e := os.UserHomeDir()
	if e != nil {
		return nil, fmt.Errorf("sshtun.knownHostsCallback home: %w", e)
	}
	path := filepath.Join(home, ".ssh", "known_hosts")
	cb, e := knownhosts.New(path)
	if e != nil {
		return nil, fmt.Errorf("sshtun.knownHostsCallback %s: %w", path, e)
	}

	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		e := cb(hostname, remote, key)
		if e == nil {
			return nil
		}
		var ke *knownhosts.KeyError
		if errors.As(e, &ke) && len(ke.Want) == 0 {
			return fmt.Errorf("%w for %s\n  fingerprint %s\n  run once to trust it:  ssh %s",
				ErrUnknownHost, hostname, ssh.FingerprintSHA256(key), hostname)
		}
		return fmt.Errorf("sshtun: HOST KEY CHANGED for %s (fingerprint %s): %w",
			hostname, ssh.FingerprintSHA256(key), e)
	}, nil
}

// authMethods builds the auth chain: agent -> key-file -> password.
func authMethods(ctx context.Context, c *config.SSH) ([]ssh.AuthMethod, error) {
	var out []ssh.AuthMethod

	if c.Agent {
		sock := os.Getenv("SSH_AUTH_SOCK")
		if sock == "" {
			return nil, errors.New("sshtun.authMethods: agent=true but SSH_AUTH_SOCK is empty")
		}
		var d net.Dialer
		//nolint:gosec // G704: SSH_AUTH_SOCK is this user's own agent socket,
		// the same one every ssh client on the box already trusts.
		conn, e := d.DialContext(ctx, "unix", sock)
		if e != nil {
			return nil, fmt.Errorf("sshtun.authMethods agent: %w", e)
		}
		out = append(out, ssh.PublicKeysCallback(agent.NewClient(conn).Signers))
	}

	if c.Key != "" {
		path, e := expandHome(c.Key)
		if e != nil {
			return nil, e
		}
		buf, e := os.ReadFile(path) //nolint:gosec // G304: path comes from our own config-file
		if e != nil {
			return nil, fmt.Errorf("sshtun.authMethods read %s: %w", path, e)
		}
		var signer ssh.Signer
		if c.Passphrase != "" {
			signer, e = ssh.ParsePrivateKeyWithPassphrase(buf, []byte(c.Passphrase))
		} else {
			signer, e = ssh.ParsePrivateKey(buf)
		}
		if e != nil {
			return nil, fmt.Errorf("sshtun.authMethods parse %s: %w", path, e)
		}
		out = append(out, ssh.PublicKeys(signer))
	}

	if c.Pass != "" {
		out = append(out, ssh.Password(c.Pass))
	}

	if len(out) == 0 {
		return nil, errors.New("sshtun.authMethods: no agent, key or pass configured")
	}
	return out, nil
}

// Dial opens the SSH connection and starts its keepalive.
// The context bounds the whole handshake, not just the TCP dial.
func Dial(ctx context.Context, name string, c *config.SSH, t config.Timeout) (*Client, error) {
	auth, e := authMethods(ctx, c)
	if e != nil {
		return nil, e
	}
	hostkey, e := knownHostsCallback()
	if e != nil {
		return nil, e
	}

	addr := c.Host
	if _, _, e := net.SplitHostPort(addr); e != nil {
		addr = net.JoinHostPort(addr, "22")
	}

	d := net.Dialer{Timeout: t.SSHDial.D()}
	conn, e := d.DialContext(ctx, "tcp", addr)
	if e != nil {
		return nil, fmt.Errorf("sshtun.Dial tcp %s: %w", addr, e)
	}

	// The handshake gets whatever is left of the caller's deadline.
	if dl, ok := ctx.Deadline(); ok {
		if e := conn.SetDeadline(dl); e != nil {
			closeConn(conn, "set deadline failed")
			return nil, fmt.Errorf("sshtun.Dial deadline: %w", e)
		}
	}

	cc, chans, reqs, e := ssh.NewClientConn(conn, addr, &ssh.ClientConfig{
		User:            c.User,
		Auth:            auth,
		HostKeyCallback: hostkey,
		Timeout:         t.SSHDial.D(),
	})
	if e != nil {
		closeConn(conn, "handshake failed")
		return nil, fmt.Errorf("sshtun.Dial handshake %s: %w", addr, e)
	}
	// Clear the handshake deadline, the tunnel is long-lived.
	if e := conn.SetDeadline(time.Time{}); e != nil {
		log.Printf("sshtun.Dial clear deadline: %s", e)
	}

	cl := &Client{
		ssh:  ssh.NewClient(cc, chans, reqs),
		done: make(chan struct{}),
		name: name,
	}
	go cl.keepalive(t.SSHKeepalive.D())

	if config.Verbose {
		log.Printf("sshtun.Dial %s connected to %s as %s", name, addr, c.User)
	}
	return cl, nil
}

// closeConn shuts a raw conn down, logging why it had to.
func closeConn(c net.Conn, why string) {
	if e := c.Close(); e != nil {
		log.Printf("sshtun: close after %s: %s", why, e)
	}
}

// keepalive pings the server so a dead tunnel is noticed within one interval
// instead of hanging a query until its own deadline.
func (c *Client) keepalive(every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-c.done:
			return
		case <-t.C:
			_, _, e := c.ssh.SendRequest("keepalive@openssh.com", true, nil)
			if e != nil {
				log.Printf("sshtun.keepalive %s: %s, closing tunnel", c.name, e)
				c.Close()
				return
			}
		}
	}
}

// DialContext opens a tunneled connection to addr as seen from the SSH host.
func (c *Client) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	conn, e := c.ssh.DialContext(ctx, network, addr)
	if e != nil {
		return nil, fmt.Errorf("sshtun.DialContext %s: %w", addr, e)
	}
	return conn, nil
}

// Close stops the keepalive and tears the SSH connection down.
// It is safe to call more than once and from several goroutines.
func (c *Client) Close() {
	c.once.Do(func() {
		close(c.done)
		if e := c.ssh.Close(); e != nil && !errors.Is(e, net.ErrClosed) {
			log.Printf("sshtun.Close %s: %s", c.name, e)
		}
	})
}
