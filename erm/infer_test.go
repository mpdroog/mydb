package erm

import (
	"strings"
	"testing"
)

// tbl builds a table with an integer primary key and the given extra
// columns, which is the shape almost every test here needs.
func tbl(name string, cols ...Column) Table {
	t := Table{Name: name, PrimaryKey: []string{"id"}}
	t.Columns = append(t.Columns, Column{Name: "id", Type: "int(11)", Key: "PRI"})
	t.Columns = append(t.Columns, cols...)
	return t
}

func intCol(name string) Column  { return Column{Name: name, Type: "int(11)"} }
func textCol(name string) Column { return Column{Name: name, Type: "varchar(32)"} }

// first drops Infer's diagnostics so a test can read just the links.
func first(links []Link, _ []Unmatched) []Link { return links }

// found looks for a link between two tables in the result.
func found(links []Link, from, to string) *Link {
	for i := range links {
		if links[i].From == from && links[i].To == to {
			return &links[i]
		}
	}
	return nil
}

func TestInferFindsTheObviousOnes(t *testing.T) {
	tables := []Table{
		tbl("customers"),
		tbl("prod"),
		tbl("orders", intCol("customer_id"), intCol("prod_id")),
	}
	links := first(Infer(tables, nil))

	for _, c := range []struct{ from, to, col string }{
		{"orders", "customers", "customer_id"}, // plural table
		{"orders", "prod", "prod_id"},          // the exact case asked about
	} {
		l := found(links, c.from, c.to)
		if l == nil {
			t.Errorf("no link %s -> %s", c.from, c.to)
			continue
		}
		if l.FromCols[0] != c.col || l.ToCols[0] != "id" {
			t.Errorf("%s -> %s joined on %v = %v, want %s = id", c.from, c.to, l.FromCols, l.ToCols, c.col)
		}
		if l.Kind != KindGuess {
			t.Errorf("%s -> %s kind = %q, want a guess", c.from, c.to, l.Kind)
		}
	}
}

func TestInferRespectsTypes(t *testing.T) {
	// A name that matches perfectly is still not a link if the values
	// could never join.
	tables := []Table{
		tbl("customers"),
		{Name: "orders", PrimaryKey: []string{"id"}, Columns: []Column{
			{Name: "id", Type: "int(11)", Key: "PRI"},
			{Name: "customer_id", Type: "varchar(64)"},
		}},
	}
	if l := found(first(Infer(tables, nil)), "orders", "customers"); l != nil {
		t.Errorf("joined varchar to int: %+v", l)
	}

	// Signedness no longer rejects the link. A legacy schema full of
	// int(11) children pointing at int(11) unsigned keys has both a real
	// relationship and a real latent bug; refusing to draw it hid both.
	// It costs confidence and says why instead.
	unsigned := []Table{
		{Name: "customers", PrimaryKey: []string{"id"}, Columns: []Column{
			{Name: "id", Type: "int(10) unsigned", Key: "PRI"}}},
		{Name: "orders", PrimaryKey: []string{"id"}, Columns: []Column{
			{Name: "id", Type: "int(11)", Key: "PRI"},
			{Name: "customer_id", Type: "int(11)"}}},
	}
	l := found(first(Infer(unsigned, nil)), "orders", "customers")
	if l == nil {
		t.Fatal("a signedness mismatch should still be drawn")
	}
	if !strings.Contains(l.Rule, "signedness differs") {
		t.Errorf("the mismatch was not reported: %q", l.Rule)
	}
	clean := found(first(Infer([]Table{tbl("customers"), tbl("orders", intCol("customer_id"))}, nil)),
		"orders", "customers")
	if l.Confidence >= clean.Confidence {
		t.Errorf("mismatched types scored %.2f, want less than a clean %.2f",
			l.Confidence, clean.Confidence)
	}

	widths := []Table{
		{Name: "customers", PrimaryKey: []string{"id"}, Columns: []Column{
			{Name: "id", Type: "int(10)", Key: "PRI"}}},
		{Name: "orders", PrimaryKey: []string{"id"}, Columns: []Column{
			{Name: "id", Type: "int(11)", Key: "PRI"},
			{Name: "customer_id", Type: "int(11)"}}},
	}
	if l := found(first(Infer(widths, nil)), "orders", "customers"); l == nil {
		t.Error("int(10) and int(11) should still join")
	}
}

func TestInferNeverOverridesAForeignKey(t *testing.T) {
	tables := []Table{
		tbl("customers"),
		tbl("orders", intCol("customer_id")),
	}
	known := []Link{{
		From: "orders", To: "customers",
		FromCols: []string{"customer_id"}, ToCols: []string{"id"}, Kind: KindFK,
	}}
	for _, l := range first(Infer(tables, known)) {
		if l.From == "orders" && l.FromCols[0] == "customer_id" {
			t.Errorf("guessed at a column that already has a foreign key: %+v", l)
		}
	}
}

