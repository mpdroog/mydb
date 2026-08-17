# mydb — a localhost MySQL GUI in Go

## Context

There is no lightweight, portable MySQL GUI that fits the way you work: single binary, no Electron,
no npm, runs on any box you SSH into, and reaches production through SSH tunnels. `mydb` is that
tool — a Go binary that serves a browser GUI on `localhost:9999` and talks to MySQL servers listed in
a TOML file next to it.

`/home/mp/go/src/github.com/mpdroog/mydb` is currently empty. This is greenfield, but not
style-greenfield: `invoiced` is already a localhost:9999 Go HTTP server with a browser GUI, and
this project copies its shape (flat packages, httprouter, `e` for errors, BurntSushi/toml,
package-level config globals) so it reads like the rest of your repos.

Two constraints drive most of the design:

1. **Strict timeouts everywhere.** Every network operation has a deadline from a `[timeout]` config
   block. Nothing is allowed to hang: not the SSH dial, not a query, not an HTTP write.
2. **The UI never blocks.** Every query is an async job the browser watches over SSE, with a cancel
   button that issues a real `KILL QUERY`. The grid virtualizes rows so wide tables don't jank.

## Decisions already taken

| Area | Decision |
|---|---|
| Frontend | Vanilla ES modules + CSS, `//go:embed static`, no build step |
| CSP | `default-src 'none'`, no inline script or style anywhere |
| Secrets | Plaintext TOML next to the binary, 0600, warn on looser perms |
| SSH | In-process `x/crypto/ssh`, custom `mysql.DialFunc`, **no local listening port** |
| Host keys | Strict `known_hosts`; unknown key = hard fail, no TOFU |
| Writes | DDL structure editor, SQL console, inline row edit (PK required) |
| Layout | Sidebar tree + tabbed content pane |
| Table open | `SELECT * FROM t ORDER BY <pk> DESC LIMIT 1000`; no PK → no `ORDER BY` |
| Keyboard | Full keymap, all `preventDefault` |
| Grid | Hand-written row virtualization, ~50 live rows |
| Queries | Async job + SSE + `KILL QUERY` cancel |
| Connections | Lazy connect, live status dots, idle reap at 10m |
| Hardening | Host-header check + `X-Mydb` CSRF header + LocalOnly |
| Config writes | GUI rewrites `config.toml` atomically, keeps `.bak` |
| v1 extras | WHERE/filter box, query history |
| Linting | `passdb/.golangci.yml` + sql/context/error linters; **no error ever ignored** |
| Testing | You point it at a real server; I verify build, vet, lint, unit tests |

## File tree

```
mydb/
  main.go                  flags, routes, http.Server timeouts, graceful shutdown   ~180
  config/config.go         TOML load, globals, [timeout] defaults, atomic save      ~220
  middleware/security.go   HostCheck, LocalOnly (IPv6-fixed), CSRFHeader, headers   ~120
  middleware/httplog.go    request logging, verbose-gated                            ~40
  writer/writer.go         JSON Encode/Decode one-liners for handlers                ~70
  sshtun/sshtun.go         ssh.Client: agent/key/password auth, knownhosts, keepalive ~200
  connman/connman.go       per-server state machine, lazy dial, idle reaper          ~320
  connman/pool.go          DialFunc registration, *sql.DB setup, pinned conns         ~90
  meta/meta.go             databases/tables/columns/indexes/PK discovery             ~230
  meta/rows.go             generic row scan -> JSON (NULL, binary, big values)       ~130
  ddl/ddl.go               structure diff -> ALTER TABLE, backtick quoting           ~300
  ddl/ddl_test.go          table-driven tests on the diff + quoting                  ~200
  jobs/jobs.go             job lifecycle, SSE hub, KILL QUERY cancel, GC             ~330
  api/server.go            server CRUD + connect/disconnect handlers                 ~180
  api/browse.go            databases/tables/columns/rows handlers                    ~160
  api/query.go             job submit/events/cancel handlers                         ~150
  api/ddl.go               structure read + ALTER preview/apply handlers             ~140
  api/row.go               inline row UPDATE handler                                 ~120
  static/index.html        the only HTML file; no inline script/style
  static/app.css           layout + theme
  static/js/*.js           see frontend section
  config.example.toml      committed sample
  .golangci.yml            copied verbatim from passdb
  README.md                ==== title, "Why create this?", bash blocks
  .gitignore               mydb, config.toml, config.toml.bak
```

