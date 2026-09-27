package config

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// write drops a config-file in a temp dir and loads it.
func write(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.toml")
	if e := os.WriteFile(path, []byte(body), 0o600); e != nil {
		t.Fatal(e)
	}
	if e := Open(path); e != nil {
		t.Fatal(e)
	}
	return path
}

func TestDefaults(t *testing.T) {
	write(t, "")

	if got := Listen(); got != "localhost:9999" {
		t.Errorf("Listen = %q, want localhost:9999", got)
	}
	tm := Timeouts()
	for _, c := range []struct {
		name string
		got  Duration
		want time.Duration
	}{
		{"ssh_dial", tm.SSHDial, 5 * time.Second},
		{"data_query", tm.DataQuery, 30 * time.Second},
		// ddl_query is covered by TestDDLHasNoDeadlineByDefault: it is the
		// one budget that defaults to unbounded, on purpose.
		{"idle_reap", tm.IdleReap, 10 * time.Minute},
	} {
		if c.got.D() != c.want {
			t.Errorf("%s = %s, want %s", c.name, c.got.D(), c.want)
		}
	}
}

func TestDurationRoundTrip(t *testing.T) {
	write(t, "[timeout]\ndata_query = \"90s\"\n")
	if got := Timeouts().DataQuery.D(); got != 90*time.Second {
		t.Errorf("data_query = %s, want 1m30s", got)
	}
	// The rest still falls back to the built-in budget.
	if got := Timeouts().MetaQuery.D(); got != 5*time.Second {
		t.Errorf("meta_query = %s, want 5s", got)
	}
}

func TestValidate(t *testing.T) {
	for _, c := range []struct {
		name string
		body string
	}{
		{"no name", "[[server]]\nhost = \"127.0.0.1\"\n"},
		{"no host", "[[server]]\nname = \"a\"\n"},
		{"duplicate", "[[server]]\nname=\"a\"\nhost=\"h\"\n[[server]]\nname=\"a\"\nhost=\"h\"\n"},
		{"ssh without host", "[[server]]\nname=\"a\"\nhost=\"h\"\n  [server.ssh]\n  user=\"mp\"\n"},
		// A socket is an alternative address, so every way of asking for
		// two at once is refused rather than resolved by precedence.
		{"host and socket", "[[server]]\nname=\"a\"\nhost=\"h\"\nsocket=\"/run/mysqld/mysqld.sock\"\n"},
		{"socket and port", "[[server]]\nname=\"a\"\nsocket=\"/run/mysqld/mysqld.sock\"\nport=3306\n"},
		{"socket and tls", "[[server]]\nname=\"a\"\nsocket=\"/run/mysqld/mysqld.sock\"\ntls=\"preferred\"\n"},
		{"socket and ssh", "[[server]]\nname=\"a\"\nsocket=\"/run/mysqld/mysqld.sock\"\n  [server.ssh]\n  host=\"bastion:22\"\n"},
	} {
		t.Run(c.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.toml")
			if e := os.WriteFile(path, []byte(c.body), 0o600); e != nil {
				t.Fatal(e)
			}
			if e := Open(path); e == nil {
				t.Errorf("Open accepted a config with %s", c.name)
			}
		})
	}
}

