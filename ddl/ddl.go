// Package ddl turns a desired table-structure into an ALTER TABLE.
//
// This is the only place in mydb where free text from the browser becomes
// SQL, because MySQL accepts no placeholder for an identifier or a type.
// Everything therefore goes through a parser that rebuilds the fragment
// from recognised pieces instead of passing the input along.
package ddl

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/mpdroog/mydb/meta"
)

// Column is one column as the structure-editor wants it to end up.
// Orig is the name it had before, empty for a new column, which is what
// makes a rename unambiguous.
type Column struct {
	Default    *string `json:"default"`
	Orig       string  `json:"orig"`
	Name       string  `json:"name"`
	Type       string  `json:"type"`
	Extra      string  `json:"extra"`
	Comment    string  `json:"comment"`
	Nullable   bool    `json:"nullable"`
	DefaultRaw bool    `json:"default_raw"`
}

// Index is one secondary index as the editor wants it.
type Index struct {
	Orig    string   `json:"orig"`
	Name    string   `json:"name"`
	Columns []string `json:"columns"`
	Unique  bool     `json:"unique"`
}

// Desired is the whole target structure.
type Desired struct {
	Columns    []Column `json:"columns"`
	Indexes    []Index  `json:"indexes"`
	PrimaryKey []string `json:"primary_key"`
	// Comment is the table's own comment. A pointer so that "leave it
	// alone" and "set it to empty" are different requests: a caller that
	// does not know about table comments must not silently clear one.
	Comment *string `json:"comment,omitempty"`
}

// BaseTypes are the column types mydb will write, in the order a person
// looks for them rather than alphabetically. Anything outside this set is
// refused rather than passed through to the server, so the editor can
// offer exactly this list and nothing it offers can be rejected.
func BaseTypes() []string {
	return []string{
		"INT", "BIGINT", "SMALLINT", "TINYINT", "MEDIUMINT",
		"DECIMAL", "FLOAT", "DOUBLE", "BIT",
		"VARCHAR", "CHAR", "TEXT", "TINYTEXT", "MEDIUMTEXT", "LONGTEXT",
		"DATE", "DATETIME", "TIMESTAMP", "TIME", "YEAR",
		"ENUM", "SET", "JSON",
		"BINARY", "VARBINARY", "BLOB", "TINYBLOB", "MEDIUMBLOB", "LONGBLOB",
	}
}

// baseTypes is the set of column types mydb will write. Anything outside
// it is refused rather than passed through to the server.
var baseTypes = map[string]bool{
	"BIT": true, "TINYINT": true, "SMALLINT": true, "MEDIUMINT": true,
	"INT": true, "INTEGER": true, "BIGINT": true, "DECIMAL": true,
	"NUMERIC": true, "FLOAT": true, "DOUBLE": true, "REAL": true,
	"DATE": true, "DATETIME": true, "TIMESTAMP": true, "TIME": true,
	"YEAR": true, "CHAR": true, "VARCHAR": true, "BINARY": true,
	"VARBINARY": true, "TINYBLOB": true, "BLOB": true, "MEDIUMBLOB": true,
	"LONGBLOB": true, "TINYTEXT": true, "TEXT": true, "MEDIUMTEXT": true,
	"LONGTEXT": true, "ENUM": true, "SET": true, "JSON": true,
	"GEOMETRY": true, "POINT": true, "LINESTRING": true, "POLYGON": true,
	"BOOL": true, "BOOLEAN": true,
}

// typeRe splits a type into base name, optional argument list and the
// trailing modifiers, so each part can be validated on its own.
var typeRe = regexp.MustCompile(`(?is)^\s*([a-z]+)\s*(\((.*)\))?\s*(.*?)\s*$`)

// charsetRe validates a charset or collation name.
var charsetRe = regexp.MustCompile(`^[A-Za-z0-9_]+$`)

// numArgsRe validates a length/precision argument list.
var numArgsRe = regexp.MustCompile(`^\s*\d+\s*(,\s*\d+\s*)?$`)

