package httpapi

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newBufferLogger() (*slog.Logger, *bytes.Buffer) {
	var buf bytes.Buffer
	return slog.New(slog.NewTextHandler(&buf, nil)), &buf
}

func TestRecoverTurnsPanicInto500(t *testing.T) {
	logger, logs := newBufferLogger()
	h := Recover(logger)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom")
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/x", nil))

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "boom") {
		t.Errorf("panic value leaked to client: %s", rec.Body)
	}
	if !strings.Contains(logs.String(), "boom") {
		t.Errorf("panic not logged; logs: %s", logs)
	}
}

func TestLoggingRecordsStatus(t *testing.T) {
	cases := []struct {
		name    string
		handler http.HandlerFunc
		want    string
	}{
		{"explicit status", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) }, "status=418"},
		{"implicit 200", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("hi")) }, "status=200"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			logger, logs := newBufferLogger()
			Logging(logger)(tc.handler).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/thing", nil))
			if !strings.Contains(logs.String(), tc.want) || !strings.Contains(logs.String(), "path=/api/thing") {
				t.Errorf("log %q missing %q or path", logs, tc.want)
			}
		})
	}
}

func TestLoggingKeepsResponseControllerFeatures(t *testing.T) {
	// Phase 2 WebSockets hijack the connection through http.ResponseController,
	// which needs the wrapper to Unwrap to the real ResponseWriter.
	logger, _ := newBufferLogger()
	var flushErr error
	h := Logging(logger)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		flushErr = http.NewResponseController(w).Flush()
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/x", nil))
	if flushErr != nil {
		t.Fatalf("Flush through Logging: %v", flushErr)
	}
}

func TestLoggingNeverRecordsPagePaths(t *testing.T) {
	// A page path may be a note name (the key), e.g. from an old-style /<name> link.
	ok := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})
	cases := map[string]string{
		"/my-secret-diary":        "path=[page]",
		"/my%20notes/work":        "path=[page]",
		"/api/notes/" + "x":       "path=/api/notes/x",
		"/assets/index-abc123.js": "path=/assets/index-abc123.js",
		"/healthz":                "path=/healthz",
		"/":                       "path=/",
	}
	for path, want := range cases {
		logger, logs := newBufferLogger()
		Logging(logger)(ok).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", path, nil))
		if !strings.Contains(logs.String(), want) || strings.Contains(logs.String(), "secret") || strings.Contains(logs.String(), "notes/work") {
			t.Errorf("GET %s logged %q, want %q and no page path", path, logs, want)
		}
	}
}
