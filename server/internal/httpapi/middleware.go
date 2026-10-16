package httpapi

import (
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"time"
)

// statusRecorder embeds http.ResponseWriter (inheriting all its methods) and
// overrides WriteHeader to remember the status code.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// Logging logs one line per request: method, path, status, duration.
func Logging(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r)
			logger.Info("request",
				"method", r.Method,
				"path", logPath(r.URL.Path),
				"status", rec.status,
				"duration_ms", time.Since(start).Milliseconds(),
			)
		})
	}
}

// logPath keeps API, asset and health paths, and hides everything else: a page
// path may be a note name (from an old-style /<name> link), and the name is the key.
func logPath(p string) string {
	if p == "/" || p == "/healthz" || strings.HasPrefix(p, "/api/") || strings.HasPrefix(p, "/assets/") {
		return p
	}
	return "[page]"
}

// Recover converts a panic in a handler into a 500 so one bad request cannot
// crash the server.
func Recover(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				v := recover()
				if v == nil {
					return
				}
				if v == http.ErrAbortHandler { // deliberate abort: let net/http handle it
					panic(v)
				}
				logger.Error("panic", "path", r.URL.Path, "panic", v, "stack", string(debug.Stack()))
				writeError(w, http.StatusInternalServerError, "internal error")
			}()
			next.ServeHTTP(w, r)
		})
	}
}
