// Package dash answers one question: what is this server doing right now.
//
// It reads the live picture — connections, running statements, transactions,
// what is blocking what, where the memory went and which statements are
// costing the most — and hands it to the browser as one snapshot per tick.
//
// Everything here is a read of server metadata. No table data is ever
// touched, so pointing a dashboard at production is safe.
//
// Two things shape the code. First, MySQL and MariaDB disagree about where
// half of this lives, and both hide parts of it behind performance_schema
// being on: every optional source is tried once, and a source that is not
// there becomes a note in the UI rather than a failed dashboard. Second, a
// tick must stay cheap, so the expensive reads run every few ticks instead
// of every one.
package dash

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/mpdroog/mydb/meta"
)

// slowEvery is how many ticks apart the expensive reads are: the variable
// list, the statement digests, the memory breakdown and the InnoDB monitor
// output. At the default 3s poll that is roughly every 15 seconds.
const slowEvery = 5

// maxDeadlock is how much of a deadlock report is shipped to the browser.
const maxDeadlock = 16 << 10

// Threads is the connection picture.
type Threads struct {
	Connected int64 `json:"connected"`
	Running   int64 `json:"running"`
	Cached    int64 `json:"cached"`
	Max       int64 `json:"max"`
}

// Rate is one counter with the speed it is moving at.
type Rate struct {
	Name string `json:"name"`
	// Unit is "" for a plain count, "B" for bytes.
	Unit   string  `json:"unit,omitempty"`
	Total  int64   `json:"total"`
	PerSec float64 `json:"per_sec"`
	// Warn marks a counter that should normally sit still. Anything moving
	// here is worth looking at even when the number is small.
	Warn bool `json:"warn,omitempty"`
}

// MemEvent is one line of the server's own memory accounting.
type MemEvent struct {
	Name  string `json:"name"`
	Bytes int64  `json:"bytes"`
}

// Memory is where the server put its memory.
type Memory struct {
	BufferPool      int64 `json:"buffer_pool"`
	BufferPoolData  int64 `json:"buffer_pool_data"`
	BufferPoolDirty int64 `json:"buffer_pool_dirty"`
	// InnoDBAlloc is what InnoDB says it allocated in total, which includes
	// everything around the buffer pool. 0 when the monitor output was not
	// readable.
	InnoDBAlloc int64 `json:"innodb_alloc"`
	// HitPct is the buffer-pool hit rate, -1 when it cannot be computed.
	// A read that misses the pool is a read that went to disk.
	HitPct float64 `json:"hit_pct"`
	// Events is the server's own breakdown, where it keeps one.
	Events []MemEvent `json:"events,omitempty"`
	// Threads is what the per-connection accounting adds up to. MariaDB
	// reports this, MySQL does not.
	Threads int64 `json:"threads,omitempty"`
}

// Proc is one row of the process list.
type Proc struct {
	User    string `json:"user"`
	Host    string `json:"host"`
	DB      string `json:"db"`
	Command string `json:"command"`
	State   string `json:"state"`
	Info    string `json:"info"`
	ID      int64  `json:"id"`
	Time    int64  `json:"time"`
	// Memory is what this connection is holding, MariaDB only, 0 elsewhere.
	Memory int64 `json:"memory,omitempty"`
	// Progress is MariaDB's percentage for a statement that reports one.
	Progress float64 `json:"progress,omitempty"`
	// Self marks the dashboard's own poll, so it is not read as a query
	// that never ends.
	Self bool `json:"self,omitempty"`
}

// Trx is one open InnoDB transaction.
type Trx struct {
	ID           string `json:"id"`
	State        string `json:"state"`
	Started      string `json:"started"`
	Query        string `json:"query"`
	Thread       int64  `json:"thread"`
	WaitSecs     int64  `json:"wait_secs"`
	RowsLocked   int64  `json:"rows_locked"`
	RowsModified int64  `json:"rows_modified"`
	TablesLocked int64  `json:"tables_locked"`
}

