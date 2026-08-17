package jobs

import "testing"

func TestParseFilter(t *testing.T) {
	for _, c := range []struct {
		in         string
		tail       string
		needsWhere bool
		hasOrder   bool
		hasLimit   bool
	}{
		{in: "", tail: ""},
		{in: "   ", tail: ""},

		// The plain case.
		{in: "status = 'new'", tail: "status = 'new'", needsWhere: true},

		// Writing WHERE yourself is the natural thing to do, and used to
		// produce "WHERE WHERE ...".
		{in: "WHERE status = 'new'", tail: "status = 'new'", needsWhere: true},
		{in: "  where   status = 'new'  ", tail: "status = 'new'", needsWhere: true},
		{in: "WHERE email_status=\"VERIFIED\"", tail: "email_status=\"VERIFIED\"", needsWhere: true},
		{in: "WHERE(a=1)", tail: "(a=1)", needsWhere: true},
		// Only a WHERE keyword and nothing else is the same as no filter.
		{in: "WHERE", tail: ""},
		// A column that merely starts with "where" must survive.
		{in: "whereabouts IS NULL", tail: "whereabouts IS NULL", needsWhere: true},

		// Trailing semicolons.
		{in: "status = 'new';", tail: "status = 'new'", needsWhere: true},
		{in: "status = 'new' ;; ", tail: "status = 'new'", needsWhere: true},
		// ...but not one inside a value.
		{in: "note = 'a;'", tail: "note = 'a;'", needsWhere: true},

		// Bringing your own ORDER BY / LIMIT suppresses mydb's.
		{in: "a = 1 ORDER BY total DESC", tail: "a = 1 ORDER BY total DESC", needsWhere: true, hasOrder: true},
		{in: "ORDER BY created_at DESC", tail: "ORDER BY created_at DESC", hasOrder: true},
		{in: "order    by  x", tail: "order    by  x", hasOrder: true},
		{in: "LIMIT 5", tail: "LIMIT 5", hasLimit: true},
		{in: "a = 1 LIMIT 5", tail: "a = 1 LIMIT 5", needsWhere: true, hasLimit: true},
		{in: "a = 1 ORDER BY b LIMIT 5", tail: "a = 1 ORDER BY b LIMIT 5", needsWhere: true, hasOrder: true, hasLimit: true},

		// A value that merely reads like a clause must not be mistaken for
		// one, or mydb would silently drop its own ordering.
		{in: "note = 'order by x'", tail: "note = 'order by x'", needsWhere: true},
		{in: "note = 'limit 5'", tail: "note = 'limit 5'", needsWhere: true},
		{in: `note = "order by x"`, tail: `note = "order by x"`, needsWhere: true},
		{in: "`order by` = 1", tail: "`order by` = 1", needsWhere: true},
		{in: "note = 'it''s order by'", tail: "note = 'it''s order by'", needsWhere: true},
		{in: `note = 'a\' order by'`, tail: `note = 'a\' order by'`, needsWhere: true},
		{in: "a = 1 -- order by b", tail: "a = 1 -- order by b", needsWhere: true},
		{in: "a = 1 # limit 3", tail: "a = 1 # limit 3", needsWhere: true},
		{in: "a = 1 /* order by b */", tail: "a = 1 /* order by b */", needsWhere: true},
		// Columns whose names merely contain the keyword.
		{in: "limits > 3", tail: "limits > 3", needsWhere: true},
		{in: "reorder_by_id = 2", tail: "reorder_by_id = 2", needsWhere: true},
	} {
		got := parseFilter(c.in)
		if got.Tail != c.tail {
			t.Errorf("parseFilter(%q).Tail = %q, want %q", c.in, got.Tail, c.tail)
		}
		if got.NeedsWhere != c.needsWhere {
			t.Errorf("parseFilter(%q).NeedsWhere = %v, want %v", c.in, got.NeedsWhere, c.needsWhere)
		}
		if got.HasOrder != c.hasOrder {
			t.Errorf("parseFilter(%q).HasOrder = %v, want %v", c.in, got.HasOrder, c.hasOrder)
		}
		if got.HasLimit != c.hasLimit {
			t.Errorf("parseFilter(%q).HasLimit = %v, want %v", c.in, got.HasLimit, c.hasLimit)
		}
	}
}

func TestBlankLiteralsKeepsLength(t *testing.T) {
	// Positions have to line up, so the blanked copy must be the same size.
	for _, s := range []string{
		"a = 'x'", `b = "y"`, "`c` = 1", "a -- x", "a /* x */ b", "a = 'unterminated",
		"a = `unterminated", "a /* unterminated", `a = 'esc\'`,
	} {
		if got := blankLiterals(s); len(got) != len(s) {
			t.Errorf("blankLiterals(%q) length %d, want %d", s, len(got), len(s))
		}
	}
}
