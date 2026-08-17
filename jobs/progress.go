package jobs

import (
	"context"
	"log"
	"strconv"
	"sync"
	"time"

	"github.com/mpdroog/mydb/config"
	"github.com/mpdroog/mydb/meta"
)

// progressPoll is how often a running statement is asked what it is doing.
// Two seconds is invisible next to a table rebuild and keeps the elapsed
// counter in the footer moving on its own.
const progressPoll = 2 * time.Second

// Progress is what the server says a running statement is up to.
type Progress struct {
	// State is MySQL's own description, e.g. "copy to tmp table" or
	// "Sending data".
	State string `json:"state,omitempty"`
	// Stage and MaxStage are MariaDB's stage counters, 0 when unknown.
	Stage    int `json:"stage,omitempty"`
	MaxStage int `json:"max_stage,omitempty"`
	// Percent is progress within the current stage, -1 when unknown.
	Percent float64 `json:"percent"`
}

// richProgress reads MariaDB's progress columns. MySQL has no such columns
// in information_schema, so this fails there and the plain query is used.
const richProgress = `SELECT IFNULL(STATE,''), IFNULL(STAGE,0), IFNULL(MAX_STAGE,0), IFNULL(PROGRESS,0)
  FROM information_schema.PROCESSLIST WHERE ID = ?`

// plainProgress is the fallback that works everywhere.
const plainProgress = `SELECT IFNULL(STATE,'') FROM information_schema.PROCESSLIST WHERE ID = ?`

// noRichProgress remembers the servers whose PROCESSLIST has no progress
// columns, so the unsupported query is tried once rather than every tick.
var noRichProgress sync.Map // server name -> bool

// watchProgress polls the server while a statement runs and republishes the
// job so the browser can show a stage and a percentage instead of a spinner
// that might mean anything.
func (m *Manager) watchProgress(ctx context.Context, j *Job) {
	t := time.NewTicker(progressPoll)
	defer t.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p, ok := m.progress(ctx, j)
			if ok {
				j.setProgress(p)
			}
			// Emit either way: the elapsed time is worth refreshing even
			// when the server has nothing to add.
			j.emit()
		}
	}
}

// progress asks the server what the job's own connection is doing.
func (m *Manager) progress(ctx context.Context, j *Job) (Progress, bool) {
	j.mu.Lock()
	connID := j.connID
	j.mu.Unlock()
	if connID == 0 {
		return Progress{}, false
	}

	// Its own short deadline: this is a status read, and it must never be
	// the reason a long statement is disturbed.
	qctx, cancel := context.WithTimeout(ctx, config.Timeouts().MetaQuery.D())
	defer cancel()

	db, release, e := m.cm.Acquire(qctx, j.Server)
	if e != nil {
		return Progress{}, false
	}
	defer release()

	_, plain := noRichProgress.Load(j.Server)
	if !plain {
		res, e := meta.Query(qctx, db, 1, richProgress, connID)
		if e == nil {
			return readRich(res), len(res.Rows) > 0
		}
		// Almost certainly MySQL rather than MariaDB: no STAGE/PROGRESS.
		noRichProgress.Store(j.Server, true)
		if config.Verbose {
			log.Printf("jobs.progress %s has no PROCESSLIST progress columns, falling back", j.Server)
		}
	}

	res, e := meta.Query(qctx, db, 1, plainProgress, connID)
	if e != nil || len(res.Rows) == 0 {
		return Progress{}, false
	}
	return Progress{State: cellStr(res.Rows[0], 0), Percent: -1}, true
}

// readRich turns MariaDB's four columns into a Progress.
func readRich(res *meta.Result) Progress {
	if len(res.Rows) == 0 {
		return Progress{Percent: -1}
	}
	r := res.Rows[0]
	p := Progress{State: cellStr(r, 0), Percent: -1}
	p.Stage = cellInt(r, 1)
	p.MaxStage = cellInt(r, 2)
	if v, e := strconv.ParseFloat(cellStr(r, 3), 64); e == nil && v > 0 {
		p.Percent = v
	}
	return p
}

// cellStr reads a column out of a row, "" for NULL or out of range.
func cellStr(row []*string, i int) string {
	if i >= len(row) || row[i] == nil {
		return ""
	}
	return *row[i]
}

// cellInt reads an integer column, 0 when absent or unparseable.
func cellInt(row []*string, i int) int {
	n, e := strconv.Atoi(cellStr(row, i))
	if e != nil {
		return 0
	}
	return n
}
