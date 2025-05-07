package models

type Note struct {
	NoteID    string `json:"note_id"`
	Content   string `json:"content"`
	UpdatedAt int64  `json:"updated_at"` // UNIX timestamp in milliseconds
	CreatedAt int64  `json:"created_at"` // UNIX timestamp in milliseconds
	IsNew     bool   `json:"is_new"`     // true if newly created
}
