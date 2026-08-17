package config

import (
	"os"
	"path/filepath"
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
		{"ddl_query", tm.DDLQuery, 60 * time.Second},
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
