package erm

import (
	"fmt"
	"sort"
	"strings"
)

// ambiguityMargin is how far the best candidate must beat the runner-up.
//
// An exact-tie check is not enough: with both `owner` and `owners` in the
// schema, `owner_id` scores 0.9 and 0.85. Those are different numbers but
// the same coin flip, and picking the higher one would present a guess as
// a decision.
const ambiguityMargin = 0.15

// minConfidence is the score a guess must reach to be drawn at all.
// Below this the name evidence is too thin and the diagram would start
// inventing relationships, which is worse than leaving a table isolated.
const minConfidence = 0.5

// Unmatched is a column that looks like it should point somewhere but does
// not, and the reason why. Without this, a diagram with few links leaves
// you unable to tell a schema that genuinely has none from a rule of mine
// that is too strict.
type Unmatched struct {
	Table      string   `json:"table"`
	Column     string   `json:"column"`
	Type       string   `json:"type"`
	Reason     string   `json:"reason"`
	Candidates []string `json:"candidates,omitempty"`
}

// Infer finds links that the schema never declared, from column naming
// alone. It reads no table data, so it is safe against production and
// costs nothing beyond the metadata already loaded.
//
// The rules, in the order they carry weight:
//
//	orders.customer_id  -> customers.id   stem matches a table, allowing plurals
//	line.prod_id        -> prod.id        stem matches a table exactly
//	orders.product_code -> products.product_code  a distinctive PK name reused
//
// A candidate is dropped unless the column types are compatible, and a
// column that already has a real foreign key is never guessed at.
func Infer(tables []Table, known []Link) ([]Link, []Unmatched) {
	// Never second-guess a declared constraint.
	declared := make(map[string]bool, len(known))
	for _, l := range known {
		for _, c := range l.FromCols {
			declared[l.From+"\x00"+c] = true
		}
	}

	// Primary-key names in use, so a column can be recognised as
	// key-shaped even when it does not end in _id.
	pkNames := map[string]bool{}
	// Counted per name so a table's own key can be told from a name that
	// genuinely belongs to another table. Backups do not count: a copy
	// sharing the name proves nothing.
	pkOwners := map[string][]string{}
	for i := range tables {
		if len(tables[i].PrimaryKey) != 1 {
			continue
		}
		n := key(tables[i].PrimaryKey[0])
		if generic(n) {
			continue
		}
		pkNames[n] = true
		if !Backupish(tables[i].Name) {
			pkOwners[n] = append(pkOwners[n], tables[i].Name)
		}
	}

	var (
		out  []Link
		miss []Unmatched
	)
	for i := range tables {
		child := &tables[i]
		for _, col := range child.Columns {
			if declared[child.Name+"\x00"+col.Name] {
				continue
			}
			// A copy's primary key holds the original's key values; it is
			// the same identity, not a reference to it. Drawing
			// amember_members_copy1 -> amember_members as a relationship
			// says something untrue about the data.
			if Backupish(child.Name) && isOwnKey(child, col) {
				continue
			}
			best, why, near, cands := bestParent(child, col, tables)
			if best != nil {
				out = append(out, *best)
				continue
			}
			// Only report columns that looked like keys; listing every
			// varchar would bury the signal.
			_, isID := idStem(key(col.Name))
			if !isID && !pkNames[key(col.Name)] {
				continue
			}
			// A table's own single-column primary key is its identity,
			// not a reference to somewhere else -- but only when no other
			// real table owns that key name. Skipping it unconditionally
			// is how a column ended up neither linked nor explained.
			if isOwnKey(child, col) && cands == 0 && onlyOwner(pkOwners[key(col.Name)], child.Name) {
				continue
			}
			miss = append(miss, Unmatched{
				Table: child.Name, Column: col.Name, Type: col.Type,
				Reason: why, Candidates: near,
			})
		}
	}

	sort.Slice(out, func(a, b int) bool {
		if out[a].From != out[b].From {
			return out[a].From < out[b].From
		}
		return out[a].FromCols[0] < out[b].FromCols[0]
	})
	sort.Slice(miss, func(a, b int) bool {
		if miss[a].Table != miss[b].Table {
			return miss[a].Table < miss[b].Table
		}
		return miss[a].Column < miss[b].Column
	})
	return out, miss
}

// candidate is one possible parent for a column, before the best is picked.
type candidate struct {
	table *Table
	pk    string
	rule  string
	score float64
}

