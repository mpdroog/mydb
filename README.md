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

Windows
-------
```bash
./build-windows.sh          # dist/mydb-windows-{amd64,arm64}.exe (+ .zip)
```

No cgo and no build step, so this is a plain cross-compile — the GUI is
embedded in the binary and every dependency is pure Go. The script stamps the
commit into the binary, so `mydb.exe` says what it is when it starts.

Two things differ on Windows. There is no `chmod`, so mydb's "your config is
world-readable" warning never fires and you have to lock the file down
yourself with `icacls config.toml /inheritance:r /grant:r "%USERNAME%:F"`.
And `agent = true` does not work: mydb reads `SSH_AUTH_SOCK` and dials it as
a unix socket, while Windows OpenSSH publishes its agent as the named pipe
`\\.\pipe\openssh-ssh-agent`. Use `key` or `pass` in `[server.ssh]` there.

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
ssh_keepalive  = "15s"
conn_lifetime  = "5m"
idle_reap      = "10m"
dashboard_poll = "3s"

[log]
queries     = "mydb-queries.jsonl"   # "" switches the query log off
max_size_mb = 32
keep        = 1

[[server]]
name = "prod-eu"
host = "127.0.0.1"     # as resolved on the SSH host
port = 3306
user = "readonly"
pass = "hunter2"
production = true      # red chrome, and destructive statements ask harder

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
Ctrl/Cmd+Shift+D dashboard: what this server is doing right now
Ctrl/Cmd+Shift+L the query log
Ctrl/Cmd+Enter   run the statement the cursor is in / reload the grid
Ctrl/Cmd+Shift+Enter   run every statement in the buffer
Ctrl/Cmd+E       explain it   ·   Ctrl/Cmd+Shift+E runs it and explains it
Ctrl/Cmd+Space   force the completion list (it also opens as you type)
Ctrl/Cmd+T       new SQL console
Ctrl/Cmd+W       close tab   ·   Ctrl/Cmd+Shift+W closes all of them
Esc              cancel the running query
/                focus the sidebar filter
?                every shortcut, including these
arrows           move around the grid
Enter            edit the focused cell   ·   Ctrl+0 sets NULL
```

`?` is the one to remember: the overlay is generated from the keymap
itself, so it cannot drift out of date with what the keys actually do.

The structure editor never applies anything blind: it asks the server for a
dry-run first and shows you the exact `ALTER TABLE` before running it. Column
renames are tracked by identity rather than by name, so a rename is a
`CHANGE COLUMN` and not a drop plus an add.

Inline row edits need a primary key; without one the grid is read-only. The
`UPDATE` also carries the value the cell was showing (`col <=> ?`), so if
somebody else changed the row in between you get a conflict instead of a
silent clobber.

What is this server doing?
--------------------------
`Ctrl/Cmd+Shift+D`, or the ◴ next to a server in the sidebar, opens a live
dashboard. The polling happens in the Go process and arrives over SSE, so a
dashboard left open in a background tab costs one round-trip per tick rather
than a pile of stacked requests.

```
connections      threads running   queries/s      buffer pool hits
  42 / 151              3            118.4            99.87%
