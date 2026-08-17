package dash

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/mpdroog/mydb/meta"
)

// maxProcs caps the process list. A server with ten thousand sleeping
// connections must not turn the dashboard into a download.
const maxProcs = 300

// maxInfo is how much of a running statement is shown per row.
const maxInfo = 4000

// richProcs is MariaDB's process list: it reports per-connection memory and
// a progress percentage, which is exactly what a dashboard wants and which
// MySQL does not have.
const richProcs = `SELECT ID, USER, HOST, IFNULL(DB,''), COMMAND, TIME,
       IFNULL(STATE,''), LEFT(IFNULL(INFO,''), 4000),
       IFNULL(MEMORY_USED,0), IFNULL(PROGRESS,0)
  FROM information_schema.PROCESSLIST ORDER BY TIME DESC`

// plainProcs is the portable form.
const plainProcs = `SELECT ID, USER, HOST, IFNULL(DB,''), COMMAND, TIME,
       IFNULL(STATE,''), LEFT(IFNULL(INFO,''), 4000)
  FROM information_schema.PROCESSLIST ORDER BY TIME DESC`

// loadProcs reads the process list, preferring MariaDB's richer columns.
func (c *Collector) loadProcs(ctx context.Context, q meta.Querier) ([]Proc, error) {
	if c.procRich != sourceGone {
		res, e := meta.Query(ctx, q, maxProcs, richProcs)
		if e == nil {
			c.procRich = sourceOK
			return readProcs(res, true), nil
		}
		c.procRich = sourceGone
	}

	res, e := meta.Query(ctx, q, maxProcs, plainProcs)
	if e != nil {
		return nil, fmt.Errorf("dash.loadProcs: %w", e)
	}
	return readProcs(res, false), nil
}

// readProcs turns the result-set into rows the browser can render.
func readProcs(res *meta.Result, rich bool) []Proc {
	out := make([]Proc, 0, len(res.Rows))
	for _, r := range res.Rows {
		p := Proc{
			ID:      num(r, 0),
			User:    str(r, 1),
			Host:    str(r, 2),
			DB:      str(r, 3),
			Command: str(r, 4),
			Time:    num(r, 5),
			State:   str(r, 6),
			Info:    str(r, 7),
		}
		if rich {
			p.Memory = num(r, 8)
			p.Progress = fnum(r, 9)
		}
		if len(p.Info) > maxInfo {
			p.Info = p.Info[:maxInfo] + "…"
		}
		// The dashboard's own poll is always in its own results. Saying so
		// stops it reading as a query that has been running forever.
		p.Self = strings.Contains(p.Info, "information_schema.PROCESSLIST")
		out = append(out, p)
	}
	return out
}

// trxQuery reads the open InnoDB transactions. A transaction sitting in
// "LOCK WAIT", or one that has been open for minutes holding row locks, is
// the usual reason everything else stopped.
const trxQuery = `SELECT trx_id, trx_state, IFNULL(trx_mysql_thread_id,0),
       IFNULL(trx_started,''),
       IFNULL(TIMESTAMPDIFF(SECOND, trx_wait_started, NOW()),0),
       LEFT(IFNULL(trx_query,''), 2000),
       IFNULL(trx_rows_locked,0), IFNULL(trx_rows_modified,0),
       IFNULL(trx_tables_locked,0)
  FROM information_schema.INNODB_TRX
 ORDER BY trx_started`

// loadTrx reads the open transactions, noting it when they are not visible.
func (c *Collector) loadTrx(ctx context.Context, q meta.Querier, s *Snapshot) {
	res, e := meta.Query(ctx, q, 100, trxQuery)
	if e != nil {
		s.note("open transactions unavailable: %s", short(e.Error()))
		return
	}
	for _, r := range res.Rows {
		s.Trx = append(s.Trx, Trx{
			ID:           str(r, 0),
			State:        str(r, 1),
			Thread:       num(r, 2),
			Started:      str(r, 3),
			WaitSecs:     num(r, 4),
			Query:        str(r, 5),
			RowsLocked:   num(r, 6),
			RowsModified: num(r, 7),
			TablesLocked: num(r, 8),
		})
	}
}

