// Package jobs runs every query as a background job. Submitting returns
// immediately, the browser follows along over SSE and can cancel with a
// real KILL QUERY, so no click ever waits on the database.
package jobs

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/mpdroog/mydb/bus"
	"github.com/mpdroog/mydb/config"
	"github.com/mpdroog/mydb/connman"
	"github.com/mpdroog/mydb/meta"
	"github.com/mpdroog/mydb/qlog"
	"github.com/mpdroog/mydb/stmt"
)

// State is where a job sits in its lifecycle.
type State string

// The states a job moves through.
const (
	Queued    State = "queued"
	Running   State = "running"
	Done      State = "done"
	Errored   State = "error"
	Cancelled State = "cancelled"
)

// Kind picks which timeout out of the budget a job runs under.
type Kind string

// The kinds of work a job can be.
const (
	KindMeta Kind = "meta"
	KindData Kind = "data"
	KindDDL  Kind = "ddl"
)

// ErrNoSuchJob is returned for an id we do not know (or already GC'd).
var ErrNoSuchJob = errors.New("jobs: no such job")

// ErrNotRunning is returned when cancelling a job that already finished.
var ErrNotRunning = errors.New("jobs: job is not running")

// retention is how long a finished job stays fetchable.
const retention = 5 * time.Minute

// Request is what the browser submits. Either SQL is given as-is, or
// Table is set and mydb builds the statement itself so the identifiers
// are quoted here and LIMIT cannot be talked upwards.
type Request struct {
	Server string `json:"server"`
	DB     string `json:"db"`
	SQL    string `json:"sql"`
	Table  string `json:"table"`
	Where  string `json:"where"`
	Kind   Kind   `json:"kind"`
	Limit  int    `json:"limit"`
	// Confirm carries the answer to the dialog a destructive statement
	// raises. It is false on the first submit by definition: the browser
	// only sets it after the operator read what the statement would do.
	Confirm bool `json:"confirm,omitempty"`
}

// ConfirmError is returned for a statement that changes data without saying
// which rows. It is not a failure — it is the question the GUI turns into a
// dialog, and it carries what that dialog needs to say.
type ConfirmError struct {
	Risk *stmt.Risk
}

// Error makes ConfirmError an error, so it can travel the same path as one.
func (e *ConfirmError) Error() string {
	target := e.Risk.Target
	if target == "" {
		target = "this table"
	}
	return fmt.Sprintf("jobs: %s on %s needs confirming: %s",
		e.Risk.Verb, target, e.Risk.Reason)
}

// Event is one SSE message about a job.
type Event struct {
	Job      string   `json:"job"`
	State    State    `json:"state"`
	Error    string   `json:"error,omitempty"`
	Progress Progress `json:"progress"`
	Elapsed  int64    `json:"elapsed_ms"`
	Rows     int      `json:"rows"`
	Affected int64    `json:"affected"`
}

// Job is one submitted statement and its result.
type Job struct {
	started  time.Time
	finished time.Time
	cancel   context.CancelFunc
	result   *meta.Result
	err      error
	events   *bus.Bus[Event]

	ID     string
	Server string
	DB     string
	Table  string
	Where  string
	Kind   Kind

	sql      string
	pk       []string
	progress Progress
	state    State
	connID   uint64
	affected int64
	limit    int
	mu       sync.Mutex
}

// Manager owns every job and cleans them up once nobody needs them.
type Manager struct {
	jobs map[string]*Job
	cm   *connman.Manager
	stop chan struct{}
	seq  atomic.Uint64
	wg   sync.WaitGroup
	mu   sync.Mutex
}

// New starts a job Manager and its garbage-collector.
func New(cm *connman.Manager) *Manager {
	m := &Manager{
		jobs: make(map[string]*Job),
		cm:   cm,
		stop: make(chan struct{}),
	}
	m.wg.Add(1)
	go m.gc()
	return m
}

