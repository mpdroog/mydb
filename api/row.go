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