// extras are the column attributes the editor may set.
var extras = map[string]string{
	"":                              "",
	"AUTO_INCREMENT":                "AUTO_INCREMENT",
	"ON UPDATE CURRENT_TIMESTAMP":   "ON UPDATE CURRENT_TIMESTAMP",
	"DEFAULT_GENERATED":             "",
	"ON UPDATE CURRENT_TIMESTAMP()": "ON UPDATE CURRENT_TIMESTAMP",
}

// rawDefaults are the expressions allowed as a DEFAULT without quoting.
var rawDefaults = regexp.MustCompile(`(?i)^(NULL|CURRENT_TIMESTAMP(\(\d?\))?|NOW\(\)|CURRENT_DATE|CURRENT_TIME|UUID\(\))$`)

// numericRe recognises a bare numeric literal.
var numericRe = regexp.MustCompile(`^-?\d+(\.\d+)?$`)

// QuoteString renders a MySQL string literal, escaping what must be escaped.
func QuoteString(s string) (string, error) {
	if strings.ContainsRune(s, 0) {
		return "", errors.New("ddl.QuoteString: NUL in value")
	}
	r := strings.NewReplacer(
		`\`, `\\`,
		`'`, `\'`,
		"\n", `\n`,
		"\r", `\r`,
		"\x1a", `\Z`,
	)
	return "'" + r.Replace(s) + "'", nil
}

// ParseType validates a column type and rebuilds it from its parts.
// The returned string is what goes into the statement, never the input.
func ParseType(t string) (string, error) {
	m := typeRe.FindStringSubmatch(t)
	if m == nil {
		return "", fmt.Errorf("ddl.ParseType: cannot read type %q", t)
	}
	base := strings.ToUpper(m[1])
	if !baseTypes[base] {
		return "", fmt.Errorf("ddl.ParseType: unsupported type %q", base)
	}

	out := base
	args, hasArgs := m[3], m[2] != ""
	if hasArgs {
		rendered, e := typeArgs(base, args)
		if e != nil {
			return "", e
		}
		out += rendered
	}

	mods, e := typeMods(m[4])
	if e != nil {
		return "", e
	}
	return out + mods, nil
}

// typeArgs validates the (...) part of a type.
func typeArgs(base, args string) (string, error) {
	if base == "ENUM" || base == "SET" {
		vals, e := parseStringList(args)
		if e != nil {
			return "", e
		}
		if len(vals) == 0 {
			return "", fmt.Errorf("ddl.typeArgs: %s needs at least one value", base)
		}
		out := make([]string, 0, len(vals))
		for _, v := range vals {
			q, e := QuoteString(v)
			if e != nil {
				return "", e
			}
			out = append(out, q)
		}
		return "(" + strings.Join(out, ",") + ")", nil
	}
	if !numArgsRe.MatchString(args) {
		return "", fmt.Errorf("ddl.typeArgs: %s takes numbers, got %q", base, args)
	}
	return "(" + strings.Join(strings.Fields(strings.ReplaceAll(args, ",", " , ")), "") + ")", nil
}

// typeMods validates the trailing UNSIGNED / CHARACTER SET / COLLATE part.
func typeMods(s string) (string, error) {
	fields := strings.Fields(strings.ToUpper(s))
	var out []string

	for i := 0; i < len(fields); i++ {
		switch fields[i] {
		case "UNSIGNED", "ZEROFILL", "BINARY":
			out = append(out, fields[i])
		case "CHARACTER":
			if i+2 >= len(fields) || fields[i+1] != "SET" {
				return "", fmt.Errorf("ddl.typeMods: bad CHARACTER SET in %q", s)
			}
			if !charsetRe.MatchString(fields[i+2]) {
				return "", fmt.Errorf("ddl.typeMods: bad charset %q", fields[i+2])
			}
			out = append(out, "CHARACTER SET "+strings.ToLower(fields[i+2]))
			i += 2
		case "COLLATE":
			if i+1 >= len(fields) || !charsetRe.MatchString(fields[i+1]) {
				return "", fmt.Errorf("ddl.typeMods: bad COLLATE in %q", s)
			}
			out = append(out, "COLLATE "+strings.ToLower(fields[i+1]))
			i++
		default:
			return "", fmt.Errorf("ddl.typeMods: unsupported modifier %q", fields[i])
		}
	}
	if len(out) == 0 {
		return "", nil
	}
	return " " + strings.Join(out, " "), nil
}

