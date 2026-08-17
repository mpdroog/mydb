// Package qlog keeps a log of every statement mydb ran, so the answer to
// "what did I run against that server last Tuesday" is not "whatever the
// browser still has in localStorage".
//
// One JSON object per line, appended to a file next to config.toml. That
// format is deliberate: it survives a crash mid-write (the worst case is
// one unparseable line), it needs no schema migration, and grep, jq and
// the GUI can all read it.
//
// The file holds the literal values of every statement — the same secrets
// the database holds — so it is created 0600 and never widened.
package qlog

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"sync"
	"time"
)

// MaxSQL is how much of one statement is kept. A 4MiB INSERT is not worth
// storing in full to be able to find it again later.
const MaxSQL = 8 << 10

// tailBytes is how far back a search reads. Beyond this the file is still
// there for grep, but the GUI stops at a bounded amount of work.
const tailBytes = 8 << 20

// Entry is one statement as it was run.
type Entry struct {
	At       int64  `json:"at"`
	Server   string `json:"server"`
	DB       string `json:"db,omitempty"`
	Table    string `json:"table,omitempty"`
	Kind     string `json:"kind"`
	SQL      string `json:"sql"`
	State    string `json:"state"`
	Error    string `json:"error,omitempty"`
	Elapsed  int64  `json:"ms"`
	Rows     int    `json:"rows,omitempty"`
	Affected int64  `json:"affected,omitempty"`
	// Production records what the server was marked as at the time, so a
	// search can pull up "everything I ran against production" even after
	// the flag has been changed.
	Production bool `json:"production,omitempty"`
}

// w is the one open log file. Package-level like config, because there is
// exactly one of these per process and threading it through every job would
// buy nothing.
var w struct {
	f    *os.File
	path string
	max  int64
	keep int
	size int64
	mu   sync.Mutex
}

// Open starts appending to path. An empty path switches the log off, which
// is what `queries = ""` in the config-file means.
func Open(path string, maxSizeMB, keep int) error {
	w.mu.Lock()
	defer w.mu.Unlock()

	if e := closeLocked(); e != nil {
		return e
	}
	w.path, w.size = path, 0
	w.max = int64(maxSizeMB) << 20
	w.keep = keep
	if path == "" {
		return nil
	}

	f, e := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600) //nolint:gosec // G304: the path comes from our own config-file
	if e != nil {
		return fmt.Errorf("qlog.Open: %w", e)
	}
	st, e := f.Stat()
	if e != nil {
		if ce := f.Close(); ce != nil {
			log.Printf("qlog.Open close after stat-fail: %s", ce)
		}
		return fmt.Errorf("qlog.Open stat: %w", e)
	}

	w.f, w.size = f, st.Size()
	return nil
}

// Close flushes and closes the log file.
func Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return closeLocked()
}

// closeLocked closes the current file, caller holds w.mu.
func closeLocked() error {
	if w.f == nil {
		return nil
	}
	f := w.f
	w.f = nil
	if e := f.Close(); e != nil {
		return fmt.Errorf("qlog.Close: %w", e)
	}
	return nil
}

// Path returns the file being written, "" when the log is off.
func Path() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.f == nil {
		return ""
	}
	return w.path
}

// Append records one statement. It never returns an error: a query that
// worked must not be reported as failed because the log file did not, so a
// write failure is logged and the entry dropped.
func Append(e Entry) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.f == nil {
		return
	}

	if e.At == 0 {
		e.At = time.Now().UnixMilli()
	}
	if len(e.SQL) > MaxSQL {
		e.SQL = e.SQL[:MaxSQL] + "…"
	}
	if len(e.Error) > MaxSQL {
		e.Error = e.Error[:MaxSQL] + "…"
	}

	b, err := json.Marshal(e)
	if err != nil {
		log.Printf("qlog.Append marshal: %s", err)
		return
	}
	b = append(b, '\n')

	if w.max > 0 && w.size+int64(len(b)) > w.max {
		if err := rotateLocked(); err != nil {
			log.Printf("qlog.Append rotate: %s", err)
		}
	}

	n, err := w.f.Write(b)
	w.size += int64(n)
	if err != nil {
		log.Printf("qlog.Append write: %s", err)
	}
}

