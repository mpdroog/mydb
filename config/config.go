// Package config loads, validates and saves the mydb TOML config-file.
// The file lives next to the binary (-c ./config.toml) and holds the MySQL
// servers in cleartext, so it is expected to be chmod 0600.
package config

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/BurntSushi/toml"
)

var (
	// Verbose enables debug logging, set from the -v flag.
	Verbose bool
	// CurDir is the directory the binary was started from.
	CurDir string
	// Path is the config-file we loaded and save back to.
	Path string

	mu sync.RWMutex
	// raw is exactly what the config-file holds, and the only thing ever
	// written back. c is raw with defaults resolved, which is what the rest
	// of mydb reads.
	//
	// Keeping them apart matters: saving the resolved copy would freeze
	// every default into the file the first time you add a server through
	// the GUI, and no later change to a default could ever reach you again.
	raw Config
	c   Config
)

// ErrNoSuchServer is returned when a server-name is not in the config.
var ErrNoSuchServer = errors.New("config: no such server")

// ErrDuplicateServer is returned when adding a server-name that already exists.
var ErrDuplicateServer = errors.New("config: server already exists")

// Duration wraps time.Duration so TOML can express it as "5s".
//
// pointer receiver to decode and a value receiver to encode, same as time.Time.
//
//nolint:recvcheck // the encoding.TextUnmarshaler/TextMarshaler pair needs a
type Duration time.Duration

// UnmarshalText decodes a Go duration-string such as "30s" or "5m".
func (d *Duration) UnmarshalText(text []byte) error {
	v, e := time.ParseDuration(string(text))
	if e != nil {
		return fmt.Errorf("config.Duration: %w", e)
	}
	*d = Duration(v)
	return nil
}

// MarshalText encodes back to a Go duration-string.
func (d Duration) MarshalText() ([]byte, error) {
	return []byte(time.Duration(d).String()), nil
}

// D unwraps to a plain time.Duration.
func (d Duration) D() time.Duration {
	return time.Duration(d)
}

// SSH describes how to reach the bastion in front of a MySQL server.
// Auth order is agent -> key -> pass, the hostkey is always checked
// against ~/.ssh/known_hosts.
type SSH struct {
	Host       string `toml:"host"`
	User       string `toml:"user,omitempty"`
	Key        string `toml:"key,omitempty"`
	Passphrase string `toml:"passphrase,omitempty"`
	Pass       string `toml:"pass,omitempty"`
	Agent      bool   `toml:"agent,omitempty"`
}

// Server is one MySQL server as reachable from mydb.
// Host/Port are resolved on the SSH host when SSH is set.
// Link is a relationship the operator declared that the schema does not.
// Plenty of production schemas have no foreign keys at all, and mydb's
// guesser only goes so far; this is how you tell it what you know.
//
// It is written here rather than to the database on purpose: mydb never
// adds a constraint you did not ask a migration for.
type Link struct {
	DB       string   `toml:"db"`
	FromTbl  string   `toml:"from_table"`
	ToTbl    string   `toml:"to_table"`
	FromCols []string `toml:"from_cols"`
	ToCols   []string `toml:"to_cols"`
}

type Server struct {
	SSH  *SSH   `toml:"ssh,omitempty"`
	Name string `toml:"name"`
	Host string `toml:"host,omitempty"`
	// Socket is the path of a MySQL unix socket, and the alternative to
	// host/port rather than an addition to it. A server that has one is on
	// this machine by definition: plenty of local installs (Alpine's
	// mariadb, Debian's default) ship with skip-networking or bind only to
	// a socket, and before this there was no way to reach them at all.
	//
	// It excludes host, port, tls and [server.ssh], all of which validate
	// rejects rather than quietly ignores.
	Socket string `toml:"socket,omitempty"`
	User   string `toml:"user,omitempty"`
	Pass   string `toml:"pass,omitempty"`
	TLS    string `toml:"tls,omitempty"`
	Port   int    `toml:"port,omitzero"`
	// Colour is the server's identity hue, worn everywhere the server
	// appears so two connections are never confused for each other. It is
	// a name from ColourNames, not a CSS value: the GUI owns the actual
	// shades so they stay legible against its own background. Empty means
	// mydb picks one, which is why an existing config-file needs no edit.
	ColourName string `toml:"colour,omitempty"`
	// Production marks a server where a mistake is expensive. It changes
	// nothing about how mydb connects; it colours the GUI red and makes a
	// destructive statement ask for the server's name instead of a click.
	Production bool `toml:"production,omitempty"`
	// Link holds the relationships the operator declared by hand for this
	// server's databases, keyed by database inside each entry.
	Link []Link `toml:"link,omitempty"`
}

