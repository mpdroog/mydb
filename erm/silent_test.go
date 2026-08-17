package erm

import (
	"strings"
	"testing"
)

// A key-shaped column that is neither linked nor explained is the worst
// outcome: it looks like the tool considered it and had nothing to say.
// These are the shapes business_analytics_daily_traffic.member_id could
// have taken; every one must now produce either a link or a reason.
func TestNothingVanishesSilently(t *testing.T) {
	parent := Table{Name: "amember_members", PrimaryKey: []string{"member_id"},
		Columns: []Column{{Name: "member_id", Type: "int(11) unsigned", Key: "PRI"}}}

	for _, c := range []struct {
		name   string
		child  Table
		expect string // "link", or a substring of the reason
	}{
		{
			name: "plain int column",
			child: Table{Name: "business_analytics_daily_traffic", PrimaryKey: []string{"id"},
				Columns: []Column{{Name: "id", Type: "int(11)"}, {Name: "member_id", Type: "int(11) unsigned"}}},
			expect: "link",
		},
		{
			name: "the column is the table's own primary key",
			child: Table{Name: "business_analytics_daily_traffic", PrimaryKey: []string{"member_id"},
				Columns: []Column{{Name: "member_id", Type: "int(11) unsigned"}}},
			expect: "link",
		},
		{
			name: "composite primary key including it",
			child: Table{Name: "business_analytics_daily_traffic", PrimaryKey: []string{"day", "member_id"},
				Columns: []Column{{Name: "day", Type: "date"}, {Name: "member_id", Type: "int(11) unsigned"}}},
			expect: "link",
		},
		{
			// A view's member_id points at a real table, and showing that
			// is the point of an overview. Views used to be skipped
			// wholesale, which hid them from the diagnostics too.
			name: "the table is a view",
			child: Table{Name: "business_analytics_daily_traffic", Type: "VIEW",
				Columns: []Column{{Name: "member_id", Type: "int(11) unsigned"}}},
			expect: "link",
		},
		{
			name: "type cannot join",
			child: Table{Name: "business_analytics_daily_traffic", PrimaryKey: []string{"id"},
				Columns: []Column{{Name: "id", Type: "int(11)"}, {Name: "member_id", Type: "varchar(32)"}}},
			expect: "not usable as a parent",
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			links, miss := Infer([]Table{parent, c.child}, nil)

			linked := found(links, c.child.Name, parent.Name) != nil
			var reason string
			for _, m := range miss {
				if m.Table == c.child.Name && m.Column == "member_id" {
					reason = m.Reason + " " + strings.Join(m.Candidates, ",")
				}
			}

			if c.expect == "link" {
				if !linked {
					t.Errorf("not linked, and reason was %q", reason)
				}
				return
			}
			if linked {
				t.Errorf("linked when it should have explained itself instead")
			}
			if reason == "" {
				t.Fatal("neither linked nor reported: it vanished")
			}
			if !strings.Contains(reason, c.expect) {
				t.Errorf("reason = %q, want it to mention %q", reason, c.expect)
			}
		})
	}
}

// The type-mismatch reason must name the table and both types, or it sends
// you looking in the wrong place.
func TestTypeMismatchReasonIsSpecific(t *testing.T) {
	tables := []Table{
		{Name: "amember_members", PrimaryKey: []string{"member_id"},
			Columns: []Column{{Name: "member_id", Type: "int(11) unsigned", Key: "PRI"}}},
		{Name: "traffic", PrimaryKey: []string{"id"},
			Columns: []Column{{Name: "id", Type: "int(11)"}, {Name: "member_id", Type: "varchar(32)"}}},
	}
	_, miss := Infer(tables, nil)
	for _, m := range miss {
		if m.Column != "member_id" || m.Table != "traffic" {
			continue
		}
		got := strings.Join(m.Candidates, ",")
		if !strings.Contains(got, "amember_members") || !strings.Contains(got, "varchar") {
			t.Errorf("candidates = %q, want the table and both types", got)
		}
		return
	}
	t.Error("the type mismatch was not reported at all")
}