// Wait is one connection held up by another. This is the answer to "my
// ALTER is stuck and I cannot see why".
type Wait struct {
	// Kind is "row" for an InnoDB record lock, "metadata" for the table
	// lock a DDL statement needs before it can start.
	Kind           string `json:"kind"`
	Object         string `json:"object,omitempty"`
	WaitingQuery   string `json:"waiting_query"`
	BlockingQuery  string `json:"blocking_query"`
	WaitingThread  int64  `json:"waiting_thread"`
	BlockingThread int64  `json:"blocking_thread"`
	Age            int64  `json:"age"`
}

// Digest is one statement shape and what it has cost.
type Digest struct {
	Text  string  `json:"text"`
	Count int64   `json:"count"`
	Total float64 `json:"total_ms"`
	Avg   float64 `json:"avg_ms"`
	// Delta fields are since the previous tick, which is what says who is
	// busy now rather than who was busy since the server started.
	DeltaCount   int64   `json:"delta_count"`
	DeltaMs      float64 `json:"delta_ms"`
	RowsExamined int64   `json:"rows_examined"`
	RowsSent     int64   `json:"rows_sent"`
	TmpDisk      int64   `json:"tmp_disk"`
	NoIndex      int64   `json:"no_index"`
}

// Deadlock is the server's last deadlock report, verbatim.
type Deadlock struct {
	At   string `json:"at"`
	Text string `json:"text"`
}

// Snapshot is everything one tick found.
type Snapshot struct {
	Deadlock *Deadlock `json:"deadlock,omitempty"`
	Server   string    `json:"server"`
	Version  string    `json:"version,omitempty"`
	Hostname string    `json:"hostname,omitempty"`
	Threads  Threads   `json:"threads"`
	Memory   Memory    `json:"memory"`
	Rates    []Rate    `json:"rates"`
	Procs    []Proc    `json:"procs"`
	Trx      []Trx     `json:"trx"`
	Waits    []Wait    `json:"waits"`
	Top      []Digest  `json:"top"`
	// Notes are the things this server would not tell us and why, so a
	// missing panel is never mistaken for "nothing is happening".
	Notes []string `json:"notes,omitempty"`
	// Error is set when a tick could not read the server at all. The stream
	// keeps going: a tunnel that dropped is usually back a tick later, and
	// closing the dashboard because of it would lose the history on screen.
	Error   string `json:"error,omitempty"`
	At      int64  `json:"at"`
	Uptime  int64  `json:"uptime"`
	Elapsed int64  `json:"elapsed_ms"`
}

// source is how far a feature-detected query has got.
type source int

const (
	sourceUnknown source = iota
	sourceOK
	sourceGone
)

// digestSample is what a statement shape had cost at the previous tick.
type digestSample struct {
	count int64
	ms    float64
}

// sticky is what the expensive reads found, kept between the ticks that do
// not run them. Without it the deadlock, the memory breakdown and the top
// statements would appear on one tick in five and be gone on the other
// four, which reads as the server changing rather than as mydb not asking.
type sticky struct {
	deadlock *Deadlock
	events   []MemEvent
	top      []Digest
	notes    []string
	alloc    int64
}

// Collector holds what one open dashboard needs to remember between ticks:
// the previous counters, so a rate can be a rate, and which optional
// sources this server turned out to have.
type Collector struct {
	prev       map[string]int64
	prevDigest map[string]digestSample
	vars       map[string]string
	server     string
	prevAt     time.Time
	varsAt     time.Time
	held       sticky
	tick       int

	procRich  source
	locks     source
	mdl       source
	digests   source
	memEvents source
	metrics   source
	innodb    source
}

// New returns a Collector for one server.
func New(server string) *Collector {
	return &Collector{
		server:     server,
		prev:       map[string]int64{},
		prevDigest: map[string]digestSample{},
		vars:       map[string]string{},
	}
}

