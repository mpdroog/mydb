package erm

import "testing"

func TestSingularCommonPlurals(t *testing.T) {
	for in, want := range map[string]string{
		"customers": "customer",
		"companies": "company",
		"boxes":     "box",
		"addresses": "address",
		"statuses":  "status",
		"buses":     "bus",
		"schemas":   "schema",
		"status":    "status",
		"address":   "address",
		"analysis":  "analysis",
		"prod":      "prod",
	} {
		if got := singular(in); got != want {
			t.Errorf("singular(%q) = %q, want %q", in, got, want)
		}
	}
}

// Words that are their own plural (series, alias, species) cannot be told
// from real plurals with the same ending -- "series" looks exactly like
// "companies", and "alias" like "schemas". singular() mangles them, and
// that is harmless: an exact name match is scored before singular() is
// ever consulted, so the link is still found. This pins that.
func TestIrregularPluralsStillLink(t *testing.T) {
	for _, name := range []string{"series", "alias", "species"} {
		tables := []Table{
			tbl(name),
			tbl("items", intCol(name+"_id")),
		}
		if l := found(first(Infer(tables, nil)), "items", name); l == nil {
			t.Errorf("items.%s_id did not link to %s", name, name)
		}
	}
}
