package api

import (
	"net/http"

	"github.com/julienschmidt/httprouter"
	"github.com/mpdroog/mydb/ddl"
	"github.com/mpdroog/mydb/jobs"
	"github.com/mpdroog/mydb/meta"
	"github.com/mpdroog/mydb/writer"
)

// alterInput is what the structure-editor posts.
type alterInput struct {
	Server  string      `json:"server"`
	DB      string      `json:"db"`
	Table   string      `json:"table"`
	Desired ddl.Desired `json:"desired"`
	Dry     bool        `json:"dry"`
}

// Alter previews or applies a structure change. The editor always calls it
// with dry first and shows the statement, so nothing is ever rebuilt on a
// table without the exact SQL having been on screen.
func (a *API) Alter(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
	var in alterInput
	if e := writer.Decode(r, &in); e != nil {
		writer.Err(w, http.StatusBadRequest, "api.Alter failed reading body", e)
		return
	}
	if in.DB == "" || in.Table == "" {
		writer.Err(w, http.StatusBadRequest, "api.Alter needs a db and table", nil)
		return
	}

	ctx, cancel := metaCtx(r)
	defer cancel()

	db, release, e := a.Conn.Acquire(ctx, in.Server)
	if e != nil {
		writer.Err(w, http.StatusServiceUnavailable, "api.Alter failed connecting", e)
		return
	}
	defer release()

	// Diff against what the table looks like right now, not against what
	// the editor was opened with.
	cur, e := meta.Describe(ctx, db, in.DB, in.Table)
	if e != nil {
		writer.Err(w, http.StatusBadGateway, "api.Alter failed reading structure", e)
		return
	}

	stmt, e := ddl.Diff(cur, in.Desired)
	if e != nil {
		writer.Err(w, http.StatusBadRequest, "api.Alter failed building statement", e)
		return
	}
	if stmt == "" {
		if e := writer.Encode(w, map[string]any{"sql": "", "changed": false}); e != nil {
			writer.Err(w, http.StatusInternalServerError, "api.Alter failed encoding", e)
		}
		return
	}

	if in.Dry {
		if e := writer.Encode(w, map[string]any{"sql": stmt, "changed": true}); e != nil {
			writer.Err(w, http.StatusInternalServerError, "api.Alter failed encoding", e)
		}
		return
	}

	// Applying runs as a job like everything else, so a long table-rebuild
	// stays cancellable and never holds the request open.
	j, e := a.Jobs.Submit(jobs.Request{
		Server: in.Server,
		DB:     in.DB,
		SQL:    stmt,
		Kind:   jobs.KindDDL,
	})
	if e != nil {
		writer.Err(w, http.StatusBadRequest, "api.Alter failed starting job", e)
		return
	}
	if e := writer.EncodeCode(w, http.StatusAccepted, j.Snapshot()); e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.Alter failed encoding", e)
	}
}
