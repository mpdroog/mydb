package jobs

import "testing"

// TestReturnsRows guards the choice between QueryContext and ExecContext.
// Getting it wrong means a SELECT reports "0 rows affected" or an UPDATE
// errors out, so the comment-skipping matters more than it looks.
func TestReturnsRows(t *testing.T) {
	for _, c := range []struct {
		sql  string
		want bool
	}{
		{sql: "SELECT 1", want: true},
		{sql: "  select * from t", want: true},
		{sql: "\n\tSHOW DATABASES", want: true},
		{sql: "(SELECT 1)", want: true},
		{sql: "WITH x AS (SELECT 1) SELECT * FROM x", want: true},
		{sql: "EXPLAIN SELECT 1", want: true},
		{sql: "-- a comment\nSELECT 1", want: true},
		{sql: "/* hi */ SELECT 1", want: true},
		{sql: "# hash comment\nSELECT 1", want: true},
		{sql: "UPDATE t SET a=1", want: false},
		{sql: "ALTER TABLE t ADD COLUMN a INT", want: false},
		{sql: "INSERT INTO t VALUES (1)", want: false},
		{sql: "DELETE FROM t", want: false},
		{sql: "-- only a comment", want: false},
		{sql: "", want: false},
		{sql: "SELECTOR", want: false},
	} {
		if got := returnsRows(c.sql); got != c.want {
			t.Errorf("returnsRows(%q) = %v, want %v", c.sql, got, c.want)
		}
	}
}

func TestIsKilled(t *testing.T) {
	if !isKilled(testError("Error 1317: Query execution was interrupted")) {
		t.Error("a KILLed query must read as cancelled, not as a failure")
	}
	if isKilled(testError("Error 1045: Access denied")) {
		t.Error("a real error must not be mistaken for a cancel")
	}
}

type testError string

func (e testError) Error() string { return string(e) }