// Close cancels everything still running and stops the collector.
func (m *Manager) Close() {
	close(m.stop)

	m.mu.Lock()
	all := make([]*Job, 0, len(m.jobs))
	for _, j := range m.jobs {
		all = append(all, j)
	}
	m.mu.Unlock()

	for _, j := range all {
		j.mu.Lock()
		cancel := j.cancel
		j.mu.Unlock()
		if cancel != nil {
			cancel()
		}
	}
	m.wg.Wait()
}

// timeout picks this job's deadline out of the config budget.
func timeout(k Kind) time.Duration {
	t := config.Timeouts()
	switch k {
	case KindMeta:
		return t.MetaQuery.D()
	case KindDDL:
		return t.DDLQuery.D()
	case KindData:
		return t.DataQuery.D()
	default:
		return t.DataQuery.D()
	}
}

// Submit registers a job and starts it. It never touches the database on
// this goroutine, so the HTTP handler answers instantly even when the
// server is still dialling.
func (m *Manager) Submit(r Request) (*Job, error) {
	if strings.TrimSpace(r.SQL) == "" && r.Table == "" {
		return nil, errors.New("jobs.Submit: empty statement")
	}
	if r.Table != "" && r.DB == "" {
		return nil, errors.New("jobs.Submit: opening a table needs a database")
	}
	if _, e := config.ServerByName(r.Server); e != nil {
		return nil, e
	}
	if r.Kind == "" {
		r.Kind = KindData
	}

	// A table open builds its own statement further down and is a SELECT by
	// construction, so only free-form SQL is worth inspecting.
	if !r.Confirm && r.Table == "" {
		if risk := stmt.Inspect(r.SQL); risk != nil {
			addCount(risk)
			return nil, &ConfirmError{Risk: risk}
		}
	}

	j := &Job{
		ID:      "j" + strconv.FormatUint(m.seq.Add(1), 10),
		Server:  r.Server,
		DB:      r.DB,
		Table:   r.Table,
		Where:   r.Where,
		sql:     r.SQL,
		Kind:    r.Kind,
		limit:   r.Limit,
		state:   Queued,
		started: time.Now(),
		events:  bus.New[Event](16),
	}

	m.mu.Lock()
	m.jobs[j.ID] = j
	m.mu.Unlock()

	m.wg.Add(1)
	go m.run(j)
	return j, nil
}

// addCount fills in the statement the confirm dialog offers to run first,
// so "this deletes every row" can be answered with a number.
//
// The name is quoted here rather than in the browser because mydb has one
// identifier-quoting function and this is it. A name it will not quote —
// too long, or holding a NUL — simply loses the offer.
func addCount(risk *stmt.Risk) {
	if !risk.Countable {
		return
	}
	var (
		q string
		e error
	)
	if db, tbl, ok := strings.Cut(risk.Target, "."); ok {
		q, e = meta.Qualify(db, tbl)
	} else {
		q, e = meta.QuoteIdent(risk.Target)
	}
	if e != nil {
		risk.Countable = false
		return
	}
	risk.CountSQL = "SELECT COUNT(*) AS rows_affected FROM " + q
}

// Get looks a job up by id.
func (m *Manager) Get(id string) (*Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, ok := m.jobs[id]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrNoSuchJob, id)
	}
	return j, nil
}

