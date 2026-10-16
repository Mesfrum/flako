// Command server runs the flako HTTP server.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Mesfrum/flako/server/internal/config"
	"github.com/Mesfrum/flako/server/internal/httpapi"
	"github.com/Mesfrum/flako/server/internal/store"
	"github.com/Mesfrum/flako/server/internal/web"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

// run holds the real program so errors flow back as values and deferred
// cleanups (closing the DB) actually execute — os.Exit skips defers.
func run() error {
	cfg := config.Load(os.Getenv)
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))

	// ctx is cancelled on Ctrl+C (SIGINT) or SIGTERM (what Docker/systemd send).
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.OpenSQLite(ctx, cfg.DBPath)
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer st.Close()

	mux := newMux(st, logger)

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           httpapi.Logging(logger)(httpapi.Recover(logger)(mux)),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second, // revisit in Phase 2: WebSockets are long-lived
		IdleTimeout:       60 * time.Second,
	}

	serveErr := make(chan error, 1)
	go func() {
		logger.Info("listening", "addr", cfg.Addr, "db", cfg.DBPath)
		serveErr <- srv.ListenAndServe()
	}()

	select {
	case err := <-serveErr:
		if !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("serve: %w", err)
		}
	case <-ctx.Done():
		logger.Info("shutting down")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	return nil
}

// newMux wires the API and the embedded client onto one router.
func newMux(st store.Store, logger *slog.Logger) *http.ServeMux {
	mux := http.NewServeMux()
	httpapi.New(st, logger).Routes(mux)
	// No method in the pattern: "GET /" would conflict with "/api/" (narrower method,
	// broader path — neither wins). The SPA handler rejects non-GET/HEAD itself.
	mux.Handle("/", web.Handler()) // everything that isn't /api or /healthz
	return mux
}
