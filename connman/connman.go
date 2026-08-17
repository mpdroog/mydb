// Package connman owns the lifecycle of every MySQL connection: it dials
// lazily in the background so the UI never waits, keeps the SSH tunnel and
// the *sql.DB together, and reaps both once a server goes idle.
package connman

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/mpdroog/mydb/bus"
	"github.com/mpdroog/mydb/config"
	"github.com/mpdroog/mydb/sshtun"
)

// State is where a server sits in the connect lifecycle.
type State string

// The states a server can be in, mirrored one-to-one in the sidebar dots.
const (
	Offline    State = "offline"
	Connecting State = "connecting"
	Ready      State = "ready"
	Errored    State = "error"
)

// ErrNotReady means the caller gave up before the dial finished.
var ErrNotReady = errors.New("connman: server not ready")

// Status is one server's live state, as sent to the browser.
type Status struct {
	Name  string `json:"name"`
	State State  `json:"state"`
	Error string `json:"error,omitempty"`
	SSH   bool   `json:"ssh"`
	Idle  int64  `json:"idle_seconds"`
}

// conn holds everything belonging to one configured server.
type conn struct {
	db       *sql.DB
	ssh      *sshtun.Client
	ready    chan struct{}
	lastErr  error
	name     string
	netName  string
	state    State
	lastUsed atomic.Int64
	active   atomic.Int32
	mu       sync.Mutex
}

// Manager is the single owner of every conn.
type Manager struct {
	conns map[string]*conn
	Bus   *bus.Bus[Status]
	stop  chan struct{}
	wg    sync.WaitGroup
	mu    sync.Mutex
}

// New starts a Manager and its idle-reaper.
func New() *Manager {
	m := &Manager{
		conns: make(map[string]*conn),
		Bus:   bus.New[Status](32),
		stop:  make(chan struct{}),
	}
	m.wg.Add(1)
	go m.reaper()
	return m
}

// Close tears every connection down and stops the reaper.
func (m *Manager) Close() {
	close(m.stop)
	m.wg.Wait()

	m.mu.Lock()
	names := make([]string, 0, len(m.conns))
	for name := range m.conns {
		names = append(names, name)
	}
	m.mu.Unlock()

	for _, name := range names {
		m.Disconnect(name)
	}
	m.Bus.Close()
}

// get returns the conn for name, creating the bookkeeping on first use.
func (m *Manager) get(name string) *conn {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c, ok := m.conns[name]; ok {
		return c
	}
	c := &conn{
		name:    name,
		netName: "mydb-" + name,
		state:   Offline,
	}
	m.conns[name] = c
	return c
}

// publish pushes a state change out to the SSE subscribers.
// Caller must NOT hold c.mu beyond reading the fields it passes in.
func (m *Manager) publish(c *conn, state State, e error) {
	s := Status{Name: c.name, State: state}
	if e != nil {
		s.Error = e.Error()
	}
	if cfg, cfge := config.ServerByName(c.name); cfge == nil {
		s.SSH = cfg.SSH != nil
	}
	m.Bus.Publish(s)
}

