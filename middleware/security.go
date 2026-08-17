// Package middleware holds the hand-rolled http.Handler wrappers.
package middleware

import (
	"log"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"
)

// CSPHeader is the strict Content-Security-Policy every response carries.
// Nothing loads unless it comes from us, and there is no inline script or
// style anywhere in static/ so no nonce or hash is needed.
const CSPHeader = "default-src 'none'; " +
	"script-src 'self'; " +
	"style-src 'self'; " +
	"connect-src 'self'; " +
	"img-src 'self' data:; " +
	"font-src 'self'; " +
	"form-action 'none'; " +
	"frame-ancestors 'none'; " +
	"base-uri 'none'"

// CSRFToken is the header a caller must send on every /api/ request.
// A cross-origin page cannot set it without a CORS preflight, and we
// answer no preflight at all.
const CSRFToken = "X-Mydb"

// maxLogged caps how much of an attacker-chosen string reaches the log.
const maxLogged = 200

// Safe strips control characters and truncates, so a crafted path or
// header cannot forge extra lines in the log.
func Safe(s string) string {
	if len(s) > maxLogged {
		s = s[:maxLogged] + "…"
	}
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return '?'
		}
		return r
	}, s)
}

// deny writes a plain-text refusal, logging why.
func deny(w http.ResponseWriter, r *http.Request, why string) {
	//nolint:gosec // G706: every interpolated value goes through Safe first,
	// which strips control characters and truncates.
	log.Printf("middleware: refused %s %s from %s: %s",
		Safe(r.Method), Safe(r.URL.Path), Safe(r.RemoteAddr), Safe(why))
	http.Error(w, "Security exception", http.StatusForbidden)
}

// SecurityHeaders sets CSP and friends on every response.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		// Embedded files carry no modtime, so they reach the browser with
		// neither ETag nor Last-Modified and get cached on a guess. That
		// makes "I rebuilt and nothing changed" a real possibility, which
		// is a miserable thing to debug.
		if strings.HasPrefix(r.URL.Path, "/static/") {
			h.Set("Cache-Control", "no-cache")
		}
		h.Set("Content-Security-Policy", CSPHeader)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
		next.ServeHTTP(w, r)
	})
}

// isLoopbackHost reports whether host (no port) is one of our own names.
func isLoopbackHost(host string) bool {
	host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	addr, e := netip.ParseAddr(host)
	if e != nil {
		return false
	}
	return addr.IsLoopback()
}

// HostCheck rejects any request whose Host header is not a loopback name.
// This is what stops DNS-rebinding: such a request really does arrive from
// 127.0.0.1, so LocalOnly alone would happily let it through.
func HostCheck(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if h, _, e := net.SplitHostPort(host); e == nil {
			host = h
		}
		if !isLoopbackHost(host) {
			deny(w, r, "bad Host header "+r.Host)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// LocalOnly rejects requests that did not come from loopback.
// Unlike mpdroog/invoiced/middleware.LocalOnly this handles IPv6 ::1.
func LocalOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, e := net.SplitHostPort(r.RemoteAddr)
		if e != nil {
			host = r.RemoteAddr
		}
		addr, e := netip.ParseAddr(strings.TrimSuffix(strings.TrimPrefix(host, "["), "]"))
		if e != nil || !addr.IsLoopback() {
			deny(w, r, "non-loopback RemoteAddr")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// CSRFHeader demands the X-Mydb header on every /api/ call and refuses
// CORS preflights outright, so no other origin can reach the API.
func CSRFHeader(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		if r.Method == http.MethodOptions {
			deny(w, r, "CORS preflight")
			return
		}
		if r.Header.Get(CSRFToken) == "" && !typedInURL(r) {
			deny(w, r, "missing "+CSRFToken+" header")
			return
		}
		if o := r.Header.Get("Origin"); o != "" && !originIsSelf(o, r.Host) {
			deny(w, r, "cross-origin Origin "+o)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// WriteDeadline gives every response a hard write-deadline. SSE handlers
// push theirs further out on each event, which is why http.Server carries
// no global WriteTimeout.
func WriteDeadline(d time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if e := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(d)); e != nil {
				log.Printf("middleware.WriteDeadline: %s", e)
			}
			next.ServeHTTP(w, r)
		})
	}
}

// typedInURL reports whether this looks like a URL the operator typed into
// the address bar, which is worth allowing without the X-Mydb header:
// pasting an /api/ URL to look at a schema is a reasonable thing to do.
//
// It is safe because Sec-Fetch-* are forbidden header names. A browser sets
// them itself and page JavaScript cannot override them, so evil.com cannot
// dress a cross-origin fetch up as a navigation: it would carry
// Sec-Fetch-Site: cross-site. A rebound DNS name gets same-origin, but
// HostCheck has already refused that request. Anything that sends no
// Sec-Fetch headers at all -- curl, a script -- still needs X-Mydb.
//
// Restricted to GET navigations, so nothing that changes state is covered.
func typedInURL(r *http.Request) bool {
	return r.Method == http.MethodGet &&
		r.Header.Get("Sec-Fetch-Site") == "none" &&
		r.Header.Get("Sec-Fetch-Mode") == "navigate"
}

// originIsSelf reports whether an Origin header points back at us.
func originIsSelf(origin, host string) bool {
	const prefix = "http://"
	if !strings.HasPrefix(origin, prefix) {
		return false
	}
	return strings.EqualFold(origin[len(prefix):], host)
}