// rotateLocked renames the log out of the way and starts a fresh one.
// Caller holds w.mu.
func rotateLocked() error {
	if e := closeLocked(); e != nil {
		return e
	}
	// Shift the generations down: .2 <- .1 <- current.
	for i := w.keep; i >= 1; i-- {
		from := w.path
		if i > 1 {
			from = fmt.Sprintf("%s.%d", w.path, i-1)
		}
		to := fmt.Sprintf("%s.%d", w.path, i)
		if e := os.Rename(from, to); e != nil && !errors.Is(e, os.ErrNotExist) {
			log.Printf("qlog.rotate %s -> %s: %s", from, to, e)
		}
	}
	if w.keep == 0 {
		if e := os.Remove(w.path); e != nil && !errors.Is(e, os.ErrNotExist) {
			log.Printf("qlog.rotate remove: %s", e)
		}
	}

	f, e := os.OpenFile(w.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600) //nolint:gosec // G304: the path comes from our own config-file
	if e != nil {
		return fmt.Errorf("qlog.rotate reopen: %w", e)
	}
	w.f, w.size = f, 0
	return nil
}

// Query is what the GUI's search box asks for. Every field is optional.
type Query struct {
	// Text matches anywhere in the statement, case-insensitively.
	Text string
	// Server, when set, keeps only that server's statements.
	Server string
	// State, when set, keeps only "done", "error" or "cancelled".
	State string
	// Failed keeps only entries that did not finish cleanly.
	Failed bool
	// Limit caps how many entries come back, newest first.
	Limit int
}

// Search reads the log back, newest first.
//
// It reads the tail of the current file and, if that did not fill the
// limit, the tail of the previous generation. Older than that is a job for
// grep — this is a search box, not an archive.
func Search(q Query) ([]Entry, error) {
	w.mu.Lock()
	path := w.path
	keep := w.keep
	w.mu.Unlock()

	if path == "" {
		return nil, errors.New("qlog.Search: the query log is switched off")
	}
	if q.Limit <= 0 || q.Limit > 2000 {
		q.Limit = 500
	}

	out := make([]Entry, 0, min(q.Limit, 64))
	files := []string{path}
	for i := 1; i <= keep; i++ {
		files = append(files, fmt.Sprintf("%s.%d", path, i))
	}

	for _, f := range files {
		if len(out) >= q.Limit {
			break
		}
		got, e := searchFile(f, q, q.Limit-len(out))
		if e != nil {
			if errors.Is(e, os.ErrNotExist) {
				continue
			}
			return nil, e
		}
		out = append(out, got...)
	}
	return out, nil
}

// searchFile scans one log file backwards, returning at most want matches.
func searchFile(path string, q Query, want int) ([]Entry, error) {
	f, e := os.Open(path) //nolint:gosec // G304: derived from our own config-file
	if e != nil {
		return nil, e
	}
	defer func() {
		if e := f.Close(); e != nil {
			log.Printf("qlog.searchFile close: %s", e)
		}
	}()

	st, e := f.Stat()
	if e != nil {
		return nil, fmt.Errorf("qlog.searchFile stat: %w", e)
	}

	// Read the tail, then drop whatever partial line it starts with.
	from := int64(0)
	if st.Size() > tailBytes {
		from = st.Size() - tailBytes
	}
	if _, e := f.Seek(from, io.SeekStart); e != nil {
		return nil, fmt.Errorf("qlog.searchFile seek: %w", e)
	}

	lines := make([][]byte, 0, 1024)
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), MaxSQL*4)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		lines = append(lines, append([]byte(nil), line...))
	}
	if e := sc.Err(); e != nil {
		return nil, fmt.Errorf("qlog.searchFile read: %w", e)
	}
	if from > 0 && len(lines) > 0 {
		lines = lines[1:] // the first one was cut in half by the seek
	}

	needle := strings.ToLower(q.Text)
	out := make([]Entry, 0, min(want, 64))
	for i := len(lines) - 1; i >= 0 && len(out) < want; i-- {
		var en Entry
		// A line torn by a crash is skipped rather than failing the search.
		if e := json.Unmarshal(lines[i], &en); e != nil {
			continue
		}
		if !match(en, q, needle) {
			continue
		}
		out = append(out, en)
	}
	return out, nil
}

// match applies the search filters to one entry.
func match(e Entry, q Query, needle string) bool {
	if q.Server != "" && e.Server != q.Server {
		return false
	}
	if q.State != "" && e.State != q.State {
		return false
	}
	if q.Failed && e.State == "done" {
		return false
	}
	if needle == "" {
		return true
	}
	return strings.Contains(strings.ToLower(e.SQL), needle) ||
		strings.Contains(strings.ToLower(e.Error), needle) ||
		strings.Contains(strings.ToLower(e.Table), needle)
}