```

MySQL has no CPU metric to report, so the dashboard shows the things that
actually move when a server is in trouble: **threads running** (connections
executing rather than waiting — the closest thing to a load average), the
query rate, and the counters that should normally sit still. Anything moving
in that last group is called out even when the number is small: slow queries,
full scans, full joins, temporary tables spilling to disk, sort merge passes,
row-lock waits, lock timeouts, deadlocks, aborted connections.

Under the tiles:

* **Blocked by** — who is holding up whom. Row-lock waits name both sides
  and the statement each is running, and metadata locks do the same for the
  case the schema-change section below is about: an `ALTER` queued behind an
  open transaction that touched the table and never committed. Both sides
  have a Kill button.
* **Connections** — the process list, filterable, with sleeping connections
  hidden by default. Kill takes two forms: `query` ends the statement and
  leaves the connection up, `conn` disconnects it and rolls its transaction
  back, and only the second one asks first.
* **Open transactions** — how long each has been open, how many rows it has
  locked and modified. A transaction that has been open for minutes holding
  locks is usually the reason for everything else on this page.
* **Top statements** — the statement shapes costing the most, ordered by
  what they have cost *since the last tick* rather than since the server
  started, which is the difference between "what has this server always
  done" and "what is it doing now". Flags a shape that uses no index or
  spills to disk.
* **Memory** — buffer pool size against what is actually in it, InnoDB's
  total allocation, and per-connection memory where the server reports it.
* **Last deadlock** — the report verbatim, which is the only place either
  fork keeps it.

Pause freezes the view without closing the stream, so a busy server can be
read at all. The process list is updated in place rather than rebuilt, so a
Kill button is still there when the click lands.

Servers differ about what they will tell you, and the dashboard says so
rather than showing an empty panel: MariaDB reports per-connection memory
and a progress percentage that MySQL does not, MariaDB 10.6 removed the
lock-wait tables, and top statements and the memory breakdown need
`performance_schema` to be on. Anything missing appears as a note with the
reason.

The SQL console
---------------
A buffer with several statements in it works the way a scratch file should.
`Ctrl/Cmd+Enter` runs the statement the cursor is in, `Ctrl/Cmd+Shift+Enter`
runs all of them in order, and each result gets a chip you can click back to:

```
[1  5 rows]  [2  1 row]  [3  ✗]
```

They run as separate jobs on separate round-trips — `MultiStatements` stays
off, so a stacked statement still cannot ride along on one. The splitting
happens on the Go side, because a semicolon inside a string is only a
boundary if you do not read SQL, and mydb has exactly one thing that reads
SQL. A stored routine is left whole rather than cut up at the semicolons in
its body.

Table and column names complete **as you type** — two characters is enough.
It follows the clause you are in: after `FROM` or `JOIN` it offers tables,
in the select list and after `WHERE`, `SET` or `ORDER BY` it offers the
columns of the tables the statement names, and a dot after a table or an
alias offers that table's columns alone.

```
SELECT cli|  FROM orders          → client, client_ref …
SELECT * FROM ord|                → orders, order_items, ORDER BY …
SELECT * FROM orders o WHERE o.|  → id, client, total, status …
```

Columns come from the tables the statement mentions, so `SELECT fie…` on its
own offers tables and keywords until there is a `FROM` to read them from.
It never blocks: it offers what has been loaded and fetches the rest for next
time, and it stays out of the way inside a string literal. Escape dismisses
it for the rest of the word.

`Ctrl/Cmd+Space` forces the list open, where your desktop lets that through:
on Linux the input-method switcher usually takes it before the browser sees
it, which is why completion does not depend on it.

`Ctrl/Cmd+E` draws the plan as a tree instead of `EXPLAIN`'s grid of
columns, with the four things worth acting on called out — a full table
scan, a full index scan, a filesort, a temporary table:

```
query block #1                          cost 1,235
  filesort                              on o.total
    orders   full table scan   no index used   5,000 rows   filtered 10%
```

`Ctrl/Cmd+Shift+E` is the measured version (`EXPLAIN ANALYZE` on MySQL,
`ANALYZE FORMAT=JSON` on MariaDB). That one *runs* the statement, so it is
offered for statements that read and refused for anything else — on MariaDB
"let me see the plan" on a `DELETE` would delete the rows.

Statements that name no rows
----------------------------
`DELETE FROM orders WHERE id = 5` and `DELETE FROM orders` are one keystroke
apart. The second one does not run until you have seen what it would do:

```
DELETE on orders — no WHERE clause: this deletes every row in the table

  DELETE FROM orders

  [Count the rows first]   1,482,301 rows are about to be affected
```

That covers an `UPDATE` or `DELETE` with no `WHERE` of its own, a `TRUNCATE`,
and a `DROP` of a table or a database. A `WHERE` belonging to a subquery does
not count — `UPDATE t SET a = (SELECT x FROM z WHERE z.id = 1)` still changes
every row of `t`, and that is exactly the one a keyword search gets wrong.
A `LIMIT` is not accepted in place of a `WHERE` either: `DELETE FROM t LIMIT
10` deletes ten rows nobody chose.

The check is in the server, not in the browser, so nothing can route around
it by not calling the dialog.

Production servers
------------------
```toml
[[server]]
name = "prod-eu"
production = true
```

It changes nothing about how mydb connects. It draws that server red
everywhere it appears — in the tree, on its tabs, and as a rule along the top
of every pane belonging to it — and it turns the dialog above into one you
have to type the server's name into rather than click through.

Query log
---------
Every statement mydb runs is appended to `mydb-queries.jsonl` next to
`config.toml`, one JSON object per line: what ran, where, how long it took,
how many rows, and what the error was if it failed. The Log button and
`Ctrl/Cmd+Shift+L` search it; `grep` and `jq` read the same file.

```bash
jq -r 'select(.production) | "\(.at) \(.server) \(.sql)"' mydb-queries.jsonl
```

The format is deliberate: a crash mid-write costs one unparseable line
rather than the file. It rotates at 32MiB and keeps one generation, both
configurable under `[log]`; `queries = ""` switches it off.

Loading a table into the grid is not logged — that is the GUI doing its job,
not something you would go looking for. Console statements, schema changes
and inline row edits are. An inline edit is recorded with its placeholders
rather than its values, because mydb has one way to put a value into a
statement and it is not string formatting.

The file holds the literal values of everything you have typed, so it is
created 0600, like `config.toml`.

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
if it is more readable than 0600. The query log holds the literal values of
every statement that ran and is written 0600 for the same reason.

Develop
-------
```bash
go build ./... && go vet ./... && go test ./...
golangci-lint run
```

The frontend is hand-written ES modules under `static/`, embedded with
`//go:embed`. There is no build step and no npm.