// LinksFor returns the manual links declared for one database.
func (s Server) LinksFor(db string) []Link {
	out := make([]Link, 0, len(s.Link))
	for _, l := range s.Link {
		if l.DB == db {
			out = append(out, l)
		}
	}
	return out
}

// ColourNames are the accepted values of a server's colour setting.
//
// They sit in the violet-azure-magenta arc on purpose. Green, amber and red
// already mean healthy, slow and broken everywhere else in the GUI, and the
// accent is teal, so an identity hue drawn from any of those could be read
// as a state rather than as a name.
var ColourNames = []string{"violet", "indigo", "azure", "magenta", "plum", "steel"}

// Colour returns the server's identity hue, choosing one when the
// config-file does not. The choice is derived from the name rather than
// from the server's position, so adding a server above another one in the
// file does not silently repaint it.
func (s Server) Colour() string {
	if s.ColourName != "" {
		return s.ColourName
	}
	var h uint32 = 2166136261
	for i := 0; i < len(s.Name); i++ {
		h ^= uint32(s.Name[i])
		h *= 16777619
	}
	return ColourNames[h%uint32(len(ColourNames))]
}

// TLSNames are the accepted values of a server's tls setting.
//
//	false       no TLS
//	preferred   use TLS when the server offers it, without verifying it
//	skip-verify TLS always, but accept any certificate
//	true        TLS always, certificate verified against the hostname
var TLSNames = map[string]bool{
	"false": true, "preferred": true, "skip-verify": true, "true": true,
}

// TLSMode returns the TLS setting to dial this server with.
// Tunnelled servers default to off because the SSH connection already
// provides confidentiality and integrity, and a certificate would be
// issued for the real hostname rather than the 127.0.0.1 we dial through
// the tunnel. Everything else defaults to opportunistic TLS.
func (s Server) TLSMode() string {
	// A unix socket never leaves the machine, so there is no transport to
	// protect and no hostname to check a certificate against. Nothing is
	// being ignored here: validate rejects a socket server that also sets
	// tls, rather than letting this quietly overrule it.
	if s.Socket != "" {
		return "false"
	}
	if s.TLS != "" {
		return s.TLS
	}
	if s.SSH != nil {
		return "false"
	}
	return "preferred"
}

// Addr returns the address to dial MySQL on: the socket path for a server
// that has one, host:port for everything else. Network says how to read it.
func (s Server) Addr() string {
	if s.Socket != "" {
		return s.Socket
	}
	port := s.Port
	if port == 0 {
		port = 3306
	}
	return fmt.Sprintf("%s:%d", s.Host, port)
}

// Network is the driver network Addr is an address on.
//
// A tunnelled server does not use this: connman hands the driver the
// per-server network name it registered the tunnel's dialler under, which
// is what makes a "tcp" address resolve on the far side of the SSH
// connection instead of here.
func (s Server) Network() string {
	if s.Socket != "" {
		return "unix"
	}
	return "tcp"
}

// Timeout is the deadline-budget, every network operation draws from it.
type Timeout struct {
	SSHDial      Duration `toml:"ssh_dial,omitzero"`
	MySQLConnect Duration `toml:"mysql_connect,omitzero"`
	MetaQuery    Duration `toml:"meta_query,omitzero"`
	DataQuery    Duration `toml:"data_query,omitzero"`
	// DDLQuery is 0 by default, meaning no deadline. A deadline bounds
	// work that might never finish; an ALTER TABLE will finish, and
	// killing it half-way through a table rebuild throws away the work
	// done so far and then makes you wait for the rollback. What can hang
	// forever is the metadata lock it needs to start, and that is bounded
	// by MySQL.LockWait instead.
	DDLQuery     Duration `toml:"ddl_query,omitzero"`
	SSHKeepalive Duration `toml:"ssh_keepalive,omitzero"`
	ConnLifetime Duration `toml:"conn_lifetime,omitzero"`
	IdleReap     Duration `toml:"idle_reap,omitzero"`
	HTTPReadHdr  Duration `toml:"http_read_hdr,omitzero"`
	HTTPIdle     Duration `toml:"http_idle,omitzero"`
	// DashPoll is how often an open dashboard asks the server what it is
	// doing. Every open dashboard costs one round-trip per tick, so this is
	// the knob to turn when watching a server over a slow tunnel.
	DashPoll Duration `toml:"dashboard_poll,omitzero"`
}

