package api

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/julienschmidt/httprouter"
	"github.com/mpdroog/mydb/config"
	"github.com/mpdroog/mydb/connman"
	"github.com/mpdroog/mydb/meta"
	"github.com/mpdroog/mydb/qlog"
	"github.com/mpdroog/mydb/writer"
)

// rowInput is one inline cell edit. Orig carries the value the grid was
// showing, which is what makes the update refuse to clobber someone else's
// change. A nil Value or Orig means SQL NULL, kept distinct from "".
type rowInput struct {
	Value  *string            `json:"value"`
	Orig   *string            `json:"orig"`
	Key    map[string]*string `json:"key"`
	Server string             `json:"server"`
	DB     string             `json:"db"`
	Table  string             `json:"table"`
	Column string             `json:"column"`
}

// ErrNoPrimaryKey is returned for a table we refuse to edit rows in.
var ErrNoPrimaryKey = errors.New("api: table has no primary key, rows are read-only")

// RowUpdate writes one cell back, addressed by primary key.
func (a *API) RowUpdate(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
	var in rowInput
	if e := writer.Decode(r, &in); e != nil {
		writer.Err(w, http.StatusBadRequest, "api.RowUpdate failed reading body", e)
		return
	}
	if in.DB == "" || in.Table == "" || in.Column == "" {
		writer.Err(w, http.StatusBadRequest, "api.RowUpdate needs a db, table and column", nil)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), config.Timeouts().DataQuery.D())
	defer cancel()

	db, release, e := a.Conn.Acquire(ctx, in.Server)
	if e != nil {
		writer.Err(w, http.StatusServiceUnavailable, "api.RowUpdate failed connecting", e)
		return
	}
	defer release()

	// Describe both proves the table exists and tells us which columns are
	// real, so nothing the browser sent reaches the statement unchecked.
	cur, e := meta.Describe(ctx, db, in.DB, in.Table)
	if e != nil {
		writer.Err(w, http.StatusBadGateway, "api.RowUpdate failed reading structure", e)
		return
	}
	if len(cur.PrimaryKey) == 0 {
		writer.Err(w, http.StatusConflict, "api.RowUpdate refused: "+ErrNoPrimaryKey.Error(), nil)
		return
	}

	stmt, args, e := updateStmt(cur, in)
	if e != nil {
		writer.Err(w, http.StatusBadRequest, "api.RowUpdate failed building statement", e)
		return
	}

	// Pin a connection and force strict mode onto it before writing. On a
	// lax server the UPDATE would otherwise truncate silently, report one
	// row affected, and leave the grid showing a value the database does
	// not hold.
	conn, e := db.Conn(ctx)
	if e != nil {
		writer.Err(w, http.StatusServiceUnavailable, "api.RowUpdate failed taking a connection", e)
		return
	}
	defer func() {
		if e := conn.Close(); e != nil {
			log.Printf("api.RowUpdate conn.Close: %s", e)
		}
	}()
	if e := connman.ApplySession(ctx, conn); e != nil {
		writer.Err(w, http.StatusBadGateway, "api.RowUpdate failed setting session mode", e)
		return
	}

	res, e := conn.ExecContext(ctx, stmt, args...)
	if e != nil {
		writer.Err(w, http.StatusBadGateway, "api.RowUpdate failed writing row", e)
		return
	}
	n, e := res.RowsAffected()
	if e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.RowUpdate failed reading result", e)
		return
	}
	if n == 0 {
		// ClientFoundRows is on, so this really means the row moved out
		// from under us rather than "the value was already that".
		writer.Err(w, http.StatusConflict,
			"api.RowUpdate refused: row changed since it was loaded, reload the table", nil)
		return
	}

	// An inline edit is a write to the database like any other, so it goes
	// in the query log. The statement is recorded with its placeholders
	// rather than the values: mydb has exactly one way to put a value into
	// a statement, and it is not string formatting.
	prod := false
	if srv, e := config.ServerByName(in.Server); e == nil {
		prod = srv.Production
	}
	qlog.Append(qlog.Entry{
		Server:     in.Server,
		DB:         in.DB,
		Table:      in.Table,
		Kind:       "row",
		SQL:        stmt,
		State:      "done",
		Affected:   n,
		Production: prod,
	})

	if e := writer.Encode(w, map[string]any{"ok": true, "affected": n}); e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.RowUpdate failed encoding", e)
	}
}

