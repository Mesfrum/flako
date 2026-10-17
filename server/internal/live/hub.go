// Package live relays end-to-end-encrypted note edits between the people in a note, over
// WebSockets, and appends them to the note's op log. It never reads note content.
package live

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/Mesfrum/flako/server/internal/noteid"
	"github.com/Mesfrum/flako/server/internal/store"
)

// Close codes shared with client/src/live/protocol.ts.
const (
	closeRoomFull   websocket.StatusCode = 4001
	closeTooSlow    websocket.StatusCode = 4008
	closeBadMessage websocket.StatusCode = 4400
)

// Options are the hub's limits. DefaultOptions holds the production values.
type Options struct {
	MaxPeers         int           // connections per note
	SendBuffer       int           // queued broadcast messages per peer before it counts as too slow
	PingInterval     time.Duration // WebSocket-level ping (detects dead peers, keeps proxies happy)
	MaxOpBytes       int           // decoded ciphertext of one op batch
	MaxSnapshotBytes int           // decoded ciphertext of one snapshot
	CatchUpPage      int           // ops per OpsAfter call during catch-up
}

func DefaultOptions() Options {
	return Options{
		MaxPeers:         20,
		SendBuffer:       64,
		PingInterval:     30 * time.Second,
		MaxOpBytes:       256 << 10,
		MaxSnapshotBytes: 8 << 20,
		CatchUpPage:      200,
	}
}

// Hub owns one room per note id with live peers in it.
type Hub struct {
	log    store.OpLog
	logger *slog.Logger
	opts   Options

	mu    sync.Mutex
	rooms map[string]*room
}

type room struct {
	peers  map[*peer]struct{}
	nextID int
}

type peer struct {
	id     int
	conn   *websocket.Conn
	direct chan []byte // replies to this peer (welcome, catch-up, ack, pong): sender waits
	bcast  chan []byte // messages from others: never waited on; full = too slow
}

func NewHub(log store.OpLog, logger *slog.Logger, opts Options) *Hub {
	return &Hub{log: log, logger: logger, opts: opts, rooms: make(map[string]*room)}
}