func TestSaveRoundTrip(t *testing.T) {
	path := write(t, "[[server]]\nname=\"one\"\nhost=\"127.0.0.1\"\nport=3306\nuser=\"root\"\npass=\"secret\"\n")

	add := Server{
		Name: "two", Host: "10.0.0.5", Port: 3307, User: "ro", Pass: "pw",
		SSH: &SSH{Host: "bastion:22", User: "mp", Agent: true},
	}
	if e := AddServer(add); e != nil {
		t.Fatal(e)
	}

	// A backup of the previous file must exist.
	if _, e := os.Stat(path + ".bak"); e != nil {
		t.Errorf("no config.toml.bak after save: %s", e)
	}
	// The temp file must be gone.
	if _, e := os.Stat(path + ".tmp"); !os.IsNotExist(e) {
		t.Errorf("config.toml.tmp left behind")
	}
	// And the mode must still be 0600, this file holds cleartext passwords.
	st, e := os.Stat(path)
	if e != nil {
		t.Fatal(e)
	}
	if m := st.Mode().Perm(); m != 0o600 {
		t.Errorf("config.toml is mode %04o after save, want 0600", m)
	}

	if e := Open(path); e != nil {
		t.Fatal(e)
	}
	got, e := ServerByName("two")
	if e != nil {
		t.Fatal(e)
	}
	if got.Pass != "pw" || got.Port != 3307 || got.SSH == nil || !got.SSH.Agent {
		t.Errorf("round-trip lost data: %+v", got)
	}

	if e := AddServer(add); e == nil {
		t.Error("AddServer accepted a duplicate name")
	}

	if e := DeleteServer("one"); e != nil {
		t.Fatal(e)
	}
	if _, e := ServerByName("one"); e == nil {
		t.Error("DeleteServer left the server behind")
	}
	if e := DeleteServer("nope"); e == nil {
		t.Error("DeleteServer accepted an unknown name")
	}
}

func TestUpdateServerKeepsOthers(t *testing.T) {
	path := write(t, "[[server]]\nname=\"a\"\nhost=\"h1\"\n[[server]]\nname=\"b\"\nhost=\"h2\"\n")

	if e := UpdateServer("a", Server{Name: "a2", Host: "h3", Port: 3306}); e != nil {
		t.Fatal(e)
	}
	if e := Open(path); e != nil {
		t.Fatal(e)
	}
	if _, e := ServerByName("a2"); e != nil {
		t.Error("rename did not stick")
	}
	if _, e := ServerByName("b"); e != nil {
		t.Error("update dropped an unrelated server")
	}
	if e := UpdateServer("a2", Server{Name: "b", Host: "h"}); e == nil {
		t.Error("rename onto an existing name was accepted")
	}
}

func TestSQLModeDefaultsStrict(t *testing.T) {
	// Absent means strict, because inheriting a lax server's global mode
	// would let a write truncate silently and still report success.
	write(t, "")
	if got := SQLMode(); got != DefaultSQLMode {
		t.Errorf("SQLMode = %q, want %q", got, DefaultSQLMode)
	}

	// An explicit empty string is the documented opt-out.
	write(t, "[mysql]\nsql_mode = \"\"\n")
	if got := SQLMode(); got != "" {
		t.Errorf("SQLMode = %q, want it to inherit the server's", got)
	}

	write(t, "[mysql]\nsql_mode = \"TRADITIONAL\"\n")
	if got := SQLMode(); got != "TRADITIONAL" {
		t.Errorf("SQLMode = %q, want TRADITIONAL", got)
	}
}

func TestTLSMode(t *testing.T) {
	for _, c := range []struct {
		name string
		s    Server
		want string
	}{
		{"direct defaults to opportunistic TLS", Server{}, "preferred"},
		{"tunnelled needs none, SSH already encrypts", Server{SSH: &SSH{Host: "h"}}, "false"},
		{"explicit wins", Server{TLS: "true"}, "true"},
		{"explicit wins over the tunnel default", Server{TLS: "skip-verify", SSH: &SSH{Host: "h"}}, "skip-verify"},
	} {
		if got := c.s.TLSMode(); got != c.want {
			t.Errorf("%s: TLSMode = %q, want %q", c.name, got, c.want)
		}
	}

	path := filepath.Join(t.TempDir(), "config.toml")
	if e := os.WriteFile(path, []byte("[[server]]\nname=\"a\"\nhost=\"h\"\ntls=\"maybe\"\n"), 0o600); e != nil {
		t.Fatal(e)
	}
	if e := Open(path); e == nil {
		t.Error("Open accepted an unknown tls mode")
	}
}

