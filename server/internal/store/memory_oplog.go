package store

import (
	"bytes"
	"context"
)

var _ OpLog = (*Memory)(nil)

func (m *Memory) AppendOp(_ context.Context, noteID string, ciphertext, iv []byte) (StoredOp, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	op := StoredOp{
		Seq:        int64(len(m.ops[noteID]) + 1),
		Ciphertext: bytes.Clone(ciphertext),
		IV:         bytes.Clone(iv),
		CreatedAt:  nowMilli(),
	}
	m.ops[noteID] = append(m.ops[noteID], op)
	return cloneOp(op), nil
}

func (m *Memory) OpsAfter(_ context.Context, noteID string, afterSeq int64, limit int) ([]StoredOp, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	all := m.ops[noteID] // seq k lives at index k-1
	out := []StoredOp{}
	for i := int(afterSeq); i < len(all) && len(out) < limit; i++ {
		out = append(out, cloneOp(all[i]))
	}
	return out, nil
}

func (m *Memory) LatestSeq(_ context.Context, noteID string) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return int64(len(m.ops[noteID])), nil
}

func (m *Memory) PutSnapshot(_ context.Context, noteID string, upToSeq int64, ciphertext, iv []byte) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	snaps := m.snapshots[noteID]
	if upToSeq > int64(len(m.ops[noteID])) || (len(snaps) > 0 && upToSeq <= snaps[len(snaps)-1].UpToSeq) {
		return false, nil
	}
	m.snapshots[noteID] = append(snaps, Snapshot{
		UpToSeq: upToSeq, Ciphertext: bytes.Clone(ciphertext), IV: bytes.Clone(iv), CreatedAt: nowMilli(),
	})
	return true, nil
}

func (m *Memory) LatestSnapshot(_ context.Context, noteID string) (Snapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	snaps := m.snapshots[noteID]
	if len(snaps) == 0 {
		return Snapshot{}, ErrNotFound
	}
	s := snaps[len(snaps)-1]
	s.Ciphertext, s.IV = bytes.Clone(s.Ciphertext), bytes.Clone(s.IV)
	return s, nil
}

func cloneOp(op StoredOp) StoredOp {
	op.Ciphertext = bytes.Clone(op.Ciphertext)
	op.IV = bytes.Clone(op.IV)
	return op
}
