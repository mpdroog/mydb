package stmt

// Risk describes a statement that changes or destroys data without naming
// which rows. mydb refuses to run one until it has been confirmed, because
// the difference between `DELETE FROM orders WHERE id = 5` and
// `DELETE FROM orders` is one keystroke and a restore from backup.
type Risk struct {
	// Verb is the statement as a human would name it: "UPDATE",
	// "DELETE", "TRUNCATE", "DROP TABLE", "DROP DATABASE".
	Verb string `json:"verb"`
	// Target is the table or database it names, "" when it could not be
	// read out with confidence.
	Target string `json:"target,omitempty"`
	// Reason says what will happen, in the words the dialog shows.
	Reason string `json:"reason"`
	// Countable is true when Target is a table a SELECT COUNT(*) can be
	// run against, so the dialog can offer to say how many rows this is
	// about to touch before it touches them.
	Countable bool `json:"countable"`
	// CountSQL is that statement, filled in by the caller: quoting an
	// identifier is not this package's job, and mydb only has one function
	// that does it.
	CountSQL string `json:"count_sql,omitempty"`
}

// modifiers sit between the verb and the table it acts on.
var modifiers = map[string]bool{
	"LOW_PRIORITY": true, "QUICK": true, "IGNORE": true, "TABLE": true,
}

// Inspect reports what is dangerous about a statement, nil when nothing is.
//
// The rule is deliberately narrow and easy to predict: an UPDATE or DELETE
// with no WHERE of its own, or a TRUNCATE or DROP of a table or database.
// A WHERE inside a subquery does not count — that is the case a naive
// keyword search gets wrong, and it is the one that matters.
//
// A LIMIT is not accepted in place of a WHERE. `DELETE FROM t LIMIT 10`
// deletes ten rows nobody chose, which is not meaningfully safer.
func Inspect(sql string) *Risk {
	toks := tokens(sql)
	i := verbAt(toks)
	if i < 0 {
		return nil
	}

	switch toks[i].Upper {
	case "UPDATE":
		if hasTopLevelWhere(toks) {
			return nil
		}
		t := tableAfter(toks, i+1)
		return &Risk{
			Verb: "UPDATE", Target: t, Countable: t != "",
			Reason: "no WHERE clause: this changes every row in the table",
		}

	case "DELETE":
		if hasTopLevelWhere(toks) {
			return nil
		}
		t := tableAfter(toks, fromAt(toks, i))
		return &Risk{
			Verb: "DELETE", Target: t, Countable: t != "",
			Reason: "no WHERE clause: this deletes every row in the table",
		}

	case "TRUNCATE":
		t := tableAfter(toks, i+1)
		return &Risk{
			Verb: "TRUNCATE", Target: t, Countable: t != "",
			Reason: "empties the table, and cannot be rolled back",
		}

	case "DROP":
		return dropRisk(toks, i)
	}
	return nil
}

// dropRisk classifies a DROP. Only the two that lose data get in the way;
// dropping an index or a view is recoverable from the schema and asking
// about it would only teach you to click through the dialog.
func dropRisk(toks []token, i int) *Risk {
	what := ""
	if i+1 < len(toks) && toks[i+1].Kind == kindWord {
		what = toks[i+1].Upper
	}
	switch what {
	case "TABLE":
		t := tableAfter(toks, i+2)
		return &Risk{
			Verb: "DROP TABLE", Target: t, Countable: t != "",
			Reason: "removes the table and everything in it",
		}
	case "DATABASE", "SCHEMA":
		return &Risk{
			Verb:   "DROP " + what,
			Target: tableAfter(toks, i+2),
			Reason: "removes the database and every table in it",
		}
	}
	return nil
}

// verbAt finds the word that says what the statement does, skipping leading
// parentheses and stepping over a CTE — `WITH x AS (...) DELETE FROM t` is
// still a DELETE, and the subquery it opens with is not the verb.
func verbAt(toks []token) int {
	for i, t := range toks {
		if t.Kind == kindPunct && t.Text == "(" {
			continue
		}
		if t.Kind != kindWord {
			return -1
		}
		if t.Upper != "WITH" {
			return i
		}
		// The CTE bodies are parenthesised, so the statement's own verb is
		// the next word back at depth 0 that is not part of the "x AS" list.
		for j := i + 1; j < len(toks); j++ {
			if toks[j].Kind != kindWord || toks[j].Depth != 0 {
				continue
			}
			switch toks[j].Upper {
			case "UPDATE", "DELETE", "SELECT", "INSERT", "REPLACE":
				return j
			}
		}
		return -1
	}
	return -1
}

// hasTopLevelWhere reports whether the statement carries its own WHERE.
// Depth is what does the work here: the WHERE in
// `UPDATE t SET x = (SELECT y FROM z WHERE ...)` belongs to the subquery
// and leaves every row of t still in scope.
func hasTopLevelWhere(toks []token) bool {
	for _, t := range toks {
		if t.Kind == kindWord && t.Depth == 0 && t.Upper == "WHERE" {
			return true
		}
	}
	return false
}

// fromAt finds the FROM of a DELETE, so that both the plain form and the
// multi-table `DELETE a, b FROM a JOIN b` land on the right table.
func fromAt(toks []token, i int) int {
	for j := i; j < len(toks); j++ {
		if toks[j].Kind == kindWord && toks[j].Depth == 0 && toks[j].Upper == "FROM" {
			return j + 1
		}
	}
	return i + 1
}

// tableAfter reads the table name starting at i, skipping the modifiers
// that may come first and joining a `db`.`table` back together.
//
// It stops at anything it does not recognise rather than guessing: an empty
// target makes the dialog say "this table" instead of naming the wrong one.
func tableAfter(toks []token, i int) string {
	for i < len(toks) && toks[i].Kind == kindWord && modifiers[toks[i].Upper] {
		i++
	}
	// DROP TABLE IF EXISTS t
	if i+1 < len(toks) && toks[i].Kind == kindWord && toks[i].Upper == "IF" &&
		toks[i+1].Kind == kindWord && toks[i+1].Upper == "EXISTS" {
		i += 2
	}
	if i >= len(toks) || (toks[i].Kind != kindWord && toks[i].Kind != kindIdent) {
		return ""
	}

	name := toks[i].Text
	// A qualified name arrives as three tokens: name, ".", name.
	if i+2 < len(toks) && toks[i+1].Kind == kindPunct && toks[i+1].Text == "." &&
		(toks[i+2].Kind == kindWord || toks[i+2].Kind == kindIdent) {
		name += "." + toks[i+2].Text
	}
	return name
}