func TestDDLHasNoDeadlineByDefault(t *testing.T) {
	// A deadline bounds work that might never finish; an ALTER will finish,
	// and killing it half-way loses the work and then charges for the
	// rollback. So the default is 0 = unbounded, and the lock wait is what
	// gets bounded instead.
	write(t, "")
	if got := Timeouts().DDLQuery.D(); got != 0 {
		t.Errorf("ddl_query = %s, want 0 (no deadline)", got)
	}
	if got := LockWait(); got != int(DefaultLockWait/time.Second) {
		t.Errorf("lock_wait_timeout = %ds, want %ds", got, int(DefaultLockWait/time.Second))
	}

	// An explicit budget is still honoured.
	write(t, "[timeout]\nddl_query = \"10m\"\n")
	if got := Timeouts().DDLQuery.D(); got != 10*time.Minute {
		t.Errorf("ddl_query = %s, want 10m", got)
	}

	// And the lock wait can be handed back to the server.
	write(t, "[mysql]\nlock_wait_timeout = \"0s\"\n")
	if got := LockWait(); got != 0 {
		t.Errorf("lock_wait_timeout = %d, want 0 (leave the server's)", got)
	}
}

func TestSaveKeepsDefaultsOutOfTheFile(t *testing.T) {
	// The bug this guards: config.save() used to write the *resolved*
	// config, so the first GUI-driven save froze every default into the
	// file. A later change to a default could then never reach the user --
	// which is exactly how a 60s ddl_query survived becoming unbounded.
	path := write(t, "listen = \"localhost:9999\"\n\n[[server]]\nname=\"a\"\nhost=\"h\"\n")

	if e := AddServer(Server{Name: "b", Host: "h2", Port: 3306}); e != nil {
		t.Fatal(e)
	}

	body, e := os.ReadFile(path) //nolint:gosec // G304: path is this test's own t.TempDir()
	if e != nil {
		t.Fatal(e)
	}
	got := string(body)
	for _, unwanted := range []string{"[timeout]", "ddl_query", "data_query", "[mysql]", "sql_mode"} {
		if strings.Contains(got, unwanted) {
			t.Errorf("save() wrote %q into a config that never set it:\n%s", unwanted, got)
		}
	}
	// The servers, which the user *did* set, must survive.
	for _, wanted := range []string{`name = "a"`, `name = "b"`} {
		if !strings.Contains(got, wanted) {
			t.Errorf("save() lost %q:\n%s", wanted, got)
		}
	}

	// And reloading still resolves the defaults in memory.
	if e := Open(path); e != nil {
		t.Fatal(e)
	}
	if got := Timeouts().DataQuery.D(); got != 30*time.Second {
		t.Errorf("data_query = %s, want the 30s default", got)
	}
	if got := Timeouts().DDLQuery.D(); got != 0 {
		t.Errorf("ddl_query = %s, want 0 (unbounded)", got)
	}
}

func TestSaveKeepsWhatWasSet(t *testing.T) {
	// A value the user did write must survive a GUI save untouched.
	path := write(t, "[timeout]\nddl_query = \"10m\"\n\n[[server]]\nname=\"a\"\nhost=\"h\"\n")
	if e := AddServer(Server{Name: "b", Host: "h2"}); e != nil {
		t.Fatal(e)
	}
	body, e := os.ReadFile(path) //nolint:gosec // G304: path is this test's own t.TempDir()
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(string(body), `ddl_query = "10m0s"`) {
		t.Errorf("save() dropped an explicitly set ddl_query:\n%s", body)
	}
	if strings.Contains(string(body), "data_query") {
		t.Errorf("save() materialised a default alongside it:\n%s", body)
	}
}

