// Package httpapi exposes the note store over HTTP.
package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"

	"github.com/Mesfrum/shribe2e/server/internal/store"
)

const maxBodyBytes = 1 << 20 // 1 MiB

var noteIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

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

type putRequest struct {
	Ciphertext  string `json:"ciphertext"`
	IV          string `json:"iv"`
	BaseVersion *int64 `json:"base_version"` // pointer so a missing field is detectable
}

type putResponse struct {
	Version   int64 `json:"version"`
	UpdatedAt int64 `json:"updated_at"`
}

func (a *API) getNote(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !noteIDPattern.MatchString(id) {
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

func (a *API) putNote(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !noteIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid note id")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req putRequest
	if err := dec.Decode(&req); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, http.StatusRequestEntityTooLarge, "note too large")
			return
		}
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	note, err := req.toNote(id)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	saved, err := a.store.PutNote(r.Context(), note, *req.BaseVersion)
	var conflict *store.ConflictError
	if errors.As(err, &conflict) {
		current := conflict.Current
		writeJSON(w, http.StatusConflict, errorResponse{Error: "version conflict", CurrentVersion: &current})
		return
	}
	if err != nil {
		a.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, putResponse{Version: saved.Version, UpdatedAt: saved.UpdatedAt.UnixMilli()})
}

// toNote validates the request. Error messages are safe to show clients.
func (req putRequest) toNote(id string) (store.Note, error) {
	if req.BaseVersion == nil {
		return store.Note{}, errors.New("base_version is required")
	}
	if *req.BaseVersion < 0 {
		return store.Note{}, errors.New("base_version must be >= 0")
	}
	iv, err := base64.StdEncoding.DecodeString(req.IV)
	if err != nil || len(iv) != 12 {
		return store.Note{}, errors.New("iv must be 12 bytes, base64-encoded")
	}
	ct, err := base64.StdEncoding.DecodeString(req.Ciphertext)
	if err != nil || len(ct) < 16 {
		return store.Note{}, errors.New("ciphertext must be at least 16 bytes, base64-encoded")
	}
	return store.Note{ID: id, Ciphertext: ct, IV: iv}, nil
}

func (a *API) internalError(w http.ResponseWriter, r *http.Request, err error) {
	a.logger.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
	writeError(w, http.StatusInternalServerError, "internal error")
}