Flat domain packages one level deep, `main.go` at the root — matching `invoiced`. No `cmd/`,
no `internal/`, no `pkg/`.

## Reuse from your existing repos

- `middleware.LocalOnly` and `middleware.HTTPLog` — `invoiced/middleware/httplog.go`. Copy both,
  and **fix the open TODO there**: it only accepts `127.0.0.1`, so IPv6 `::1` is rejected. Split
  with `net.SplitHostPort` and compare a parsed `netip.Addr` against loopback.
- `config` package shape — `invoiced/config/config.go`: exported globals `Verbose`, `CurDir`, `C`,
  and `func Open(f string) error`. Add `func Save() error` for GUI-driven edits.
- `writer` — `invoiced/writer/writer.go`, trimmed to JSON only (drop msgpack and `?accept=`).
- Generic row scanning — `invoiced/sql/model.go` scans into `map[string]*string`; `meta/rows.go`
  is the same idea, upgraded to `sql.RawBytes` so NULL and binary columns survive.
- `.golangci.yml` — start from `passdb/.golangci.yml` (`govet` enable-all, `nakedret` max 0,
  `gosec`, `gocritic` diagnostic+style+performance, `errcheck` with `check-blank`) and tighten it
  further for this project — see below.

Conventions to hold to: error variable is **`e`**, never `err`. Handler failures are
`log.Printf(e.Error())` then `http.Error(w, "pkg.Func failed doing X", 400)`. Startup failures are
`log.Fatal(e)`. Verbose output gated on `if config.Verbose`. stdlib `log`, no logging library.

## Linting and error handling

**Rule: no error is ever ignored. Every error is either returned to the caller or logged.**
There is no third option — no `_ =`, no bare `defer x.Close()`, no empty `if e != nil {}`.

The `passdb` config plus these additions, all of which matter for a database/SSH/HTTP program:

```yaml
linters:
  enable:
    # ... everything from passdb/.golangci.yml, plus:
    - sqlclosecheck   # *sql.Rows / *sql.Stmt closed on every path
    - rowserrcheck    # rows.Err() checked after every iteration
    - contextcheck    # never drop a context on the floor
    - errchkjson      # unhandled json encode errors
    - nilnil          # no (nil, nil) returns
    - exhaustive      # every State enum switch is complete
    - containedctx    # no context.Context stashed in a struct
    - fatcontext      # no context built up inside a loop
    - makezero
    - errname         # error vars/types named correctly

linters-settings:
  errcheck:
    check-type-assertions: true
    check-blank: true          # `_ = f()` is an error, not an escape hatch
    exclude-functions: []      # nothing gets a free pass
  gosec:
    excludes: []               # no blanket excludes; suppress at the line with a reason
```

`errcheck` with `check-blank: true` is what actually enforces the rule — it fails the build on
`_ = f()`, which is the usual way error ignoring sneaks in.

The pattern this forces in deferred cleanup, used consistently across the codebase:

```go
defer func() {
    if e := rows.Close(); e != nil {
        log.Printf("meta.Rows rows.Close: %s", e)
    }
}()
```

