package live

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/Mesfrum/flako/server/internal/httpapi"
	"github.com/Mesfrum/flako/server/internal/store"
)

const noteID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

var (
	discard = slog.New(slog.NewTextHandler(io.Discard, nil))
	goodIV  = base64.StdEncoding.EncodeToString(make([]byte, 12))
	goodCT  = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32))
)

// testOptions keeps tests fast; individual tests override fields.
func testOptions() Options {
	o := DefaultOptions()
	o.PingInterval = time.Hour
	return o
}

func newMux(log store.OpLog, opts Options) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /api/notes/{id}/live", NewHub(log, discard, opts))
	return httpapi.Logging(discard)(mux) // the real middleware: hijacking must work through it
}

func newTestServer(t *testing.T, opts Options) (string, *store.Memory) {
	t.Helper()
	log := store.NewMemory()
	srv := httptest.NewServer(newMux(log, opts))
	t.Cleanup(srv.Close)
	return srv.URL, log
}

func wsURL(base, id string) string {
	return "ws" + strings.TrimPrefix(base, "http") + "/api/notes/" + id + "/live"
}

func dial(t *testing.T, base string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, wsURL(base, noteID), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	c.SetReadLimit(64 << 20)
	t.Cleanup(func() { c.CloseNow() })
	return c
}

func send(t *testing.T, c *websocket.Conn, v any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := wsjson.Write(ctx, c, v); err != nil {
		t.Fatalf("send: %v", err)
	}
}

// recv reads the next message, skipping viewer-count chatter ("here"/"left") that most tests ignore.
func recv(t *testing.T, c *websocket.Conn) map[string]any {
	t.Helper()
	for {
		m := recvRaw(t, c)
		if m["t"] != "here" && m["t"] != "left" {
			return m
		}
	}
}

// recvRaw reads one message as a generic map (field names exactly as on the wire).
func recvRaw(t *testing.T, c *websocket.Conn) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var m map[string]any
	if err := wsjson.Read(ctx, c, &m); err != nil {
		t.Fatalf("recv: %v", err)
	}
	return m
}

func expectType(t *testing.T, m map[string]any, typ string) {
	t.Helper()
	if m["t"] != typ {
		t.Fatalf("got %v, want t=%q", m, typ)
	}
}

// join says hello and consumes welcome … synced, returning the welcome and the ops in between.
func join(t *testing.T, c *websocket.Conn, have int64) (map[string]any, []map[string]any) {
	t.Helper()
	send(t, c, map[string]any{"t": "hello", "have": have})
	welcome := recv(t, c)
	expectType(t, welcome, "welcome")
	var ops []map[string]any
	for {
		m := recv(t, c)
		if m["t"] == "synced" {
			if m["seq"] != welcome["seq"] {
				t.Fatalf("synced seq %v != welcome seq %v", m["seq"], welcome["seq"])
			}
			return welcome, ops
		}
		expectType(t, m, "op")
		ops = append(ops, m)
	}
}

// closeCode waits for the server to close the connection and returns the close status.
func closeCode(t *testing.T, c *websocket.Conn) websocket.StatusCode {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		_, _, err := c.Read(ctx)
		if err != nil {
			return websocket.CloseStatus(err)
		}
	}
}

func seed(t *testing.T, log *store.Memory, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		if _, err := log.AppendOp(context.Background(), noteID, bytes.Repeat([]byte{byte(i)}, 32), make([]byte, 12)); err != nil {
			t.Fatal(err)
		}
	}
}

func seqs(ops []map[string]any) []float64 {
	out := []float64{}
	for _, op := range ops {
		out = append(out, op["seq"].(float64))
	}
	return out
}

func equal(a, b []float64) bool {
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	return string(ja) == string(jb)
}

func TestJoinEmptyNote(t *testing.T) {
	base, _ := newTestServer(t, testOptions())
	welcome, ops := join(t, dial(t, base), 0)
	if welcome["seq"] != 0.0 || welcome["here"] != 1.0 || welcome["snapshot"] != nil || len(ops) != 0 {
		t.Fatalf("welcome = %v, ops = %v", welcome, ops)
	}
}

func TestOpsAreAckedAndBroadcast(t *testing.T) {
	base, log := newTestServer(t, testOptions())
	a, b := dial(t, base), dial(t, base)
	join(t, a, 0)
	join(t, b, 0)
	send(t, a, map[string]any{"t": "ops", "cid": "c1", "ct": goodCT, "iv": goodIV})

	ack := recv(t, a)
	if ack["t"] != "ack" || ack["cid"] != "c1" || ack["seq"] != 1.0 {
		t.Fatalf("ack = %v", ack)
	}
	op := recv(t, b)
	if op["t"] != "op" || op["seq"] != 1.0 || op["ct"] != goodCT || op["iv"] != goodIV {
		t.Fatalf("broadcast = %v", op)
	}
	// A must not get its own op back: the next thing A sees is the pong.
	send(t, a, map[string]any{"t": "ping"})
	expectType(t, recv(t, a), "pong")
	if seq, _ := log.LatestSeq(context.Background(), noteID); seq != 1 {
		t.Errorf("stored seq = %d, want 1", seq)
	}
}

