package handlers

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"github.com/Mesfrum/shribe2e/server/models"
	"github.com/Mesfrum/shribe2e/server/services"
	"github.com/Mesfrum/shribe2e/server/utils"
	"github.com/gorilla/mux"
	"github.com/jackc/pgx/v5"
)

func UpdateNoteHandler(w http.ResponseWriter, r *http.Request) {
	// checks for note id
	noteID, ok := mux.Vars(r)["note_id"]
	if !ok || noteID == "" {
		utils.RespondWithError(w, http.StatusBadRequest, "Missing note_id in URL")
		return
	}

	// decodes and verifies valid payload
	var req models.UpdateNoteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.RespondWithError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}

	if req.Content == "" {
		utils.RespondWithError(w, http.StatusBadRequest, "Content cannot be empty")
		return
	}

	note, err := services.UpdateNote(r.Context(), noteID, req.Content)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			utils.RespondWithError(w, http.StatusNotFound, "Note not found")
			return
		}
		log.Printf("Failed to update note %s: %v", noteID, err)
		utils.RespondWithError(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	utils.RespondWithJSON(w, http.StatusOK, note)
}