func TestInferRefusesAmbiguity(t *testing.T) {
	// Both `owner` and `owners` exist. `owner_id` says nothing about which
	// was meant, so drawing either would be a coin flip presented as fact.
	tables := []Table{
		tbl("owner"),
		tbl("owners"),
		tbl("things", intCol("owner_id")),
	}
	for _, l := range first(Infer(tables, nil)) {
		if l.From == "things" {
			t.Errorf("picked a side in an ambiguous match: %+v", l)
		}
	}
}

func TestInferIgnoresGenericKeyNames(t *testing.T) {
	// Every table has an `id`; that is not evidence of anything.
	tables := []Table{
		tbl("a", intCol("code")),
		tbl("b"),
	}
	for _, l := range first(Infer(tables, nil)) {
		if l.FromCols[0] == "id" {
			t.Errorf("linked on a bare id: %+v", l)
		}
	}
}

func TestInferDistinctivePrimaryKey(t *testing.T) {
	// A distinctive key name reused elsewhere is real evidence.
	tables := []Table{
		{Name: "products", PrimaryKey: []string{"sku"}, Columns: []Column{
			{Name: "sku", Type: "varchar(32)", Key: "PRI"}}},
		tbl("order_lines", textCol("sku")),
	}
	if l := found(first(Infer(tables, nil)), "order_lines", "products"); l == nil {
		t.Error("did not link order_lines.sku -> products.sku")
	}
}

func TestInferSkipsCompositeAndViews(t *testing.T) {
	composite := []Table{
		{Name: "pairs", PrimaryKey: []string{"a", "b"}, Columns: []Column{
			{Name: "a", Type: "int(11)"}, {Name: "b", Type: "int(11)"}}},
		tbl("things", intCol("pair_id")),
	}
	if l := found(first(Infer(composite, nil)), "things", "pairs"); l != nil {
		t.Errorf("guessed at a composite primary key: %+v", l)
	}

	view := []Table{
		{Name: "customers", Type: "VIEW", PrimaryKey: []string{"id"}, Columns: []Column{
			{Name: "id", Type: "int(11)"}}},
		tbl("orders", intCol("customer_id")),
	}
	if l := found(first(Infer(view, nil)), "orders", "customers"); l != nil {
		t.Errorf("linked to a view: %+v", l)
	}
}

func TestInferPrefixedTableNames(t *testing.T) {
	// Legacy schemas use a prefix where a schema would be used today.
	tables := []Table{
		tbl("shop_customers"),
		tbl("shop_orders", intCol("customer_id")),
	}
	if l := found(first(Infer(tables, nil)), "shop_orders", "shop_customers"); l == nil {
		t.Error("did not link customer_id -> shop_customers")
	}
}

func TestSingular(t *testing.T) {
	for in, want := range map[string]string{
		"customers": "customer",
		"companies": "company",
		"boxes":     "box",
		"addresses": "address",
		"status":    "status",
		"s":         "s",
		"prod":      "prod",
	} {
		if got := singular(in); got != want {
			t.Errorf("singular(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestUnmatchedExplainsItself covers the diagnostics: a sparse diagram has
// to be distinguishable from an over-strict rule.
func TestUnmatchedExplainsItself(t *testing.T) {
	tables := []Table{
		tbl("owner"), tbl("owners"),
		tbl("things", intCol("owner_id"), intCol("nothing_id"), textCol("label")),
		{Name: "settings", PrimaryKey: []string{"id"}, Columns: []Column{
			{Name: "id", Type: "int(11)", Key: "PRI"},
			{Name: "owner_id", Type: "varchar(64)"}}},
	}
	_, miss := Infer(tables, nil)

	byCol := map[string]Unmatched{}
	for _, m := range miss {
		byCol[m.Table+"."+m.Column] = m
	}

	amb, ok := byCol["things.owner_id"]
	if !ok {
		t.Fatal("an ambiguous column was not reported at all")
	}
	if !strings.Contains(amb.Reason, "ambiguous") {
		t.Errorf("reason = %q, want it to mention ambiguity", amb.Reason)
	}
	if len(amb.Candidates) != 2 {
		t.Errorf("candidates = %v, want both owner and owners", amb.Candidates)
	}

	if m, ok := byCol["things.nothing_id"]; !ok {
		t.Error("a _id column with no candidate was not reported")
	} else if !strings.Contains(m.Reason, "no table name") {
		t.Errorf("reason = %q", m.Reason)
	}

	// A plain label is not key-shaped, so it must not be listed at all.
	if _, ok := byCol["things.label"]; ok {
		t.Error("a non-key column was reported as unmatched")
	}
}