func TestCatchUpFromZeroUsesLatestSnapshot(t *testing.T) {
	base, log := newTestServer(t, testOptions())
	seed(t, log, 5)
	if ok, _ := log.PutSnapshot(context.Background(), noteID, 3, []byte("snapshot-ciphertext"), make([]byte, 12)); !ok {
		t.Fatal("snapshot rejected")
	}
	seed(t, log, 2)
	welcome, ops := join(t, dial(t, base), 0)
	snap, _ := welcome["snapshot"].(map[string]any)
	if welcome["seq"] != 7.0 || snap == nil || snap["upTo"] != 3.0 {
		t.Fatalf("welcome = %v", welcome)
	}
	if !equal(seqs(ops), []float64{4, 5, 6, 7}) {
		t.Fatalf("catch-up seqs = %v, want 4..7", seqs(ops))
	}
}

func TestCatchUpFromHaveSkipsSnapshot(t *testing.T) {
	base, log := newTestServer(t, testOptions())
	seed(t, log, 5)
	log.PutSnapshot(context.Background(), noteID, 4, []byte("snapshot-ciphertext"), make([]byte, 12))
	welcome, ops := join(t, dial(t, base), 2)
	if welcome["snapshot"] != nil || !equal(seqs(ops), []float64{3, 4, 5}) {
		t.Fatalf("welcome = %v, seqs = %v", welcome, seqs(ops))
	}
}

func TestCatchUpPages(t *testing.T) {
	opts := testOptions()
	opts.CatchUpPage = 2
	base, log := newTestServer(t, opts)
	seed(t, log, 5)
	_, ops := join(t, dial(t, base), 0)
	if !equal(seqs(ops), []float64{1, 2, 3, 4, 5}) {
		t.Fatalf("seqs = %v", seqs(ops))
	}
}

func TestRejectsBadMessages(t *testing.T) {
	opts := testOptions()
	opts.MaxOpBytes = 1024
	base, _ := newTestServer(t, opts)
	big := base64.StdEncoding.EncodeToString(make([]byte, 1025))
	cases := map[string][]map[string]any{
		"ops before hello": {{"t": "ops", "cid": "x", "ct": goodCT, "iv": goodIV}},
		"iv of 11 bytes": {{"t": "hello", "have": 0}, {"t": "ops", "cid": "x", "ct": goodCT,
			"iv": base64.StdEncoding.EncodeToString(make([]byte, 11))}},
		"ciphertext too big": {{"t": "hello", "have": 0}, {"t": "ops", "cid": "x", "ct": big, "iv": goodIV}},
		"not base64":         {{"t": "hello", "have": 0}, {"t": "ops", "cid": "x", "ct": "!!!", "iv": goodIV}},
		"unknown type":       {{"t": "hello", "have": 0}, {"t": "launch-missiles"}},
	}
	for name, msgs := range cases {
		t.Run(name, func(t *testing.T) {
			c := dial(t, base)
			for _, m := range msgs {
				send(t, c, m)
			}
			if code := closeCode(t, c); code != 4400 {
				t.Fatalf("close code = %d, want 4400", code)
			}
		})
	}
}

func TestInvalidIDIs400(t *testing.T) {
	base, _ := newTestServer(t, testOptions())
	res, err := http.Get(base + "/api/notes/short/live")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusBadRequest || !strings.HasPrefix(res.Header.Get("Content-Type"), "application/json") {
		t.Fatalf("status = %d, content-type %q; want JSON 400", res.StatusCode, res.Header.Get("Content-Type"))
	}
}

func TestPingPong(t *testing.T) {
	base, _ := newTestServer(t, testOptions())
	c := dial(t, base)
	join(t, c, 0)
	send(t, c, map[string]any{"t": "ping"})
	expectType(t, recv(t, c), "pong")
}

func TestServerPingKeepsIdleConnectionAlive(t *testing.T) {
	opts := testOptions()
	opts.PingInterval = 50 * time.Millisecond
	base, _ := newTestServer(t, opts)
	c := dial(t, base)
	join(t, c, 0)
	// The client library answers pings only while something reads; a reader loop is how a browser behaves.
	go func() {
		for {
			if _, _, err := c.Read(context.Background()); err != nil {
				return
			}
		}
	}()
	time.Sleep(300 * time.Millisecond) // several pings answered
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := c.Ping(ctx); err != nil {
		t.Fatalf("connection died: %v", err)
	}
}

