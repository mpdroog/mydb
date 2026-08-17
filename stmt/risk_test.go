package stmt

import "testing"

// TestInspect covers the confirm gate. Two failure modes matter and they
// pull in opposite directions: letting an unguarded DELETE through, and
// nagging about a statement that is perfectly well guarded. The subquery
// cases are where a keyword search gets it wrong.
func TestInspect(t *testing.T) {
	for _, c := range []struct {
		name   string
		sql    string
		verb   string // "" means no risk
		target string
	}{
		// Guarded: nothing to ask about.
		{name: "select", sql: "SELECT * FROM t"},
		{name: "update with where", sql: "UPDATE t SET a = 1 WHERE id = 2"},
		{name: "delete with where", sql: "DELETE FROM t WHERE id = 2"},
		{name: "insert", sql: "INSERT INTO t VALUES (1)"},
		{name: "alter", sql: "ALTER TABLE t ADD COLUMN a INT"},
		{name: "drop index", sql: "DROP INDEX i ON t"},
		{name: "drop view", sql: "DROP VIEW v"},
		{name: "empty", sql: ""},
		{name: "comment only", sql: "-- nothing here"},
		{
			name: "where in lowercase still counts",
			sql:  "update t set a = 1 where id = 2",
		},
		{
			name: "where after a subquery in the SET",
			sql:  "UPDATE t SET a = (SELECT x FROM z WHERE z.id = 1) WHERE t.id = 2",
		},
		{
			name: "delete with a subquery in its where",
			sql:  "DELETE FROM t WHERE id IN (SELECT id FROM z)",
		},

		// Unguarded: ask first.
		{name: "bare update", sql: "UPDATE t SET a = 1", verb: "UPDATE", target: "t"},
		{name: "bare delete", sql: "DELETE FROM t", verb: "DELETE", target: "t"},
		{
			name: "delete with a limit is still unguarded",
			sql:  "DELETE FROM t LIMIT 10",
			verb: "DELETE", target: "t",
		},
		{
			name:   "the where belongs to a subquery, not to the update",
			sql:    "UPDATE t SET a = (SELECT x FROM z WHERE z.id = 1)",
			verb:   "UPDATE",
			target: "t",
		},
		{
			name:   "a where inside a string literal is not a where",
			sql:    "UPDATE t SET note = 'where did it go'",
			verb:   "UPDATE",
			target: "t",
		},
		{
			name:   "modifiers before the table",
			sql:    "UPDATE LOW_PRIORITY IGNORE t SET a = 1",
			verb:   "UPDATE", target: "t",
		},
		{
			name:   "qualified name",
			sql:    "DELETE FROM shop.orders",
			verb:   "DELETE", target: "shop.orders",
		},
		{
			name:   "backticked name is unquoted for the dialog",
			sql:    "DELETE FROM `shop`.`odd name`",
			verb:   "DELETE", target: "shop.odd name",
		},
		{
			name:   "multi-table delete names the table it deletes from",
			sql:    "DELETE a FROM a JOIN b ON b.id = a.b_id",
			verb:   "DELETE", target: "a",
		},
		{name: "truncate", sql: "TRUNCATE TABLE t", verb: "TRUNCATE", target: "t"},
		{name: "truncate without TABLE", sql: "TRUNCATE t", verb: "TRUNCATE", target: "t"},
		{name: "drop table", sql: "DROP TABLE t", verb: "DROP TABLE", target: "t"},
		{
			name: "drop table if exists",
			sql:  "DROP TABLE IF EXISTS t",
			verb: "DROP TABLE", target: "t",
		},
		{
			name: "drop database",
			sql:  "DROP DATABASE shop",
			verb: "DROP DATABASE", target: "shop",
		},
		{
			name: "cte in front of a bare delete",
			sql:  "WITH x AS (SELECT 1 WHERE 1=1) DELETE FROM t",
			verb: "DELETE", target: "t",
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			got := Inspect(c.sql)
			if c.verb == "" {
				if got != nil {
					t.Fatalf("Inspect(%q) = %+v, want no risk", c.sql, got)
				}
				return
			}
			if got == nil {
				t.Fatalf("Inspect(%q) = nil, want a %s risk", c.sql, c.verb)
			}
			if got.Verb != c.verb {
				t.Errorf("verb = %q, want %q", got.Verb, c.verb)
			}
			if got.Target != c.target {
				t.Errorf("target = %q, want %q", got.Target, c.target)
			}
			if got.Reason == "" {
				t.Error("a risk with no reason gives the dialog nothing to say")
			}
		})
	}
}
