package meta

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// ErrNoSuchTable is returned when a name does not exist on the server.
// Every identifier is checked against the live schema before it is ever
// glued into a statement, because MySQL has no placeholder for identifiers.
var ErrNoSuchTable = errors.New("meta: no such database or table")

// QuoteIdent wraps a MySQL identifier in backticks, doubling any it holds.
// This is the only place in mydb that builds an identifier, everything
// else goes through it.
func QuoteIdent(s string) (string, error) {
	if s == "" {
		return "", errors.New("meta.QuoteIdent: empty identifier")
	}
	if strings.ContainsRune(s, 0) {
		return "", errors.New("meta.QuoteIdent: NUL in identifier")
	}
	if len(s) > 64 {
		return "", fmt.Errorf("meta.QuoteIdent: identifier longer than 64 chars: %q", s[:64])
	}
	return "`" + strings.ReplaceAll(s, "`", "``") + "`", nil
}

// Qualify builds a quoted `db`.`table`.
func Qualify(db, table string) (string, error) {
	d, e := QuoteIdent(db)
	if e != nil {
		return "", e
	}
	t, e := QuoteIdent(table)
	if e != nil {
		return "", e
	}
	return d + "." + t, nil
}

// Table is one row of the table-list in the sidebar.
type Table struct {
	Name    string `json:"name"`
	Engine  string `json:"engine"`
	Comment string `json:"comment"`
	Type    string `json:"type"`
	Rows    int64  `json:"rows"`
}

// Databases lists the schemas on the server.
func Databases(ctx context.Context, q Querier) ([]string, error) {
	out, e := Strings(ctx, q, "SHOW DATABASES")
	if e != nil {
		return nil, e
	}
	sort.Strings(out)
	return out, nil
}

// Tables lists a schema's tables and views with their row-estimate.
// TABLE_ROWS is an estimate on InnoDB, which is fine for a sidebar hint.
func Tables(ctx context.Context, q Querier, db string) ([]Table, error) {
	const query = `SELECT TABLE_NAME, IFNULL(ENGINE,''), IFNULL(TABLE_ROWS,0),
	       IFNULL(TABLE_COMMENT,''), TABLE_TYPE
	  FROM information_schema.TABLES
	 WHERE TABLE_SCHEMA = ?
	 ORDER BY TABLE_NAME`

	res, e := Query(ctx, q, 0, query, db)
	if e != nil {
		return nil, e
	}

	out := make([]Table, 0, len(res.Rows))
	for _, r := range res.Rows {
		t := Table{
			Name:    deref(r[0]),
			Engine:  deref(r[1]),
			Comment: deref(r[3]),
			Type:    deref(r[4]),
		}
		if n, e := strconv.ParseInt(deref(r[2]), 10, 64); e == nil {
			t.Rows = n
		}
		out = append(out, t)
	}
	return out, nil
}

// ColumnDef is one column as the structure-editor sees it.
type ColumnDef struct {
	Default   *string `json:"default"`
	Name      string  `json:"name"`
	Type      string  `json:"type"`
	Collation string  `json:"collation"`
	Extra     string  `json:"extra"`
	Comment   string  `json:"comment"`
	Nullable  bool    `json:"nullable"`
}

// Binary reports whether this column holds bytes rather than text, which
// the grid shows hex-encoded and refuses to edit inline.
func (c ColumnDef) Binary() bool {
	t := strings.ToUpper(c.Type)
	if i := strings.IndexAny(t, " ("); i > 0 {
		t = t[:i]
	}
	return binaryTypes[t]
}

// Index is one secondary index or the primary key.
type Index struct {
	Name    string   `json:"name"`
	Type    string   `json:"type"`
	Columns []string `json:"columns"`
	Unique  bool     `json:"unique"`
}

// Structure is everything the CMD+D editor needs about one table.
type Structure struct {
	Database   string      `json:"database"`
	Table      string      `json:"table"`
	CreateSQL  string      `json:"create_sql"`
	Columns    []ColumnDef `json:"columns"`
	Indexes    []Index     `json:"indexes"`
	PrimaryKey []string    `json:"primary_key"`
}

// Exists reports whether db.table is really there. Callers must run this
// before interpolating the names into a statement.
func Exists(ctx context.Context, q Querier, db, table string) error {
	const query = `SELECT 1 FROM information_schema.TABLES
	 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1`
	res, e := Query(ctx, q, 1, query, db, table)
	if e != nil {
		return e
	}
	if len(res.Rows) == 0 {
		return fmt.Errorf("%w: %s.%s", ErrNoSuchTable, db, table)
	}
	return nil
}

