package routes

import (
	"net/http"

	"github.com/Mesfrum/shribe2e/server/handlers"
	"github.com/gorilla/mux"
)

func SetupRoutes() *mux.Router {
	r := mux.NewRouter()

	r.Methods("OPTIONS").HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	r.HandleFunc("/api/note/{note_id}", handlers.FetchNote).Methods("GET")
	r.HandleFunc("/api/note/{note_id}", handlers.UpdateNoteHandler).Methods("PUT")
	return r
}
