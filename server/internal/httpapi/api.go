// Package httpapi exposes the note store over HTTP.
package httpapi

import (
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"

	"github.com/Mesfrum/flako/server/internal/noteid"
	"github.com/Mesfrum/flako/server/internal/store"
)

// API holds handler dependencies.
type API struct {
	store  store.Store
	logger *slog.Logger
}

func New(s store.Store, logger *slog.Logger) *API {
	return &API{store: s, logger: logger}
}

// Routes registers the API on mux. More specific patterns win, so "/api/"
// only catches API paths nothing else matched.
func (a *API) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/notes/{id}", a.getNote)
	mux.HandleFunc("PUT /api/notes/{id}", a.putNote)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "no such endpoint")
	})
}

type noteResponse struct {
	Ciphertext string `json:"ciphertext"`
	IV         string `json:"iv"`
	Version    int64  `json:"version"`
	UpdatedAt  int64  `json:"updated_at"`
}

func (a *API) getNote(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !noteid.Valid(id) {
		writeError(w, http.StatusBadRequest, "invalid note id")
		return
	}
	n, err := a.store.GetNote(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "note not found")
		return
	}
	if err != nil {
		a.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, noteResponse{
		Ciphertext: base64.StdEncoding.EncodeToString(n.Ciphertext),
		IV:         base64.StdEncoding.EncodeToString(n.IV),
		Version:    n.Version,
		UpdatedAt:  n.UpdatedAt.UnixMilli(),
	})
}

// putNote is retired: notes are edited live over /api/notes/{id}/live now. A stale Phase 1 tab
// gets 410 instead of writing to the legacy blob and forking the note.
func (a *API) putNote(w http.ResponseWriter, _ *http.Request) {
	writeError(w, http.StatusGone, "this note moved to live editing; reload the page")
}

func (a *API) internalError(w http.ResponseWriter, r *http.Request, err error) {
	a.logger.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
	writeError(w, http.StatusInternalServerError, "internal error")
}
