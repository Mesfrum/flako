package store

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
)

const otherID = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

var testIV = bytes.Repeat([]byte{9}, 12)

func appendN(t *testing.T, log OpLog, id string, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		if _, err := log.AppendOp(context.Background(), id, []byte("op-ciphertext-00"), testIV); err != nil {
			t.Fatalf("AppendOp: %v", err)
		}
	}
}

// runOpLogContract is the behaviour every OpLog implementation must have.
func runOpLogContract(t *testing.T, newLog func(t *testing.T) OpLog) {
	ctx := context.Background()

	t.Run("append assigns 1, 2, 3 per note, independently per note", func(t *testing.T) {
		log := newLog(t)
		for want := int64(1); want <= 3; want++ {
			op, err := log.AppendOp(ctx, testID, []byte("ciphertext-bytes"), testIV)
			if err != nil || op.Seq != want {
				t.Fatalf("AppendOp = %d, %v; want seq %d", op.Seq, err, want)
			}
			if op.CreatedAt.IsZero() {
				t.Errorf("CreatedAt is zero")
			}
		}
		op, _ := log.AppendOp(ctx, otherID, []byte("ciphertext-bytes"), testIV)
		if op.Seq != 1 {
			t.Errorf("other note's first seq = %d, want 1", op.Seq)
		}
	})

	t.Run("OpsAfter returns ascending ops after the seq, honouring limit", func(t *testing.T) {
		log := newLog(t)
		appendN(t, log, testID, 5)
		ops, err := log.OpsAfter(ctx, testID, 2, 2)
		if err != nil || len(ops) != 2 || ops[0].Seq != 3 || ops[1].Seq != 4 {
			t.Fatalf("OpsAfter(2, 2) = %+v, %v; want seqs 3, 4", ops, err)
		}
		if !bytes.Equal(ops[0].Ciphertext, []byte("op-ciphertext-00")) || !bytes.Equal(ops[0].IV, testIV) {
			t.Errorf("bytes not returned intact")
		}
		rest, _ := log.OpsAfter(ctx, testID, 4, 100)
		if len(rest) != 1 || rest[0].Seq != 5 {
			t.Errorf("OpsAfter(4) = %+v, want [5]", rest)
		}
		none, _ := log.OpsAfter(ctx, testID, 5, 100)
		if len(none) != 0 {
			t.Errorf("OpsAfter(5) = %+v, want none", none)
		}
	})

	t.Run("LatestSeq is 0 for an empty note", func(t *testing.T) {
		log := newLog(t)
		if seq, err := log.LatestSeq(ctx, testID); err != nil || seq != 0 {
			t.Fatalf("LatestSeq = %d, %v; want 0", seq, err)
		}
		appendN(t, log, testID, 3)
		if seq, _ := log.LatestSeq(ctx, testID); seq != 3 {
			t.Errorf("LatestSeq = %d, want 3", seq)
		}
	})

	t.Run("20 concurrent appends get exactly seqs 1..20", func(t *testing.T) {
		log := newLog(t)
		var wg sync.WaitGroup
		var mu sync.Mutex
		seen := map[int64]bool{}
		for range 20 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				op, err := log.AppendOp(ctx, testID, []byte("concurrent-bytes"), testIV)
				mu.Lock()
				defer mu.Unlock()
				if err != nil {
					t.Errorf("AppendOp: %v", err)
					return
				}
				seen[op.Seq] = true
			}()
		}
		wg.Wait()
		for want := int64(1); want <= 20; want++ {
			if !seen[want] {
				t.Errorf("seq %d missing (got %v)", want, seen)
			}
		}
	})

	t.Run("snapshot: accepted when newer and <= latest seq; rejected when stale or ahead of the log", func(t *testing.T) {
		log := newLog(t)
		appendN(t, log, testID, 5)
		cases := []struct {
			upTo int64
			want bool
		}{
			{6, false}, // ahead of the log
			{3, true},
			{3, false}, // not newer
			{2, false}, // stale
			{5, true},
		}
		for _, tc := range cases {
			ok, err := log.PutSnapshot(ctx, testID, tc.upTo, []byte("snapshot-bytes!!"), testIV)
			if err != nil || ok != tc.want {
				t.Errorf("PutSnapshot(upTo %d) = %v, %v; want %v", tc.upTo, ok, err, tc.want)
			}
		}
	})

	t.Run("LatestSnapshot returns ErrNotFound, then the newest accepted", func(t *testing.T) {
		log := newLog(t)
		if _, err := log.LatestSnapshot(ctx, testID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("LatestSnapshot err = %v, want ErrNotFound", err)
		}
		appendN(t, log, testID, 4)
		log.PutSnapshot(ctx, testID, 2, []byte("snapshot-two!!!!"), testIV)
		log.PutSnapshot(ctx, testID, 4, []byte("snapshot-four!!!"), testIV)
		snap, err := log.LatestSnapshot(ctx, testID)
		if err != nil || snap.UpToSeq != 4 || string(snap.Ciphertext) != "snapshot-four!!!" || !bytes.Equal(snap.IV, testIV) {
			t.Fatalf("LatestSnapshot = %+v, %v; want upTo 4", snap, err)
		}
	})

	t.Run("stored bytes are copies (mutating the input after append changes nothing)", func(t *testing.T) {
		log := newLog(t)
		ct := []byte("original-bytes!!")
		log.AppendOp(ctx, testID, ct, testIV)
		ct[0] = 'X'
		ops, _ := log.OpsAfter(ctx, testID, 0, 10)
		if string(ops[0].Ciphertext) != "original-bytes!!" {
			t.Errorf("stored = %q", ops[0].Ciphertext)
		}
	})
}

func TestMemoryOpLog(t *testing.T) {
	runOpLogContract(t, func(t *testing.T) OpLog { return NewMemory() })
}
