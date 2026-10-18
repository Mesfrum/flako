package live

import (
	"bytes"
	"context"
	"encoding/base64"
	"testing"

	"github.com/coder/websocket"

	"github.com/Mesfrum/flako/server/internal/store"
)

// seedIVs appends n ops with distinct IVs and returns each IV as the wire (std base64) string.
func seedIVs(t *testing.T, log *store.Memory, n int) []string {
	t.Helper()
	var ivs []string
	for i := 0; i < n; i++ {
		iv := bytes.Repeat([]byte{byte(i + 1)}, 12)
		if _, err := log.AppendOp(context.Background(), noteID, bytes.Repeat([]byte{byte(i)}, 32), iv); err != nil {
			t.Fatal(err)
		}
		ivs = append(ivs, base64.StdEncoding.EncodeToString(iv))
	}
	return ivs
}

// joinHello is join with a caller-built hello (to set haveIv).
func joinHello(t *testing.T, c *websocket.Conn, hello map[string]any) (map[string]any, []map[string]any) {
	t.Helper()
	hello["t"] = "hello"
	send(t, c, hello)
	welcome := recv(t, c)
	expectType(t, welcome, "welcome")
	var ops []map[string]any
	for {
		m := recv(t, c)
		if m["t"] == "synced" {
			return welcome, ops
		}
		expectType(t, m, "op")
		ops = append(ops, m)
	}
}

func TestHelloWithMatchingIVCatchesUpNormally(t *testing.T) {
	base, log := newTestServer(t, testOptions())
	ivs := seedIVs(t, log, 3)
	welcome, ops := joinHello(t, dial(t, base), map[string]any{"have": 2, "haveIv": ivs[1]})
	if welcome["reset"] != false || welcome["seqIv"] != ivs[2] || welcome["seq"] != 3.0 {
		t.Fatalf("welcome = %v", welcome)
	}
	if !equal(seqs(ops), []float64{3}) {
		t.Fatalf("seqs = %v, want [3]", seqs(ops))
	}
}

func TestHelloAheadOfServerResets(t *testing.T) {
	base, log := newTestServer(t, testOptions())
	seedIVs(t, log, 2)
	welcome, ops := joinHello(t, dial(t, base), map[string]any{"have": 5, "haveIv": "x"})
	if welcome["reset"] != true || welcome["seq"] != 2.0 {
		t.Fatalf("welcome = %v", welcome)
	}
	if !equal(seqs(ops), []float64{1, 2}) {
		t.Fatalf("seqs = %v, want [1 2]", seqs(ops))
	}
}

func TestHelloWithDifferentIVResets(t *testing.T) {
	base, log := newTestServer(t, testOptions())
	seedIVs(t, log, 6)
	welcome, ops := joinHello(t, dial(t, base), map[string]any{"have": 4, "haveIv": goodIV})
	if welcome["reset"] != true {
		t.Fatalf("welcome = %v", welcome)
	}
	if !equal(seqs(ops), []float64{1, 2, 3, 4, 5, 6}) {
		t.Fatalf("seqs = %v, want 1..6", seqs(ops))
	}
}

func TestHelloWithDifferentIVResetsUsesSnapshot(t *testing.T) {
	base, log := newTestServer(t, testOptions())
	seedIVs(t, log, 6)
	log.PutSnapshot(context.Background(), noteID, 3, []byte("snapshot-ciphertext"), make([]byte, 12))
	welcome, ops := joinHello(t, dial(t, base), map[string]any{"have": 4, "haveIv": goodIV})
	snap, _ := welcome["snapshot"].(map[string]any)
	if welcome["reset"] != true || snap == nil || snap["upTo"] != 3.0 {
		t.Fatalf("welcome = %v", welcome)
	}
	if !equal(seqs(ops), []float64{4, 5, 6}) {
		t.Fatalf("seqs = %v, want 4..6", seqs(ops))
	}
}

func TestHelloWithoutIVKeepsOldBehaviour(t *testing.T) {
	base, log := newTestServer(t, testOptions())
	seedIVs(t, log, 2)
	welcome, ops := joinHello(t, dial(t, base), map[string]any{"have": 5})
	if welcome["reset"] != false || len(ops) != 0 {
		t.Fatalf("welcome = %v, ops = %v", welcome, ops)
	}
}

func TestWelcomeSeqIVEmptyForEmptyNote(t *testing.T) {
	base, _ := newTestServer(t, testOptions())
	welcome, _ := joinHello(t, dial(t, base), map[string]any{"have": 0})
	if welcome["seqIv"] != "" || welcome["reset"] != false {
		t.Fatalf("welcome = %v", welcome)
	}
}
