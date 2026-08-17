package connman

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"

	"github.com/go-sql-driver/mysql"
	"github.com/mpdroog/mydb/config"
)

// maxOpenConns keeps the pool small: this is a single-user GUI, and every
// extra connection is another channel over the SSH tunnel. Two is the
// working minimum, a running query plus the conn that KILLs it.
const maxOpenConns = 4

// openPool builds the *sql.DB for one server on the given driver network,
// which is "tcp" for direct servers and the per-server tunnel name otherwise.
//
// The settings below are deliberately the strict end of what the driver
// offers. Three of them defend against a *server* rather than a query,
// which matters because mydb is pointed at machines you may not control.
func openPool(s config.Server, network string, t config.Timeout) (*sql.DB, error) {
	c := mysql.NewConfig()
	c.User = s.User
	c.Passwd = s.Pass
	c.Net = network
	c.Addr = s.Addr()
	c.Timeout = t.MySQLConnect.D()
	c.CheckConnLiveness = true

	// Strict session mode. Without it a server silently truncates on write
	// and still reports success, so an inline edit could store something
	// other than what the grid then shows.
	c.Params = map[string]string{}
	if mode := config.SQLMode(); mode != "" {
		c.Params["sql_mode"] = quoteParam(mode)
	}
	// Bound the wait for a metadata lock. This is the deadline that keeps a
	// blocked ALTER from taking a table offline behind it.
	if secs := config.LockWait(); secs > 0 {
		c.Params["lock_wait_timeout"] = strconv.Itoa(secs)
	}

	// Transport. Tunnelled servers get their confidentiality from SSH;
	// a direct connection to a remote box would otherwise be cleartext.
	c.TLSConfig = s.TLSMode()
	// "preferred" is opportunistic by definition, so let it fall back
	// rather than refusing to connect to a server without TLS.
	c.AllowFallbackToPlaintext = c.TLSConfig == "preferred"

	// A malicious server can answer any query with a LOAD DATA LOCAL INFILE
	// request and read files off this machine. false means only paths
	// explicitly registered with the driver are readable, and mydb
	// registers none.
	c.AllowAllFiles = false
	// A malicious server can also ask the client to hand over the password
	// in the clear, or to fall back to the pre-4.1 password hash.
	c.AllowCleartextPasswords = false
	c.AllowOldPasswords = false
	// Still needed: mysql_native_password is what most MariaDB installs
	// use. It is challenge-response, not cleartext.
	c.AllowNativePasswords = true

	// Every value we send travels as a placeholder, so the server never
	// has to parse a string we glued together.
	c.InterpolateParams = false
	// One statement per round-trip, so a stacked query can never ride along.
	c.MultiStatements = false
	// Scan into sql.RawBytes ourselves, the driver must not guess types.
	c.ParseTime = false
	// RowsAffected must mean "matched", not "changed", or an edit that
	// rewrites a value with itself reads as a lost-update conflict.
	c.ClientFoundRows = true
	// Makes mydb's sessions identifiable in SHOW PROCESSLIST.
	c.ConnectionAttributes = "program_name:mydb"
	// No ReadTimeout/WriteTimeout on purpose: they fire per-read and would
	// kill a legitimately slow query. Deadlines come from the context.

	conn, e := mysql.NewConnector(c)
	if e != nil {
		return nil, fmt.Errorf("connman.openPool connector %s: %w", s.Name, e)
	}

	db := sql.OpenDB(conn)
	db.SetMaxOpenConns(maxOpenConns)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(t.ConnLifetime.D())
	db.SetConnMaxIdleTime(t.ConnLifetime.D())
	return db, nil
}

// quoteParam wraps a system-variable value the way the driver's handshake
// expects, since it is sent as SET <name>=<value>.
func quoteParam(v string) string {
	return "'" + v + "'"
}

// ApplySession re-asserts the strict session settings on a pinned
// connection.
//
// openPool sets sql_mode once at connect time, but a `SET SESSION
// sql_mode=''` typed into the query console would otherwise linger on that
// pooled connection for its whole lifetime and quietly weaken every later
// write that happened to reuse it. One extra round-trip per statement is
// cheap next to that.
func ApplySession(ctx context.Context, conn *sql.Conn) error {
	// Placeholders work for SET SESSION, so nothing has to be interpolated.
	if mode := config.SQLMode(); mode != "" {
		if _, e := conn.ExecContext(ctx, "SET SESSION sql_mode = ?", mode); e != nil {
			return fmt.Errorf("connman.ApplySession sql_mode: %w", e)
		}
	}
	if secs := config.LockWait(); secs > 0 {
		if _, e := conn.ExecContext(ctx, "SET SESSION lock_wait_timeout = ?", secs); e != nil {
			return fmt.Errorf("connman.ApplySession lock_wait_timeout: %w", e)
		}
	}
	return nil
}
