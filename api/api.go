// Package api holds the HTTP handlers. Every handler answers immediately:
// anything that could block on the database goes through jobs.Manager and
// is followed over SSE instead.
package api

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/mpdroog/mydb/connman"
	"github.com/mpdroog/mydb/jobs"
)

// sseWrite is how long a single SSE write may take before we give up on
// the browser. It is refreshed on every event and heartbeat.
const sseWrite = 30 * time.Second

// heartbeat is how often an idle SSE stream sends a comment, which both
// keeps the connection warm and refreshes its write deadline.
const heartbeat = 15 * time.Second

// API carries the shared managers into the handlers.
type API struct {
	Conn *connman.Manager
	Jobs *jobs.Manager
}

// New builds the handler set.
func New(cm *connman.Manager, jm *jobs.Manager) *API {
	return &API{Conn: cm, Jobs: jm}
}

// sse is an open Server-Sent Events stream.
type sse struct {
	w  http.ResponseWriter
	rc *http.ResponseController
}

// newSSE sends the SSE headers and opens the stream.
func newSSE(w http.ResponseWriter) (*sse, error) {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("Connection", "keep-alive")
	// Text/event-stream must not be buffered by anything in between.
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	s := &sse{w: w, rc: http.NewResponseController(w)}
	if e := s.flush(); e != nil {
		return nil, e
	}
	return s, nil
}

// deadline pushes the write deadline out, so a long-lived stream survives
// the deadline the middleware set for ordinary requests.
func (s *sse) deadline() error {
	if e := s.rc.SetWriteDeadline(time.Now().Add(sseWrite)); e != nil {
		return fmt.Errorf("api.sse deadline: %w", e)
	}
	return nil
}

// flush pushes what we wrote out to the browser.
func (s *sse) flush() error {
	if e := s.rc.Flush(); e != nil {
		return fmt.Errorf("api.sse flush: %w", e)
	}
	return nil
}

// send writes one JSON event.
func (s *sse) send(v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return fmt.Errorf("api.sse marshal: %w", e)
	}
	if e := s.deadline(); e != nil {
		return e
	}
	if _, e := fmt.Fprintf(s.w, "data: %s\n\n", b); e != nil {
		return fmt.Errorf("api.sse write: %w", e)
	}
	return s.flush()
}

// ping writes a comment to keep the stream alive.
func (s *sse) ping() error {
	if e := s.deadline(); e != nil {
		return e
	}
	if _, e := fmt.Fprint(s.w, ": ping\n\n"); e != nil {
		return fmt.Errorf("api.sse ping: %w", e)
	}
	return s.flush()
}

// closeStream records why a stream ended. A write error here is the normal
// way a browser walks away, so it is logged rather than surfaced.
func closeStream(what string, e error) {
	if e != nil {
		log.Printf("api.%s stream ended: %s", what, e)
	}
}