// run executes one job start to finish.
func (m *Manager) run(j *Job) {
	defer m.wg.Done()

	// A zero budget means no deadline, which is the default for DDL: a
	// table rebuild is slow rather than hung, and cutting it off loses the
	// work and then charges you for the rollback. Such a job ends when it
	// finishes or when you cancel it.
	var (
		ctx    context.Context
		cancel context.CancelFunc
	)
	if d := timeout(j.Kind); d > 0 {
		ctx, cancel = context.WithTimeout(context.Background(), d)
	} else {
		ctx, cancel = context.WithCancel(context.Background())
	}
	defer cancel()

	j.mu.Lock()
	j.cancel = cancel
	j.state = Running
	j.mu.Unlock()
	j.emit()

	e := m.exec(ctx, j)

	// Dropping our end of the connection does not stop the server working:
	// MySQL only notices a dead client when it next tries to write. So a
	// query that outlived its deadline gets the same KILL a manual cancel
	// would issue, or it burns CPU until it finishes on its own.
	if e != nil && ctx.Err() != nil {
		m.killTimedOut(j)
	}

	j.mu.Lock()
	j.finished = time.Now()
	j.cancel = nil
	switch {
	case e == nil:
		j.state = Done
	case errors.Is(ctx.Err(), context.Canceled), isKilled(e):
		j.state = Cancelled
		j.err = e
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		j.state = Errored
		j.err = fmt.Errorf("timed out after %s (raise timeout.%s in config.toml): %w",
			timeout(j.Kind), budgetName(j.Kind), e)
	default:
		j.state = Errored
		j.err = e
	}
	state := j.state
	j.mu.Unlock()

	if e != nil && state == Errored {
		log.Printf("jobs.run %s on %s: %s", j.ID, j.Server, e)
	}
	j.record()
	j.emit()
}

// record appends the finished statement to the query log. It runs on the
// job's own goroutine after the work is done, so nothing waits on a file
// write, and a log that cannot be written never fails a query.
func (j *Job) record() {
	s := j.Snapshot()
	// A table open is the grid doing its job, not something worth keeping:
	// the log is for statements you might want to find again.
	if s.Table != "" && s.State == Done {
		return
	}
	prod := false
	if cfg, e := config.ServerByName(j.Server); e == nil {
		prod = cfg.Production
	}
	qlog.Append(qlog.Entry{
		Server:     s.Server,
		DB:         s.DB,
		Table:      s.Table,
		Kind:       string(j.Kind),
		SQL:        s.SQL,
		State:      string(s.State),
		Error:      s.Error,
		Elapsed:    s.Elapsed,
		Rows:       s.Rows,
		Affected:   s.Affected,
		Production: prod,
	})
}

// budgetName is the config key a job's deadline came from, so the error
// message can point at the knob to turn.
func budgetName(k Kind) string {
	switch k {
	case KindMeta:
		return "meta_query"
	case KindDDL:
		return "ddl_query"
	case KindData:
		return "data_query"
	default:
		return "data_query"
	}
}

// killTimedOut stops a query the server is still running after we gave up
// on it. Best-effort: it gets its own short deadline and only logs.
func (m *Manager) killTimedOut(j *Job) {
	j.mu.Lock()
	connID := j.connID
	j.mu.Unlock()
	if connID == 0 {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), config.Timeouts().MetaQuery.D())
	defer cancel()

	if e := m.kill(ctx, j.Server, connID); e != nil {
		log.Printf("jobs.killTimedOut %s: %s", j.ID, e)
	} else if config.Verbose {
		log.Printf("jobs.killTimedOut %s: killed connection %d after its deadline", j.ID, connID)
	}
}

// isKilled recognises the error MySQL returns for a KILLed query, so a
// cancel does not get reported to the user as a failure.
func isKilled(e error) bool {
	s := e.Error()
	return strings.Contains(s, "Query execution was interrupted") ||
		strings.Contains(s, "server has gone away") && strings.Contains(s, "1317")
}