// DefaultQueryLog is the file the query log is appended to when the
// config-file does not name one. It lives next to config.toml because that
// is where mydb's own state belongs, and it holds the literal values of
// every statement, so it is written 0600 like the config-file itself.
const DefaultQueryLog = "mydb-queries.jsonl"

// Log configures the query log: every statement mydb runs, appended as one
// JSON object per line so it can be searched from the GUI and with grep.
type Log struct {
	// Queries is the file to append to. A pointer so that "" can mean off
	// rather than "unset, use the default".
	Queries *string `toml:"queries,omitempty"`
	// MaxSizeMB rotates the file once it grows past this.
	MaxSizeMB int `toml:"max_size_mb,omitzero"`
	// Keep is how many rotated generations to hold on to.
	Keep int `toml:"keep,omitzero"`
}

// Path returns the file to append to, "" when the log is switched off.
// A relative name is resolved next to the config-file rather than the
// working directory, so mydb started from elsewhere still finds it.
func (l Log) Path() string {
	p := DefaultQueryLog
	if l.Queries != nil {
		p = *l.Queries
	}
	if p == "" || filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(filepath.Dir(Path), p)
}

// DefaultSQLMode is the session sql_mode mydb connects with unless the
// config-file says otherwise.
//
// This matters more than it looks. Without STRICT_ALL_TABLES a server
// silently truncates: an inline edit of "way too long" into a VARCHAR(5)
// is stored as "way t" and still reports one row affected, so mydb would
// tell you the write succeeded and paint a value the database does not
// hold. Strict mode turns that into an error you can see.
const DefaultSQLMode = "STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION"

// DefaultLockWait bounds how long a statement waits for a metadata lock.
//
// This is the deadline that actually matters for DDL. MySQL ships with
// lock_wait_timeout at a year and MariaDB at a day, so an ALTER that cannot
// get its lock queues behind whatever holds it — and every read and write
// of that table then queues behind the ALTER. Failing in half a minute with
// "Lock wait timeout exceeded" is much kinder than taking the table down.
const DefaultLockWait = 30 * time.Second

// MySQL holds settings applied to every MySQL session.
type MySQL struct {
	// SQLMode is the session sql_mode. Unset means DefaultSQLMode; set it
	// to "" to inherit whatever the server's global mode happens to be.
	SQLMode *string `toml:"sql_mode,omitempty"`
	// LockWait is the session lock_wait_timeout. Unset means
	// DefaultLockWait; set it to "0s" to leave the server's own value.
	LockWait *Duration `toml:"lock_wait_timeout,omitzero"`
}

// Mode returns the configured sql_mode, or the strict default.
func (m MySQL) Mode() string {
	if m.SQLMode == nil {
		return DefaultSQLMode
	}
	return *m.SQLMode
}

// LockWaitSeconds returns the lock_wait_timeout to set, or 0 to leave the
// server's own value alone. MySQL takes this variable in whole seconds.
func (m MySQL) LockWaitSeconds() int {
	if m.LockWait == nil {
		return int(DefaultLockWait / time.Second)
	}
	return int(m.LockWait.D() / time.Second)
}

// Config is the whole config-file.
//
// Timeout and MySQL are pointers so that a file which never mentioned them
// is written back without them, rather than sprouting a full set of
// materialised defaults.
type Config struct {
	Timeout *Timeout `toml:"timeout,omitempty"`
	MySQL   *MySQL   `toml:"mysql,omitempty"`
	Log     *Log     `toml:"log,omitempty"`
	Listen  string   `toml:"listen,omitempty"`
	Server  []Server `toml:"server"`
}