Same for `db.Close()`, `ssh.Close()`, `conn.Close()`, `f.Close()` and the SSE flush path. Where an
error genuinely cannot be acted on (a `Close` during a shutdown that's already failing) it still
gets logged — logging is the floor, never silence.

Two consequences worth calling out up front, because they shape the code rather than just decorate
it: `rowserrcheck` means every row-scanning loop ends with `if e := rows.Err(); e != nil`, which is
the check that catches a connection dying mid-result-set — exactly the failure mode an SSH tunnel
produces. And `contextcheck` + `containedctx` mean contexts are threaded as parameters everywhere,
which is what makes the timeout budget real instead of aspirational.

A `gosec` suppression is allowed only inline with a justification comment, matching the `passdb`
style:

```go
//nolint:gosec // G404: job ids are not secrets, only unique within a process lifetime
```

## Config

`config.toml` sits next to the binary (`-c ./config.toml`), 0600.

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
http_read_hdr = "5s"
http_idle     = "60s"

[[server]]
name = "prod-eu"
host = "127.0.0.1"      # as seen from the SSH host
port = 3306
user = "root"
pass = "hunter2"

  [server.ssh]
  host  = "bastion.example.com:22"
  user  = "mp"
  agent = true            # or key = "~/.ssh/id_ed25519" (+ optional passphrase)
```

Load warns (does not refuse) if the mode is looser than 0600. Save is atomic:
write `config.toml.tmp` → `fsync` → rename over `config.toml`, keeping the previous file as
`config.toml.bak`. BurntSushi's encoder drops comments and reorders keys — accepted tradeoff, the
`.bak` is the safety net.

## HTTP API

All routes under `/api/v1/`, httprouter, registered inline in `main()`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/servers` | list servers + live status |
| POST | `/api/v1/servers` | add server (rewrites config.toml) |
| PUT | `/api/v1/servers/:name` | edit server |
| DELETE | `/api/v1/servers/:name` | remove server |
| POST | `/api/v1/servers/:name/connect` | kick off lazy dial, returns immediately |
| POST | `/api/v1/servers/:name/disconnect` | tear down pool + tunnel |
| GET | `/api/v1/status/events` | SSE: connection state changes for all servers |
| GET | `/api/v1/servers/:name/databases` | database list |
| GET | `/api/v1/servers/:name/:db/tables` | table list + row estimate + engine |
| GET | `/api/v1/servers/:name/:db/:table/structure` | columns, indexes, PK, `SHOW CREATE TABLE` |
| POST | `/api/v1/query` | submit a job → `202 {"job":"j7"}` |
| GET | `/api/v1/job/:id/events` | SSE: `running` / `rows` / `done` / `error` |
| GET | `/api/v1/job/:id/result` | fetch the buffered result set |
| POST | `/api/v1/job/:id/cancel` | `KILL QUERY <connid>` |
| POST | `/api/v1/servers/:name/:db/:table/alter` | preview (`dry=1`) or apply ALTER |
| PATCH | `/api/v1/servers/:name/:db/:table/row` | inline row UPDATE |

`GET /` 303-redirects to `/static/index.html`; `static/` is served from the embedded FS with
`http.FileServerFS`.

Table open is not a special endpoint — the frontend submits a job:
`{"server":"prod-eu","db":"shop","table":"orders","where":"","limit":1000}`. The server builds
`SELECT * FROM `db`.`orders` ORDER BY `id` DESC LIMIT 1000` itself so identifiers are quoted
server-side and `LIMIT` can never be overridden upward.

## Connection manager

```go
type State int  // Offline, Connecting, Ready, Errored

type Conn struct {
    mu       sync.Mutex
    name     string
    state    State
    lastErr  error
    ssh      *ssh.Client
    db       *sql.DB
    ready    chan struct{}   // closed when a Connecting attempt resolves
    lastUsed atomic.Int64    // unix nano
    active   atomic.Int32    // in-flight queries; idle reaper refuses to touch a busy conn
}
```

`Manager.Get(ctx, name) (*sql.DB, error)` is the only entry point. Under the mutex it either
returns a ready `*sql.DB`, starts a dial goroutine and returns a "connecting" sentinel, or waits on
`ready` with `select { case <-ready: ...; case <-ctx.Done(): ... }`. Only one dial per server can be
in flight, so a burst of sidebar clicks can't open five tunnels.

The dial goroutine, on its own `context.WithTimeout(ssh_dial + mysql_connect)`:

1. `sshtun.Dial` — agent (`SSH_AUTH_SOCK`) → key file → password, host key checked strictly against
   `~/.ssh/known_hosts` via `knownhosts.New`. An unknown or changed key is a **hard failure**: no
   TOFU prompt in the GUI, the error carries the SHA256 fingerprint and tells you to
   `ssh <user>@<host>` once. Starts a keepalive goroutine sending
   `client.SendRequest("keepalive@openssh.com", ...)` every `ssh_keepalive`, tearing the
   connection down on failure.
2. `mysql.RegisterDialContext("mydb+"+name, ...)` returning `sshClient.DialContext(ctx, "tcp", addr)`.
   Servers with no `[server.ssh]` block skip this and use plain `tcp`.
3. `sql.Open` with DSN `user:pass@mydb+prod-eu(host:port)/?timeout=…&readTimeout=…`,
   `SetMaxOpenConns(4)`, `SetConnMaxLifetime(conn_lifetime)`, then `db.PingContext`.

Every state transition publishes to the status SSE hub, so the sidebar dot updates without polling.

An idle reaper ticks every 30s: any `Ready` conn with `active == 0` and
`now-lastUsed > idle_reap` gets `db.Close()` then `ssh.Close()` and drops to `Offline`. The next
`Get` transparently redials.

## Job manager

```go
type Job struct {
    ID       string
    Server, DB, SQL string
    State    string        // queued|running|done|error|cancelled
    ConnID   uint64        // MySQL CONNECTION_ID(), for KILL
    Started  time.Time
    Rows     []map[string]any
    Cols     []Column
    Err      error
    subs     []chan Event
    cancel   context.CancelFunc
}
```

Submit returns `202` before any DB work starts, so the POST is instant regardless of server state —
if the server is still `Connecting`, the job simply waits inside its goroutine and the UI shows
"connecting…".

The runner **pins a `*sql.Conn`** (`db.Conn(ctx)`), runs `SELECT CONNECTION_ID()` on it, stores the
id, then runs the real query on that same conn. Cancel takes a *second* conn from the pool and
issues `KILL QUERY <connid>` — this is why pinning matters; without it the KILL could land on an
idle connection. The job's own context also carries `data_query`/`ddl_query` as a hard deadline, so
even a client that vanishes gets cleaned up.

Results are capped (1000 rows by default, and a total byte budget so a table of MEDIUMTEXT can't
balloon the process). Finished jobs are GC'd after 5 minutes or when their tab closes.

SSE: each subscriber gets a buffered channel; a slow reader is dropped rather than allowed to block
the runner. Heartbeat comment every 15s keeps proxies and the browser honest.

**SSE vs. write timeouts.** A global `http.Server.WriteTimeout` would kill long SSE streams, so the
server sets `WriteTimeout: 0` and instead applies per-request deadlines with
`http.NewResponseController(w).SetWriteDeadline(...)` in ordinary handlers. SSE handlers extend the
deadline on each heartbeat. `ReadHeaderTimeout: 5s` and `IdleTimeout: 60s` stay global.

## Security

The threat is not someone on the network — it's any web page you happen to have open. Four layers:

1. **Host header check.** Reject anything whose `Host` isn't `localhost`/`127.0.0.1`/`[::1]` (+port).
   This is what actually stops DNS rebinding; `LocalOnly` alone does not, because a rebound request
   really does arrive from 127.0.0.1.
2. **`X-Mydb: 1` required on every `/api/` request.** A cross-origin page can't send a custom header
   without a CORS preflight, and we return no CORS headers at all, so the preflight fails.
3. **`LocalOnly`** on `RemoteAddr` (IPv6-fixed) — defence in depth.
4. **CSP**, on every response:
   `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`
   plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
   `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`.

Frontend rule that pairs with the CSP: **never `innerHTML`**. Cell values come from databases you
don't control; everything goes through `textContent` / `document.createElement`.

Injection: user values always travel as `?` placeholders. Identifiers cannot — MySQL has no
placeholder for them — so there is exactly one quoting function, used everywhere:

```go
// quoteIdent wraps a MySQL identifier in backticks, doubling any it contains.
func quoteIdent(s string) (string, error) {
    if strings.ContainsRune(s, 0) { return "", errors.New("ddl.quoteIdent: NUL in identifier") }
    return "`" + strings.ReplaceAll(s, "`", "``") + "`", nil
}
```

Table/column names are additionally checked against the live `INFORMATION_SCHEMA` before being
interpolated, so a name has to actually exist on that server to reach a statement.

## DDL structure editor

Read current structure with `SHOW FULL COLUMNS FROM `db`.`t`` + `SHOW INDEX FROM `db`.`t`` (works
across MySQL 5.7/8 and MariaDB without `INFORMATION_SCHEMA` privilege quirks), and
`SHOW CREATE TABLE` for the verbatim view.

The editor sends the desired column list; the server diffs it against live structure and emits:

- new column → `ADD COLUMN `x` <type> [NULL|NOT NULL] [DEFAULT ?] [AFTER `y`]`
- changed type/null/default/comment → `MODIFY COLUMN`
- renamed → `CHANGE COLUMN `old` `new` <type> …` (matched by a stable client-side column id, not by
  name, so rename is unambiguous)
- removed → `DROP COLUMN`
- index add/drop → `ADD INDEX` / `DROP INDEX`, PK add/drop

All of it is folded into a single `ALTER TABLE` with comma-separated clauses so MySQL does one table
rebuild. `dry=1` returns the SQL as text; the UI shows it and only applies on explicit confirm.

**v1 scope:** columns (add/rename/retype/nullability/default/comment/reorder), secondary indexes,
primary key, AUTO_INCREMENT. **Not v1:** foreign keys, partitions, table rename, engine/charset
changes, generated columns — those show as read-only in the editor.

## Inline row editing

Only for tables with a primary key; the grid shows a lock badge and refuses edits otherwise. On
commit:

```sql
UPDATE `db`.`t` SET `col` = ? WHERE `pk1` = ? AND `pk2` = ? LIMIT 1
```

Optimistic concurrency: the `WHERE` also carries the *original* value of the edited column
(`AND `col` <=> ?`, the NULL-safe operator). Zero rows affected means someone else changed it — the
UI reports a conflict and reloads the row instead of silently clobbering.

NULL is a distinct UI state (a checkbox / `Ctrl+0`), never conflated with `''`. Binary and BLOB
columns are shown hex-truncated and are read-only in v1.

## Frontend

```
static/js/
  app.js         bootstrap, wire modules, restore layout
  api.js         fetch wrapper: X-Mydb header, AbortController registry, typed errors
  state.js       tiny pub/sub store (servers, tabs, active tab)
  dom.js         h() element helper — textContent only, no innerHTML
  keymap.js      one document keydown listener, context-aware, preventDefault
  sidebar.js     server/db/table tree, status dots, lazy expand, filter
  tabs.js        tab bar + pane lifecycle
  grid.js        virtualized data grid
  jobs.js        SSE subscription, progress, cancel
  structure.js   DDL editor + ALTER confirm dialog
  console.js     SQL console + persisted history