// exec does the database work: pin a connection, learn its id so it can be
// KILLed, optionally USE a schema, then run the statement.
func (m *Manager) exec(ctx context.Context, j *Job) error {
	db, release, e := m.cm.Acquire(ctx, j.Server)
	if e != nil {
		return e
	}
	defer release()

	// Pinned: the KILL must land on the connection running this query,
	// not on some idle one the pool happens to hand out.
	conn, e := db.Conn(ctx)
	if e != nil {
		return fmt.Errorf("jobs.exec conn: %w", e)
	}
	defer func() {
		if e := conn.Close(); e != nil {
			log.Printf("jobs.exec conn.Close: %s", e)
		}
	}()

	// Re-assert strict mode: this connection may have been used by a
	// console statement that changed it.
	if e := connman.ApplySession(ctx, conn); e != nil {
		return e
	}

	var connID uint64
	if e := conn.QueryRowContext(ctx, "SELECT CONNECTION_ID()").Scan(&connID); e != nil {
		return fmt.Errorf("jobs.exec connection_id: %w", e)
	}
	j.mu.Lock()
	j.connID = connID
	j.mu.Unlock()

	// Now that the connection is known, watch what the server says it is
	// doing. Without this a ten-minute ALTER is indistinguishable from a
	// hang, which is the whole reason a deadline felt necessary.
	pctx, stopWatch := context.WithCancel(ctx)
	defer stopWatch()
	go m.watchProgress(pctx, j)

	if j.DB != "" {
		qdb, e := meta.QuoteIdent(j.DB)
		if e != nil {
			return e
		}
		if _, e := conn.ExecContext(ctx, "USE "+qdb); e != nil { //nolint:gosec // G202: qdb went through meta.QuoteIdent
			return fmt.Errorf("jobs.exec USE %s: %w", j.DB, e)
		}
	}

	if j.Table != "" {
		if e := j.buildTableQuery(ctx, conn); e != nil {
			return e
		}
	}

	query := j.statement()
	if returnsRows(query) {
		res, e := meta.Query(ctx, conn, j.limit, query)
		if e != nil {
			return e
		}
		j.mu.Lock()
		j.result = res
		j.mu.Unlock()
		return nil
	}

	r, e := conn.ExecContext(ctx, query)
	if e != nil {
		return fmt.Errorf("jobs.exec: %w", e)
	}
	n, e := r.RowsAffected()
	if e != nil {
		log.Printf("jobs.exec RowsAffected: %s", e)
		n = 0
	}
	j.mu.Lock()
	j.affected = n
	j.mu.Unlock()
	return nil
}

// statement reads the SQL this job will run.
func (j *Job) statement() string {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.sql
}

// defaultLimit is how many rows a table opens with.
const defaultLimit = 1000

// buildTableQuery composes the SELECT behind a table double-click. The
// identifiers are quoted here and the LIMIT is ours, so the browser cannot
// widen either. The optional WHERE fragment is the user's own SQL, which
// is no more reach than the query console already gives them, and
// MultiStatements is off so it cannot become a second statement.
func (j *Job) buildTableQuery(ctx context.Context, q meta.Querier) error {
	if e := meta.Exists(ctx, q, j.DB, j.Table); e != nil {
		return e
	}
	qname, e := meta.Qualify(j.DB, j.Table)
	if e != nil {
		return e
	}
	pk, e := meta.PrimaryKey(ctx, q, j.DB, j.Table)
	if e != nil {
		return e
	}

	limit := j.limit
	if limit <= 0 {
		limit = defaultLimit
	}

	f := parseFilter(j.Where)

	var b strings.Builder
	b.WriteString("SELECT * FROM ")
	b.WriteString(qname)
	if f.Tail != "" {
		b.WriteString("\n ")
		// A fragment that is only "ORDER BY x" has no condition to introduce.
		if f.NeedsWhere {
			b.WriteString("WHERE ")
		}
		b.WriteString(f.Tail)
	}

	// The filter box may bring its own ORDER BY or LIMIT; appending ours
	// on top would be a syntax error. A user LIMIT also has to end the
	// statement, since ORDER BY cannot follow it.
	if !f.HasOrder && !f.HasLimit && len(pk) > 0 {
		// No primary key means no stable "last N", so we take the server's
		// own order rather than inventing one.
		cols := make([]string, 0, len(pk))
		for _, c := range pk {
			qc, e := meta.QuoteIdent(c)
			if e != nil {
				return e
			}
			cols = append(cols, qc+" DESC")
		}
		b.WriteString("\n ORDER BY ")
		b.WriteString(strings.Join(cols, ", "))
	}
	if !f.HasLimit {
		// One more than we mean to show: the scanner stops at limit and
		// flags the result truncated, which is the only way to tell
		// "exactly 1000 rows" apart from "the first 1000 of many".
		b.WriteString("\n LIMIT ")
		b.WriteString(strconv.Itoa(limit + 1))
	}

	j.mu.Lock()
	j.sql = b.String()
	j.pk = pk
	j.limit = limit
	j.mu.Unlock()
	return nil
}