// Collect reads one snapshot.
//
// Only the status counters and the process list are treated as required:
// without those there is no dashboard, and the error goes back to the
// caller. Everything else that fails becomes a note and is not asked for
// again.
func (c *Collector) Collect(ctx context.Context, q meta.Querier) (*Snapshot, error) {
	begin := time.Now()
	c.tick++
	slow := c.tick == 1 || c.tick%slowEvery == 0

	s := &Snapshot{Server: c.server, At: begin.UnixMilli()}

	if slow || len(c.vars) == 0 || time.Since(c.varsAt) > time.Minute {
		if e := c.loadVars(ctx, q); e != nil {
			return nil, e
		}
	}
	s.Version = c.vars["version"]
	s.Hostname = c.vars["hostname"]

	status, e := loadKV(ctx, q, "SHOW GLOBAL STATUS")
	if e != nil {
		return nil, fmt.Errorf("dash.Collect status: %w", e)
	}
	c.readMetrics(ctx, q, status, s)

	s.Uptime = status["Uptime"]
	s.Threads = Threads{
		Connected: status["Threads_connected"],
		Running:   status["Threads_running"],
		Cached:    status["Threads_cached"],
		Max:       atoi(c.vars["max_connections"]),
	}
	s.Rates = c.rates(status, begin)
	s.Memory = c.memory(status)

	procs, e := c.loadProcs(ctx, q)
	if e != nil {
		return nil, e
	}
	s.Procs = procs
	for _, p := range procs {
		s.Memory.Threads += p.Memory
	}

	c.loadTrx(ctx, q, s)
	c.loadWaits(ctx, q, s)
	c.loadMDL(ctx, q, s)

	if slow {
		before := len(s.Notes)
		c.loadDigests(ctx, q, s)
		c.loadMemEvents(ctx, q, s)
		c.loadInnoDB(ctx, q, s)
		if strings.EqualFold(c.vars["performance_schema"], "OFF") {
			s.note("performance_schema is off on this server: no top statements " +
				"and no per-subsystem memory. Turning it on needs a restart.")
		}
		c.held = sticky{
			deadlock: s.Deadlock,
			events:   s.Memory.Events,
			top:      s.Top,
			alloc:    s.Memory.InnoDBAlloc,
			notes:    append([]string(nil), s.Notes[before:]...),
		}
	} else {
		s.Deadlock = c.held.deadlock
		s.Memory.Events = c.held.events
		s.Memory.InnoDBAlloc = c.held.alloc
		s.Top = c.held.top
		for _, n := range c.held.notes {
			s.note("%s", n)
		}
	}

	s.Elapsed = time.Since(begin).Milliseconds()
	return s, nil
}

// note records why a panel is empty, once per snapshot.
func (s *Snapshot) note(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	for _, n := range s.Notes {
		if n == msg {
			return
		}
	}
	s.Notes = append(s.Notes, msg)
}

// Execer is satisfied by *sql.DB and *sql.Conn.
type Execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// Kill stops one connection. query kills only the statement it is running
// and leaves the connection open, which is what the button in the process
// list does by default: killing the connection as well throws away an open
// transaction's work and disconnects whoever owns it.
func Kill(ctx context.Context, x Execer, id int64, query bool) error {
	verb := "KILL "
	if query {
		verb = "KILL QUERY "
	}
	// MySQL takes no placeholder for a KILL argument. id is an int64 read
	// out of the process list, so there is nothing here to interpolate but
	// digits.
	stmt := verb + strconv.FormatInt(id, 10) //nolint:gosec // G202: the only variable part is an int64
	if _, e := x.ExecContext(ctx, stmt); e != nil {
		return fmt.Errorf("dash.Kill %d: %w", id, e)
	}
	return nil
}

// ---- small readers ----------------------------------------------------

// str reads a cell as a string, "" when NULL or out of range.
func str(row []*string, i int) string {
	if i >= len(row) || row[i] == nil {
		return ""
	}
	return *row[i]
}

// num reads a cell as an int64, 0 when NULL or unparseable.
func num(row []*string, i int) int64 {
	return atoi(str(row, i))
}

// fnum reads a cell as a float64, 0 when NULL or unparseable.
func fnum(row []*string, i int) float64 {
	f, e := strconv.ParseFloat(strings.TrimSpace(str(row, i)), 64)
	if e != nil {
		return 0
	}
	return f
}

// atoi parses an integer, 0 when it is not one.
func atoi(s string) int64 {
	n, e := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if e != nil {
		return 0
	}
	return n
}