// Acquire hands out a ready *sql.DB, kicking off a dial when needed.
// The returned release func must always be called, it drives both the
// idle-reaper and the "busy" accounting.
func (m *Manager) Acquire(ctx context.Context, name string) (*sql.DB, func(), error) {
	if _, e := config.ServerByName(name); e != nil {
		return nil, nil, e
	}
	c := m.get(name)

	// At most three rounds: wait out a dial somebody else started, then
	// start exactly one of our own, then report. dialed is what stops a
	// broken host from being dialled twice per caller, which would double
	// the time it takes for the error to reach the sidebar.
	dialed := false
	for range 3 {
		c.mu.Lock()
		switch c.state {
		case Ready:
			db := c.db
			c.mu.Unlock()
			c.lastUsed.Store(time.Now().UnixNano())
			c.active.Add(1)
			return db, func() {
				c.active.Add(-1)
				c.lastUsed.Store(time.Now().UnixNano())
			}, nil

		case Connecting:
			ready := c.ready
			c.mu.Unlock()
			if e := wait(ctx, ready); e != nil {
				return nil, nil, fmt.Errorf("connman.Acquire %s: %w", name, e)
			}

		case Offline, Errored:
			if dialed {
				e := c.lastErr
				c.mu.Unlock()
				return nil, nil, failed(name, e)
			}
			dialed = true
			c.state = Connecting
			c.lastErr = nil
			c.ready = make(chan struct{})
			ready := c.ready
			c.mu.Unlock()

			m.publish(c, Connecting, nil)
			// WithoutCancel on purpose: the dial keeps the caller's values
			// but not its cancellation, so one impatient click cannot abort
			// a tunnel the next click needs.
			go m.dial(context.WithoutCancel(ctx), c)

			if e := wait(ctx, ready); e != nil {
				return nil, nil, fmt.Errorf("connman.Acquire %s: %w", name, e)
			}
		}
	}

	c.mu.Lock()
	e := c.lastErr
	c.mu.Unlock()
	return nil, nil, failed(name, e)
}