// rowStatements are the leading keywords that produce a result-set.
var rowStatements = map[string]bool{
	"SELECT": true, "SHOW": true, "DESCRIBE": true, "DESC": true,
	"EXPLAIN": true, "WITH": true, "TABLE": true, "VALUES": true,
	"ANALYZE": true, "CHECK": true, "CHECKSUM": true, "CALL": true,
}

// returnsRows guesses whether a statement yields rows, so we pick between
// QueryContext and ExecContext.
func returnsRows(q string) bool {
	q = strings.TrimLeft(q, " \t\r\n(")
	// Skip a leading line-comment or block-comment.
	for {
		switch {
		case strings.HasPrefix(q, "--"), strings.HasPrefix(q, "#"):
			if i := strings.IndexByte(q, '\n'); i >= 0 {
				q = strings.TrimLeft(q[i+1:], " \t\r\n(")
				continue
			}
			return false
		case strings.HasPrefix(q, "/*"):
			if i := strings.Index(q, "*/"); i >= 0 {
				q = strings.TrimLeft(q[i+2:], " \t\r\n(")
				continue
			}
			return false
		}
		break
	}
	i := strings.IndexAny(q, " \t\r\n(;")
	if i < 0 {
		i = len(q)
	}
	return rowStatements[strings.ToUpper(q[:i])]
}

// Cancel KILLs a running job's query on the server and trips its context.
func (m *Manager) Cancel(ctx context.Context, id string) error {
	j, e := m.Get(id)
	if e != nil {
		return e
	}

	j.mu.Lock()
	state, connID, cancel := j.state, j.connID, j.cancel
	j.mu.Unlock()

	if state != Running && state != Queued {
		return fmt.Errorf("%w: %s is %s", ErrNotRunning, id, state)
	}

	// KILL first: it stops the work on the server. Tripping the context
	// alone would only abandon our side of it.
	if connID != 0 {
		if e := m.kill(ctx, j.Server, connID); e != nil {
			log.Printf("jobs.Cancel kill %s: %s", id, e)
		}
	}
	if cancel != nil {
		cancel()
	}
	return nil
}

// kill issues KILL QUERY on a second connection to the same server.
func (m *Manager) kill(ctx context.Context, server string, connID uint64) error {
	kctx, cancel := context.WithTimeout(ctx, config.Timeouts().MetaQuery.D())
	defer cancel()

	db, release, e := m.cm.Acquire(kctx, server)
	if e != nil {
		return e
	}
	defer release()

	// connID is a uint64 we read out of the server with SELECT
	// CONNECTION_ID(), so it cannot carry SQL. MySQL takes no placeholder
	// for a KILL argument, which is why this is concatenated at all.
	stmt := "KILL QUERY " + strconv.FormatUint(connID, 10) //nolint:gosec // G202: see above, the only variable part is a uint64
	if _, e := db.ExecContext(kctx, stmt); e != nil {
		return fmt.Errorf("jobs.kill: %w", e)
	}
	return nil
}

