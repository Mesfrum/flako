package main

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Mesfrum/flako/server/internal/store"
)

// newMux registers the API and the SPA on one mux. Overlapping patterns with
// no clear winner panic at registration, so building it at all is the first check.
func TestNewMuxRoutesAPIAndSPA(t *testing.T) {
	mux := newMux(store.NewMemory(), slog.New(slog.NewTextHandler(io.Discard, nil)))

	do := func(method, path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
		return rec
	}

	for _, method := range []string{"GET", "PUT", "POST"} {
		rec := do(method, "/api/nope")
		if rec.Code != http.StatusNotFound || !strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
			t.Errorf("%s /api/nope = %d %q, want JSON 404", method, rec.Code, rec.Header().Get("Content-Type"))
		}
	}
	live := "/api/notes/" + strings.Repeat("a", 43) + "/live"
	if rec := do("GET", live); rec.Code == http.StatusNotFound {
		t.Errorf("GET %s = 404, want the live hub (it rejects a non-upgrade request)", live)
	}
	if rec := do("PUT", "/api/notes/"+strings.Repeat("a", 43)); rec.Code != http.StatusGone {
		t.Errorf("PUT note = %d, want 410", rec.Code)
	}
	if rec := do("GET", "/healthz"); rec.Body.String() != "ok" {
		t.Errorf("GET /healthz = %q, want ok", rec.Body)
	}
	// The SPA answers client routes (200 with a build, 503 build hint without one) — never 404.
	if rec := do("GET", "/taco"); rec.Code != http.StatusOK && rec.Code != http.StatusServiceUnavailable {
		t.Errorf("GET /taco = %d, want SPA response", rec.Code)
	}
}
