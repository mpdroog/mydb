package api

import (
	"context"
	"net/http"
	"time"

	"github.com/julienschmidt/httprouter"
	"github.com/mpdroog/mydb/config"
	"github.com/mpdroog/mydb/dash"
	"github.com/mpdroog/mydb/writer"
)

// DashEvents streams what a server is doing, one snapshot per tick.
//
// The polling lives here rather than in the browser so that a dashboard
// left open in a background tab cannot pile up requests: one stream, one
// query set per tick, and it stops the moment the tab closes.
func (a *API) DashEvents(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
	server := r.URL.Query().Get("server")
	if _, e := config.ServerByName(server); e != nil {
		writer.Err(w, http.StatusNotFound, "api.DashEvents no such server", e)
		return
	}

	s, e := newSSE(w)
	if e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.DashEvents failed opening stream", e)
		return
	}

	c := dash.New(server)
	poll := config.Timeouts().DashPoll.D()
	tick := time.NewTicker(poll)
	defer tick.Stop()

	for {
		if e := s.send(a.collect(r, c, server)); e != nil {
			closeStream("DashEvents", e)
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-tick.C:
		}
	}
}

// collect reads one snapshot, turning any failure into a snapshot that says
// so. A dropped tunnel is a line in the UI, not the end of the stream.
func (a *API) collect(r *http.Request, c *dash.Collector, server string) *dash.Snapshot {
	// The budget is the poll interval plus one metadata query, so a tick
	// that cannot keep up is abandoned rather than overlapping the next.
	t := config.Timeouts()
	ctx, cancel := context.WithTimeout(r.Context(), t.DashPoll.D()+t.MetaQuery.D())
	defer cancel()

	fail := func(e error) *dash.Snapshot {
		return &dash.Snapshot{Server: server, At: time.Now().UnixMilli(), Error: e.Error()}
	}

	db, release, e := a.Conn.Acquire(ctx, server)
	if e != nil {
		return fail(e)
	}
	defer release()

	snap, e := c.Collect(ctx, db)
	if e != nil {
		return fail(e)
	}
	return snap
}

// killInput is what the process list's Kill button sends.
type killInput struct {
	Server string `json:"server"`
	ID     int64  `json:"id"`
	// Query kills only the running statement and leaves the connection up,
	// which is what the button does unless it is told otherwise.
	Query bool `json:"query"`
}

// Kill stops a connection, or just the statement it is running.
func (a *API) Kill(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
	var in killInput
	if e := writer.Decode(r, &in); e != nil {
		writer.Err(w, http.StatusBadRequest, "api.Kill failed reading body", e)
		return
	}
	if in.ID <= 0 {
		writer.Err(w, http.StatusBadRequest, "api.Kill needs a connection id", nil)
		return
	}

	ctx, cancel := metaCtx(r)
	defer cancel()

	db, release, e := a.Conn.Acquire(ctx, in.Server)
	if e != nil {
		writer.Err(w, http.StatusServiceUnavailable, "api.Kill failed connecting", e)
		return
	}
	defer release()

	if e := dash.Kill(ctx, db, in.ID, in.Query); e != nil {
		writer.Err(w, http.StatusBadGateway, "api.Kill failed", e)
		return
	}
	if e := writer.Encode(w, map[string]bool{"ok": true}); e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.Kill failed encoding", e)
	}
}
