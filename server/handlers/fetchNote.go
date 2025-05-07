package handlers

import (
	"errors"
	"log"
	"net/http"

	"github.com/Mesfrum/shribe2e/server/services"
	"github.com/Mesfrum/shribe2e/server/utils"
	"github.com/gorilla/mux"
	"github.com/jackc/pgx/v5"
)

func FetchNote(w http.ResponseWriter, r *http.Request) {
	noteID, ok := mux.Vars(r)["note_id"]
	if !ok || noteID == "" {
		utils.RespondWithError(w, http.StatusBadRequest, "Missing note_id in URL")
		return
	}

	note, err := services.GetNoteByID(r.Context(), noteID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Create Note when it does not exist
			note, err = services.CreateNote(r.Context(), noteID)
			if err != nil {
				log.Printf("Failed to create note %s: %v", noteID, err)
				utils.RespondWithError(w, http.StatusInternalServerError, "Failed to create note")
				return
			}
		} else {
			log.Printf("Failed to fetch note %s: %v", noteID, err)
			utils.RespondWithError(w, http.StatusInternalServerError, "Internal server error")
			return
		}
	} else {
		// For already existing note, IsNew is false
		note.IsNew = false
	}

	utils.RespondWithJSON(w, http.StatusOK, note)
}