```

**Virtualized grid.** Fixed 24px rows. A spacer div sized `rowCount * 24` gives a real scrollbar; a
absolutely-positioned viewport renders only `floor(scrollTop/24) - 5` through `+visible + 5`. Row
nodes are recycled from a pool, so the DOM stays ~60 elements whether the result is 1000 rows or
100k. Sticky header, drag-resizable columns persisted per table in `localStorage`.

**Non-blocking, concretely.** No `await` ever gates a render. Clicking a server paints the
"connecting" dot immediately from the SSE stream; opening a table paints an empty grid with a
loading strip and fills it when the job's `done` event arrives. Every fetch is registered with an
`AbortController` keyed by tab — closing a tab or switching tables aborts the in-flight request and
cancels the server-side job.

**Keymap** (all `preventDefault`):

| Key | Action |
|---|---|
| `Ctrl/Cmd+D` | structure editor for the focused table |
| `Ctrl/Cmd+K` | quick-switcher over servers/databases/tables |
| `Ctrl/Cmd+Enter` | run the SQL console query |
| `Ctrl/Cmd+W` | close tab |
| `Esc` | close dialog / cancel running job |
| `/` | focus the filter box |
| `↑ ↓ ← → PgUp PgDn Home End` | grid navigation |
| `Enter` | edit focused cell · `Ctrl+0` set NULL |

## Build order

0. **`plan.md`** — copy this document to `/home/mp/go/src/github.com/mpdroog/mydb/plan.md` so it
   lives with the code, as you asked.
1. **Skeleton** — `main.go`, `config`, `middleware`, `writer`, embedded `static/`, an index page
   that renders the layout shell. Runnable and lint-clean from day one.
2. **sshtun + connman** — server list, connect/disconnect, status SSE, sidebar dots.
3. **meta** — databases and tables in the sidebar tree.
4. **jobs + grid** — double-click a table → async job → virtualized 1000 rows. The core milestone.
5. **SQL console** — history, `Ctrl+Enter`, cancel button, WHERE/filter box on the grid.
6. **structure** — read, diff, ALTER preview, apply.
7. **row edit** — inline UPDATE with conflict detection.
8. **server CRUD** — add/edit/delete writing `config.toml` atomically.
9. **Polish** — keymap completion, README, `ddl` unit tests, full lint pass.

## Verification

`go` is at `/usr/local/go/bin/go` and is **not** on the fish `PATH`.

```bash
/usr/local/go/bin/go build ./...
/usr/local/go/bin/go vet ./...
/usr/local/go/bin/go test ./...
~/go/bin/golangci-lint run
./mydb -v -c ./config.toml
# open http://localhost:9999
```

Unit tests (no DB needed, table-driven, next to the source):

- `ddl/ddl_test.go` — identifier quoting (backticks, NUL rejection), structure diff → expected
  `ALTER TABLE` text, rename-by-id, no-op diff produces no statement.
- `meta/rows_test.go` — `sql.RawBytes` → JSON: NULL vs `''`, binary detection, truncation.
- `config/config_test.go` — round-trip load → save → load, atomic rename leaves `.bak`.
- `middleware/security_test.go` — Host header accept/reject table, missing `X-Mydb` → 403, `::1`
  accepted by `LocalOnly` (the bug being fixed).

Manual, against a server you configure:

1. Add a server through the GUI; confirm `config.toml` is rewritten 0600 and `.bak` exists.
2. Click it — sidebar goes connecting → ready without the UI freezing; a bad host goes to `error`
   within `ssh_dial` (5s), not hanging.
3. Double-click a wide table — grid scrolls smoothly, DOM node count stays flat in devtools.
4. Run `SELECT SLEEP(60)` in the console — cancel button ends it immediately; confirm via
   `SHOW PROCESSLIST` that the query is actually gone.
5. `Ctrl+D`, add a column, read the previewed `ALTER TABLE`, apply, confirm with
   `SHOW CREATE TABLE`.
6. Edit a cell; edit the same row from another client first to see the conflict path.
7. Devtools console must show **zero** CSP violations on every screen.
8. Leave it idle past `idle_reap` — tunnel closes, next click transparently redials.

## Open items

- **Comment loss in config.toml.** GUI-driven saves re-encode the file; comments and key order do
  not survive. `.bak` mitigates it.
- **MariaDB vs MySQL 8** differ in `SHOW CREATE TABLE` output and a few `INFORMATION_SCHEMA`
  columns. v1 targets both via `SHOW`-based introspection; anything version-specific gets flagged
  when you test against your real servers.
