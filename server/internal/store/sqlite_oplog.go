package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

var _ OpLog = (*SQLite)(nil)

func (s *SQLite) AppendOp(ctx context.Context, noteID string, ciphertext, iv []byte) (StoredOp, error) {
	// The statement below is atomic on its own (SQLite takes the write lock before evaluating the
	// SELECT); the mutex just queues our own goroutines instead of making them spin on busy_timeout.
	s.appendMu.Lock()
	defer s.appendMu.Unlock()
	now := nowMilli()
	var seq int64
	// The (note_id, seq) primary key is the backstop: a duplicate seq fails instead of overwriting.
	err := s.db.QueryRowContext(ctx,
		`INSERT INTO ops (note_id, seq, ciphertext, iv, created_at)
		 SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ? FROM ops WHERE note_id = ?
		 RETURNING seq`,
		noteID, ciphertext, iv, now.UnixMilli(), noteID,
	).Scan(&seq)
	if err != nil {
		return StoredOp{}, fmt.Errorf("append op: %w", err)
	}
	return StoredOp{Seq: seq, Ciphertext: bytes.Clone(ciphertext), IV: bytes.Clone(iv), CreatedAt: now}, nil
}

func (s *SQLite) OpsAfter(ctx context.Context, noteID string, afterSeq int64, limit int) ([]StoredOp, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT seq, ciphertext, iv, created_at FROM ops
		 WHERE note_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
		noteID, afterSeq, limit)
	if err != nil {
		return nil, fmt.Errorf("ops after: %w", err)
	}
	defer rows.Close()
	out := []StoredOp{}
	for rows.Next() {
		var op StoredOp
		var created int64
		if err := rows.Scan(&op.Seq, &op.Ciphertext, &op.IV, &created); err != nil {
			return nil, fmt.Errorf("ops after: %w", err)
		}
		op.CreatedAt = time.UnixMilli(created).UTC()
		out = append(out, op)
	}
	return out, rows.Err()
}

func (s *SQLite) LatestSeq(ctx context.Context, noteID string) (int64, error) {
	var seq int64
	err := s.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(seq), 0) FROM ops WHERE note_id = ?`, noteID).Scan(&seq)
	if err != nil {
		return 0, fmt.Errorf("latest seq: %w", err)
	}
	return seq, nil
}

func (s *SQLite) PutSnapshot(ctx context.Context, noteID string, upToSeq int64, ciphertext, iv []byte) (bool, error) {
	// One statement decides and inserts: newer than the latest snapshot, and not ahead of the log.
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO snapshots (note_id, up_to_seq, ciphertext, iv, created_at)
		 SELECT ?, ?, ?, ?, ?
		 WHERE ? <= (SELECT COALESCE(MAX(seq), 0) FROM ops WHERE note_id = ?)
		   AND ? > (SELECT COALESCE(MAX(up_to_seq), 0) FROM snapshots WHERE note_id = ?)`,
		noteID, upToSeq, ciphertext, iv, nowMilli().UnixMilli(),
		upToSeq, noteID, upToSeq, noteID)
	if err != nil {
		return false, fmt.Errorf("put snapshot: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("put snapshot: %w", err)
	}
	return n == 1, nil
}

func (s *SQLite) LatestSnapshot(ctx context.Context, noteID string) (Snapshot, error) {
	var snap Snapshot
	var created int64
	err := s.db.QueryRowContext(ctx,
		`SELECT up_to_seq, ciphertext, iv, created_at FROM snapshots
		 WHERE note_id = ? ORDER BY up_to_seq DESC LIMIT 1`, noteID,
	).Scan(&snap.UpToSeq, &snap.Ciphertext, &snap.IV, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return Snapshot{}, ErrNotFound
	}
	if err != nil {
		return Snapshot{}, fmt.Errorf("latest snapshot: %w", err)
	}
	snap.CreatedAt = time.UnixMilli(created).UTC()
	return snap, nil
}
