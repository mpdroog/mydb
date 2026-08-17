package qlog

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// open points the package at a fresh file under t.TempDir.
func open(t *testing.T, maxMB, keep int) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "q.jsonl")
	if e := Open(path, maxMB, keep); e != nil {
		t.Fatalf("Open: %s", e)
	}
	t.Cleanup(func() {
		if e := Close(); e != nil {
			t.Errorf("Close: %s", e)
		}
	})
	return path
}

func TestAppendAndSearch(t *testing.T) {
	open(t, 32, 1)

	Append(Entry{Server: "local", DB: "shop", SQL: "SELECT 1", State: "done", Rows: 1})
	Append(Entry{Server: "prod", DB: "shop", SQL: "DELETE FROM orders", State: "error",
		Error: "nope", Production: true})
	Append(Entry{Server: "local", SQL: "SELECT 2", State: "done"})

	all, e := Search(Query{})
	if e != nil {
		t.Fatalf("Search: %s", e)
	}
	if len(all) != 3 {
		t.Fatalf("got %d entries, want 3", len(all))
	}
	// Newest first is what a history list wants.
	if all[0].SQL != "SELECT 2" {
		t.Errorf("first entry = %q, want the newest", all[0].SQL)
	}
	if all[0].At == 0 {
		t.Error("Append must stamp a time when the caller did not")
	}

	byServer, e := Search(Query{Server: "prod"})
	if e != nil {
		t.Fatalf("Search: %s", e)
	}
	if len(byServer) != 1 || byServer[0].Server != "prod" {
		t.Errorf("server filter gave %#v", byServer)
	}
	if !byServer[0].Production {
		t.Error("the production flag has to survive the round-trip")
	}

	byText, e := Search(Query{Text: "delete"})
	if e != nil {
		t.Fatalf("Search: %s", e)
	}
	if len(byText) != 1 {
		t.Fatalf("text search gave %d entries, want 1", len(byText))
	}

	failed, e := Search(Query{Failed: true})
	if e != nil {
		t.Fatalf("Search: %s", e)
	}
	if len(failed) != 1 || failed[0].State != "error" {
		t.Errorf("failed filter gave %#v", failed)
	}
}

func TestAppendTruncatesHugeSQL(t *testing.T) {
	open(t, 32, 1)

	Append(Entry{Server: "local", SQL: strings.Repeat("x", MaxSQL*2), State: "done"})
	got, e := Search(Query{})
	if e != nil {
		t.Fatalf("Search: %s", e)
	}
	if len(got) != 1 {
		t.Fatalf("got %d entries, want 1", len(got))
	}
	if len([]rune(got[0].SQL)) != MaxSQL+1 {
		t.Errorf("SQL kept %d runes, want it capped at %d plus the ellipsis",
			len([]rune(got[0].SQL)), MaxSQL)
	}
}

// A rotation must not lose the entries that were already searchable, which
// is the whole point of keeping a generation back.
func TestRotateKeepsHistorySearchable(t *testing.T) {
	path := open(t, 1, 1)

	line := strings.Repeat("a", 4000)
	for i := range 400 {
		Append(Entry{Server: "local", SQL: line, State: "done", Rows: i})
	}

	if _, e := os.Stat(path + ".1"); e != nil {
		t.Fatalf("expected a rotated generation: %s", e)
	}
	st, e := os.Stat(path)
	if e != nil {
		t.Fatalf("stat: %s", e)
	}
	if st.Size() > 1<<20 {
		t.Errorf("current file is %d bytes, past the 1MiB cap", st.Size())
	}
	if m := st.Mode().Perm(); m != 0o600 {
		t.Errorf("log file is mode %04o, it holds query values and must be 0600", m)
	}

	got, e := Search(Query{Limit: 400})
	if e != nil {
		t.Fatalf("Search: %s", e)
	}
	if len(got) != 400 {
		t.Errorf("found %d entries after rotating, want all 400 back", len(got))
	}
}

func TestSearchOffWhenClosed(t *testing.T) {
	if e := Close(); e != nil {
		t.Fatalf("Close: %s", e)
	}
	if e := Open("", 32, 1); e != nil {
		t.Fatalf("Open(\"\"): %s", e)
	}
	if _, e := Search(Query{}); e == nil {
		t.Error("searching a switched-off log must say so rather than answer nothing")
	}
}
