package stmt

import "strings"

// Statement is one statement out of a script, with the offsets it occupied
// in the source. The offsets are what lets the console work out which
// statement the cursor is sitting in.
type Statement struct {
	SQL   string `json:"sql"`
	Start int    `json:"start"`
	End   int    `json:"end"`
}

// routineWords introduce a body that has its own semicolons in it. The
// mysql client deals with that through DELIMITER, which is a client-side
// command mydb does not implement; splitting such a script on ";" would
// cut the body in half and run the pieces, so it is left whole instead.
var routineWords = map[string]bool{
	"PROCEDURE": true, "FUNCTION": true, "TRIGGER": true, "EVENT": true,
}

// Split cuts a script into its statements on top-level semicolons.
//
// Semicolons inside strings, identifiers, comments and parentheses are not
// boundaries. Empty statements — a stray ";" or a trailing comment — are
// dropped rather than submitted as blank queries.
func Split(s string) []Statement {
	toks := tokens(s)
	if hasRoutine(toks) {
		if one, ok := trim(s, 0, len(s)); ok {
			return []Statement{one}
		}
		return nil
	}

	out := make([]Statement, 0, 4)
	start := 0
	for _, t := range toks {
		if t.Kind != kindPunct || t.Text != ";" || t.Depth != 0 {
			continue
		}
		if one, ok := trim(s, start, t.Start); ok {
			out = append(out, one)
		}
		start = t.End
	}
	if one, ok := trim(s, start, len(s)); ok {
		out = append(out, one)
	}
	return out
}

// hasRoutine reports whether the script declares a stored routine.
func hasRoutine(toks []token) bool {
	for i, t := range toks {
		if t.Kind != kindWord || t.Upper != "CREATE" {
			continue
		}
		// CREATE DEFINER=`x`@`y` PROCEDURE ... puts a few tokens in between.
		for j := i + 1; j < len(toks) && j <= i+12; j++ {
			if toks[j].Kind == kindWord && routineWords[toks[j].Upper] {
				return true
			}
		}
	}
	return false
}

// trim cuts s[a:b] down to its non-blank part, false when nothing is left.
// A run that holds only comments and whitespace tokenizes to nothing, so it
// is dropped: submitting it would be an empty statement.
func trim(s string, a, b int) (Statement, bool) {
	if a > b || b > len(s) {
		return Statement{}, false
	}
	raw := s[a:b]
	lead := len(raw) - len(strings.TrimLeft(raw, " \t\r\n"))
	tail := len(raw) - len(strings.TrimRight(raw, " \t\r\n;"))
	a, b = a+lead, b-tail
	if a >= b || len(tokens(s[a:b])) == 0 {
		return Statement{}, false
	}
	return Statement{SQL: s[a:b], Start: a, End: b}, true
}
