// Package erm builds an entity-relationship model of a schema: the tables,
// the links between them, and a grouping that makes the result readable.
//
// Links come from two places. Declared foreign keys are facts. Everything
// else is inferred from naming, because a great many schemas carry no FK
// constraints at all and would otherwise draw as a page of disconnected
// boxes. Inference here reads metadata only, never table data, so it is
// safe to point at production.
package erm

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/mpdroog/mydb/meta"
)

// Column is one column, as much of it as a diagram needs.
type Column struct {
	Name string `json:"name"`
	Type string `json:"type"`
	// Key is "PRI", "UNI", "MUL" or "" straight from the server.
	Key      string `json:"key,omitempty"`
	Nullable bool   `json:"nullable"`
}

// Table is one box in the diagram.
type Table struct {
	Name       string   `json:"name"`
	Type       string   `json:"type"`
	Columns    []Column `json:"columns"`
	PrimaryKey []string `json:"primary_key"`
	Rows       int64    `json:"rows"`
	// Backup marks a name that looks like a copy kept aside rather than a
	// table the application uses.
	Backup bool `json:"backup,omitempty"`
}

// Kind says where a link came from.
type Kind string

// The two sorts of link a diagram can hold.
const (
	// KindFK is declared in the schema and is simply true.
	KindFK Kind = "fk"
	// KindGuess was inferred from naming and may be wrong.
	KindGuess Kind = "guess"
)

// Link is one edge: From.FromCols references To.ToCols.
type Link struct {
	From       string   `json:"from"`
	To         string   `json:"to"`
	FromCols   []string `json:"from_cols"`
	ToCols     []string `json:"to_cols"`
	Kind       Kind     `json:"kind"`
	Rule       string   `json:"rule,omitempty"`
	Name       string   `json:"name,omitempty"`
	Confidence float64  `json:"confidence"`
}

// Schema is the whole model handed to the renderer.
type Schema struct {
	Database string  `json:"database"`
	Tables   []Table `json:"tables"`
	Links    []Link  `json:"links"`
	Groups   []Group `json:"groups"`
	// Unmatched are key-shaped columns that mydb chose not to link, with
	// the reason. Shown in the UI so a sparse diagram can be told apart
	// from an over-strict rule.
	Unmatched []Unmatched `json:"unmatched"`
}

// Load reads a whole schema in four queries rather than per-table, which
// matters on a database with a few hundred tables.
func Load(ctx context.Context, q meta.Querier, db string) (*Schema, error) {
	s := &Schema{Database: db}

	tables, e := loadTables(ctx, q, db)
	if e != nil {
		return nil, e
	}
	if e := loadColumns(ctx, q, db, tables); e != nil {
		return nil, e
	}
	if e := loadPrimaryKeys(ctx, q, db, tables); e != nil {
		return nil, e
	}
	fks, e := loadForeignKeys(ctx, q, db)
	if e != nil {
		return nil, e
	}

	names := make([]string, 0, len(tables))
	for name := range tables {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		s.Tables = append(s.Tables, *tables[name])
	}

	guessed, miss := Infer(s.Tables, fks)
	links := make([]Link, 0, len(fks)+len(guessed))
	links = append(links, fks...)
	links = append(links, guessed...)
	s.Links = links
	s.Unmatched = miss
	s.Groups = Cluster(s.Tables, s.Links)
	return s, nil
}

// loadTables reads the table list.
func loadTables(ctx context.Context, q meta.Querier, db string) (map[string]*Table, error) {
	const query = `SELECT TABLE_NAME, TABLE_TYPE, IFNULL(TABLE_ROWS,0)
	  FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`

	res, e := meta.Query(ctx, q, 0, query, db)
	if e != nil {
		return nil, fmt.Errorf("erm.loadTables: %w", e)
	}

	out := make(map[string]*Table, len(res.Rows))
	for _, r := range res.Rows {
		t := &Table{Name: str(r, 0), Type: str(r, 1)}
		t.Rows = num(r, 2)
		t.Backup = Backupish(t.Name)
		out[t.Name] = t
	}
	return out, nil
}

// loadColumns fills every table's column list in one pass.
func loadColumns(ctx context.Context, q meta.Querier, db string, tables map[string]*Table) error {
	const query = `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, IFNULL(COLUMN_KEY,'')
	  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?
	 ORDER BY TABLE_NAME, ORDINAL_POSITION`

	res, e := meta.Query(ctx, q, 0, query, db)
	if e != nil {
		return fmt.Errorf("erm.loadColumns: %w", e)
	}
	for _, r := range res.Rows {
		t, ok := tables[str(r, 0)]
		if !ok {
			continue
		}
		t.Columns = append(t.Columns, Column{
			Name:     str(r, 1),
			Type:     str(r, 2),
			Nullable: strings.EqualFold(str(r, 3), "YES"),
			Key:      str(r, 4),
		})
	}
	return nil
}

// loadPrimaryKeys reads primary keys in declaration order.
func loadPrimaryKeys(ctx context.Context, q meta.Querier, db string, tables map[string]*Table) error {
	const query = `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.STATISTICS
	 WHERE TABLE_SCHEMA = ? AND INDEX_NAME = 'PRIMARY'
	 ORDER BY TABLE_NAME, SEQ_IN_INDEX`

	res, e := meta.Query(ctx, q, 0, query, db)
	if e != nil {
		return fmt.Errorf("erm.loadPrimaryKeys: %w", e)
	}
	for _, r := range res.Rows {
		if t, ok := tables[str(r, 0)]; ok {
			t.PrimaryKey = append(t.PrimaryKey, str(r, 1))
		}
	}
	return nil
}

// loadForeignKeys reads declared foreign keys, folding multi-column
// constraints back into one link each.
func loadForeignKeys(ctx context.Context, q meta.Querier, db string) ([]Link, error) {
	const query = `SELECT CONSTRAINT_NAME, TABLE_NAME, COLUMN_NAME,
	       REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
	  FROM information_schema.KEY_COLUMN_USAGE
	 WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
	   AND REFERENCED_TABLE_SCHEMA = TABLE_SCHEMA
	 ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`

	res, e := meta.Query(ctx, q, 0, query, db)
	if e != nil {
		return nil, fmt.Errorf("erm.loadForeignKeys: %w", e)
	}

	var (
		out  []Link
		cur  *Link
		curK string
	)
	for _, r := range res.Rows {
		key := str(r, 1) + "\x00" + str(r, 0)
		if cur == nil || key != curK {
			if cur != nil {
				out = append(out, *cur)
			}
			cur = &Link{
				Name:       str(r, 0),
				From:       str(r, 1),
				To:         str(r, 3),
				Kind:       KindFK,
				Confidence: 1,
			}
			curK = key
		}
		cur.FromCols = append(cur.FromCols, str(r, 2))
		cur.ToCols = append(cur.ToCols, str(r, 4))
	}
	if cur != nil {
		out = append(out, *cur)
	}
	return out, nil
}

// str reads a cell as a string, "" when NULL.
func str(row []*string, i int) string {
	if i >= len(row) || row[i] == nil {
		return ""
	}
	return *row[i]
}

// num reads a cell as an int64, 0 when NULL or unparseable.
func num(row []*string, i int) int64 {
	var n int64
	if _, e := fmt.Sscanf(str(row, i), "%d", &n); e != nil {
		return 0
	}
	return n
}