// parseStringList reads the quoted values of an ENUM/SET argument list.
func parseStringList(s string) ([]string, error) {
	var (
		out []string
		cur strings.Builder
		in  bool
	)
	runes := []rune(s)
	for i := 0; i < len(runes); i++ {
		c := runes[i]
		switch {
		case !in && (c == ' ' || c == '\t' || c == '\n' || c == ','):
			// separator outside a literal, nothing to collect
		case !in && c == '\'':
			in = true
			cur.Reset()
		case in && c == '\\' && i+1 < len(runes):
			i++
			cur.WriteRune(unescape(runes[i]))
		case in && c == '\'':
			if i+1 < len(runes) && runes[i+1] == '\'' {
				i++
				cur.WriteRune('\'')
				continue
			}
			in = false
			out = append(out, cur.String())
		case in:
			cur.WriteRune(c)
		default:
			return nil, fmt.Errorf("ddl.parseStringList: unexpected %q in %q", c, s)
		}
	}
	if in {
		return nil, fmt.Errorf("ddl.parseStringList: unterminated value in %q", s)
	}
	return out, nil
}

// unescape resolves a backslash-escape inside a MySQL string literal.
func unescape(c rune) rune {
	switch c {
	case 'n':
		return '\n'
	case 'r':
		return '\r'
	case 't':
		return '\t'
	case '0':
		return 0
	default:
		return c
	}
}

// def renders one column definition, without a position clause.
func def(c Column) (string, error) {
	name, e := meta.QuoteIdent(c.Name)
	if e != nil {
		return "", e
	}
	typ, e := ParseType(c.Type)
	if e != nil {
		return "", e
	}

	var b strings.Builder
	b.WriteString(name)
	b.WriteString(" ")
	b.WriteString(typ)
	if c.Nullable {
		b.WriteString(" NULL")
	} else {
		b.WriteString(" NOT NULL")
	}

	if c.Default != nil {
		lit, e := defaultLiteral(*c.Default, c.DefaultRaw)
		if e != nil {
			return "", e
		}
		b.WriteString(" DEFAULT ")
		b.WriteString(lit)
	}

	extra, ok := extras[strings.ToUpper(strings.TrimSpace(c.Extra))]
	if !ok {
		return "", fmt.Errorf("ddl.def: unsupported extra %q on column %s", c.Extra, c.Name)
	}
	if extra != "" {
		b.WriteString(" ")
		b.WriteString(extra)
	}

	if c.Comment != "" {
		q, e := QuoteString(c.Comment)
		if e != nil {
			return "", e
		}
		b.WriteString(" COMMENT ")
		b.WriteString(q)
	}
	return b.String(), nil
}

// defaultLiteral renders a DEFAULT value. DDL takes no placeholders, so a
// literal is either a recognised expression, a number, or a quoted string.
func defaultLiteral(v string, raw bool) (string, error) {
	if raw {
		if !rawDefaults.MatchString(strings.TrimSpace(v)) {
			return "", fmt.Errorf("ddl.defaultLiteral: %q is not an allowed expression", v)
		}
		return strings.ToUpper(strings.TrimSpace(v)), nil
	}
	if numericRe.MatchString(strings.TrimSpace(v)) {
		return strings.TrimSpace(v), nil
	}
	return QuoteString(v)
}