// TestServerColourIsStableAndSafe pins the two properties the GUI relies on:
// a server without a colour still gets one, and that choice never lands on a
// hue the interface already uses to mean a state.
func TestServerColourIsStableAndSafe(t *testing.T) {
	for _, name := range []string{"local", "prod-eu-1", "staging", "a", ""} {
		s := Server{Name: name}
		got := s.Colour()
		if !slices.Contains(ColourNames, got) {
			t.Errorf("Server{Name:%q}.Colour() = %q, not one of %v", name, got, ColourNames)
		}
		if got != s.Colour() {
			t.Errorf("Server{Name:%q}.Colour() is not stable", name)
		}
	}

	// An explicit colour wins over the derived one.
	s := Server{Name: "local", ColourName: "plum"}
	if got := s.Colour(); got != "plum" {
		t.Errorf("explicit colour = %q, want plum", got)
	}

	// Deriving from the name, not the position: reordering the file must not
	// repaint a server the operator has learned to recognise.
	first := Server{Name: "prod-eu-1"}.Colour()
	if second := (Server{Name: "prod-eu-1"}).Colour(); first != second {
		t.Errorf("colour depends on something other than the name: %q then %q", first, second)
	}
}

// TestValidateRejectsAnUnknownColour keeps a typo in config.toml from
// reaching the GUI as a server with no identity at all.
func TestValidateRejectsAnUnknownColour(t *testing.T) {
	c := &Config{Server: []Server{{Name: "a", Host: "h", ColourName: "puce"}}}
	if e := c.validate(); e == nil {
		t.Fatal("validate accepted colour = puce")
	}
	c.Server[0].ColourName = "azure"
	if e := c.validate(); e != nil {
		t.Fatalf("validate rejected a good colour: %s", e)
	}
}

// TestSocketServer covers the local-socket server end to end: it loads, it
// dials on the right driver network, and it asks for no TLS. The last one
// is not cosmetic -- "preferred" on a unix socket would have the driver
// negotiate a TLS session with a server on the other side of a file.
func TestSocketServer(t *testing.T) {
	write(t, "[[server]]\nname=\"local\"\nsocket=\"/run/mysqld/mysqld.sock\"\nuser=\"root\"\n")

	s, e := ServerByName("local")
	if e != nil {
		t.Fatal(e)
	}
	if got := s.Network(); got != "unix" {
		t.Errorf("Network = %q, want unix", got)
	}
	if got := s.Addr(); got != "/run/mysqld/mysqld.sock" {
		t.Errorf("Addr = %q, want the socket path", got)
	}
	if got := s.TLSMode(); got != "false" {
		t.Errorf("TLSMode = %q, want false", got)
	}
}

// TestSocketSurvivesSave checks that a socket server written back out is
// still a socket server, and that no empty host or zero port rides along
// with it: the GUI rewrites this file on every edit, and a host = "" left
// in it would fail the next load with "both host and socket".
func TestSocketSurvivesSave(t *testing.T) {
	path := write(t, "")

	if e := AddServer(Server{Name: "local", Socket: "/run/mysqld/mysqld.sock", User: "root"}); e != nil {
		t.Fatal(e)
	}
	body, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(body), "host") || strings.Contains(string(body), "port") {
		t.Errorf("a socket server was written with a host or port:\n%s", body)
	}
	if e := Open(path); e != nil {
		t.Fatalf("reloading what we just wrote: %v", e)
	}
	s, e := ServerByName("local")
	if e != nil {
		t.Fatal(e)
	}
	if s.Socket != "/run/mysqld/mysqld.sock" {
		t.Errorf("socket = %q after a save round-trip", s.Socket)
	}
}

// TestTCPServerIsUnchanged is the other half: adding a socket must not have
// moved a plain tcp server, which is what every existing config-file holds.
func TestTCPServerIsUnchanged(t *testing.T) {
	write(t, "[[server]]\nname=\"one\"\nhost=\"10.0.0.5\"\n")

	s, e := ServerByName("one")
	if e != nil {
		t.Fatal(e)
	}
	if got := s.Network(); got != "tcp" {
		t.Errorf("Network = %q, want tcp", got)
	}
	if got := s.Addr(); got != "10.0.0.5:3306" {
		t.Errorf("Addr = %q, want the default port filled in", got)
	}
	if got := s.TLSMode(); got != "preferred" {
		t.Errorf("TLSMode = %q, want preferred", got)
	}
}
