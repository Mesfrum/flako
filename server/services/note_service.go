package services

import (
	"context"
	"errors"
	"time"

	"github.com/Mesfrum/shribe2e/server/db"
	"github.com/Mesfrum/shribe2e/server/models"
	"github.com/jackc/pgx/v5"
)

func CreateNote(ctx context.Context, noteID string) (*models.Note, error) {
	const query = `
		INSERT INTO notes (note_id, content, updated_at)
		VALUES ($1, $2, NOW())
		RETURNING note_id, content, updated_at, created_at
	`

	var (
		note      models.Note
		updatedAt time.Time
		createdAt time.Time
	)

	defaultContent := ""

	err := db.Conn.QueryRow(ctx, query, noteID, defaultContent).Scan(&note.NoteID, &note.Content, &updatedAt, &createdAt)
	if err != nil {
		return nil, err
	}

	// Convert timestamps to UNIX millisecond values
	note.UpdatedAt = updatedAt.UnixMilli()
	note.CreatedAt = createdAt.UnixMilli()

	note.IsNew = true

	return &note, nil
}

func GetNoteByID(ctx context.Context, noteID string) (*models.Note, error) {
	const query = `
		SELECT note_id, content, updated_at, created_at 
		FROM notes 
		WHERE note_id = $1
	`

	var (
		note       models.Note
		updated_at time.Time // for handling postgres timestamp
		created_at time.Time // for handling postgres timestamp
	)

	err := db.Conn.QueryRow(ctx, query, noteID).Scan(&note.NoteID, &note.Content, &updated_at, &created_at)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, pgx.ErrNoRows
		}
		return nil, err
	}

	// Converts updatedAt to milliseconds since epoch
	note.UpdatedAt = updated_at.UnixMilli()
	note.CreatedAt = created_at.UnixMilli()

	return &note, nil
}

func UpdateNote(ctx context.Context, noteID string, newContent string) (*models.Note, error) {
	const query = `
		UPDATE notes
		SET content = $1, updated_at = NOW()
		WHERE note_id = $2
		RETURNING note_id, content, updated_at, created_at
	`

	var (
		note      models.Note
		updatedAt time.Time
		createdAt time.Time
	)

	err := db.Conn.QueryRow(ctx, query, newContent, noteID).Scan(&note.NoteID, &note.Content, &updatedAt, &createdAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, pgx.ErrNoRows
		}
		return nil, err
	}

	note.UpdatedAt = updatedAt.UnixMilli()
	note.CreatedAt = createdAt.UnixMilli()

	return &note, nil
}
