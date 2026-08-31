package api

import (
	"context"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/julienschmidt/httprouter"
	"github.com/mpdroog/mydb/config"
	"github.com/mpdroog/mydb/jobs"
	"github.com/mpdroog/mydb/writer"
)

// QuerySubmit registers a job and answers 202 without touching the
// database, so this POST is instant even when the server is still dialling.
func (a *API) QuerySubmit(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
	var req jobs.Request
	if e := writer.Decode(r, &req); e != nil {
		writer.Err(w, http.StatusBadRequest, "api.QuerySubmit failed reading body", e)
		return
	}

	j, e := a.Jobs.Submit(req)
	if e != nil {
		// A statement that changes data without naming which rows is not a
		// bad request, it is an unanswered question. It comes back as JSON
		// so the GUI can raise the dialog rather than show a red toast.
		var confirm *jobs.ConfirmError
		if errors.As(e, &confirm) {
			log.Printf("api.QuerySubmit held back: %s", e)
			if e := writer.EncodeCode(w, http.StatusConflict, map[string]any{
				"error":   e.Error(),
				"confirm": confirm.Risk,
			}); e != nil {
				writer.Err(w, http.StatusInternalServerError, "api.QuerySubmit failed encoding", e)
			}
			return
		}
		writer.Err(w, http.StatusBadRequest, "api.QuerySubmit failed starting job", e)
		return
	}
	if e := writer.EncodeCode(w, http.StatusAccepted, j.Snapshot()); e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.QuerySubmit failed encoding", e)
	}
}

// JobResult hands back a finished job with its rows.
func (a *API) JobResult(w http.ResponseWriter, r *http.Request, ps httprouter.Params) {
	j, e := a.Jobs.Get(ps.ByName("id"))
	if e != nil {
		writer.Err(w, http.StatusNotFound, "api.JobResult no such job", e)
		return
	}
	if e := writer.Encode(w, j.Snapshot()); e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.JobResult failed encoding", e)
	}
}

// JobCancel KILLs the running query on the server.
func (a *API) JobCancel(w http.ResponseWriter, r *http.Request, ps httprouter.Params) {
	ctx, cancel := context.WithTimeout(r.Context(), config.Timeouts().MetaQuery.D())
	defer cancel()

	if e := a.Jobs.Cancel(ctx, ps.ByName("id")); e != nil {
		code := http.StatusBadRequest
		if errors.Is(e, jobs.ErrNoSuchJob) {
			code = http.StatusNotFound
		}
		writer.Err(w, code, "api.JobCancel failed cancelling", e)
		return
	}
	if e := writer.Encode(w, map[string]bool{"ok": true}); e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.JobCancel failed encoding", e)
	}
}

// JobForget drops a job's buffered result, called when a tab closes so a
// long session does not hold on to every grid it ever loaded.
func (a *API) JobForget(w http.ResponseWriter, r *http.Request, ps httprouter.Params) {
	a.Jobs.Forget(ps.ByName("id"))
	if e := writer.Encode(w, map[string]bool{"ok": true}); e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.JobForget failed encoding", e)
	}
}

// JobEvents streams a job's progress. The browser opens this right after
// submitting, so nothing on the page ever waits on a response body.
func (a *API) JobEvents(w http.ResponseWriter, r *http.Request, ps httprouter.Params) {
	j, e := a.Jobs.Get(ps.ByName("id"))
	if e != nil {
		writer.Err(w, http.StatusNotFound, "api.JobEvents no such job", e)
		return
	}

	// Subscribe before snapshotting, or a job that finishes in between
	// would leave the browser waiting for an event that already happened.
	ch, unsub := j.Events()
	defer unsub()

	s, e := newSSE(w)
	if e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.JobEvents failed opening stream", e)
		return
	}
	if e := s.send(j.Event()); e != nil {
		closeStream("JobEvents", e)
		return
	}
	if j.Finished() {
		return
	}

	tick := time.NewTicker(heartbeat)
	defer tick.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-a.done:
			return
		case ev, ok := <-ch:
			if !ok {
				return
			}
			if e := s.send(ev); e != nil {
				closeStream("JobEvents", e)
				return
			}
			if ev.State == jobs.Done || ev.State == jobs.Errored || ev.State == jobs.Cancelled {
				return
			}
		case <-tick.C:
			if e := s.ping(); e != nil {
				closeStream("JobEvents", e)
				return
			}
		}
	}
}
