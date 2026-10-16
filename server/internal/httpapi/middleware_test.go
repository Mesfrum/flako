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
			Logging(logger)(tc.handler).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/thing", nil))
			if !strings.Contains(logs.String(), tc.want) || !strings.Contains(logs.String(), "path=/thing") {
				t.Errorf("log %q missing %q or path", logs, tc.want)
			}
		})
	}
}