// Snapshot is the current state of a job, safe to hand to a handler.
type Snapshot struct {
	Result     *meta.Result `json:"result,omitempty"`
	ID         string       `json:"job"`
	Server     string       `json:"server"`
	DB         string       `json:"db"`
	Table      string       `json:"table,omitempty"`
	SQL        string       `json:"sql"`
	State      State        `json:"state"`
	Error      string       `json:"error,omitempty"`
	Progress   Progress     `json:"progress"`
	PrimaryKey []string     `json:"primary_key,omitempty"`
	Elapsed    int64        `json:"elapsed_ms"`
	Rows       int          `json:"rows"`
	Affected   int64        `json:"affected"`
}

// Snapshot reads a job's current state without racing the runner.
func (j *Job) Snapshot() Snapshot {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.snapshotLocked()
}

// snapshotLocked builds a Snapshot, caller holds j.mu.
func (j *Job) snapshotLocked() Snapshot {
	s := Snapshot{
		ID:         j.ID,
		Server:     j.Server,
		DB:         j.DB,
		Table:      j.Table,
		SQL:        j.sql,
		State:      j.state,
		Result:     j.result,
		Affected:   j.affected,
		PrimaryKey: j.pk,
		Progress:   j.progress,
	}
	if j.err != nil {
		s.Error = j.err.Error()
	}
	if j.result != nil {
		s.Rows = len(j.result.Rows)
	}
	end := j.finished
	if end.IsZero() {
		end = time.Now()
	}
	s.Elapsed = end.Sub(j.started).Milliseconds()
	return s
}

// Events subscribes to this job's state changes.
func (j *Job) Events() (<-chan Event, func()) {
	return j.events.Subscribe()
}

// Finished reports whether the job will produce no further events.
func (j *Job) Finished() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.state == Done || j.state == Errored || j.state == Cancelled
}

// Event builds the current state as an SSE event.
func (j *Job) Event() Event {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.eventLocked()
}

// eventLocked builds an Event, caller holds j.mu.
func (j *Job) eventLocked() Event {
	s := j.snapshotLocked()
	return Event{
		Job:      s.ID,
		State:    s.State,
		Error:    s.Error,
		Elapsed:  s.Elapsed,
		Rows:     s.Rows,
		Affected: s.Affected,
		Progress: s.Progress,
	}
}

// setProgress records what the server last said about this statement.
func (j *Job) setProgress(p Progress) {
	j.mu.Lock()
	j.progress = p
	j.mu.Unlock()
}

// emit publishes the job's current state to its subscribers.
func (j *Job) emit() {
	j.mu.Lock()
	ev := j.eventLocked()
	j.mu.Unlock()
	j.events.Publish(ev)
}

// gc drops finished jobs once they are past retention, so a long session
// does not hold every result-set it ever fetched.
func (m *Manager) gc() {
	defer m.wg.Done()
	t := time.NewTicker(time.Minute)
	defer t.Stop()

	for {
		select {
		case <-m.stop:
			return
		case <-t.C:
			m.gcOnce()
		}
	}
}

// gcOnce is one sweep of the job collector.
func (m *Manager) gcOnce() {
	cutoff := time.Now().Add(-retention)

	m.mu.Lock()
	defer m.mu.Unlock()
	for id, j := range m.jobs {
		j.mu.Lock()
		drop := !j.finished.IsZero() && j.finished.Before(cutoff)
		j.mu.Unlock()
		if drop {
			j.events.Close()
			delete(m.jobs, id)
		}
	}
}

// Forget drops a finished job's buffered result, used when the browser
// closes its tab.
//
// A job that is still running is kept: dropping it would leave a statement
// working on the server with nothing able to report on it or cancel it,
// which is exactly the wrong thing to do to a ten-minute ALTER whose tab
// was closed by accident.
func (m *Manager) Forget(id string) {
	m.mu.Lock()
	j, ok := m.jobs[id]
	if ok && j.Finished() {
		delete(m.jobs, id)
	} else {
		ok = false
	}
	m.mu.Unlock()
	if ok {
		j.events.Close()
	}
}