// bestParent scores every table that could own this column and returns the
// winner. When there is none it explains why, so the UI can show it.
func bestParent(child *Table, col Column, tables []Table) (*Link, string, []string, int) {
	var (
		cands    []candidate
		rejected []string
	)

	for i := range tables {
		parent := &tables[i]
		if parent.Name == child.Name || parent.Type == "VIEW" {
			continue
		}
		// Only single-column primary keys: a composite key cannot be
		// matched from one column name, and guessing at it would be noise.
		if len(parent.PrimaryKey) != 1 {
			continue
		}
		pk := parent.PrimaryKey[0]

		// A table the application uses does not reference a copy kept
		// aside. Dropping these outright removes the tie instead of
		// merely shading it, which is what the penalty alone did.
		if Backupish(parent.Name) && !Backupish(child.Name) {
			if s, _ := score(col, parent, pk); s >= minConfidence {
				rejected = append(rejected, parent.Name+" (backup copy)")
			}
			continue
		}

		pcol, ok := columnOf(parent, pk)
		if !ok {
			continue
		}
		fit, penalty, note := compatible(col.Type, pcol.Type)
		if !fit {
			// The name matched and the type did not. Saying "no table
			// matches" here would send you looking in the wrong place.
			if s, _ := score(col, parent, pk); s >= minConfidence {
				rejected = append(rejected,
					fmt.Sprintf("%s (%s vs %s)", parent.Name, bareType(col.Type), bareType(pcol.Type)))
			}
			continue
		}
		if s, rule := score(col, parent, pk); s > 0 {
			if note != "" {
				rule += " (" + note + ")"
			}
			// A copy kept aside carries the same key name as the original
			// and would otherwise tie with it forever.
			if Backupish(parent.Name) {
				penalty += backupPenalty
			}
			cands = append(cands, candidate{
				table: parent, pk: pk, rule: rule, score: s - penalty,
			})
		}
	}

	if len(cands) == 0 {
		if len(rejected) > 0 {
			return nil, "name matches, but not usable as a parent", rejected, 0
		}
		return nil, "no table name or primary key matches this column", nil, 0
	}
	sort.SliceStable(cands, func(a, b int) bool { return cands[a].score > cands[b].score })

	top := cands[0]
	if top.score < minConfidence {
		return nil, fmt.Sprintf("best match %s scored %.2f, below the %.2f threshold",
			top.table.Name, top.score, minConfidence), []string{top.table.Name}, len(cands)
	}
	// Too close to call: see ambiguityMargin. The epsilon matters --
	// 0.95-0.3 minus 0.8-0.3 is 0.1499999999999999 in binary floating
	// point, and without slack that exact boundary decided a real link.
	if len(cands) > 1 && top.score-cands[1].score < ambiguityMargin-1e-9 {
		tied := []string{}
		for _, c := range cands {
			if top.score-c.score < ambiguityMargin {
				tied = append(tied, c.table.Name)
			}
		}
		return nil, "ambiguous: several tables match equally well", tied, len(cands)
	}

	return &Link{
		From:       child.Name,
		To:         top.table.Name,
		FromCols:   []string{col.Name},
		ToCols:     []string{top.pk},
		Kind:       KindGuess,
		Rule:       top.rule,
		Confidence: round2(top.score),
	}, "", nil, len(cands)
}

// score rates one child-column / parent pairing, and names the rule that
// earned it.
//
// Every rule is weighed and the best wins. Returning on the first match
// was a real bug: `xsnews_payment.payment_id` hit a weak "prefixed table
// name" rule at 0.6 and never reached the far stronger observation that
// the column *is* `amember_payments`'s primary key.
func score(col Column, parent *Table, pk string) (float64, string) {
	best, rule := 0.0, ""
	take := func(s float64, r string) {
		if s > best {
			best, rule = s, r
		}
	}

	c, p := key(col.Name), key(parent.Name)
	stem, isID := idStem(c)

	// The strongest evidence there is: the column carries the parent's own
	// primary-key name, and that name is specific enough to belong to one
	// table. This is the amember convention -- amember_payments keyed on
	// payment_id rather than on id.
	if c == key(pk) && !generic(c) {
		if isID && strings.Contains(singular(p), singular(stem)) {
			// Corroborated: payment_id, and the table is *_payments.
			take(0.95, "column is the parent's primary key, named for it")
		} else {
			take(0.8, "column is the parent's distinctive primary key")
		}
	}

	if isID {
		switch {
		case stem == p:
			take(0.9, "column_id matches table name")
		case singular(stem) == singular(p):
			take(0.85, "column_id matches table name (plural)")
		case strings.HasSuffix(p, "_"+stem), strings.HasSuffix(singular(p), "_"+singular(stem)):
			// `customer_id` -> `shop_customers`, common where a prefix
			// stands in for a schema.
			take(0.6, "column_id matches a prefixed table name")
		case strings.HasPrefix(p, stem+"_"):
			// Weaker: `user_id` -> `user_settings` is usually wrong, so
			// this only survives when nothing better scores.
			take(0.5, "column_id matches a table name prefix")
		}
	}

	// `orders.product_code` -> `products.code`: the column is the parent's
	// name plus its key.
	if tail, ok := strings.CutPrefix(c, p+"_"); ok && tail == key(pk) {
		take(0.8, "column is table_pk")
	}
	if tail, ok := strings.CutPrefix(c, singular(p)+"_"); ok && tail == key(pk) {
		take(0.75, "column is table_pk (plural)")
	}

	return best, rule
}