// Describe reads a table's columns, indexes, primary key and CREATE TABLE.
// It uses SHOW rather than information_schema so it behaves the same on
// MySQL 5.7/8 and MariaDB, and reads the output by column-name so an extra
// column in a newer version cannot break the scan.
func Describe(ctx context.Context, q Querier, db, table string) (*Structure, error) {
	if e := Exists(ctx, q, db, table); e != nil {
		return nil, e
	}
	qname, e := Qualify(db, table)
	if e != nil {
		return nil, e
	}

	s := &Structure{Database: db, Table: table}
	if s.Columns, e = describeColumns(ctx, q, qname); e != nil {
		return nil, e
	}
	if s.Indexes, s.PrimaryKey, e = describeIndexes(ctx, q, qname); e != nil {
		return nil, e
	}
	if s.CreateSQL, e = createTable(ctx, q, qname); e != nil {
		return nil, e
	}
	return s, nil
}

// describeColumns reads SHOW FULL COLUMNS.
func describeColumns(ctx context.Context, q Querier, qname string) ([]ColumnDef, error) {
	res, e := Query(ctx, q, 0, "SHOW FULL COLUMNS FROM "+qname) //nolint:gosec // G202: qname went through meta.Qualify and meta.Exists
	if e != nil {
		return nil, e
	}
	idx := byName(res)

	out := make([]ColumnDef, 0, len(res.Rows))
	for _, r := range res.Rows {
		out = append(out, ColumnDef{
			Name:      cell(r, idx, "Field"),
			Type:      cell(r, idx, "Type"),
			Collation: cell(r, idx, "Collation"),
			Nullable:  strings.EqualFold(cell(r, idx, "Null"), "YES"),
			Default:   cellPtr(r, idx, "Default"),
			Extra:     cell(r, idx, "Extra"),
			Comment:   cell(r, idx, "Comment"),
		})
	}
	return out, nil
}

// describeIndexes reads SHOW INDEX and splits the primary key out of it.
func describeIndexes(ctx context.Context, q Querier, qname string) ([]Index, []string, error) {
	res, e := Query(ctx, q, 0, "SHOW INDEX FROM "+qname) //nolint:gosec // G202: qname went through meta.Qualify and meta.Exists
	if e != nil {
		return nil, nil, e
	}
	idx := byName(res)

	type entry struct {
		seq  int
		col  string
		name string
		typ  string
		uniq bool
	}
	entries := make([]entry, 0, len(res.Rows))
	for _, r := range res.Rows {
		// A server that omits Seq_in_index leaves seq at 0, which keeps
		// the rows in the order the server sent them.
		seq, e := strconv.Atoi(cell(r, idx, "Seq_in_index"))
		if e != nil {
			seq = 0
		}
		entries = append(entries, entry{
			name: cell(r, idx, "Key_name"),
			col:  cell(r, idx, "Column_name"),
			typ:  cell(r, idx, "Index_type"),
			uniq: cell(r, idx, "Non_unique") == "0",
			seq:  seq,
		})
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].seq < entries[j].seq })

	var (
		pk    []string
		order []string
		byKey = map[string]*Index{}
	)
	for _, en := range entries {
		if en.name == "PRIMARY" {
			pk = append(pk, en.col)
			continue
		}
		if _, ok := byKey[en.name]; !ok {
			byKey[en.name] = &Index{Name: en.name, Unique: en.uniq, Type: en.typ}
			order = append(order, en.name)
		}
		byKey[en.name].Columns = append(byKey[en.name].Columns, en.col)
	}

	out := make([]Index, 0, len(order))
	for _, name := range order {
		out = append(out, *byKey[name])
	}
	return out, pk, nil
}

// createTable reads the verbatim CREATE TABLE statement.
func createTable(ctx context.Context, q Querier, qname string) (string, error) {
	res, e := Query(ctx, q, 1, "SHOW CREATE TABLE "+qname) //nolint:gosec // G202: qname went through meta.Qualify and meta.Exists
	if e != nil {
		return "", e
	}
	if len(res.Rows) == 0 || len(res.Rows[0]) < 2 {
		return "", nil
	}
	// Column 1 is "Create Table" for tables and "Create View" for views.
	return deref(res.Rows[0][len(res.Rows[0])-1]), nil
}

// PrimaryKey returns just the primary-key columns, in order.
func PrimaryKey(ctx context.Context, q Querier, db, table string) ([]string, error) {
	qname, e := Qualify(db, table)
	if e != nil {
		return nil, e
	}
	_, pk, e := describeIndexes(ctx, q, qname)
	if e != nil {
		return nil, e
	}
	return pk, nil
}

// byName maps a result-set's column-names to their position.
func byName(r *Result) map[string]int {
	out := make(map[string]int, len(r.Cols))
	for i, c := range r.Cols {
		out[c.Name] = i
	}
	return out
}

// cell reads a named column out of a row, "" when absent or NULL.
func cell(row []*string, idx map[string]int, name string) string {
	return deref(cellPtr(row, idx, name))
}

// cellPtr reads a named column, keeping NULL distinct from "".
func cellPtr(row []*string, idx map[string]int, name string) *string {
	i, ok := idx[name]
	if !ok || i >= len(row) {
		return nil
	}
	return row[i]
}

// deref flattens a nullable string, NULL becomes "".
func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
