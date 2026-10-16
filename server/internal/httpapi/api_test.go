package httpapi

import (
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

	"github.com/Mesfrum/shribe2e/server/internal/store"
)

var (
	validID = strings.Repeat("a", 43)
	validIV = base64.StdEncoding.EncodeToString(make([]byte, 12))
	validCT = base64.StdEncoding.EncodeToString(make([]byte, 16)) // smallest legal: an empty note's GCM tag
)

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

func putBody(ct, iv string, base int64) string {
	return `{"ciphertext":"` + ct + `","iv":"` + iv + `","base_version":` + jsonInt(base) + `}`
}

func jsonInt(n int64) string { b, _ := json.Marshal(n); return string(b) }

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
		for _, method := range []string{"GET", "PUT"} {
			rec := do(t, h, method, "/api/notes/"+id, putBody(validCT, validIV, 0))
			if rec.Code != http.StatusBadRequest {
				t.Errorf("%s id=%q: status = %d, want 400", method, id, rec.Code)
			}
		}
	}
}

func TestPutThenGetRoundTrip(t *testing.T) {
	h := newHandler(store.NewMemory())
	ct := base64.StdEncoding.EncodeToString([]byte("0123456789abcdef-more"))

	rec := do(t, h, "PUT", "/api/notes/"+validID, putBody(ct, validIV, 0))
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, body %s", rec.Code, rec.Body)
	}
	put := decode[putResponse](t, rec)
	if put.Version != 1 || put.UpdatedAt <= 0 {
		t.Errorf("PUT response = %+v, want version 1 and updated_at > 0", put)
	}

	rec = do(t, h, "GET", "/api/notes/"+validID, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET status = %d", rec.Code)
	}
	got := decode[noteResponse](t, rec)
	want := noteResponse{Ciphertext: ct, IV: validIV, Version: 1, UpdatedAt: put.UpdatedAt}
	if got != want {
		t.Errorf("GET = %+v, want %+v", got, want)
	}
}

func TestPutMinimalCiphertextIsAccepted(t *testing.T) {
	// An encrypted empty note is still >= 16 bytes, so "delete all text" must save.
	rec := do(t, newHandler(store.NewMemory()), "PUT", "/api/notes/"+validID, putBody(validCT, validIV, 0))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body)
	}
}

func TestPutValidation(t *testing.T) {
	cases := []struct{ name, body string }{
		{"invalid JSON", `{"ciphertext":`},
		{"unknown field", `{"ciphertext":"` + validCT + `","iv":"` + validIV + `","base_version":0,"name":"taco"}`},
		{"missing base_version", `{"ciphertext":"` + validCT + `","iv":"` + validIV + `"}`},
		{"negative base_version", putBody(validCT, validIV, -1)},
		{"ciphertext not base64", putBody("!!!", validIV, 0)},
		{"ciphertext too short", putBody(base64.StdEncoding.EncodeToString(make([]byte, 15)), validIV, 0)},
		{"iv wrong length", putBody(validCT, base64.StdEncoding.EncodeToString(make([]byte, 11)), 0)},
		{"iv not base64", putBody(validCT, "!!!", 0)},
	}
	h := newHandler(store.NewMemory())
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := do(t, h, "PUT", "/api/notes/"+validID, tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400 (body %s)", rec.Code, rec.Body)
			}
		})
	}
}

func TestPutConflictReportsCurrentVersion(t *testing.T) {
	h := newHandler(store.NewMemory())
	do(t, h, "PUT", "/api/notes/"+validID, putBody(validCT, validIV, 0))

	rec := do(t, h, "PUT", "/api/notes/"+validID, putBody(validCT, validIV, 0))
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
	if got := decode[errorResponse](t, rec); got.CurrentVersion == nil || *got.CurrentVersion != 1 {
		t.Errorf("current_version = %v, want 1", got.CurrentVersion)
	}
}

func TestPutConflictOnMissingNoteReportsZero(t *testing.T) {
	rec := do(t, newHandler(store.NewMemory()), "PUT", "/api/notes/"+validID, putBody(validCT, validIV, 3))
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"current_version":0`) {
		t.Errorf("body %s must include current_version 0", rec.Body)
	}
}

func TestPutTooLargeIs413(t *testing.T) {
	huge := strings.Repeat("A", 2<<20)
	rec := do(t, newHandler(store.NewMemory()), "PUT", "/api/notes/"+validID, putBody(huge, validIV, 0))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
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
	h := newHandler(failingStore{})
	for _, rec := range []*httptest.ResponseRecorder{
		do(t, h, "GET", "/api/notes/"+validID, ""),
		do(t, h, "PUT", "/api/notes/"+validID, putBody(validCT, validIV, 0)),
	} {
		if rec.Code != http.StatusInternalServerError {
			t.Errorf("status = %d, want 500", rec.Code)
		}
		if strings.Contains(rec.Body.String(), "disk on fire") {
			t.Errorf("internal error leaked to client: %s", rec.Body)
		}
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