func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !noteid.Valid(id) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"invalid note id"}` + "\n"))
		return
	}

	// http.Server's Read/WriteTimeout don't kill this long-lived connection: net/http clears the
	// connection's deadlines when Accept hijacks it (TestConnectionOutlivesServerTimeouts pins this).
	conn, err := websocket.Accept(w, r, nil) // default: reject cross-origin browser requests
	if err != nil {
		return // Accept already answered with an HTTP error
	}
	defer conn.CloseNow()
	conn.SetReadLimit(int64(h.opts.MaxSnapshotBytes*4/3 + 4096))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h.serve(ctx, cancel, conn, id)
}

func (h *Hub) serve(ctx context.Context, cancel context.CancelFunc, conn *websocket.Conn, id string) {
	var hello inMsg
	if err := readJSON(ctx, conn, &hello); err != nil {
		return
	}
	if hello.T != "hello" {
		conn.Close(closeBadMessage, "hello first")
		return
	}

	p := &peer{conn: conn, direct: make(chan []byte), bcast: make(chan []byte, h.opts.SendBuffer)}
	here := h.join(id, p) // join before reading the log, so no broadcast is missed
	defer h.leave(id, p)
	go h.writer(ctx, cancel, p)
	go h.pinger(ctx, cancel, conn)

	if err := h.catchUp(ctx, id, p, hello.Have, here); err != nil {
		h.fail(conn, "catch-up", err)
		return
	}

	for {
		var m inMsg
		if err := readJSON(ctx, conn, &m); err != nil {
			return // closed, timed out, or cancelled by the writer
		}
		switch m.T {
		case "ops":
			ct, iv, ok := decodeSealed(m.Ct, m.IV, h.opts.MaxOpBytes)
			if !ok {
				conn.Close(closeBadMessage, "bad ops message")
				return
			}
			op, err := h.log.AppendOp(ctx, id, ct, iv)
			if err != nil {
				h.fail(conn, "append", err)
				return
			}
			h.reply(ctx, p, ackMsg{T: "ack", Cid: m.Cid, Seq: op.Seq})
			h.broadcast(id, p, opMsg{T: "op", Seq: op.Seq, Ct: m.Ct, IV: m.IV})
		case "ping":
			h.reply(ctx, p, pongMsg{T: "pong"})
		default:
			conn.Close(closeBadMessage, "unknown message type")
			return
		}
	}
}

// catchUp sends welcome, every op the client is missing up to welcome.seq, then synced.
func (h *Hub) catchUp(ctx context.Context, id string, p *peer, have int64, here int) error {
	latest, err := h.log.LatestSeq(ctx, id)
	if err != nil {
		return err
	}
	welcome := welcomeMsg{T: "welcome", Seq: latest, Here: here}
	from := have
	if have == 0 {
		snap, err := h.log.LatestSnapshot(ctx, id)
		switch {
		case err == nil:
			welcome.Snapshot = &sealedSnapshot{
				UpTo: snap.UpToSeq,
				Ct:   base64.StdEncoding.EncodeToString(snap.Ciphertext),
				IV:   base64.StdEncoding.EncodeToString(snap.IV),
			}
			from = snap.UpToSeq
		case !errors.Is(err, store.ErrNotFound):
			return err
		}
	}
	h.reply(ctx, p, welcome)
	for from < latest {
		ops, err := h.log.OpsAfter(ctx, id, from, h.opts.CatchUpPage)
		if err != nil {
			return err
		}
		if len(ops) == 0 {
			break
		}
		for _, op := range ops {
			if op.Seq > latest {
				break // newer ops reach this peer by broadcast
			}
			h.reply(ctx, p, opMsg{
				T:   "op",
				Seq: op.Seq,
				Ct:  base64.StdEncoding.EncodeToString(op.Ciphertext),
				IV:  base64.StdEncoding.EncodeToString(op.IV),
			})
			from = op.Seq
		}
	}
	h.reply(ctx, p, syncedMsg{T: "synced", Seq: latest})
	return nil
}

// writer is the only goroutine that writes data frames to this connection.
func (h *Hub) writer(ctx context.Context, cancel context.CancelFunc, p *peer) {
	defer cancel()
	for {
		var b []byte
		select {
		case <-ctx.Done():
			return
		case b = <-p.direct:
		case b = <-p.bcast:
		}
		wctx, done := context.WithTimeout(ctx, 10*time.Second)
		err := p.conn.Write(wctx, websocket.MessageText, b)
		done()
		if err != nil {
			return
		}
	}
}

// pinger sends WebSocket pings; a peer that stops answering is dropped.
func (h *Hub) pinger(ctx context.Context, cancel context.CancelFunc, conn *websocket.Conn) {
	t := time.NewTicker(h.opts.PingInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pctx, done := context.WithTimeout(ctx, h.opts.PingInterval)
			err := conn.Ping(pctx)
			done()
			if err != nil {
				cancel()
				return
			}
		}
	}
}

// reply queues a message for this peer, waiting if needed (only this peer's goroutine waits).
func (h *Hub) reply(ctx context.Context, p *peer, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	select {
	case p.direct <- b:
	case <-ctx.Done():
	}
}

// broadcast sends to every peer in the room except `from`, never waiting on anyone.
func (h *Hub) broadcast(id string, from *peer, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[id]
	if r == nil {
		return
	}
	for p := range r.peers {
		if p == from {
			continue
		}
		select {
		case p.bcast <- b:
		default:
			// Its queue is full: it can't keep up. Task 9 drops it here.
		}
	}
}

func (h *Hub) join(id string, p *peer) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[id]
	if r == nil {
		r = &room{peers: make(map[*peer]struct{})}
		h.rooms[id] = r
	}
	r.nextID++
	p.id = r.nextID
	r.peers[p] = struct{}{}
	return len(r.peers)
}

func (h *Hub) leave(id string, p *peer) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[id]
	if r == nil {
		return
	}
	delete(r.peers, p)
	if len(r.peers) == 0 {
		delete(h.rooms, id)
	}
}

func (h *Hub) fail(conn *websocket.Conn, what string, err error) {
	h.logger.Error("live note failed", "step", what, "err", err)
	conn.Close(websocket.StatusInternalError, "server error")
}

func readJSON(ctx context.Context, conn *websocket.Conn, v any) error {
	_, b, err := conn.Read(ctx)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

// decodeSealed checks a sealed payload's shape: 12-byte IV, 16..max bytes of ciphertext.
func decodeSealed(ct, iv string, max int) ([]byte, []byte, bool) {
	ivb, err := base64.StdEncoding.DecodeString(iv)
	if err != nil || len(ivb) != 12 {
		return nil, nil, false
	}
	ctb, err := base64.StdEncoding.DecodeString(ct)
	if err != nil || len(ctb) < 16 || len(ctb) > max {
		return nil, nil, false
	}
	return ctb, ivb, true
}
