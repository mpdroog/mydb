package api

import (
	"net/http"

	"github.com/julienschmidt/httprouter"
	"github.com/mpdroog/mydb/erm"
	"github.com/mpdroog/mydb/writer"
)

// ERM builds the entity-relationship model for one schema: tables, links
// and grouping. Reads metadata only, never table data.
func (a *API) ERM(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
	q := r.URL.Query()
	server, dbname := q.Get("server"), q.Get("db")
	if dbname == "" {
		writer.Err(w, http.StatusBadRequest, "api.ERM needs a db", nil)
		return
	}

	ctx, cancel := metaCtx(r)
	defer cancel()

	db, release, e := a.Conn.Acquire(ctx, server)
	if e != nil {
		writer.Err(w, http.StatusServiceUnavailable, "api.ERM failed connecting", e)
		return
	}
	defer release()

	s, e := erm.Load(ctx, db, dbname)
	if e != nil {
		writer.Err(w, http.StatusBadGateway, "api.ERM failed reading schema", e)
		return
	}
	if e := writer.Encode(w, s); e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.ERM failed encoding", e)
	}
}
