// Package writer abstracts sending JSON back to the client so handlers
// stay one-liners. Trimmed down from mpdroog/invoiced/writer to JSON-only.
package writer

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
)

// MaxBody caps how much request-body we are willing to decode.
const MaxBody = 4 << 20 // 4MiB

// Decode reads a JSON request-body into d.
func Decode(r *http.Request, d any) error {
	ctype := r.Header.Get("Content-Type")
	if idx := strings.Index(ctype, ";"); idx > -1 {
		ctype = ctype[:idx]
	}
	ctype = strings.ToLower(strings.TrimSpace(ctype))
	if ctype != "application/json" {
		return fmt.Errorf("writer.Decode: invalid Content-Type=%s", ctype)
	}

	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, MaxBody))
	dec.DisallowUnknownFields()
	if e := dec.Decode(d); e != nil {
		return fmt.Errorf("writer.Decode: %w", e)
	}
	return nil
}

// Encode writes d as JSON with a 200.
func Encode(w http.ResponseWriter, d any) error {
	return EncodeCode(w, http.StatusOK, d)
}

// EncodeCode writes d as JSON with an explicit status-code.
func EncodeCode(w http.ResponseWriter, code int, d any) error {
	b, e := json.Marshal(d)
	if e != nil {
		return fmt.Errorf("writer.EncodeCode marshal: %w", e)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if _, e := w.Write(b); e != nil {
		return fmt.Errorf("writer.EncodeCode write: %w", e)
	}
	return nil
}

// Err logs the error and sends it on to the client.
//
// mydb deliberately does not hide the cause the way a public web app would.
// The only person who can reach this API is the operator, who is also the
// one holding the database credentials, and "Data too long for column
// 'small' at row 1" is the whole answer to what just went wrong. Sending
// "failed writing row" instead would mean reading the terminal to use the
// GUI. The message stays prefixed with pkg.Func, as everywhere else.
func Err(w http.ResponseWriter, code int, msg string, e error) {
	if e != nil {
		log.Printf("%s: %s", msg, e)
		msg += ": " + e.Error()
	} else {
		log.Print(msg)
	}
	http.Error(w, msg, code)
}
