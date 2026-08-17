package erm

import (
	"sort"
	"testing"
)

// link builds a guessed link between two tables.
func link(from, to string) Link {
	return Link{From: from, To: to, FromCols: []string{to + "_id"}, ToCols: []string{"id"}, Kind: KindGuess}
}

// placed returns every table name the grouping accounted for.
func placed(groups []Group) []string {
	var out []string
	for _, g := range groups {
		out = append(out, g.Tables...)
	}
	sort.Strings(out)
	return out
}

// TestClusterPlacesEveryTableExactlyOnce is the invariant that matters: a
// table missing from every group is a table missing from the diagram, and
// singleton components used to vanish exactly this way.
func TestClusterPlacesEveryTableExactlyOnce(t *testing.T) {
	tables := []Table{
		tbl("users"), tbl("posts"), tbl("comments"), tbl("sessions"),
		tbl("tokens"), tbl("audits"), tbl("prefs"), tbl("logins"),
		tbl("avatars"), tbl("orders"), tbl("order_lines"),
		tbl("cms_pages"), tbl("cms_blocks"), tbl("lonely"),
	}
	sats := []string{"posts", "comments", "sessions", "tokens",
		"audits", "prefs", "logins", "avatars"}
	links := make([]Link, 0, len(sats)+1)
	for _, sat := range sats {
		links = append(links, link(sat, "users"))
	}
	links = append(links, link("order_lines", "orders"))

	groups := Cluster(tables, links)

	seen := map[string]int{}
	for _, g := range groups {
		for _, n := range g.Tables {
			seen[n]++
		}
	}
	for _, tb := range tables {
		switch seen[tb.Name] {
		case 1:
		case 0:
			t.Errorf("%s is in no group at all", tb.Name)
		default:
			t.Errorf("%s is in %d groups", tb.Name, seen[tb.Name])
		}
	}
	if len(placed(groups)) != len(tables) {
		t.Errorf("grouped %d names, have %d tables", len(placed(groups)), len(tables))
	}
}

func TestClusterHubKeepsItsSatellites(t *testing.T) {
	sats := []string{"a", "b", "c", "d", "e", "f", "g", "h"}
	tables := make([]Table, 0, len(sats)+1)
	tables = append(tables, tbl("users"))
	links := make([]Link, 0, len(sats))
	for _, sat := range sats {
		tables = append(tables, tbl(sat))
		links = append(links, link(sat, "users"))
	}

	var hub *Group
	for i, g := range Cluster(tables, links) {
		if g.Kind == GroupHub {
			hub = &Cluster(tables, links)[i]
		}
	}
	if hub == nil {
		t.Fatal("users was not treated as a hub")
	}
	if len(hub.Tables) != 9 {
		t.Errorf("hub group holds %d tables, want the hub plus its 8 satellites", len(hub.Tables))
	}
	if hub.Name != "users +8" {
		t.Errorf("hub group named %q, want \"users +8\"", hub.Name)
	}
}

func TestClusterPrefixAndIsolated(t *testing.T) {
	tables := []Table{
		tbl("cms_pages"), tbl("cms_blocks"), tbl("cms_widgets"), tbl("lonely"),
	}
	groups := Cluster(tables, nil)

	var prefix, iso *Group
	for i := range groups {
		switch groups[i].Kind {
		case GroupPrefix:
			prefix = &groups[i]
		case GroupIsolated:
			iso = &groups[i]
		case GroupComponent, GroupHub:
		}
	}
	if prefix == nil || len(prefix.Tables) != 3 || prefix.Name != "cms_*" {
		t.Errorf("cms_* prefix group not formed: %+v", prefix)
	}
	if iso == nil || len(iso.Tables) != 1 || iso.Tables[0] != "lonely" {
		t.Errorf("lonely should stand alone: %+v", iso)
	}
}