// resolve returns a deep copy of r with every default filled in.
func resolve(r Config) Config {
	e := Config{Listen: r.Listen}

	t := Timeout{}
	if r.Timeout != nil {
		t = *r.Timeout
	}
	m := MySQL{}
	if r.MySQL != nil {
		m = *r.MySQL
	}
	l := Log{}
	if r.Log != nil {
		l = *r.Log
	}
	e.Timeout, e.MySQL, e.Log = &t, &m, &l

	e.Server = make([]Server, len(r.Server))
	copy(e.Server, r.Server)

	e.defaults()
	return e
}

// defaults fills in every field the config-file left empty.
func (c *Config) defaults() {
	if c.Listen == "" {
		c.Listen = "localhost:9999"
	}
	t := c.Timeout
	for _, d := range []struct {
		p   *Duration
		def time.Duration
	}{
		{&t.SSHDial, 5 * time.Second},
		{&t.MySQLConnect, 5 * time.Second},
		{&t.MetaQuery, 5 * time.Second},
		{&t.DataQuery, 30 * time.Second},
		// Deliberately 0: see the field comment. A ten-minute ALTER is
		// slow, not hung.
		{&t.DDLQuery, 0},
		{&t.SSHKeepalive, 15 * time.Second},
		{&t.ConnLifetime, 5 * time.Minute},
		{&t.IdleReap, 10 * time.Minute},
		{&t.HTTPReadHdr, 5 * time.Second},
		{&t.HTTPIdle, 60 * time.Second},
		{&t.DashPoll, 3 * time.Second},
	} {
		if *d.p == 0 {
			*d.p = Duration(d.def)
		}
	}

	if c.Log.MaxSizeMB == 0 {
		c.Log.MaxSizeMB = 32
	}
	if c.Log.Keep == 0 {
		c.Log.Keep = 1
	}
}

// validate rejects a config we cannot sanely run with.
func (c *Config) validate() error {
	seen := make(map[string]bool, len(c.Server))
	for i, s := range c.Server {
		if s.Name == "" {
			return fmt.Errorf("config.validate: server[%d] has no name", i)
		}
		if seen[s.Name] {
			return fmt.Errorf("config.validate: duplicate server name %q", s.Name)
		}
		seen[s.Name] = true
		switch {
		case s.Host == "" && s.Socket == "":
			return fmt.Errorf("config.validate: server %q has neither host nor socket", s.Name)
		case s.Host != "" && s.Socket != "":
			return fmt.Errorf("config.validate: server %q has both host and socket, it can only be dialled one way", s.Name)
		}
		// The three things a socket cannot be combined with. Each of them
		// would otherwise have to be silently dropped, and a config-file
		// that does not mean what it says is worse than one that is refused.
		if s.Socket != "" {
			if s.SSH != nil {
				return fmt.Errorf("config.validate: server %q has socket and [server.ssh], but a socket file is on this machine and a tunnel forwards tcp to another one", s.Name)
			}
			if s.Port != 0 {
				return fmt.Errorf("config.validate: server %q has socket and port, a socket file has no port", s.Name)
			}
			if s.TLS != "" {
				return fmt.Errorf("config.validate: server %q has socket and tls, a socket connection never leaves the machine", s.Name)
			}
		}
		if s.SSH != nil && s.SSH.Host == "" {
			return fmt.Errorf("config.validate: server %q has [server.ssh] without host", s.Name)
		}
		for j, l := range s.Link {
			if l.DB == "" || l.FromTbl == "" || l.ToTbl == "" {
				return fmt.Errorf("config.validate: server %q link[%d] needs db, from_table and to_table",
					s.Name, j)
			}
			if len(l.FromCols) == 0 || len(l.FromCols) != len(l.ToCols) {
				return fmt.Errorf("config.validate: server %q link[%d] needs from_cols and to_cols of the same length",
					s.Name, j)
			}
		}
		if s.ColourName != "" && !slices.Contains(ColourNames, s.ColourName) {
			return fmt.Errorf("config.validate: server %q has colour = %q, want one of %s",
				s.Name, s.ColourName, strings.Join(ColourNames, "/"))
		}
		if s.TLS != "" && !TLSNames[s.TLS] {
			return fmt.Errorf("config.validate: server %q has tls = %q, want one of false/preferred/skip-verify/true",
				s.Name, s.TLS)
		}
	}
	return nil
}

