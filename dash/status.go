package dash

import (
	"context"
	"fmt"
	"time"

	"github.com/mpdroog/mydb/meta"
)

// loadKV reads a SHOW ... STATUS or SHOW ... VARIABLES result into a map.
func loadKV(ctx context.Context, q meta.Querier, query string) (map[string]int64, error) {
	res, e := meta.Query(ctx, q, 0, query)
	if e != nil {
		return nil, e
	}
	out := make(map[string]int64, len(res.Rows))
	for _, r := range res.Rows {
		// Only the numeric ones are counters; the rest is text nobody here
		// has a use for.
		if v := str(r, 1); v != "" {
			if n := atoi(v); n != 0 || v == "0" {
				out[str(r, 0)] = n
			}
		}
	}
	return out, nil
}

// loadVars reads the server variables the dashboard needs. They barely
// change, so this runs on the slow tick rather than every one.
func (c *Collector) loadVars(ctx context.Context, q meta.Querier) error {
	res, e := meta.Query(ctx, q, 0, "SHOW GLOBAL VARIABLES")
	if e != nil {
		return fmt.Errorf("dash.loadVars: %w", e)
	}
	vars := make(map[string]string, len(res.Rows))
	for _, r := range res.Rows {
		vars[str(r, 0)] = str(r, 1)
	}
	c.vars, c.varsAt = vars, time.Now()
	return nil
}

// readMetrics folds InnoDB's own metric table into the status map, which is
// where the deadlock count lives on MySQL. MariaDB publishes it as a plain
// status variable, so this is the one that fills the gap.
func (c *Collector) readMetrics(ctx context.Context, q meta.Querier, status map[string]int64, s *Snapshot) {
	if c.metrics == sourceGone || status["Innodb_deadlocks"] != 0 {
		return
	}
	const query = `SELECT NAME, COUNT FROM information_schema.INNODB_METRICS
	 WHERE NAME IN ('lock_deadlocks','lock_timeouts','lock_row_lock_waits')`

	res, e := meta.Query(ctx, q, 8, query)
	if e != nil {
		c.metrics = sourceGone
		s.note("deadlock count unavailable: %s", short(e.Error()))
		return
	}
	c.metrics = sourceOK
	for _, r := range res.Rows {
		switch str(r, 0) {
		case "lock_deadlocks":
			status["Innodb_deadlocks"] = num(r, 1)
		case "lock_timeouts":
			status["Innodb_lock_timeouts"] = num(r, 1)
		}
	}
}

// counter names the status variables the dashboard turns into rates, in the
// order they are shown.
type counter struct {
	label string
	keys  []string
	unit  string
	warn  bool
}

var counters = []counter{
	{label: "queries", keys: []string{"Questions"}},
	{label: "selects", keys: []string{"Com_select"}},
	{label: "writes", keys: []string{"Com_insert", "Com_update", "Com_delete", "Com_replace"}},
	{label: "commits", keys: []string{"Com_commit"}},
	{label: "rollbacks", keys: []string{"Com_rollback"}, warn: true},
	{label: "slow queries", keys: []string{"Slow_queries"}, warn: true},
	{label: "full scans", keys: []string{"Select_scan"}, warn: true},
	{label: "full joins", keys: []string{"Select_full_join"}, warn: true},
	{label: "tmp tables on disk", keys: []string{"Created_tmp_disk_tables"}, warn: true},
	{label: "sort merge passes", keys: []string{"Sort_merge_passes"}, warn: true},
	{label: "row lock waits", keys: []string{"Innodb_row_lock_waits"}, warn: true},
	{label: "lock timeouts", keys: []string{"Innodb_lock_timeouts"}, warn: true},
	{label: "table lock waits", keys: []string{"Table_locks_waited"}, warn: true},
	{label: "deadlocks", keys: []string{"Innodb_deadlocks"}, warn: true},
	{label: "aborted clients", keys: []string{"Aborted_clients"}, warn: true},
	{label: "aborted connects", keys: []string{"Aborted_connects"}, warn: true},
	{label: "bytes sent", keys: []string{"Bytes_sent"}, unit: "B"},
	{label: "bytes received", keys: []string{"Bytes_received"}, unit: "B"},
}

// rates turns the raw counters into per-second numbers against the previous
// tick. The first tick has nothing to compare with, so everything reads
// zero per second and only the totals are real.
func (c *Collector) rates(status map[string]int64, at time.Time) []Rate {
	secs := 0.0
	if !c.prevAt.IsZero() {
		secs = at.Sub(c.prevAt).Seconds()
	}

	out := make([]Rate, 0, len(counters))
	for _, ct := range counters {
		var total, prev int64
		seen := false
		for _, k := range ct.keys {
			if v, ok := status[k]; ok {
				total += v
				seen = true
			}
			prev += c.prev[k]
		}
		// A counter this server does not publish is left out rather than
		// drawn as a permanent zero.
		if !seen {
			continue
		}
		r := Rate{Name: ct.label, Total: total, Unit: ct.unit, Warn: ct.warn}
		// A counter that went backwards means the server restarted under
		// us; report no rate rather than a negative one.
		if secs > 0 && total >= prev && len(c.prev) > 0 {
			r.PerSec = float64(total-prev) / secs
		}
		out = append(out, r)
	}

	c.prev, c.prevAt = status, at
	return out
}

// memory reads what the server says about the buffer pool.
func (c *Collector) memory(status map[string]int64) Memory {
	m := Memory{
		BufferPool:      atoi(c.vars["innodb_buffer_pool_size"]),
		BufferPoolData:  status["Innodb_buffer_pool_bytes_data"],
		BufferPoolDirty: status["Innodb_buffer_pool_bytes_dirty"],
		HitPct:          -1,
	}
	// The hit rate is the one number here that says whether the pool is big
	// enough: a read that misses it is a read that went to disk.
	reqs := status["Innodb_buffer_pool_read_requests"]
	reads := status["Innodb_buffer_pool_reads"]
	if reqs > 0 {
		m.HitPct = 100 * float64(reqs-reads) / float64(reqs)
	}
	return m
}

// short trims a driver error down to something that fits in a note.
func short(s string) string {
	if len(s) > 160 {
		return s[:160] + "…"
	}
	return s
}
