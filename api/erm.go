package api

import (
	"net/http"

	"github.com/julienschmidt/httprouter"
	"github.com/mpdroog/mydb/config"
	"github.com/mpdroog/mydb/erm"
	"github.com/mpdroog/mydb/writer"
)

// manualLinks turns the config-file's declarations into diagram edges. A
// server that is not in the config-file simply has none, which is not worth
// failing a whole diagram over.
func manualLinks(server, dbname string) []erm.Link {
	srv, e := config.ServerByName(server)
	if e != nil {
		return nil
	}
	declared := srv.LinksFor(dbname)
	out := make([]erm.Link, 0, len(declared))
	for _, l := range declared {
		out = append(out, erm.Link{
			From:     l.FromTbl,
			To:       l.ToTbl,
			FromCols: l.FromCols,
			ToCols:   l.ToCols,
			Kind:     erm.KindManual,
		})
	}
	return out
}

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

	s, e := erm.Load(ctx, db, dbname, manualLinks(server, dbname))
	if e != nil {
		writer.Err(w, http.StatusBadGateway, "api.ERM failed reading schema", e)
		return
	}
	if e := writer.Encode(w, s); e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.ERM failed encoding", e)
	}
}