// onlyOwner reports whether name is the sole real table owning a key name.
func onlyOwner(owners []string, name string) bool {
	for _, o := range owners {
		if o != name {
			return false
		}
	}
	return true
}

// isOwnKey reports whether a column is the table's whole primary key.
func isOwnKey(t *Table, col Column) bool {
	return len(t.PrimaryKey) == 1 && key(t.PrimaryKey[0]) == key(col.Name)
}

// idStem strips a trailing _id and reports whether there was one.
func idStem(c string) (string, bool) {
	if s, ok := strings.CutSuffix(c, "_id"); ok && s != "" {
		return s, true
	}
	return "", false
}

// generic covers key names that carry no information about which table
// they belong to.
func generic(c string) bool {
	switch c {
	case "id", "uid", "uuid", "guid", "key", "code", "pk", "no", "num", "seq":
		return true
	}
	return false
}

// key normalises an identifier for comparison.
func key(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

// notPlural are endings where a trailing s is part of the word rather
// than a plural: status, alias, analysis, address. Without these, `status`
// singularises to `statu` and stops matching its own table.
var notPlural = []string{"ss", "us", "is"}

// singular strips the usual English plural endings. It is deliberately
// crude: it only has to make `customer` and `customers` meet in the middle.
func singular(s string) string {
	for _, end := range notPlural {
		if strings.HasSuffix(s, end) {
			return s
		}
	}
	switch {
	case strings.HasSuffix(s, "ies") && len(s) > 3:
		return s[:len(s)-3] + "y"
	case strings.HasSuffix(s, "ses"), strings.HasSuffix(s, "xes"), strings.HasSuffix(s, "zes"),
		strings.HasSuffix(s, "ches"), strings.HasSuffix(s, "shes"):
		return s[:len(s)-2]
	case strings.HasSuffix(s, "s") && len(s) > 1:
		return s[:len(s)-1]
	}
	return s
}

// columnOf finds a column by name.
func columnOf(t *Table, name string) (Column, bool) {
	for _, c := range t.Columns {
		if key(c.Name) == key(name) {
			return c, true
		}
	}
	return Column{}, false
}

// signedPenalty is how much confidence a signedness mismatch costs.
const signedPenalty = 0.15

// narrowPenalty is the cost of a child column narrower than the key it
// points at, which cannot address the whole parent table.
const narrowPenalty = 0.15

// compatible reports whether two column types could hold the same values,
// how much the pairing should cost in confidence, and what to say about it.
//
// Widths are ignored on purpose: an INT(10) child pointing at an INT(11)
// parent is completely ordinary.
//
// Signedness used to be a flat rejection, which was wrong. A legacy schema
// full of `int(11)` children pointing at `int(11) unsigned` keys has a
// real relationship and a real latent bug; refusing to draw it hid both.
// It now costs confidence and says so, so the diagram reports the smell
// instead of swallowing the link.
func compatible(a, b string) (fit bool, penalty float64, note string) {
	fa, ua := typeFamily(a)
	fb, ub := typeFamily(b)
	if fa == "" || fa != fb {
		return false, 0, ""
	}
	if fa == "int" {
		// A tinyint pointing at an int key can only address 127 rows: a
		// real relationship carrying a real bug, exactly like the
		// signedness case, so it is reported rather than hidden.
		if cw, pw := intWidth(a), intWidth(b); cw > 0 && pw > 0 && cw < pw {
			return true, narrowPenalty, "narrower than its key"
		}
		if ua != ub {
			return true, signedPenalty, "signedness differs"
		}
	}
	return true, 0, ""
}

// bareType strips length, signedness and anything else off a column type,
// leaving just the type name.
func bareType(t string) string {
	base := strings.ToLower(t)
	if i := strings.IndexAny(base, " ("); i > 0 {
		base = base[:i]
	}
	return base
}

// typeFamily reduces a column type to what matters for joining, plus
// whether it is unsigned.
func typeFamily(t string) (string, bool) {
	unsigned := strings.Contains(strings.ToLower(t), "unsigned")
	base := bareType(t)

	switch base {
	case "tinyint", "smallint", "mediumint", "int", "integer", "bigint", "bit":
		return "int", unsigned
	case "char", "varchar", "tinytext", "text", "mediumtext", "longtext", "enum":
		return "text", false
	case "binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob":
		return "binary", false
	case "decimal", "numeric", "float", "double", "real":
		return "float", unsigned
	case "date", "datetime", "timestamp", "time", "year":
		return "time", false
	}
	return "", false
}

// round2 keeps confidences readable in the JSON.
func round2(f float64) float64 {
	return float64(int(f*100+0.5)) / 100
}
