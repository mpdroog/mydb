package api

import (
	"strings"
	"testing"

	"github.com/mpdroog/mydb/meta"
)

// fixture is a small table with one of each thing insertStmt has to care
// about: an auto-increment key, an ordinary column, and a binary one.
func fixture() *meta.Structure {
	return &meta.Structure{
		Database: "shop",
		Table:    "orders",
		Columns: []meta.ColumnDef{
			{Name: "id", Type: "int", Extra: "auto_increment"},
			{Name: "client", Type: "varchar(300)", Nullable: true},
			{Name: "total", Type: "decimal(10,2)"},
			{Name: "payload", Type: "varbinary(64)", Nullable: true},
		},
		PrimaryKey: []string{"id"},
	}
}

func ptr(s string) *string { return &s }

// TestInsertStmtFollowsSchemaOrder keeps the logged statement stable: two
// identical inserts should produce the same SQL whatever order the browser
// happened to serialise its form in.
func TestInsertStmtFollowsSchemaOrder(t *testing.T) {
	in := insertInput{Values: map[string]*string{
		"total":  ptr("42.50"),
		"client": ptr("acme"),
	}}
	got, args, e := insertStmt(fixture(), in)
	if e != nil {
		t.Fatalf("insertStmt: %s", e)
	}
	want := "INSERT INTO `shop`.`orders` (`client`, `total`) VALUES (?, ?)"
	if got != want {
		t.Errorf("statement =\n  %s\nwant\n  %s", got, want)
	}
	if len(args) != 2 || args[0] != "acme" || args[1] != "42.50" {
		t.Errorf("args = %#v, want [acme 42.50] in schema order", args)
	}
}

// TestInsertStmtKeepsNullDistinctFromAbsent is the distinction the whole
// form rests on: leaving a column out takes its default, sending null sets
// it to NULL, and those are different statements.
func TestInsertStmtKeepsNullDistinctFromAbsent(t *testing.T) {
	withNull, args, e := insertStmt(fixture(), insertInput{
		Values: map[string]*string{"client": nil},
	})
	if e != nil {
		t.Fatalf("insertStmt: %s", e)
	}
	if !strings.Contains(withNull, "`client`") {
		t.Errorf("an explicit NULL dropped the column: %s", withNull)
	}
	if len(args) != 1 || args[0] != nil {
		t.Errorf("args = %#v, want a single nil", args)
	}

	absent, args, e := insertStmt(fixture(), insertInput{Values: map[string]*string{}})
	if e != nil {
		t.Fatalf("insertStmt: %s", e)
	}
	if absent != "INSERT INTO `shop`.`orders` () VALUES ()" {
		t.Errorf("a row of pure defaults built %q", absent)
	}
	if len(args) != 0 {
		t.Errorf("args = %#v, want none", args)
	}
}

// TestInsertStmtRefusesWhatTheFormCouldNotHaveMeant: anything not in the
// schema is a bug or an attack, and either way must not reach the server.
func TestInsertStmtRefusesWhatTheFormCouldNotHaveMeant(t *testing.T) {
	for _, tc := range []struct {
		name   string
		values map[string]*string
		want   string
	}{
		{"unknown column", map[string]*string{"nope": ptr("x")}, "no such column"},
		{"binary column", map[string]*string{"payload": ptr("x")}, "read-only"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, _, e := insertStmt(fixture(), insertInput{Values: tc.values})
			if e == nil {
				t.Fatalf("insertStmt accepted %v", tc.values)
			}
			if !strings.Contains(e.Error(), tc.want) {
				t.Errorf("error = %q, want it to mention %q", e, tc.want)
			}
		})
	}
}

// TestInsertStmtNeverInterpolatesAValue is the property that matters most:
// values reach the server as placeholders, never as text in the statement.
func TestInsertStmtNeverInterpolatesAValue(t *testing.T) {
	evil := "'); DROP TABLE orders; --"
	got, args, e := insertStmt(fixture(), insertInput{
		Values: map[string]*string{"client": ptr(evil)},
	})
	if e != nil {
		t.Fatalf("insertStmt: %s", e)
	}
	if strings.Contains(got, "DROP") {
		t.Fatalf("a value reached the statement text: %s", got)
	}
	if len(args) != 1 || args[0] != evil {
		t.Errorf("args = %#v, want the value carried as an argument", args)
	}
}
