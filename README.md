mydb
====
A MySQL GUI that is one Go binary and a browser tab.

Why create this?
----------------
Every MySQL GUI I tried is either an Electron app I do not want on a server,
or it cannot reach production without me first setting up an `ssh -L` tunnel
by hand. mydb is a single binary you can scp anywhere: it serves its own GUI
on localhost, reads its servers from a TOML file next to it, and dials through
SSH in-process so no local port is ever opened.

Two things drove the design:

* **Strict timeouts everywhere.** Every network operation takes its deadline
  from the `[timeout]` block. The SSH dial, the MySQL handshake, a metadata
  lookup, a grid load, an `ALTER TABLE`, an HTTP write — all of them. Nothing
  is allowed to hang.
* **The UI never blocks.** Every query is a background job: submitting returns
  a job id immediately, progress arrives over SSE, and Cancel issues a real
  `KILL QUERY` on the connection running it. The grid virtualizes its rows, so
  a wide table scrolls the same as a narrow one.

Install
-------
```bash
go build
cp config.example.toml config.toml
chmod 0600 config.toml     # it holds cleartext passwords
$EDITOR config.toml
```

Run
---
```bash
./mydb -v -c ./config.toml
open "http://localhost:9999"
```

```
-v          verbose, log every request
-c FILE     config-file (default ./config.toml)
-h ADDR     listen address, overrides the config-file
```

Config
------
```toml
listen = "localhost:9999"

[timeout]
ssh_dial      = "5s"
mysql_connect = "5s"
meta_query    = "5s"
data_query    = "30s"
ddl_query     = "60s"
ssh_keepalive = "15s"
conn_lifetime = "5m"
idle_reap     = "10m"

[[server]]
name = "prod-eu"
host = "127.0.0.1"     # as resolved on the SSH host
port = 3306
user = "readonly"
pass = "hunter2"

  [server.ssh]
  host  = "bastion.example.com:22"
  user  = "mp"
  agent = true         # or key = "~/.ssh/id_ed25519"
```

Servers can also be added, edited and removed from the GUI, which rewrites
`config.toml` atomically and keeps the previous version as `config.toml.bak`.
The TOML encoder does not preserve comments, which is what the `.bak` is for.

SSH
---
The tunnel runs inside the process: mydb hands the MySQL driver a `net.Conn`
dialled over the SSH connection, so there is no `-L 13306:...` listener for
anything else on the box to ride.

Auth is tried in this order: **ssh-agent** (`SSH_AUTH_SOCK`), **key file**
(with optional passphrase), **password**.

Host keys are checked strictly against `~/.ssh/known_hosts`. An unknown or
changed key is a hard failure — there is no trust-on-first-use button in the
GUI. If a bastion is new, trust it the normal way once:

```bash
ssh mp@bastion.example.com
```

Using it
--------
Click a server to connect; the sidebar dot goes amber then green without the
page waiting on it. Click a database to list its tables. Double-click a table
to load its last 1000 rows, ordered by primary key descending.

```
Ctrl/Cmd+K       jump to any server, database or table
Ctrl/Cmd+D       structure editor for the current table
Ctrl/Cmd+Enter   run the query / reload the grid
Ctrl/Cmd+T       new SQL console
Ctrl/Cmd+W       close tab
Esc              cancel the running query
/                focus the sidebar filter
arrows           move around the grid
Enter            edit the focused cell   ·   Ctrl+0 sets NULL
```

The structure editor never applies anything blind: it asks the server for a
dry-run first and shows you the exact `ALTER TABLE` before running it. Column
renames are tracked by identity rather than by name, so a rename is a
`CHANGE COLUMN` and not a drop plus an add.

Inline row edits need a primary key; without one the grid is read-only. The
`UPDATE` also carries the value the cell was showing (`col <=> ?`), so if
somebody else changed the row in between you get a conflict instead of a
silent clobber.

Encoding
--------
Databases show their default charset in the sidebar. Tables normally show a
row count instead — the encoding only appears when it *disagrees* with the
database it lives in, which is the case worth looking at:

```
▾ ● Ma local
  ▾ shop                              utf8mb4
      orders                              5,102
      legacy_latin1                      latin1     ← red
      odd_collation                   unicode_ci    ← amber
      order_items                            83
```

* **Red** is a charset mismatch. That one silently mangles text on the way in
  or out, and is usually a table created before the database was converted.
* **Amber** is the same charset with a different collation. Milder, but real:
  joining those columns raises `Illegal mix of collations` rather than
  returning rows.

The collation is joined back to its charset through
`information_schema.COLLATIONS` rather than split off the name, so an unusual
collation cannot be misread. Views are never flagged — they have no encoding
of their own.