// Diff turns the current structure plus the desired one into a single
// ALTER TABLE. It returns "" when nothing needs to change.
func Diff(cur *meta.Structure, want Desired) (string, error) {
	qname, e := meta.Qualify(cur.Database, cur.Table)
	if e != nil {
		return "", e
	}

	clauses, e := columnClauses(cur, want)
	if e != nil {
		return "", e
	}
	idxc, e := indexClauses(cur, want)
	if e != nil {
		return "", e
	}
	clauses = append(clauses, idxc...)

	pkc, e := pkClauses(cur, want)
	if e != nil {
		return "", e
	}
	clauses = append(clauses, pkc...)

	// The table's own comment, which is not a column and not an index and
	// so has nowhere else to go.
	if want.Comment != nil && *want.Comment != cur.Comment {
		q, e := QuoteString(*want.Comment)
		if e != nil {
			return "", fmt.Errorf("ddl.Diff comment: %w", e)
		}
		clauses = append(clauses, "COMMENT = "+q)
	}

	if len(clauses) == 0 {
		return "", nil
	}
	return "ALTER TABLE " + qname + "\n  " + strings.Join(clauses, ",\n  "), nil
}

// columnClauses builds the ADD/CHANGE/MODIFY/DROP COLUMN parts.
func columnClauses(cur *meta.Structure, want Desired) ([]string, error) {
	existing := make(map[string]meta.ColumnDef, len(cur.Columns))
	for _, c := range cur.Columns {
		existing[c.Name] = c
	}

	// First pass: work out which columns survive, so "did it move?" can be
	// judged among the survivors. Comparing raw indexes instead would make
	// a single DROP look like every later column moved, and each of those
	// would then be rewritten for nothing.
	kept := make(map[string]bool, len(want.Columns))
	for _, c := range want.Columns {
		if c.Orig == "" {
			continue
		}
		if _, ok := existing[c.Orig]; !ok {
			return nil, fmt.Errorf("ddl.columnClauses: column %q is gone, reload the table", c.Orig)
		}
		kept[c.Orig] = true
	}

	curPos := make(map[string]int, len(kept))
	n := 0
	for _, c := range cur.Columns {
		if kept[c.Name] {
			curPos[c.Name] = n
			n++
		}
	}
	wantPos := make(map[string]int, len(kept))
	n = 0
	for _, c := range want.Columns {
		if c.Orig != "" {
			wantPos[c.Orig] = n
			n++
		}
	}

	out := make([]string, 0, len(want.Columns))
	for i, c := range want.Columns {
		body, e := def(c)
		if e != nil {
			return nil, e
		}
		where, e := position(i, want.Columns)
		if e != nil {
			return nil, e
		}

		// A new column always needs to say where it goes.
		if c.Orig == "" {
			out = append(out, "ADD COLUMN "+body+where)
			continue
		}

		moved := curPos[c.Orig] != wantPos[c.Orig]
		if c.Name != c.Orig {
			q, e := meta.QuoteIdent(c.Orig)
			if e != nil {
				return nil, e
			}
			out = append(out, "CHANGE COLUMN "+q+" "+body+clauseIf(moved, where))
			continue
		}
		same, e := unchanged(existing[c.Orig], c)
		if e != nil {
			return nil, e
		}
		if !same || moved {
			out = append(out, "MODIFY COLUMN "+body+clauseIf(moved, where))
		}
	}

	for _, c := range cur.Columns {
		if kept[c.Name] {
			continue
		}
		q, e := meta.QuoteIdent(c.Name)
		if e != nil {
			return nil, e
		}
		out = append(out, "DROP COLUMN "+q)
	}
	return out, nil
}

// clauseIf keeps a position clause only when the column actually moved.
func clauseIf(yes bool, s string) string {
	if yes {
		return s
	}
	return ""
}

// position renders FIRST or AFTER `x` for the i'th desired column.
func position(i int, cols []Column) (string, error) {
	if i == 0 {
		return " FIRST", nil
	}
	prev, e := meta.QuoteIdent(cols[i-1].Name)
	if e != nil {
		return "", e
	}
	return " AFTER " + prev, nil
}

