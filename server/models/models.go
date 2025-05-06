package models

type Note struct {
	NoteID    string `json:"note_id"`
	Content   string `json:"content"`
	UpdatedAt int64  `json:"updatedAt"` // UNIX timestamp in milliseconds
}
