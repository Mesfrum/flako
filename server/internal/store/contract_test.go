package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
)

const testID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" // 43 chars, like a real id

func sampleNote(content string) Note {
	return Note{ID: testID, Ciphertext: []byte(content), IV: bytes.Repeat([]byte{7}, 12)}
}

// runContract is the behaviour every Store implementation must have.
func runContract(t *testing.T, newStore func(t *testing.T) Store) {
	ctx := context.Background()

	t.Run("get missing note returns ErrNotFound", func(t *testing.T) {
		s := newStore(t)
		_, err := s.GetNote(ctx, testID)
		if !errors.Is(err, ErrNotFound) {
			t.Fatalf("GetNote err = %v, want ErrNotFound", err)
		}
	})

	t.Run("create with base 0 then read back", func(t *testing.T) {
		s := newStore(t)
		in := sampleNote("hello ciphertext")
		saved, err := s.PutNote(ctx, in, 0)
		if err != nil {
			t.Fatalf("PutNote: %v", err)
		}
		if saved.Version != 1 {
			t.Errorf("Version = %d, want 1", saved.Version)
		}
		if saved.CreatedAt.IsZero() || !saved.UpdatedAt.Equal(saved.CreatedAt) {
			t.Errorf("timestamps = %v / %v, want equal and non-zero", saved.CreatedAt, saved.UpdatedAt)
		}
		got, err := s.GetNote(ctx, testID)
		if err != nil {
			t.Fatalf("GetNote: %v", err)
		}
		if !bytes.Equal(got.Ciphertext, in.Ciphertext) || !bytes.Equal(got.IV, in.IV) {
			t.Errorf("GetNote bytes = %q/%v, want %q/%v", got.Ciphertext, got.IV, in.Ciphertext, in.IV)
		}
		if got.Version != 1 || !got.CreatedAt.Equal(saved.CreatedAt) {
			t.Errorf("GetNote = v%d created %v, want v1 created %v", got.Version, got.CreatedAt, saved.CreatedAt)
		}
	})

	t.Run("update with current base increments version and keeps created_at", func(t *testing.T) {
		s := newStore(t)
		first, err := s.PutNote(ctx, sampleNote("first"), 0)
		if err != nil {
			t.Fatal(err)
		}
		second, err := s.PutNote(ctx, sampleNote("second"), 1)
		if err != nil {
			t.Fatalf("update: %v", err)
		}
		if second.Version != 2 {
			t.Errorf("Version = %d, want 2", second.Version)
		}
		if !second.CreatedAt.Equal(first.CreatedAt) {
			t.Errorf("CreatedAt changed: %v -> %v", first.CreatedAt, second.CreatedAt)
		}
		got, _ := s.GetNote(ctx, testID)
		if string(got.Ciphertext) != "second" {
			t.Errorf("content = %q, want %q", got.Ciphertext, "second")
		}
	})

	conflicts := []struct {
		name        string
		setupSaves  int   // how many successful saves happen first
		base        int64 // baseVersion of the losing write
		wantCurrent int64
	}{
		{"create when note exists", 1, 0, 1},
		{"stale base version", 2, 1, 2},
		{"base version from the future", 1, 5, 1},
		{"update of a missing note", 0, 3, 0},
	}
	for _, tc := range conflicts {
		t.Run("conflict: "+tc.name, func(t *testing.T) {
			s := newStore(t)
			for v := range tc.setupSaves {
				if _, err := s.PutNote(ctx, sampleNote("setup"), int64(v)); err != nil {
					t.Fatalf("setup save %d: %v", v, err)
				}
			}
			_, err := s.PutNote(ctx, sampleNote("loser"), tc.base)
			var ce *ConflictError
			if !errors.As(err, &ce) {
				t.Fatalf("err = %v, want *ConflictError", err)
			}
			if !errors.Is(err, ErrVersionConflict) {
				t.Errorf("errors.Is(err, ErrVersionConflict) = false")
			}
			if ce.Current != tc.wantCurrent {
				t.Errorf("Current = %d, want %d", ce.Current, tc.wantCurrent)
			}
			if tc.setupSaves > 0 {
				got, _ := s.GetNote(ctx, testID)
				if string(got.Ciphertext) != "setup" {
					t.Errorf("losing write changed content to %q", got.Ciphertext)
				}
			}
		})
	}

	t.Run("store does not keep a reference to the caller's bytes", func(t *testing.T) {
		s := newStore(t)
		in := sampleNote("original")
		if _, err := s.PutNote(ctx, in, 0); err != nil {
			t.Fatal(err)
		}
		in.Ciphertext[0] = 'X'
		got, _ := s.GetNote(ctx, testID)
		if string(got.Ciphertext) != "original" {
			t.Errorf("stored content = %q, want %q", got.Ciphertext, "original")
		}
	})

	t.Run("concurrent creates: exactly one wins", func(t *testing.T) {
		s := newStore(t)
		const writers = 20
		var (
			wg        sync.WaitGroup
			mu        sync.Mutex
			wins      int
			conflicts int
			others    []error
		)
		for i := range writers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, err := s.PutNote(ctx, sampleNote(fmt.Sprintf("writer-%d", i)), 0)
				mu.Lock()
				defer mu.Unlock()
				switch {
				case err == nil:
					wins++
				case errors.Is(err, ErrVersionConflict):
					conflicts++
				default:
					others = append(others, err)
				}
			}()
		}
		wg.Wait()
		for _, err := range others {
			t.Errorf("unexpected error: %v", err)
		}
		if wins != 1 || conflicts != writers-1 {
			t.Fatalf("wins=%d conflicts=%d, want 1 and %d", wins, conflicts, writers-1)
		}
	})
}
