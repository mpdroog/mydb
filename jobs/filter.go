package jobs

import (
	"regexp"
	"strings"
)

// The grid's filter box takes the tail of the SELECT, so all of these are
// meant to work:
//
//	status = 'new'
//	WHERE status = 'new'
//	status = 'new' ORDER BY total DESC
//	ORDER BY created_at DESC
//	status = 'new' LIMIT 50
//
// Writing the WHERE keyword is the natural thing to do, and mydb adds its
// own, so a fragment that already has one produced "WHERE WHERE ...".
// Supplying an ORDER BY or LIMIT has to suppress mydb's, or the statement
// ends up with two of them.
var (
	leadingWhere = regexp.MustCompile(`(?is)^\s*where\b\s*`)
	orderByRe    = regexp.MustCompile(`(?is)\border\s+by\b`)
	limitRe      = regexp.MustCompile(`(?is)\blimit\b`)
	leadsOrderRe = regexp.MustCompile(`(?is)^\s*(order\s+by|limit)\b`)
)

// filter is a parsed filter-box fragment.
type filter struct {
	// Tail is the fragment with a leading WHERE and trailing semicolons
	// removed.
	Tail string
	// NeedsWhere is false when the fragment is only an ORDER BY / LIMIT,
	// in which case there is no condition to introduce.
	NeedsWhere bool
	// HasOrder and HasLimit say the fragment brings its own, so mydb must
	// not append a second.
	HasOrder bool
	HasLimit bool
}

// parseFilter reads what the user typed into the filter box.
//
// The keyword search runs over a copy with string literals, quoted
// identifiers and comments blanked out, so a value like 'order by date'
// cannot be mistaken for the clause.
func parseFilter(s string) filter {
	s = strings.TrimSpace(s)
	s = strings.TrimRight(s, "; \t\r\n")
	if s == "" {
		return filter{}
	}
	if m := leadingWhere.FindString(s); m != "" {
		s = s[len(m):]
		s = strings.TrimSpace(s)
	}
	if s == "" {
		return filter{}
	}

	bare := blankLiterals(s)
	return filter{
		Tail:       s,
		NeedsWhere: !leadsOrderRe.MatchString(bare),
		HasOrder:   orderByRe.MatchString(bare),
		HasLimit:   limitRe.MatchString(bare),
	}
}

// blankLiterals returns s with every string literal, quoted identifier and
// comment replaced by spaces, keeping the same length so positions still
// line up. Everything else is copied through.
func blankLiterals(s string) string {
	out := make([]byte, len(s))
	for i := range out {
		out[i] = ' '
	}

	i := 0
	for i < len(s) {
		c := s[i]
		switch {
		case c == '\'' || c == '"' || c == '`':
			i = skipQuoted(s, i)
		case c == '-' && i+1 < len(s) && s[i+1] == '-',
			c == '#':
			for i < len(s) && s[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < len(s) && s[i+1] == '*':
			i += 2
			for i+1 < len(s) && (s[i] != '*' || s[i+1] != '/') {
				i++
			}
			i = min(i+2, len(s))
		default:
			out[i] = c
			i++
		}
	}
	return string(out)
}

// skipQuoted walks past the literal starting at s[i] and returns the index
// just after it.
func skipQuoted(s string, i int) int {
	q := s[i]
	i++
	for i < len(s) {
		// Backslash escapes apply inside '' and "" but not inside ``.
		if q != '`' && s[i] == '\\' && i+1 < len(s) {
			i += 2
			continue
		}
		if s[i] == q {
			// A doubled quote is an escaped quote, not the end.
			if i+1 < len(s) && s[i+1] == q {
				i += 2
				continue
			}
			return i + 1
		}
		i++
	}
	return i
}
