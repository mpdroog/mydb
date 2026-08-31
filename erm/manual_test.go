package erm

import "testing"

// manual builds a one-column declared link, the shape the config-file
// produces.
func manual(fromTbl, fromCol, toTbl, toCol string) Link {
	return Link{From: fromTbl, To: toTbl, FromCols: []string{fromCol}, ToCols: []string{toCol}}
}

// TestKeepRealMarksAndKeepsWhatIsStillThere: a declared link is not a
// guess, and must not be drawn as one.
func TestKeepRealMarksAndKeepsWhatIsStillThere(t *testing.T) {
	tables := []Table{tbl("orders"), tbl("audit_log", intCol("order_id"))}
	got := keepReal([]Link{manual("audit_log", "order_id", "orders", "id")}, tables)

	if len(got) != 1 {
		t.Fatalf("keepReal returned %d links, want 1", len(got))
	}
	if got[0].Kind != KindManual {
		t.Errorf("kind = %q, want %q", got[0].Kind, KindManual)
	}
	if got[0].Confidence != 1 {
		t.Errorf("confidence = %v, want 1: the operator checked this one", got[0].Confidence)
	}
	if got[0].Rule == "" {
		t.Error("a manual link should say where it came from")
	}
}

// TestKeepRealDropsWhatTheSchemaNoLongerHas is the case that matters after
// a rename: a config-file outlives the schema it describes, and a stale
// link must not put a box on the diagram that is not in the database.
func TestKeepRealDropsWhatTheSchemaNoLongerHas(t *testing.T) {
	tables := []Table{tbl("orders"), tbl("audit_log", intCol("order_id"))}

	for _, tc := range []struct {
		name string
		link Link
	}{
		{"table is gone", manual("ghosts", "order_id", "orders", "id")},
		{"target table is gone", manual("audit_log", "order_id", "ghosts", "id")},
		{"column is gone", manual("audit_log", "nope", "orders", "id")},
		{"target column is gone", manual("audit_log", "order_id", "orders", "nope")},
		{"no columns at all", Link{From: "audit_log", To: "orders"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := keepReal([]Link{tc.link}, tables); len(got) != 0 {
				t.Errorf("keepReal kept %+v", got)
			}
		})
	}
}

// TestManualLinkStopsTheGuesserAskingAgain: once the operator has answered
// for a column, mydb must not propose its own edge for it as well, or the
// diagram grows two lines where the schema has one relationship.
func TestManualLinkStopsTheGuesserAskingAgain(t *testing.T) {
	tables := []Table{tbl("customers"), tbl("orders", intCol("customer_id"))}

	// Left alone, the guesser finds this one.
	if l := found(first(Infer(tables, nil)), "orders", "customers"); l == nil {
		t.Fatal("the guesser did not find orders.customer_id, so this test proves nothing")
	}

	declared := keepReal([]Link{manual("orders", "customer_id", "customers", "id")}, tables)
	guessed, _ := Infer(tables, declared)
	if l := found(guessed, "orders", "customers"); l != nil {
		t.Errorf("the guesser proposed %+v for a column already declared by hand", *l)
	}
}

// TestDropAnsweredStopsAskingTwice: a column the operator has linked should
// leave the "unlinked" list, or the interface keeps offering to fix
// something already fixed.
func TestDropAnsweredStopsAskingTwice(t *testing.T) {
	miss := []Unmatched{
		{Table: "audit_log", Column: "order_id", Reason: "row-count ratio"},
		{Table: "orders", Column: "status", Reason: "not key-shaped"},
	}
	got := dropAnswered(miss, []Link{manual("audit_log", "order_id", "orders", "id")})

	if len(got) != 1 {
		t.Fatalf("dropAnswered left %d entries, want 1", len(got))
	}
	if got[0].Column != "status" {
		t.Errorf("left %q, want the one nobody answered", got[0].Column)
	}
}

// TestManualLinkGroupsTheTables: a link the operator drew is as good a
// reason to cluster two tables as a foreign key, which is why the merge
// happens before Cluster rather than after it.
//
// The assertion is on the *kind* of group, not on membership: with no links
// at all every table lands in the leftover "unrelated" bucket together, so
// finding them side by side there would prove nothing.
func TestManualLinkGroupsTheTables(t *testing.T) {
	tables := []Table{tbl("orders"), tbl("audit_log", intCol("order_id")), tbl("settings")}
	declared := keepReal([]Link{manual("audit_log", "order_id", "orders", "id")}, tables)

	component := func(groups []Group) *Group {
		for i := range groups {
			if groups[i].Kind == GroupComponent {
				return &groups[i]
			}
		}
		return nil
	}

	if g := component(Cluster(tables, nil)); g != nil {
		t.Fatalf("unlinked tables already formed a component %+v, so this test proves nothing", *g)
	}

	g := component(Cluster(tables, declared))
	if g == nil {
		t.Fatal("a declared link did not form a component group")
	}
	if len(g.Tables) != 2 {
		t.Errorf("component holds %v, want just the two linked tables", g.Tables)
	}
}
