package ddl

import (
	"strings"
	"testing"

	"github.com/mpdroog/mydb/meta"
)

func ptr(s string) *string { return &s }

func TestQuoteString(t *testing.T) {
	for _, c := range []struct {
		in   string
		want string
		fail bool
	}{
		{in: "hello", want: `'hello'`},
		{in: "it's", want: `'it\'s'`},
		{in: `back\slash`, want: `'back\\slash'`},
		{in: "line\nbreak", want: `'line\nbreak'`},
		{in: "nul\x00byte", fail: true},
	} {
		got, e := QuoteString(c.in)
		if c.fail {
			if e == nil {
				t.Errorf("QuoteString(%q) = %q, want error", c.in, got)
			}
			continue
		}
		if e != nil {
			t.Errorf("QuoteString(%q): %s", c.in, e)
			continue
		}
		if got != c.want {
			t.Errorf("QuoteString(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestQuoteIdent(t *testing.T) {
	for _, c := range []struct {
		in   string
		want string
		fail bool
	}{
		{in: "users", want: "`users`"},
		{in: "weird`name", want: "`weird``name`"},
		{in: "", fail: true},
		{in: "nul\x00", fail: true},
		{in: strings.Repeat("x", 65), fail: true},
	} {
		got, e := meta.QuoteIdent(c.in)
		if c.fail {
			if e == nil {
				t.Errorf("QuoteIdent(%q) = %q, want error", c.in, got)
			}
			continue
		}
		if e != nil {
			t.Errorf("QuoteIdent(%q): %s", c.in, e)
			continue
		}
		if got != c.want {
			t.Errorf("QuoteIdent(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestParseType(t *testing.T) {
	for _, c := range []struct {
		in   string
		want string
		fail bool
	}{
		{in: "int", want: "INT"},
		{in: "varchar(255)", want: "VARCHAR(255)"},
		{in: "decimal(10,2)", want: "DECIMAL(10,2)"},
		{in: "int unsigned", want: "INT UNSIGNED"},
		{in: "varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin",
			want: "VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"},
		{in: "enum('a','b')", want: "ENUM('a','b')"},
		{in: "enum('it''s')", want: `ENUM('it\'s')`},
		// The whole point: nothing outside the recognised grammar survives.
		{in: "int, DROP TABLE users", fail: true},
		{in: "varchar(255) /* comment */", fail: true},
		{in: "nosuchtype", fail: true},
		{in: "varchar(abc)", fail: true},
		{in: "int COLLATE 'x; DROP'", fail: true},
	} {
		got, e := ParseType(c.in)
		if c.fail {
			if e == nil {
				t.Errorf("ParseType(%q) = %q, want error", c.in, got)
			}
			continue
		}
		if e != nil {
			t.Errorf("ParseType(%q): %s", c.in, e)
			continue
		}
		if got != c.want {
			t.Errorf("ParseType(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// base is a small table the diff tests work against.
func base() *meta.Structure {
	return &meta.Structure{
		Database: "shop",
		Table:    "orders",
		Columns: []meta.ColumnDef{
			{Name: "id", Type: "int", Nullable: false, Extra: "auto_increment"},
			{Name: "customer", Type: "varchar(255)", Nullable: true},
		},
		Indexes:    []meta.Index{{Name: "idx_customer", Columns: []string{"customer"}}},
		PrimaryKey: []string{"id"},
	}
}

// want mirrors base(), so a diff against it must be empty.
func want() Desired {
	return Desired{
		Columns: []Column{
			{Orig: "id", Name: "id", Type: "int", Extra: "AUTO_INCREMENT"},
			{Orig: "customer", Name: "customer", Type: "varchar(255)", Nullable: true},
		},
		Indexes:    []Index{{Orig: "idx_customer", Name: "idx_customer", Columns: []string{"customer"}}},
		PrimaryKey: []string{"id"},
	}
}

func TestDiffNoop(t *testing.T) {
	got, e := Diff(base(), want())
	if e != nil {
		t.Fatal(e)
	}
	if got != "" {
		t.Errorf("Diff of an unchanged table = %q, want empty", got)
	}
}

func TestDiff(t *testing.T) {
	for _, c := range []struct {
		name   string
		mutate func(*Desired)
		has    []string
		lacks  []string
	}{
		{
			name:   "add column",
			mutate: func(d *Desired) { d.Columns = append(d.Columns, Column{Name: "total", Type: "decimal(10,2)"}) },
			has:    []string{"ADD COLUMN `total` DECIMAL(10,2) NOT NULL AFTER `customer`"},
		},
		{
			name:   "rename column",
			mutate: func(d *Desired) { d.Columns[1].Name = "client" },
			has:    []string{"CHANGE COLUMN `customer` `client` VARCHAR(255) NULL"},
		},
		{
			name:   "drop column",
			mutate: func(d *Desired) { d.Columns = d.Columns[:1] },
			has:    []string{"DROP COLUMN `customer`"},
			// Dropping shifts every later column's index; that must not be
			// mistaken for a reorder and rewrite them all.
			lacks: []string{"MODIFY COLUMN", "AFTER"},
		},
		{
			name: "drop the middle column, leave the rest alone",
			mutate: func(d *Desired) {
				d.Columns = append(d.Columns, Column{Name: "total", Type: "decimal(10,2)"})
				d.Columns[1], d.Columns[2] = d.Columns[2], d.Columns[1]
			},
			has: []string{"ADD COLUMN `total`"},
		},
		{
			name:   "change nullability",
			mutate: func(d *Desired) { d.Columns[1].Nullable = false },
			has:    []string{"MODIFY COLUMN `customer` VARCHAR(255) NOT NULL"},
		},
		{
			name:   "quoted default",
			mutate: func(d *Desired) { d.Columns[1].Default = ptr("it's") },
			has:    []string{`DEFAULT 'it\'s'`},
		},
		{
			name:   "expression default",
			mutate: func(d *Desired) { d.Columns[1].Default, d.Columns[1].DefaultRaw = ptr("CURRENT_TIMESTAMP"), true },
			has:    []string{"DEFAULT CURRENT_TIMESTAMP"},
		},
		{
			name:   "drop index",
			mutate: func(d *Desired) { d.Indexes = nil },
			has:    []string{"DROP INDEX `idx_customer`"},
			lacks:  []string{"ADD INDEX"},
		},
		{
			name:   "make index unique",
			mutate: func(d *Desired) { d.Indexes[0].Unique = true },
			has:    []string{"DROP INDEX `idx_customer`", "ADD UNIQUE INDEX `idx_customer` (`customer`)"},
		},
		{
			name:   "change primary key",
			mutate: func(d *Desired) { d.PrimaryKey = []string{"customer"} },
			has:    []string{"DROP PRIMARY KEY", "ADD PRIMARY KEY (`customer`)"},
		},
		{
			name:   "reorder columns",
			mutate: func(d *Desired) { d.Columns[0], d.Columns[1] = d.Columns[1], d.Columns[0] },
			has:    []string{"FIRST"},
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			d := want()
			c.mutate(&d)

			got, e := Diff(base(), d)
			if e != nil {
				t.Fatal(e)
			}
			if !strings.HasPrefix(got, "ALTER TABLE `shop`.`orders`") {
				t.Fatalf("missing ALTER prefix in:\n%s", got)
			}
			for _, w := range c.has {
				if !strings.Contains(got, w) {
					t.Errorf("want %q in:\n%s", w, got)
				}
			}
			for _, w := range c.lacks {
				if strings.Contains(got, w) {
					t.Errorf("did not want %q in:\n%s", w, got)
				}
			}
		})
	}
}

func TestDiffRejects(t *testing.T) {
	for _, c := range []struct {
		name   string
		mutate func(*Desired)
	}{
		{"bad type", func(d *Desired) { d.Columns[1].Type = "varchar(255); DROP TABLE x" }},
		{"bad extra", func(d *Desired) { d.Columns[1].Extra = "; DROP TABLE x" }},
		{"bad name", func(d *Desired) { d.Columns[1].Name = "" }},
		{"unknown orig", func(d *Desired) { d.Columns[1].Orig = "vanished" }},
		{"bad raw default", func(d *Desired) { d.Columns[1].Default, d.Columns[1].DefaultRaw = ptr("(SELECT 1)"), true }},
		{"empty index", func(d *Desired) { d.Indexes[0].Columns = nil }},
	} {
		t.Run(c.name, func(t *testing.T) {
			d := want()
			c.mutate(&d)
			if got, e := Diff(base(), d); e == nil {
				t.Errorf("Diff accepted %s, produced:\n%s", c.name, got)
			}
		})
	}
}

// TestDiffTableComment: a table's comment is neither a column nor an
// index, and had nowhere to go until now.
func TestDiffTableComment(t *testing.T) {
	cur := &meta.Structure{
		Database: "shop", Table: "orders",
		Comment: "orders placed by customers",
		Columns: []meta.ColumnDef{{Name: "id", Type: "int"}},
	}
	want := Desired{Columns: []Column{{Orig: "id", Name: "id", Type: "INT"}}}

	// Absent means "leave it alone". A client that knows nothing about
	// table comments must not silently clear one.
	got, e := Diff(cur, want)
	if e != nil {
		t.Fatalf("Diff: %s", e)
	}
	if strings.Contains(got, "COMMENT") {
		t.Errorf("a nil comment changed it:\n%s", got)
	}

	// The same comment is not a change either.
	same := cur.Comment
	want.Comment = &same
	if got, e = Diff(cur, want); e != nil || strings.Contains(got, "COMMENT") {
		t.Errorf("an unchanged comment produced a clause:\n%s", got)
	}

	// A new one is.
	next := "one row per order"
	want.Comment = &next
	got, e = Diff(cur, want)
	if e != nil {
		t.Fatalf("Diff: %s", e)
	}
	if !strings.Contains(got, "COMMENT = 'one row per order'") {
		t.Errorf("comment not written:\n%s", got)
	}

	// And clearing it is a change the caller can ask for explicitly.
	empty := ""
	want.Comment = &empty
	got, e = Diff(cur, want)
	if e != nil {
		t.Fatalf("Diff: %s", e)
	}
	if !strings.Contains(got, "COMMENT = ''") {
		t.Errorf("comment not cleared:\n%s", got)
	}

	// A quote in a comment is escaped, not interpolated.
	tricky := "it's fine"
	want.Comment = &tricky
	got, e = Diff(cur, want)
	if e != nil {
		t.Fatalf("Diff: %s", e)
	}
	// mydb escapes with a backslash rather than by doubling; either is
	// valid MySQL, and this is the one QuoteString has always used.
	if !strings.Contains(got, `'it\'s fine'`) {
		t.Errorf("quote not escaped:\n%s", got)
	}
}

// TestBaseTypesAreAllAccepted keeps the list the editor offers and the list
// the writer accepts from drifting apart: every type offered must survive a
// round through Diff.
func TestBaseTypesAreAllAccepted(t *testing.T) {
	cur := &meta.Structure{Database: "shop", Table: "t"}
	for _, ty := range BaseTypes() {
		spec := ty
		switch ty {
		case "VARCHAR", "CHAR", "BINARY", "VARBINARY":
			spec = ty + "(64)"
		case "DECIMAL":
			spec = "DECIMAL(10,2)"
		case "ENUM", "SET":
			spec = ty + "('a','b')"
		case "BIT":
			spec = "BIT(8)"
		}
		want := Desired{Columns: []Column{{Name: "c", Type: spec, Nullable: true}}}
		if _, e := Diff(cur, want); e != nil {
			t.Errorf("BaseTypes offers %q but Diff refuses %q: %s", ty, spec, e)
		}
	}
}
