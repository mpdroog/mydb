package api

import (
	"net/http"
	"strconv"

	"github.com/julienschmidt/httprouter"
	"github.com/mpdroog/mydb/qlog"
	"github.com/mpdroog/mydb/stmt"
	"github.com/mpdroog/mydb/writer"
)

// QueryLog searches the log of everything mydb has run.
func (a *API) QueryLog(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
	q := r.URL.Query()
	limit, e := strconv.Atoi(q.Get("limit"))
	if e != nil {
		limit = 0 // qlog picks its own default
	}

	out, e := qlog.Search(qlog.Query{
		Text:   q.Get("q"),
		Server: q.Get("server"),
		State:  q.Get("state"),
		Failed: q.Get("failed") == "1",
		Limit:  limit,
	})
	if e != nil {
		writer.Err(w, http.StatusServiceUnavailable, "api.QueryLog failed searching", e)
		return
	}

	if e := writer.Encode(w, map[string]any{
		"path":    qlog.Path(),
		"entries": out,
	}); e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.QueryLog failed encoding", e)
	}
}

// splitInput is a console buffer waiting to be cut into statements.
type splitInput struct {
	SQL string `json:"sql"`
}

// Split cuts a console buffer into its statements.
//
// The browser could count semicolons itself, but then mydb would have two
// SQL readers that have to agree about quoting, and the one that got it
// wrong would be the one deciding what to run. There is one, and it is
// here, next to the confirm gate that uses the same tokenizer.
func (a *API) Split(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
	var in splitInput
	if e := writer.Decode(r, &in); e != nil {
		writer.Err(w, http.StatusBadRequest, "api.Split failed reading body", e)
		return
	}
	if e := writer.Encode(w, map[string]any{
		"statements": stmt.Split(in.SQL),
	}); e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.Split failed encoding", e)
	}
}