// lockWaitsPS is MySQL 8's lock-wait view.
const lockWaitsPS = `SELECT r.trx_mysql_thread_id, LEFT(IFNULL(r.trx_query,''), 2000),
       b.trx_mysql_thread_id, LEFT(IFNULL(b.trx_query,''), 2000),
       IFNULL(TIMESTAMPDIFF(SECOND, r.trx_wait_started, NOW()),0)
  FROM performance_schema.data_lock_waits w
  JOIN information_schema.INNODB_TRX b ON b.trx_id = w.BLOCKING_ENGINE_TRANSACTION_ID
  JOIN information_schema.INNODB_TRX r ON r.trx_id = w.REQUESTING_ENGINE_TRANSACTION_ID`

// lockWaitsIS is the older InnoDB table, which MySQL 5.7 and MariaDB before
// 10.6 have and which MariaDB 10.6 removed.
const lockWaitsIS = `SELECT r.trx_mysql_thread_id, LEFT(IFNULL(r.trx_query,''), 2000),
       b.trx_mysql_thread_id, LEFT(IFNULL(b.trx_query,''), 2000),
       IFNULL(TIMESTAMPDIFF(SECOND, r.trx_wait_started, NOW()),0)
  FROM information_schema.INNODB_LOCK_WAITS w
  JOIN information_schema.INNODB_TRX b ON b.trx_id = w.blocking_trx_id
  JOIN information_schema.INNODB_TRX r ON r.trx_id = w.requesting_trx_id`

// loadWaits reads who is holding up whom on row locks.
//
// Three servers, three answers: MySQL 8 has performance_schema, older MySQL
// and MariaDB up to 10.5 have the InnoDB tables, and MariaDB 10.6 dropped
// both. On the last one the waiting side is still visible in INNODB_TRX, so
// the panel says who is waiting and admits it cannot name the blocker.
func (c *Collector) loadWaits(ctx context.Context, q meta.Querier, s *Snapshot) {
	if c.locks != sourceGone {
		for _, query := range []string{lockWaitsPS, lockWaitsIS} {
			res, e := meta.Query(ctx, q, 100, query)
			if e != nil {
				continue
			}
			c.locks = sourceOK
			for _, r := range res.Rows {
				s.Waits = append(s.Waits, Wait{
					Kind:           "row",
					WaitingThread:  num(r, 0),
					WaitingQuery:   str(r, 1),
					BlockingThread: num(r, 2),
					BlockingQuery:  str(r, 3),
					Age:            num(r, 4),
				})
			}
			return
		}
		c.locks = sourceGone
	}

	// Fall back to what the transaction list already told us.
	waiting := false
	for _, t := range s.Trx {
		if !strings.EqualFold(t.State, "LOCK WAIT") {
			continue
		}
		waiting = true
		s.Waits = append(s.Waits, Wait{
			Kind:          "row",
			WaitingThread: t.Thread,
			WaitingQuery:  t.Query,
			Age:           t.WaitSecs,
		})
	}
	if waiting {
		s.note("this server has no lock-wait table, so the blocking connection " +
			"cannot be named — the InnoDB monitor output below has the detail")
	}
}

// mdlQuery pairs a pending metadata lock with the connection already
// holding one on the same table.
//
// This is the query behind "my ALTER has been stuck for ten minutes": the
// statement is not slow, it is queued behind an open transaction that
// touched the table and never committed, and every read and write of that
// table is now queued behind the ALTER.
const mdlQuery = `SELECT CONCAT(IFNULL(w.OBJECT_SCHEMA,''), '.', IFNULL(w.OBJECT_NAME,'')),
       tw.PROCESSLIST_ID, LEFT(IFNULL(tw.PROCESSLIST_INFO,''), 2000),
       th.PROCESSLIST_ID, LEFT(IFNULL(th.PROCESSLIST_INFO,''), 2000),
       IFNULL(tw.PROCESSLIST_TIME,0)
  FROM performance_schema.metadata_locks w
  JOIN performance_schema.metadata_locks h
    ON h.OBJECT_TYPE = w.OBJECT_TYPE
   AND h.OBJECT_SCHEMA <=> w.OBJECT_SCHEMA
   AND h.OBJECT_NAME <=> w.OBJECT_NAME
   AND h.LOCK_STATUS = 'GRANTED'
   AND h.OWNER_THREAD_ID <> w.OWNER_THREAD_ID
  JOIN performance_schema.threads tw ON tw.THREAD_ID = w.OWNER_THREAD_ID
  JOIN performance_schema.threads th ON th.THREAD_ID = h.OWNER_THREAD_ID
 WHERE w.LOCK_STATUS = 'PENDING'`