// updateStmt builds the UPDATE and its placeholder arguments.
// Every value travels as a placeholder, only checked identifiers are
// interpolated.
func updateStmt(cur *meta.Structure, in rowInput) (string, []any, error) {
	known := make(map[string]meta.ColumnDef, len(cur.Columns))
	for _, c := range cur.Columns {
		known[c.Name] = c
	}

	col, ok := known[in.Column]
	if !ok {
		return "", nil, errors.New("api.updateStmt: no such column " + in.Column)
	}
	if col.Binary() {
		return "", nil, errors.New("api.updateStmt: binary columns are read-only")
	}

	qname, e := meta.Qualify(cur.Database, cur.Table)
	if e != nil {
		return "", nil, e
	}
	qcol, e := meta.QuoteIdent(in.Column)
	if e != nil {
		return "", nil, e
	}

	args := make([]any, 0, len(cur.PrimaryKey)+2)
	args = append(args, nullable(in.Value))

	where := make([]string, 0, len(cur.PrimaryKey)+1)
	for _, pk := range cur.PrimaryKey {
		v, ok := in.Key[pk]
		if !ok {
			return "", nil, errors.New("api.updateStmt: missing primary-key column " + pk)
		}
		q, e := meta.QuoteIdent(pk)
		if e != nil {
			return "", nil, e
		}
		where = append(where, q+" <=> ?")
		args = append(args, nullable(v))
	}

	// The optimistic-concurrency guard: NULL-safe so a NULL -> value edit
	// is checked the same way as any other.
	where = append(where, qcol+" <=> ?")
	args = append(args, nullable(in.Orig))

	stmt := "UPDATE " + qname + " SET " + qcol + " = ? WHERE " + strings.Join(where, " AND ") + " LIMIT 1"
	return stmt, args, nil
}

