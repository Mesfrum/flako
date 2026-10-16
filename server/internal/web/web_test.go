package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestSPAHandler(t *testing.T) {
	fsys := fstest.MapFS{
		"index.html":    {Data: []byte("<html>app</html>")},
		"assets/app.js": {Data: []byte("console.log(1)")},
	}
	h := NewSPAHandler(fsys)

	cases := []struct {
		path       string
		wantStatus int
		wantBody   string
	}{
		{"/", 200, "<html>app</html>"},
		{"/assets/app.js", 200, "console.log(1)"},
		{"/taco", 200, "<html>app</html>"},
		{"/my%20notes/work", 200, "<html>app</html>"},
		{"/assets/missing.js", 404, ""},
	}
	for _, tc := range cases {
		t.Run(tc.path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest("GET", tc.path, nil))
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d", rec.Code, tc.wantStatus)
			}
			if tc.wantBody != "" && rec.Body.String() != tc.wantBody {
				t.Errorf("body = %q, want %q", rec.Body, tc.wantBody)
			}
		})
	}
}

func TestSPAHandlerOnlyServesReads(t *testing.T) {
	h := NewSPAHandler(fstest.MapFS{"index.html": {Data: []byte("<html>app</html>")}})
	for _, method := range []string{"POST", "PUT", "DELETE"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(method, "/taco", nil))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s /taco = %d, want 405", method, rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("HEAD", "/taco", nil))
	if rec.Code != http.StatusOK {
		t.Errorf("HEAD /taco = %d, want 200", rec.Code)
	}
}

func TestSPAHandlerWithoutBuild(t *testing.T) {
	h := NewSPAHandler(fstest.MapFS{".gitkeep": {}})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "npm run build") {
		t.Fatalf("got %d %q, want 503 with build hint", rec.Code, rec.Body)
	}
}
