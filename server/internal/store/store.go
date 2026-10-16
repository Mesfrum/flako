// Package store persists encrypted notes. It never sees plaintext.
package store

import (
	"context"
	"errors"
	"fmt"
	"time"
)

var (
	// ErrNotFound means no note exists with the given id.
	ErrNotFound = errors.New("note not found")
	// ErrVersionConflict means the caller's baseVersion is not the current version.
	ErrVersionConflict = errors.New("version conflict")
)

// ConflictError reports a version conflict along with the version the store holds.
// errors.Is(err, ErrVersionConflict) is true for it.
type ConflictError struct {
	Current int64 // 0 when the note does not exist
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("version conflict: current version is %d", e.Current)
}

func (e *ConflictError) Unwrap() error { return ErrVersionConflict }

// Note is an encrypted note as stored. Ciphertext and IV are opaque bytes.
type Note struct {
	ID         string
	Ciphertext []byte
	IV         []byte
	Version    int64
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// Store is the persistence boundary. Implementations must be safe for concurrent use.
type Store interface {
	GetNote(ctx context.Context, id string) (Note, error)
	// PutNote stores n.Ciphertext and n.IV under n.ID if baseVersion equals the
	// current version (0 = note must not exist yet). On success the returned
	// Note has Version = baseVersion+1. Otherwise it returns a *ConflictError.
	PutNote(ctx context.Context, n Note, baseVersion int64) (Note, error)
}

// nowMilli returns the current UTC time truncated to milliseconds, the
// resolution we persist, so every Store returns identical timestamps.
func nowMilli() time.Time {
	return time.UnixMilli(time.Now().UnixMilli()).UTC()
}