// SQLMode returns the session sql_mode every connection is set to.
func SQLMode() string {
	mu.RLock()
	defer mu.RUnlock()
	return c.MySQL.Mode()
}

// LockWait returns the session lock_wait_timeout in seconds, 0 to leave the
// server's own value.
func LockWait() int {
	mu.RLock()
	defer mu.RUnlock()
	return c.MySQL.LockWaitSeconds()
}

// QueryLog returns the query-log settings with their defaults resolved.
func QueryLog() Log {
	mu.RLock()
	defer mu.RUnlock()
	return *c.Log
}

// Open reads the config-file, applies defaults and validates it.
func Open(f string) error {
	abs, e := filepath.Abs(f)
	if e != nil {
		return fmt.Errorf("config.Open abs: %w", e)
	}
	Path = abs

	st, e := os.Stat(abs)
	if e != nil {
		return fmt.Errorf("config.Open stat: %w", e)
	}
	if m := st.Mode().Perm(); m&0o077 != 0 {
		log.Printf("WARN config.Open: %s is mode %04o, it holds cleartext passwords, chmod 0600 it", abs, m)
	}

	var r Config
	if _, e := toml.DecodeFile(abs, &r); e != nil {
		return fmt.Errorf("config.Open TOML: %w", e)
	}
	n := resolve(r)
	if e := n.validate(); e != nil {
		return e
	}

	mu.Lock()
	raw, c = r, n
	mu.Unlock()

	if Verbose {
		log.Printf("config.Open %s servers=%d listen=%s ddl_query=%s",
			abs, len(n.Server), n.Listen, n.Timeout.DDLQuery.D())
	}
	return nil
}

// Get returns a copy of the current config.
func Get() Config {
	mu.RLock()
	defer mu.RUnlock()
	return resolve(raw)
}

// Timeouts returns the deadline-budget.
func Timeouts() Timeout {
	mu.RLock()
	defer mu.RUnlock()
	return *c.Timeout
}

// Listen returns the HTTP listen-address from the config-file.
func Listen() string {
	mu.RLock()
	defer mu.RUnlock()
	return c.Listen
}

// Servers returns a copy of the configured servers.
func Servers() []Server {
	mu.RLock()
	defer mu.RUnlock()
	out := make([]Server, len(c.Server))
	copy(out, c.Server)
	return out
}

// ServerByName looks up one server, ErrNoSuchServer when it is gone.
func ServerByName(name string) (Server, error) {
	mu.RLock()
	defer mu.RUnlock()
	for _, s := range c.Server {
		if s.Name == name {
			return s, nil
		}
	}
	return Server{}, fmt.Errorf("%w: %s", ErrNoSuchServer, name)
}

// AddServer appends a server and rewrites the config-file.
func AddServer(s Server) error {
	mu.Lock()
	defer mu.Unlock()
	for _, o := range raw.Server {
		if o.Name == s.Name {
			return fmt.Errorf("%w: %s", ErrDuplicateServer, s.Name)
		}
	}
	raw.Server = append(raw.Server, s)
	if e := commit(); e != nil {
		raw.Server = raw.Server[:len(raw.Server)-1]
		_ = commit() //nolint:errcheck // restoring a config that already validated
		return e
	}
	return save()
}

// UpdateServer replaces the server named orig and rewrites the config-file.
func UpdateServer(orig string, s Server) error {
	mu.Lock()
	defer mu.Unlock()
	idx := -1
	for i, o := range raw.Server {
		if o.Name == orig {
			idx = i
			break
		}
	}
	if idx == -1 {
		return fmt.Errorf("%w: %s", ErrNoSuchServer, orig)
	}
	if s.Name != orig {
		for _, o := range raw.Server {
			if o.Name == s.Name {
				return fmt.Errorf("%w: %s", ErrDuplicateServer, s.Name)
			}
		}
	}
	old := raw.Server[idx]
	raw.Server[idx] = s
	if e := commit(); e != nil {
		raw.Server[idx] = old
		_ = commit() //nolint:errcheck // restoring a config that already validated
		return e
	}
	return save()
}

