package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Mesfrum/flako/server/internal/store"
)

var validID = strings.Repeat("a", 43)

func newHandler(s store.Store) http.Handler {
	mux := http.NewServeMux()
	New(s, slog.New(slog.NewTextHandler(io.Discard, nil))).Routes(mux)
	return mux
}

func do(t *testing.T, h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decode[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.NewDecoder(rec.Body).Decode(&v); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return v
}

func TestGetMissingNoteIs404(t *testing.T) {
	rec := do(t, newHandler(store.NewMemory()), "GET", "/api/notes/"+validID, "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if got := decode[map[string]string](t, rec)["error"]; got == "" {
		t.Errorf("missing error message")
	}
}

func TestInvalidIDIs400(t *testing.T) {
	h := newHandler(store.NewMemory())
	for _, id := range []string{"short", strings.Repeat("a", 44), strings.Repeat("a", 42) + "!"} {
		rec := do(t, h, "GET", "/api/notes/"+id, "")
		if rec.Code != http.StatusBadRequest {
			t.Errorf("GET id=%q: status = %d, want 400", id, rec.Code)
		}
	}
}

func TestGetReturnsAPhase1Note(t *testing.T) {
	s := store.NewMemory()
	ct := []byte("0123456789abcdef-more")
	iv := bytes.Repeat([]byte{7}, 12)
	saved, err := s.PutNote(context.Background(), store.Note{ID: validID, Ciphertext: ct, IV: iv}, 0)
	if err != nil {
		t.Fatal(err)
	}
	rec := do(t, newHandler(s), "GET", "/api/notes/"+validID, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET status = %d", rec.Code)
	}
	got := decode[noteResponse](t, rec)
	want := noteResponse{
		Ciphertext: base64.StdEncoding.EncodeToString(ct),
		IV:         base64.StdEncoding.EncodeToString(iv),
		Version:    1,
		UpdatedAt:  saved.UpdatedAt.UnixMilli(),
	}
	if got != want {
		t.Errorf("GET = %+v, want %+v", got, want)
	}
}

func TestPutIsGone(t *testing.T) {
	// Notes moved to live editing; a stale Phase 1 tab must not fork the note.
	body := `{"ciphertext":"AAAAAAAAAAAAAAAAAAAAAA==","iv":"AAAAAAAAAAAAAAAA","base_version":0}`
	rec := do(t, newHandler(store.NewMemory()), "PUT", "/api/notes/"+validID, body)
	if rec.Code != http.StatusGone {
		t.Fatalf("status = %d, want 410", rec.Code)
	}
	if got := decode[map[string]string](t, rec)["error"]; got != "this note moved to live editing; reload the page" {
		t.Errorf("error = %q", got)
	}
}

type failingStore struct{}

func (failingStore) GetNote(context.Context, string) (store.Note, error) {
	return store.Note{}, errors.New("disk on fire")
}
func (failingStore) PutNote(context.Context, store.Note, int64) (store.Note, error) {
	return store.Note{}, errors.New("disk on fire")
}

func TestStoreFailureIsGeneric500(t *testing.T) {
	rec := do(t, newHandler(failingStore{}), "GET", "/api/notes/"+validID, "")
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "disk on fire") {
		t.Errorf("internal error leaked to client: %s", rec.Body)
	}
}

func TestUnknownAPIPathIsJSON404(t *testing.T) {
	rec := do(t, newHandler(store.NewMemory()), "GET", "/api/nope", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q, want JSON", ct)
	}
}

func TestHealthz(t *testing.T) {
	rec := do(t, newHandler(store.NewMemory()), "GET", "/healthz", "")
	if rec.Code != http.StatusOK || rec.Body.String() != "ok" {
		t.Fatalf("got %d %q, want 200 ok", rec.Code, rec.Body)
	}
}