Not covered yet: a single **column** whose charset differs from its own
table's default. That is the sneakiest version of this bug, and the sidebar
cannot show it.

Long schema changes
-------------------
`ALTER TABLE` has **no deadline** by default, and that is deliberate.

A deadline bounds work that might never finish. An `ALTER` will finish. Killing
one half-way through a table rebuild throws away the work done so far and then
makes you wait for the rollback, so you get neither the change nor the time
back. A ten-minute `ALTER` is slow, not hung.

What can hang forever is the metadata lock the statement needs before it can
start — and that one is genuinely dangerous, because every read and write of
the table queues behind a blocked `ALTER`. So that is what gets bounded:
`lock_wait_timeout` is set to 30s rather than MySQL's default of a year.

Instead of a timeout, a running statement is watched. Every two seconds mydb
asks the server what its own connection is doing and shows it:

```
altering 4m12s · stage 1/2 · 63.4% · copy to tmp table
```

MariaDB reports the stage and percentage directly; on MySQL there are no such
columns in `information_schema.PROCESSLIST`, so only the state is shown and
mydb stops asking for the rest after the first attempt.

A schema change also **outlives its tab**. Closing the tab drops the buffered
result but leaves the statement running and still observable, because losing a
nine-minute rebuild to a stray Ctrl+W would be miserable. Cancel is explicit,
and issues a real `KILL QUERY`. Finished jobs are dropped on tab close as
before.

Set `ddl_query` under `[timeout]` if you want a deadline anyway.

Config the GUI writes
---------------------
Adding or editing a server rewrites `config.toml`, and it writes back **only
what you actually set** — never the resolved defaults. That distinction
matters: an earlier version saved the resolved config, so the first GUI save
froze every default into the file, and no later change to a default could ever
reach you again. If your `config.toml` has a full `[timeout]` block you did not
write, that is where it came from; delete it and the current defaults apply.

Strictness
----------
mydb connects with `sql_mode = STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION`
rather than inheriting whatever the server happens to be set to. This is not
cosmetic. On a lax server, editing a cell to a value too long for its column
stores a truncated one, reports a row affected, and mydb would show you a value
the database does not hold:

```sql
SET SESSION sql_mode='';
UPDATE t SET small='way too long';   -- stores 'way t', reports success
```

Strict mode turns that into `Error 1406: Data too long for column 'small'`,
which is what you see in the GUI. Set `sql_mode = ""` under `[mysql]` to
inherit the server's own mode instead.

It is re-applied on each statement's own connection, not only at connect,
so a `SET SESSION sql_mode=''` typed into the query console cannot linger on
a pooled connection and quietly weaken a later write.

Other connection settings, all on the strict end of what the driver offers:

| | |
|---|---|
| `InterpolateParams=false` | real prepared statements, values never glued into SQL |
| `MultiStatements=false` | a stacked query can never ride along |
| `AllowAllFiles=false` | a rogue server cannot read local files via `LOAD DATA LOCAL INFILE` |
| `AllowCleartextPasswords=false` | a rogue server cannot ask for the password in the clear |
| `AllowOldPasswords=false` | no pre-4.1 password hash |
| `ClientFoundRows=true` | needed so "unchanged value" is not misread as a lost-update conflict |

Direct connections default to `tls = "preferred"`; tunnelled ones to
`tls = "false"`, since SSH already provides confidentiality and a certificate
would be issued for the real hostname rather than the `127.0.0.1` we dial
through the tunnel. Set `tls = "true"` per server to require a verified
certificate.

Security
--------
mydb listens on localhost, which by itself is not much of a wall — any page
you have open can talk to localhost. So:

* the `Host` header must be a loopback name, which is what actually stops DNS
  rebinding (a rebound request really does arrive from 127.0.0.1);
* every `/api/` call must carry `X-Mydb`, which no cross-origin page can send
  without a CORS preflight, and no preflight is answered;
* `RemoteAddr` must be loopback;
* a strict CSP: `default-src 'none'` with no `unsafe-inline` anywhere. There
  is not one inline script or style in `static/`, and no code path builds
  markup from a database value — everything goes through `textContent`.

SQL injection: values always travel as placeholders. Identifiers cannot (MySQL
has no placeholder for them), so they go through one backtick-quoting function
and are checked against `information_schema` before being used. The structure
editor's type field is parsed and rebuilt from recognised pieces rather than
passed through.

The config-file holds passwords in cleartext, like `~/.my.cnf` does. mydb warns
if it is more readable than 0600.

Develop
-------
```bash
go build ./... && go vet ./... && go test ./...
golangci-lint run
```

The frontend is hand-written ES modules under `static/`, embedded with
`//go:embed`. There is no build step and no npm.