// DeleteServer drops a server and rewrites the config-file.
// AddLink records a relationship the operator declared. Idempotent: the
// same link twice is not an error, it is the same answer given twice.
func AddLink(server string, l Link) error {
	mu.Lock()
	defer mu.Unlock()
	for i := range raw.Server {
		if raw.Server[i].Name != server {
			continue
		}
		for _, o := range raw.Server[i].Link {
			if sameLink(o, l) {
				return nil
			}
		}
		raw.Server[i].Link = append(raw.Server[i].Link, l)
		if e := commit(); e != nil {
			raw.Server[i].Link = raw.Server[i].Link[:len(raw.Server[i].Link)-1]
			_ = commit() //nolint:errcheck // restoring a config that already validated
			return e
		}
		return save()
	}
	return fmt.Errorf("%w: %s", ErrNoSuchServer, server)
}

// DeleteLink forgets one. A link that is not there is not an error either:
// the caller wanted it gone, and it is.
func DeleteLink(server string, l Link) error {
	mu.Lock()
	defer mu.Unlock()
	for i := range raw.Server {
		if raw.Server[i].Name != server {
			continue
		}
		kept := raw.Server[i].Link[:0]
		for _, o := range raw.Server[i].Link {
			if !sameLink(o, l) {
				kept = append(kept, o)
			}
		}
		if len(kept) == len(raw.Server[i].Link) {
			return nil
		}
		raw.Server[i].Link = kept
		if e := commit(); e != nil {
			return e
		}
		return save()
	}
	return fmt.Errorf("%w: %s", ErrNoSuchServer, server)
}

// sameLink compares by what the link means, not by how it was written.
func sameLink(a, b Link) bool {
	return a.DB == b.DB && a.FromTbl == b.FromTbl && a.ToTbl == b.ToTbl &&
		slices.Equal(a.FromCols, b.FromCols) && slices.Equal(a.ToCols, b.ToCols)
}

func DeleteServer(name string) error {
	mu.Lock()
	defer mu.Unlock()
	for i, o := range raw.Server {
		if o.Name == name {
			raw.Server = append(raw.Server[:i], raw.Server[i+1:]...)
			if e := commit(); e != nil {
				return e
			}
			return save()
		}
	}
	return fmt.Errorf("%w: %s", ErrNoSuchServer, name)
}

// commit re-resolves raw into the live config. Caller holds mu.
func commit() error {
	n := resolve(raw)
	if e := n.validate(); e != nil {
		return e
	}
	c = n
	return nil
}

// save atomically rewrites Path, keeping the previous file as .bak.
// Caller holds mu.
func save() error {
	if Path == "" {
		return errors.New("config.save: no config-file loaded")
	}

	tmp := Path + ".tmp"
	f, e := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600) //nolint:gosec // G304: Path is our own -c flag, not user input
	if e != nil {
		return fmt.Errorf("config.save create: %w", e)
	}

	if e := toml.NewEncoder(f).Encode(raw); e != nil {
		if e := f.Close(); e != nil {
			log.Printf("config.save close after encode-fail: %s", e)
		}
		if e := os.Remove(tmp); e != nil {
			log.Printf("config.save remove tmp: %s", e)
		}
		return fmt.Errorf("config.save encode: %w", e)
	}
	if e := f.Sync(); e != nil {
		if e := f.Close(); e != nil {
			log.Printf("config.save close after sync-fail: %s", e)
		}
		return fmt.Errorf("config.save sync: %w", e)
	}
	if e := f.Close(); e != nil {
		return fmt.Errorf("config.save close: %w", e)
	}

	// Keep one generation back, the TOML encoder drops comments.
	if _, e := os.Stat(Path); e == nil {
		if e := os.Rename(Path, Path+".bak"); e != nil {
			log.Printf("config.save backup: %s", e)
		}
	} else if !os.IsNotExist(e) {
		return fmt.Errorf("config.save stat: %w", e)
	}

	if e := os.Rename(tmp, Path); e != nil {
		return fmt.Errorf("config.save rename: %w", e)
	}
	if Verbose {
		log.Printf("config.save wrote %s servers=%d", Path, len(raw.Server))
	}
	return nil
}
