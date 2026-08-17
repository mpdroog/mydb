package middleware

import (
	"log"
	"net/http"
	"time"

	"github.com/mpdroog/mydb/config"
)

// HTTPLog logs each request once it finished, only when -v is set.
// SSE streams are logged on subscribe so a long-lived stream still shows up.
func HTTPLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !config.Verbose {
			next.ServeHTTP(w, r)
			return
		}
		meta := ""
		if r.Method != http.MethodGet {
			meta = r.Header.Get("Content-Type")
		}
		begin := time.Now()
		next.ServeHTTP(w, r)
		//nolint:gosec // G706: every interpolated value goes through Safe first,
		// which strips control characters and truncates.
		log.Printf("HTTP[%s] %s %s duration=%s %s",
			Safe(r.RemoteAddr), Safe(r.Method), Safe(r.URL.String()), time.Since(begin), Safe(meta))
	})
}