// unchanged reports whether a column already looks the way the editor wants.
func unchanged(old meta.ColumnDef, want Column) (bool, error) {
	typ, e := ParseType(want.Type)
	if e != nil {
		return false, e
	}
	if !strings.EqualFold(strings.ReplaceAll(old.Type, " ", ""), strings.ReplaceAll(typ, " ", "")) {
		return false, nil
	}
	if old.Nullable != want.Nullable {
		return false, nil
	}
	if old.Comment != want.Comment {
		return false, nil
	}
	if !strings.EqualFold(strings.TrimSpace(old.Extra), strings.TrimSpace(want.Extra)) {
		return false, nil
	}
	switch {
	case old.Default == nil && want.Default == nil:
		return true, nil
	case old.Default == nil || want.Default == nil:
		return false, nil
	default:
		return *old.Default == *want.Default, nil
	}
}

// indexClauses builds the ADD/DROP INDEX parts. A changed index is dropped
// and re-added, which is what MySQL does under the hood anyway.
func indexClauses(cur *meta.Structure, want Desired) ([]string, error) {
	existing := make(map[string]meta.Index, len(cur.Indexes))
	for _, i := range cur.Indexes {
		existing[i.Name] = i
	}

	kept := make(map[string]bool, len(want.Indexes))
	var drops, adds []string

	for _, i := range want.Indexes {
		add, e := addIndex(i)
		if e != nil {
			return nil, e
		}

		if i.Orig == "" {
			adds = append(adds, add)
			continue
		}
		old, ok := existing[i.Orig]
		if !ok {
			return nil, fmt.Errorf("ddl.indexClauses: index %q is gone, reload the table", i.Orig)
		}
		kept[i.Orig] = true
		if sameIndex(old, i) {
			continue
		}
		drop, e := dropIndex(i.Orig)
		if e != nil {
			return nil, e
		}
		drops = append(drops, drop)
		adds = append(adds, add)
	}

	for _, i := range cur.Indexes {
		if kept[i.Name] {
			continue
		}
		drop, e := dropIndex(i.Name)
		if e != nil {
			return nil, e
		}
		drops = append(drops, drop)
	}
	// Drops first: re-adding a name we are also dropping must not collide.
	return append(drops, adds...), nil
}

// sameIndex reports whether an index already matches what the editor wants.
func sameIndex(old meta.Index, want Index) bool {
	if old.Name != want.Name || old.Unique != want.Unique || len(old.Columns) != len(want.Columns) {
		return false
	}
	for i := range old.Columns {
		if old.Columns[i] != want.Columns[i] {
			return false
		}
	}
	return true
}

// addIndex renders an ADD INDEX clause.
func addIndex(i Index) (string, error) {
	if len(i.Columns) == 0 {
		return "", fmt.Errorf("ddl.addIndex: index %q has no columns", i.Name)
	}
	name, e := meta.QuoteIdent(i.Name)
	if e != nil {
		return "", e
	}
	cols, e := quoteList(i.Columns)
	if e != nil {
		return "", e
	}
	kind := "INDEX"
	if i.Unique {
		kind = "UNIQUE INDEX"
	}
	return "ADD " + kind + " " + name + " (" + cols + ")", nil
}

// dropIndex renders a DROP INDEX clause.
func dropIndex(name string) (string, error) {
	q, e := meta.QuoteIdent(name)
	if e != nil {
		return "", e
	}
	return "DROP INDEX " + q, nil
}

// pkClauses builds the primary-key parts.
func pkClauses(cur *meta.Structure, want Desired) ([]string, error) {
	if equalStrings(cur.PrimaryKey, want.PrimaryKey) {
		return nil, nil
	}
	var out []string
	if len(cur.PrimaryKey) > 0 {
		out = append(out, "DROP PRIMARY KEY")
	}
	if len(want.PrimaryKey) > 0 {
		cols, e := quoteList(want.PrimaryKey)
		if e != nil {
			return nil, e
		}
		out = append(out, "ADD PRIMARY KEY ("+cols+")")
	}
	return out, nil
}

// quoteList renders a comma-separated list of quoted identifiers.
func quoteList(names []string) (string, error) {
	out := make([]string, 0, len(names))
	for _, n := range names {
		q, e := meta.QuoteIdent(n)
		if e != nil {
			return "", e
		}
		out = append(out, q)
	}
	return strings.Join(out, ", "), nil
}

// equalStrings compares two ordered string slices.
func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
