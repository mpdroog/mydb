// Package stmt reads SQL well enough to answer the two questions mydb asks
// before it runs anything: where one statement ends and the next begins,
// and whether a statement changes data without naming which rows.
//
// It is a tokenizer, not a parser. It understands quoting, comments and
// nesting, and nothing else. That is deliberate: mydb never rewrites what
// you typed, it only decides whether to run it or ask first. Everything
// here has to survive a value like `'; DROP TABLE x --` sitting inside a
// string literal, which is exactly what the quoting rules are for.
package stmt

import "strings"

// kind is what a token is, as far as anything here needs to care.
type kind int

const (
	// kindWord is a bare word: a keyword, an identifier or a number.
	kindWord kind = iota
	// kindIdent is a `backtick quoted` identifier.
	kindIdent
	// kindString is a 'literal' or "literal".
	kindString
	// kindPunct is a single character of anything else.
	kindPunct
)

// token is one lexical piece of a statement. Start and End are byte offsets
// into the original string, so a caller can slice the source back out
// verbatim rather than reassembling it from tokens.
type token struct {
	Text  string
	Upper string
	Kind  kind
	Depth int
	Start int
	End   int
}

// isWordByte reports whether c can appear in a bare word. Bytes above ASCII
// are included so a UTF-8 identifier stays one token.
func isWordByte(c byte) bool {
	return c >= 'a' && c <= 'z' ||
		c >= 'A' && c <= 'Z' ||
		c >= '0' && c <= '9' ||
		c == '_' || c == '$' || c >= 0x80
}

// isSpace reports whether c separates tokens.
func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\r' || c == '\n'
}

// tokens splits s into tokens, dropping whitespace and comments.
//
// Depth is the parenthesis nesting the token sits at, which is what keeps a
// WHERE belonging to a subquery from being mistaken for the statement's own.
func tokens(s string) []token {
	out := make([]token, 0, 32)
	depth := 0

	for i := 0; i < len(s); {
		c := s[i]
		switch {
		case isSpace(c):
			i++

		// MySQL only treats -- as a comment when whitespace follows it, so
		// `a--1` is a subtraction and has to stay one expression.
		case c == '-' && i+1 < len(s) && s[i+1] == '-' &&
			(i+2 >= len(s) || isSpace(s[i+2])):
			i = lineEnd(s, i)
		case c == '#':
			i = lineEnd(s, i)
		case c == '/' && i+1 < len(s) && s[i+1] == '*':
			i = blockEnd(s, i)

		case c == '\'' || c == '"' || c == '`':
			end := skipQuoted(s, i)
			k := kindString
			if c == '`' {
				k = kindIdent
			}
			out = append(out, token{
				Text: unquote(s[i:end]), Kind: k, Depth: depth, Start: i, End: end,
			})
			i = end

		case isWordByte(c):
			start := i
			for i < len(s) && isWordByte(s[i]) {
				i++
			}
			w := s[start:i]
			out = append(out, token{
				Text: w, Upper: strings.ToUpper(w), Kind: kindWord,
				Depth: depth, Start: start, End: i,
			})

		default:
			if c == '(' {
				depth++
			}
			if c == ')' && depth > 0 {
				depth--
			}
			out = append(out, token{
				Text: string(c), Kind: kindPunct, Depth: depth, Start: i, End: i + 1,
			})
			i++
		}
	}
	return out
}

// lineEnd returns the index just past the end of the line starting at i.
func lineEnd(s string, i int) int {
	if n := strings.IndexByte(s[i:], '\n'); n >= 0 {
		return i + n + 1
	}
	return len(s)
}

// blockEnd returns the index just past the /* */ comment starting at i.
// An unterminated comment runs to the end, which is what MySQL does too.
func blockEnd(s string, i int) int {
	if n := strings.Index(s[i+2:], "*/"); n >= 0 {
		return i + 2 + n + 2
	}
	return len(s)
}

// skipQuoted returns the index just past the quoted run starting at i.
// Copied in spirit from jobs.skipQuoted: a doubled quote is an escaped
// quote, and a backslash escapes inside '' and "" but not inside ``.
func skipQuoted(s string, i int) int {
	q := s[i]
	i++
	for i < len(s) {
		if q != '`' && s[i] == '\\' && i+1 < len(s) {
			i += 2
			continue
		}
		if s[i] == q {
			if i+1 < len(s) && s[i+1] == q {
				i += 2
				continue
			}
			return i + 1
		}
		i++
	}
	return len(s)
}

// unquote strips the quotes off a quoted run and undoubles what is inside.
// The result is the name or value as the server would read it, which is
// what a confirmation dialog should be showing a human.
func unquote(s string) string {
	if len(s) < 2 {
		return s
	}
	q := s[0]
	body := s[1 : len(s)-1]
	// An unterminated literal keeps everything after the opening quote.
	if s[len(s)-1] != q {
		body = s[1:]
	}
	return strings.ReplaceAll(body, string([]byte{q, q}), string(q))
}
