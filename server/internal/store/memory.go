package store

import (
	"bytes"
	"context"
	"sync"
)

// Memory is an in-memory Store. It is the reference implementation of the
// contract and the fake used by handler tests. Data is lost on restart.
type Memory struct {
	mu        sync.Mutex
	notes     map[string]Note
	ops       map[string][]StoredOp // see memory_oplog.go
	snapshots map[string][]Snapshot
}

var _ Store = (*Memory)(nil) // compile-time check: *Memory satisfies Store

func NewMemory() *Memory {
	return &Memory{
		notes:     make(map[string]Note),
		ops:       make(map[string][]StoredOp),
		snapshots: make(map[string][]Snapshot),
	}
}

func (m *Memory) GetNote(_ context.Context, id string) (Note, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	n, ok := m.notes[id]
	if !ok {
		return Note{}, ErrNotFound
	}
	return cloneNote(n), nil
}

func (m *Memory) PutNote(_ context.Context, n Note, baseVersion int64) (Note, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	current, exists := m.notes[n.ID]
	// A missing note has version 0, so "create" and "update" are the same check.
	if baseVersion != current.Version {
		return Note{}, &ConflictError{Current: current.Version}
	}

	now := nowMilli()
	stored := Note{
		ID:         n.ID,
		Ciphertext: bytes.Clone(n.Ciphertext),
		IV:         bytes.Clone(n.IV),
		Version:    current.Version + 1,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	if exists {
		stored.CreatedAt = current.CreatedAt
	}
	m.notes[n.ID] = stored
	return cloneNote(stored), nil
}

func cloneNote(n Note) Note {
	n.Ciphertext = bytes.Clone(n.Ciphertext)
	n.IV = bytes.Clone(n.IV)
	return n
}