// nullable turns a possibly-absent string into a driver argument, keeping
// NULL distinct from the empty string.
func nullable(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// insertInput is one new row. Values is keyed by column name; a nil value
// means SQL NULL, and a column simply left out of the map takes whatever
// default the schema gives it. That distinction is the whole point: "set
// this to NULL" and "do not mention this column" are different statements,
// and an auto-increment key needs the second one.
type insertInput struct {
	Values map[string]*string `json:"values"`
	Server string             `json:"server"`
	DB     string             `json:"db"`
	Table  string             `json:"table"`
}

// RowInsert adds one row. It is deliberately not a general INSERT: the
// console is there for that. This exists so the GUI can offer a form built
// from the schema, and it refuses anything the form could not have meant.
func (a *API) RowInsert(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
	var in insertInput
	if e := writer.Decode(r, &in); e != nil {
		writer.Err(w, http.StatusBadRequest, "api.RowInsert failed reading body", e)
		return
	}
	if in.DB == "" || in.Table == "" {
		writer.Err(w, http.StatusBadRequest, "api.RowInsert needs a db and table", nil)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), config.Timeouts().DataQuery.D())
	defer cancel()

	db, release, e := a.Conn.Acquire(ctx, in.Server)
	if e != nil {
		writer.Err(w, http.StatusServiceUnavailable, "api.RowInsert failed connecting", e)
		return
	}
	defer release()

	// As with an edit: Describe both proves the table is there and says
	// which columns are real, so nothing from the browser is interpolated
	// without having been checked against the schema first.
	cur, e := meta.Describe(ctx, db, in.DB, in.Table)
	if e != nil {
		writer.Err(w, http.StatusBadGateway, "api.RowInsert failed reading structure", e)
		return
	}

	stmt, args, e := insertStmt(cur, in)
	if e != nil {
		writer.Err(w, http.StatusBadRequest, "api.RowInsert failed building statement", e)
		return
	}

	// Strict mode matters more here than anywhere. Without it a value too
	// long for its column is silently truncated on the way in, and the row
	// you get back is not the row you asked for.
	conn, e := db.Conn(ctx)
	if e != nil {
		writer.Err(w, http.StatusServiceUnavailable, "api.RowInsert failed taking a connection", e)
		return
	}
	defer func() {
		if e := conn.Close(); e != nil {
			log.Printf("api.RowInsert conn.Close: %s", e)
		}
	}()
	if e := connman.ApplySession(ctx, conn); e != nil {
		writer.Err(w, http.StatusBadGateway, "api.RowInsert failed setting session mode", e)
		return
	}

	res, e := conn.ExecContext(ctx, stmt, args...)
	if e != nil {
		writer.Err(w, http.StatusBadGateway, "api.RowInsert failed writing row", e)
		return
	}
	n, e := res.RowsAffected()
	if e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.RowInsert failed reading result", e)
		return
	}
	// A table with no auto-increment key has no insert id, and that is not
	// an error worth failing the whole write over.
	var id int64
	if v, e := res.LastInsertId(); e == nil {
		id = v
	}

	prod := false
	if srv, e := config.ServerByName(in.Server); e == nil {
		prod = srv.Production
	}
	qlog.Append(qlog.Entry{
		Server:     in.Server,
		DB:         in.DB,
		Table:      in.Table,
		Kind:       "row",
		SQL:        stmt,
		State:      "done",
		Affected:   n,
		Production: prod,
	})

	if e := writer.Encode(w, map[string]any{"ok": true, "affected": n, "insert_id": id}); e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.RowInsert failed encoding", e)
	}
}

// insertStmt builds the INSERT and its placeholder arguments. Values travel
// as placeholders; only identifiers checked against the schema are ever
// interpolated.
func insertStmt(cur *meta.Structure, in insertInput) (string, []any, error) {
	known := make(map[string]meta.ColumnDef, len(cur.Columns))
	for _, c := range cur.Columns {
		known[c.Name] = c
	}

	qname, e := meta.Qualify(cur.Database, cur.Table)
	if e != nil {
		return "", nil, e
	}

	// Walk the schema's own column order rather than the map's, so the
	// statement that lands in the query log reads like the table does and
	// is stable between two identical inserts.
	cols := make([]string, 0, len(in.Values))
	args := make([]any, 0, len(in.Values))
	for _, c := range cur.Columns {
		v, ok := in.Values[c.Name]
		if !ok {
			continue
		}
		if c.Binary() {
			return "", nil, errors.New("api.insertStmt: binary columns are read-only: " + c.Name)
		}
		q, e := meta.QuoteIdent(c.Name)
		if e != nil {
			return "", nil, e
		}
		cols = append(cols, q)
		args = append(args, nullable(v))
	}

	// Anything the browser sent that is not a column of this table is a
	// bug or an attack, and either way is worth refusing loudly rather
	// than quietly dropping.
	for name := range in.Values {
		if _, ok := known[name]; !ok {
			return "", nil, errors.New("api.insertStmt: no such column " + name)
		}
	}

	// A row made entirely of defaults is a legitimate thing to want.
	if len(cols) == 0 {
		return "INSERT INTO " + qname + " () VALUES ()", nil, nil
	}

	holders := strings.TrimSuffix(strings.Repeat("?, ", len(cols)), ", ")
	stmt := "INSERT INTO " + qname + " (" + strings.Join(cols, ", ") + ") VALUES (" + holders + ")"
	return stmt, args, nil
}
