package store

import (
	"context"
	"time"
)

// StoredOp is one encrypted batch of CRDT ops. The server orders and stores it, never reads it.
type StoredOp struct {
	Seq        int64
	Ciphertext []byte
	IV         []byte
	CreatedAt  time.Time
}

// Snapshot is a client-made, encrypted copy of the whole CRDT state covering ops 1..UpToSeq.
type Snapshot struct {
	UpToSeq    int64
	Ciphertext []byte
	IV         []byte
	CreatedAt  time.Time
}

// OpLog is the append-only, per-note log behind live editing. Safe for concurrent use.
type OpLog interface {
	// AppendOp stores a batch with seq = previous max + 1 (starting at 1).
	AppendOp(ctx context.Context, noteID string, ciphertext, iv []byte) (StoredOp, error)
	// OpsAfter returns up to limit ops with seq > afterSeq, ascending.
	OpsAfter(ctx context.Context, noteID string, afterSeq int64, limit int) ([]StoredOp, error)
	// LatestSeq is 0 for a note with no ops.
	LatestSeq(ctx context.Context, noteID string) (int64, error)
	// PutSnapshot keeps the snapshot only if upToSeq <= LatestSeq and it is newer than the
	// current latest snapshot; it reports whether it was kept. All kept snapshots are retained.
	PutSnapshot(ctx context.Context, noteID string, upToSeq int64, ciphertext, iv []byte) (bool, error)
	// LatestSnapshot returns ErrNotFound when the note has none.
	LatestSnapshot(ctx context.Context, noteID string) (Snapshot, error)
}
