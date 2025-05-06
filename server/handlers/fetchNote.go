package handlers

import (
	"context"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/Mesfrum/shribe2e/server/db"
	"github.com/Mesfrum/shribe2e/server/models"
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

	note, err := getNoteByID(r.Context(), noteID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			utils.RespondWithError(w, http.StatusNotFound, "Note not found!")
		} else {
			log.Printf("Failed to fetch note %s: %v", noteID, err)
			utils.RespondWithError(w, http.StatusInternalServerError, "Internal server error")
		}
		return
	}

	utils.RespondWithJSON(w, http.StatusOK, note)
}

func getNoteByID(ctx context.Context, noteID string) (*models.Note, error) {
	const query = `
		SELECT note_id, content, updated_at 
		FROM notes 
		WHERE note_id = $1
	`

	var (
		note      models.Note
		updatedAt time.Time // used to handle postgres timestamp
	)

	err := db.Conn.QueryRow(ctx, query, noteID).Scan(&note.NoteID, &note.Content, &updatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, pgx.ErrNoRows
		}
		return nil, err
	}

	// Convert updatedAt to milliseconds since epoch
	note.UpdatedAt = updatedAt.UnixMilli()

	return &note, nil
}