// wait blocks until the dial resolves or the caller gives up.
func wait(ctx context.Context, ready <-chan struct{}) error {
	select {
	case <-ready:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// failed wraps whatever the last dial attempt reported.
func failed(name string, e error) error {
	if e != nil {
		return fmt.Errorf("connman.Acquire %s: %w", name, e)
	}
	return fmt.Errorf("%w: %s", ErrNotReady, name)
}

// Connect starts a dial without waiting for it, used by the sidebar so a
// click paints "connecting" straight away.
func (m *Manager) Connect(name string) error {
	if _, e := config.ServerByName(name); e != nil {
		return e
	}
	c := m.get(name)

	c.mu.Lock()
	if c.state == Ready || c.state == Connecting {
		c.mu.Unlock()
		return nil
	}
	c.state = Connecting
	c.lastErr = nil
	c.ready = make(chan struct{})
	c.mu.Unlock()

	m.publish(c, Connecting, nil)
	go m.dial(context.Background(), c)
	return nil
}

// dial builds the tunnel and the pool, then flips the conn to Ready or
// Errored and wakes everyone waiting on it. The caller passes a context
// that carries no cancellation of its own, only the dial budget applies.
func (m *Manager) dial(ctx context.Context, c *conn) {
	cfg, e := config.ServerByName(c.name)
	t := config.Timeouts()

	var (
		tun *sshtun.Client
		db  *sql.DB
	)
	if e == nil {
		budget := t.SSHDial.D() + t.MySQLConnect.D() + time.Second
		dctx, cancel := context.WithTimeout(ctx, budget)
		defer cancel()
		tun, db, e = m.open(dctx, c, cfg, t)
	}

	c.mu.Lock()
	ready := c.ready
	if e != nil {
		c.state = Errored
		c.lastErr = e
		c.db, c.ssh = nil, nil
	} else {
		c.state = Ready
		c.lastErr = nil
		c.db, c.ssh = db, tun
		c.lastUsed.Store(time.Now().UnixNano())
	}
	state := c.state
	c.ready = nil
	c.mu.Unlock()

	if ready != nil {
		close(ready)
	}
	if e != nil {
		log.Printf("connman.dial %s: %s", c.name, e)
	} else if config.Verbose {
		log.Printf("connman.dial %s ready", c.name)
	}
	m.publish(c, state, e)
}

// open does the actual SSH + MySQL work for one dial attempt.
func (m *Manager) open(ctx context.Context, c *conn, cfg config.Server, t config.Timeout) (*sshtun.Client, *sql.DB, error) {
	var tun *sshtun.Client

	network := "tcp"
	if cfg.SSH != nil {
		var e error
		tun, e = sshtun.Dial(ctx, c.name, cfg.SSH, t)
		if e != nil {
			return nil, nil, e
		}
		network = c.netName
		// Registered once per server-name; the closure reads whatever
		// tunnel is current, so a redial needs no re-registration.
		registerOnce(c, m)
	}

	if cfg.SSH != nil {
		c.mu.Lock()
		c.ssh = tun
		c.mu.Unlock()
	}

	db, e := openPool(cfg, network, t)
	if e != nil {
		if tun != nil {
			tun.Close()
		}
		return nil, nil, e
	}

	pctx, cancel := context.WithTimeout(ctx, t.MySQLConnect.D())
	defer cancel()
	if e := db.PingContext(pctx); e != nil {
		if ce := db.Close(); ce != nil {
			log.Printf("connman.open close after ping-fail: %s", ce)
		}
		if tun != nil {
			tun.Close()
		}
		return nil, nil, fmt.Errorf("connman.open ping %s: %w", cfg.Addr(), e)
	}
	return tun, db, nil
}

// registered tracks which driver network-names we already claimed.
var (
	registered   = make(map[string]bool)
	registeredMu sync.Mutex
)

// registerOnce teaches the MySQL driver to dial through this server's tunnel.
func registerOnce(c *conn, m *Manager) {
	registeredMu.Lock()
	defer registeredMu.Unlock()
	if registered[c.netName] {
		return
	}
	registered[c.netName] = true

	name := c.name
	mysql.RegisterDialContext(c.netName, func(ctx context.Context, addr string) (net.Conn, error) {
		cc := m.get(name)
		cc.mu.Lock()
		tun := cc.ssh
		cc.mu.Unlock()
		if tun == nil {
			return nil, fmt.Errorf("connman: tunnel for %s is down", name)
		}
		return tun.DialContext(ctx, "tcp", addr)
	})
}

// Disconnect tears a server's pool and tunnel down right now.
func (m *Manager) Disconnect(name string) {
	c := m.get(name)

	c.mu.Lock()
	db, tun := c.db, c.ssh
	c.db, c.ssh = nil, nil
	if c.state != Connecting {
		c.state = Offline
		c.lastErr = nil
	}
	c.mu.Unlock()

	if db != nil {
		if e := db.Close(); e != nil {
			log.Printf("connman.Disconnect %s db.Close: %s", name, e)
		}
	}
	if tun != nil {
		tun.Close()
	}
	m.publish(c, Offline, nil)
}

// Status reports every configured server, merging config with live state.
func (m *Manager) Status() []Status {
	servers := config.Servers()
	out := make([]Status, 0, len(servers))
	now := time.Now().UnixNano()

	for _, s := range servers {
		st := Status{Name: s.Name, State: Offline, SSH: s.SSH != nil}

		m.mu.Lock()
		c, ok := m.conns[s.Name]
		m.mu.Unlock()

		if ok {
			c.mu.Lock()
			st.State = c.state
			if c.lastErr != nil {
				st.Error = c.lastErr.Error()
			}
			c.mu.Unlock()
			if last := c.lastUsed.Load(); last > 0 && st.State == Ready {
				st.Idle = (now - last) / int64(time.Second)
			}
		}
		out = append(out, st)
	}
	return out
}

// reaper closes tunnels nobody touched for config.timeout.idle_reap.
func (m *Manager) reaper() {
	defer m.wg.Done()
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()

	for {
		select {
		case <-m.stop:
			return
		case <-t.C:
			m.reapOnce()
		}
	}
}

// reapOnce is one sweep of the idle-reaper.
func (m *Manager) reapOnce() {
	idle := config.Timeouts().IdleReap.D()
	cutoff := time.Now().Add(-idle).UnixNano()

	m.mu.Lock()
	cands := make([]*conn, 0, len(m.conns))
	for _, c := range m.conns {
		cands = append(cands, c)
	}
	m.mu.Unlock()

	for _, c := range cands {
		c.mu.Lock()
		state := c.state
		c.mu.Unlock()
		if state != Ready || c.active.Load() > 0 {
			continue
		}
		if last := c.lastUsed.Load(); last == 0 || last > cutoff {
			continue
		}
		if config.Verbose {
			log.Printf("connman.reap %s idle for %s, closing", c.name, idle)
		}
		m.Disconnect(c.name)
	}
}
