package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ok is the handler the middleware is supposed to let through.
var ok = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
})

func TestHostCheck(t *testing.T) {
	for _, c := range []struct {
		host string
		want int
	}{
		{host: "localhost:9999", want: 200},
		{host: "127.0.0.1:9999", want: 200},
		{host: "[::1]:9999", want: 200},
		{host: "localhost", want: 200},
		// DNS rebinding: the packet really does come from 127.0.0.1, so
		// only the Host header gives it away.
		{host: "rebind.evil.com:9999", want: 403},
		{host: "192.168.1.10:9999", want: 403},
		{host: "", want: 403},
	} {
		r := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/servers", nil)
		r.Host = c.host
		w := httptest.NewRecorder()
		HostCheck(ok).ServeHTTP(w, r)
		if w.Code != c.want {
			t.Errorf("HostCheck(Host=%q) = %d, want %d", c.host, w.Code, c.want)
		}
	}
}

func TestLocalOnly(t *testing.T) {
	for _, c := range []struct {
		addr string
		want int
	}{
		{addr: "127.0.0.1:5000", want: 200},
		{addr: "127.0.0.53:5000", want: 200},
		// The invoiced version rejected this one, it only matched "127.0.0.1".
		{addr: "[::1]:5000", want: 200},
		{addr: "192.168.1.10:5000", want: 403},
		{addr: "nonsense", want: 403},
	} {
		r := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/servers", nil)
		r.RemoteAddr = c.addr
		w := httptest.NewRecorder()
		LocalOnly(ok).ServeHTTP(w, r)
		if w.Code != c.want {
			t.Errorf("LocalOnly(RemoteAddr=%q) = %d, want %d", c.addr, w.Code, c.want)
		}
	}
}

func TestCSRFHeader(t *testing.T) {
	for _, c := range []struct {
		name   string
		method string
		path   string
		hdr    map[string]string
		want   int
	}{
		{name: "api with token", method: http.MethodGet, path: "/api/v1/servers",
			hdr: map[string]string{CSRFToken: "1"}, want: 200},
		{name: "api without token", method: http.MethodGet, path: "/api/v1/servers",
			want: 403},
		{name: "preflight refused", method: http.MethodOptions, path: "/api/v1/servers",
			hdr: map[string]string{CSRFToken: "1"}, want: 403},
		{name: "cross-origin refused", method: http.MethodPost, path: "/api/v1/query",
			hdr: map[string]string{CSRFToken: "1", "Origin": "http://evil.com"}, want: 403},
		{name: "same-origin allowed", method: http.MethodPost, path: "/api/v1/query",
			hdr: map[string]string{CSRFToken: "1", "Origin": "http://localhost:9999"}, want: 200},
		{name: "static needs nothing", method: http.MethodGet, path: "/static/app.css",
			want: 200},
	} {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequestWithContext(t.Context(), c.method, c.path, nil)
			r.Host = "localhost:9999"
			for k, v := range c.hdr {
				r.Header.Set(k, v)
			}
			w := httptest.NewRecorder()
			CSRFHeader(ok).ServeHTTP(w, r)
			if w.Code != c.want {
				t.Errorf("CSRFHeader = %d, want %d", w.Code, c.want)
			}
		})
	}
}

func TestSecurityHeaders(t *testing.T) {
	r := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/static/index.html", nil)
	w := httptest.NewRecorder()
	SecurityHeaders(ok).ServeHTTP(w, r)

	csp := w.Header().Get("Content-Security-Policy")
	if csp == "" {
		t.Fatal("no Content-Security-Policy set")
	}
	// The page carries no inline script or style, so neither escape hatch
	// may ever creep into the policy.
	for _, bad := range []string{"unsafe-inline", "unsafe-eval", "*"} {
		if strings.Contains(csp, bad) {
			t.Errorf("CSP contains %q: %s", bad, csp)
		}
	}
	for _, want := range []string{"default-src 'none'", "script-src 'self'", "frame-ancestors 'none'"} {
		if !strings.Contains(csp, want) {
			t.Errorf("CSP missing %q: %s", want, csp)
		}
	}
	if w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Error("missing nosniff")
	}
}