func TestConnectionOutlivesServerTimeouts(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{
		Handler:      newMux(store.NewMemory(), testOptions()),
		ReadTimeout:  200 * time.Millisecond,
		WriteTimeout: 200 * time.Millisecond,
	}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })

	c := dial(t, "http://"+ln.Addr().String())
	join(t, c, 0)
	time.Sleep(time.Second) // 5x the server's read/write timeouts
	send(t, c, map[string]any{"t": "ping"})
	expectType(t, recv(t, c), "pong")
	send(t, c, map[string]any{"t": "ops", "cid": "late", "ct": goodCT, "iv": goodIV})
	if ack := recv(t, c); ack["t"] != "ack" {
		t.Fatalf("ops after the timeout window: %v", ack)
	}
}

func TestPresenceRelayedNotStored(t *testing.T) {
	base, log := newTestServer(t, testOptions())
	a, b := dial(t, base), dial(t, base)
	join(t, a, 0)
	join(t, b, 0)
	send(t, a, map[string]any{"t": "presence", "ct": goodCT, "iv": goodIV})
	m := recv(t, b)
	if m["t"] != "presence" || m["ct"] != goodCT || m["iv"] != goodIV || m["from"] != 1.0 {
		t.Fatalf("presence = %v, want from 1 (A)", m)
	}
	if seq, _ := log.LatestSeq(context.Background(), noteID); seq != 0 {
		t.Errorf("presence was stored: LatestSeq = %d", seq)
	}
}

func TestPresenceTooBigIsRejected(t *testing.T) {
	base, _ := newTestServer(t, testOptions())
	c := dial(t, base)
	join(t, c, 0)
	send(t, c, map[string]any{"t": "presence", "ct": base64.StdEncoding.EncodeToString(make([]byte, 4097)), "iv": goodIV})
	if code := closeCode(t, c); code != 4400 {
		t.Fatalf("close code = %d, want 4400", code)
	}
}

func TestHereCountsJoinAndLeave(t *testing.T) {
	base, _ := newTestServer(t, testOptions())
	a := dial(t, base)
	if w, _ := join(t, a, 0); w["here"] != 1.0 {
		t.Fatalf("welcome.here = %v, want 1", w["here"])
	}
	b := dial(t, base)
	if w, _ := join(t, b, 0); w["here"] != 2.0 {
		t.Fatalf("B welcome.here = %v, want 2", w["here"])
	}
	if m := recvRaw(t, a); m["t"] != "here" || m["n"] != 2.0 {
		t.Fatalf("A got %v, want here 2", m)
	}
	b.Close(websocket.StatusNormalClosure, "")
	if m := recvRaw(t, a); m["t"] != "left" || m["from"] != 2.0 {
		t.Fatalf("A got %v, want left from 2", m)
	}
	if m := recvRaw(t, a); m["t"] != "here" || m["n"] != 1.0 {
		t.Fatalf("A got %v, want here 1", m)
	}
}

func TestRoomFull(t *testing.T) {
	opts := testOptions()
	opts.MaxPeers = 2
	base, _ := newTestServer(t, opts)
	join(t, dial(t, base), 0)
	join(t, dial(t, base), 0)
	third := dial(t, base)
	send(t, third, map[string]any{"t": "hello", "have": 0})
	if code := closeCode(t, third); code != 4001 {
		t.Fatalf("close code = %d, want 4001", code)
	}
}

func TestSnapshotStored(t *testing.T) {
	base, log := newTestServer(t, testOptions())
	c := dial(t, base)
	join(t, c, 0)
	for i := 0; i < 3; i++ {
		send(t, c, map[string]any{"t": "ops", "cid": "c", "ct": goodCT, "iv": goodIV})
		expectType(t, recv(t, c), "ack")
	}
	send(t, c, map[string]any{"t": "snapshot", "upTo": 3, "ct": goodCT, "iv": goodIV})
	send(t, c, map[string]any{"t": "ping"}) // the server handles messages in order: pong ⇒ snapshot done
	expectType(t, recv(t, c), "pong")
	snap, err := log.LatestSnapshot(context.Background(), noteID)
	if err != nil || snap.UpToSeq != 3 {
		t.Fatalf("LatestSnapshot = %+v, %v; want upTo 3", snap, err)
	}
}

func TestSlowClientDropped(t *testing.T) {
	opts := testOptions()
	opts.SendBuffer = 2
	opts.MaxOpBytes = 64 << 10
	base, _ := newTestServer(t, opts)
	a, b, slow := dial(t, base), dial(t, base), dial(t, base)
	join(t, a, 0)
	join(t, b, 0)
	join(t, slow, 0) // …and then never reads again

	bigCT := base64.StdEncoding.EncodeToString(make([]byte, 60<<10))
	for i := 0; i < 50; i++ {
		send(t, a, map[string]any{"t": "ops", "cid": "big", "ct": bigCT, "iv": goodIV})
		expectType(t, recv(t, a), "ack") // A keeps being served
		if m := recv(t, b); m["t"] != "op" {
			t.Fatalf("B got %v, want op", m)
		}
	}
	if code := closeCode(t, slow); code != 4008 {
		t.Fatalf("slow client close code = %d, want 4008", code)
	}
}
