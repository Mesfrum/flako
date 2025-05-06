package routes

import (
	"github.com/Mesfrum/shribe2e/server/handlers"
	"github.com/gorilla/mux"
)

func SetupRoutes() *mux.Router {
	r := mux.NewRouter()
	r.HandleFunc("/api/{note_id}", handlers.FetchNote).Methods("GET")
	return r
}
