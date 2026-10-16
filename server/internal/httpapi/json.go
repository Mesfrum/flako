package httpapi

import (
	"encoding/json"
	"net/http"
)

type errorResponse struct {
	Error          string `json:"error"`
	CurrentVersion *int64 `json:"current_version,omitempty"` // pointer: 0 is a real value
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v) // the client hung up if this fails; nothing to do
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, errorResponse{Error: msg})
}