// loadMDL reads the metadata locks a DDL statement is queued behind.
func (c *Collector) loadMDL(ctx context.Context, q meta.Querier, s *Snapshot) {
	if c.mdl == sourceGone {
		return
	}
	res, e := meta.Query(ctx, q, 100, mdlQuery)
	if e != nil {
		c.mdl = sourceGone
		s.note("metadata locks unavailable, so a blocked ALTER cannot name what "+
			"is blocking it: %s", short(e.Error()))
		return
	}
	c.mdl = sourceOK
	for _, r := range res.Rows {
		s.Waits = append(s.Waits, Wait{
			Kind:           "metadata",
			Object:         str(r, 0),
			WaitingThread:  num(r, 1),
			WaitingQuery:   str(r, 2),
			BlockingThread: num(r, 3),
			BlockingQuery:  str(r, 4),
			Age:            num(r, 5),
		})
	}
}

// digestQuery reads the statement digests. The timer is in picoseconds.
const digestQuery = `SELECT LEFT(DIGEST_TEXT, 2000), COUNT_STAR, SUM_TIMER_WAIT,
       SUM_ROWS_EXAMINED, SUM_ROWS_SENT, SUM_CREATED_TMP_DISK_TABLES, SUM_NO_INDEX_USED
  FROM performance_schema.events_statements_summary_by_digest
 WHERE DIGEST_TEXT IS NOT NULL
 ORDER BY SUM_TIMER_WAIT DESC LIMIT 40`

// topDigests is how many statement shapes are shown.
const topDigests = 12

// loadDigests reads the most expensive statement shapes.
//
// Ordering by total time alone answers "what has this server spent its life
// doing", which is rarely the question. The delta against the previous tick
// answers "what is it doing now", so the list is sorted by that when there
// is one.
func (c *Collector) loadDigests(ctx context.Context, q meta.Querier, s *Snapshot) {
	if c.digests == sourceGone {
		return
	}
	res, e := meta.Query(ctx, q, 40, digestQuery)
	if e != nil {
		c.digests = sourceGone
		s.note("top statements unavailable, performance_schema is off or "+
			"unreadable: %s", short(e.Error()))
		return
	}
	c.digests = sourceOK

	now := make(map[string]digestSample, len(res.Rows))
	out := make([]Digest, 0, len(res.Rows))
	for _, r := range res.Rows {
		text := str(r, 0)
		count := num(r, 1)
		// Picoseconds to milliseconds.
		total := fnum(r, 2) / 1e9
		d := Digest{
			Text:         text,
			Count:        count,
			Total:        total,
			RowsExamined: num(r, 3),
			RowsSent:     num(r, 4),
			TmpDisk:      num(r, 5),
			NoIndex:      num(r, 6),
		}
		if count > 0 {
			d.Avg = total / float64(count)
		}
		if prev, ok := c.prevDigest[text]; ok && count >= prev.count {
			d.DeltaCount = count - prev.count
			d.DeltaMs = total - prev.ms
		}
		now[text] = digestSample{count: count, ms: total}
		out = append(out, d)
	}
	c.prevDigest = now

	sort.SliceStable(out, func(i, j int) bool {
		if out[i].DeltaMs != out[j].DeltaMs {
			return out[i].DeltaMs > out[j].DeltaMs
		}
		return out[i].Total > out[j].Total
	})
	if len(out) > topDigests {
		out = out[:topDigests]
	}
	s.Top = out
}

// memQuery reads the server's own memory accounting. MySQL 5.7 and up keep
// it; MariaDB's performance_schema is older and does not.
const memQuery = `SELECT EVENT_NAME, CURRENT_NUMBER_OF_BYTES_USED
  FROM performance_schema.memory_summary_global_by_event_name
 WHERE CURRENT_NUMBER_OF_BYTES_USED > 0
 ORDER BY CURRENT_NUMBER_OF_BYTES_USED DESC LIMIT 10`

// loadMemEvents reads where the server put its memory, where it knows.
func (c *Collector) loadMemEvents(ctx context.Context, q meta.Querier, s *Snapshot) {
	if c.memEvents == sourceGone {
		return
	}
	res, e := meta.Query(ctx, q, 10, memQuery)
	if e != nil {
		c.memEvents = sourceGone
		s.note("per-subsystem memory unavailable on this server: %s", short(e.Error()))
		return
	}
	c.memEvents = sourceOK
	for _, r := range res.Rows {
		s.Memory.Events = append(s.Memory.Events, MemEvent{
			Name:  strings.TrimPrefix(str(r, 0), "memory/"),
			Bytes: num(r, 1),
		})
	}
}
