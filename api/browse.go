package api

import (
	"context"
	"net/http"

	"github.com/julienschmidt/httprouter"
	"github.com/mpdroog/mydb/config"
	"github.com/mpdroog/mydb/ddl"
	"github.com/mpdroog/mydb/meta"
	"github.com/mpdroog/mydb/writer"
)

// metaCtx bounds a metadata lookup with the meta_query budget, tied to the
// request so a browser that navigates away releases the connection.
func metaCtx(r *http.Request) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), config.Timeouts().MetaQuery.D())
}

// Databases lists the schemas on a server.
func (a *API) Databases(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
	server := r.URL.Query().Get("server")

	ctx, cancel := metaCtx(r)
	defer cancel()

	db, release, e := a.Conn.Acquire(ctx, server)
	if e != nil {
		writer.Err(w, http.StatusServiceUnavailable, "api.Databases failed connecting", e)
		return
	}
	defer release()

	out, e := meta.Databases(ctx, db)
	if e != nil {
		writer.Err(w, http.StatusBadGateway, "api.Databases failed listing databases", e)
		return
	}
	if e := writer.Encode(w, out); e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.Databases failed encoding", e)
	}
}

// Tables lists a schema's tables and views.
func (a *API) Tables(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
	q := r.URL.Query()
	server, dbname := q.Get("server"), q.Get("db")
	if dbname == "" {
		writer.Err(w, http.StatusBadRequest, "api.Tables needs a db", nil)
		return
	}

	ctx, cancel := metaCtx(r)
	defer cancel()

	db, release, e := a.Conn.Acquire(ctx, server)
	if e != nil {
		writer.Err(w, http.StatusServiceUnavailable, "api.Tables failed connecting", e)
		return
	}
	defer release()

	out, e := meta.Tables(ctx, db, dbname)
	if e != nil {
		writer.Err(w, http.StatusBadGateway, "api.Tables failed listing tables", e)
		return
	}
	if e := writer.Encode(w, out); e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.Tables failed encoding", e)
	}
}

// Structure answers the CMD+D editor with a table's columns and indexes.
func (a *API) Structure(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
	q := r.URL.Query()
	server, dbname, table := q.Get("server"), q.Get("db"), q.Get("table")
	if dbname == "" || table == "" {
		writer.Err(w, http.StatusBadRequest, "api.Structure needs a db and table", nil)
		return
	}

	ctx, cancel := metaCtx(r)
	defer cancel()

	db, release, e := a.Conn.Acquire(ctx, server)
	if e != nil {
		writer.Err(w, http.StatusServiceUnavailable, "api.Structure failed connecting", e)
		return
	}
	defer release()

	out, e := meta.Describe(ctx, db, dbname, table)
	if e != nil {
		writer.Err(w, http.StatusBadGateway, "api.Structure failed reading structure", e)
		return
	}
	// The editor offers exactly the types the writer accepts, so nothing it
	// can suggest gets refused on apply. Sending them here rather than from
	// their own endpoint keeps it to the round-trip the editor already makes.
	body := struct {
		*meta.Structure
		Types []string `json:"types"`
	}{out, ddl.BaseTypes()}
	if e := writer.Encode(w, body); e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.Structure failed encoding", e)
	}
}
