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

// maxPresenceBytes caps one sealed cursor message (a couple of ids and a colour, encrypted).
const maxPresenceBytes = 4096

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
	kick   sync.Once   // closes a too-slow peer at most once
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
	here, ok := h.join(id, p) // join before reading the log, so no broadcast is missed
	if !ok {
		conn.Close(closeRoomFull, "note is busy")
		return
	}
	defer h.leave(id, p)
	go h.writer(ctx, cancel, p)
	go h.pinger(ctx, cancel, conn)

	if err := h.catchUp(ctx, id, p, hello.Have, hello.HaveIV, here); err != nil {
		h.fail(conn, "catch-up", err)
		return
	}
	// The join-time count is stale by now, and the newcomer's writer may deliver queued broadcasts
	// before its welcome. Announce the CURRENT size to everyone, newcomer included, so the last
	// word each peer hears is the freshest.
	h.announceHere(id)

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
		case "presence":
			// Ephemeral: relayed to the others, never stored (the server can't read it anyway).
			if _, _, ok := decodeSealed(m.Ct, m.IV, maxPresenceBytes); !ok {
				conn.Close(closeBadMessage, "bad presence message")
				return
			}
			h.broadcast(id, p, presenceMsg{T: "presence", From: p.id, Ct: m.Ct, IV: m.IV})
		case "snapshot":
			ct, iv, ok := decodeSealed(m.Ct, m.IV, h.opts.MaxSnapshotBytes)
			if !ok || m.UpTo < 1 {
				conn.Close(closeBadMessage, "bad snapshot message")
				return
			}
			if _, err := h.log.PutSnapshot(ctx, id, m.UpTo, ct, iv); err != nil { // a rejected (stale) snapshot is fine
				h.fail(conn, "snapshot", err)
				return
			}
		case "ping":
			h.reply(ctx, p, pongMsg{T: "pong"})
		default:
			conn.Close(closeBadMessage, "unknown message type")
			return
		}
	}
}

// catchUp sends welcome, every op the client is missing up to welcome.seq, then synced.
func (h *Hub) catchUp(ctx context.Context, id string, p *peer, have int64, haveIV string, here int) error {
	latest, err := h.log.LatestSeq(ctx, id)
	if err != nil {
		return err
	}
	welcome := welcomeMsg{T: "welcome", Seq: latest, Here: here}
	if latest > 0 {
		last, err := h.log.OpsAfter(ctx, id, latest-1, 1)
		if err != nil {
			return err
		}
		if len(last) == 1 && last[0].Seq == latest {
			welcome.SeqIV = base64.StdEncoding.EncodeToString(last[0].IV)
		}
	}
	// A restored/rewound database can hold fewer (or different) ops than the client has seen. Every
	// op carries a random IV, so the IV of the op at `have` fingerprints the history: if it is
	// missing or differs, the client's history is not ours and it must start over from zero.
	if have > 0 && haveIV != "" {
		ops, err := h.log.OpsAfter(ctx, id, have-1, 1)
		if err != nil {
			return err
		}
		if len(ops) != 1 || ops[0].Seq != have || base64.StdEncoding.EncodeToString(ops[0].IV) != haveIV {
			welcome.Reset = true
			have = 0
		}
	}
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
	h.mu.Lock()
	defer h.mu.Unlock()
	if r := h.rooms[id]; r != nil {
		h.broadcastLocked(r, from, v)
	}
}

// announceHere tells every peer in the room (nobody excluded) how many are in it right now.
func (h *Hub) announceHere(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r := h.rooms[id]; r != nil {
		h.broadcastLocked(r, nil, hereMsg{T: "here", N: len(r.peers)})
	}
}

func (h *Hub) broadcastLocked(r *room, from *peer, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	for p := range r.peers {
		if p == from {
			continue
		}
		select {
		case p.bcast <- b:
		default:
			// Back-pressure: its queue is full, so it can't keep up. Drop it rather than stall the
			// room; it reconnects and catches up from its `have`. Close waits for the handshake,
			// so it runs off the lock.
			p.kick.Do(func() { go p.conn.Close(closeTooSlow, "too slow") })
		}
	}
}

// join adds p to the note's room, or reports false if the room is full.
func (h *Hub) join(id string, p *peer) (int, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[id]
	if r == nil {
		r = &room{peers: make(map[*peer]struct{})}
		h.rooms[id] = r
	}
	if len(r.peers) >= h.opts.MaxPeers {
		return 0, false
	}
	r.nextID++
	p.id = r.nextID
	r.peers[p] = struct{}{}
	return len(r.peers), true
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
		return
	}
	h.broadcastLocked(r, nil, leftMsg{T: "left", From: p.id})
	h.broadcastLocked(r, nil, hereMsg{T: "here", N: len(r.peers)})
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
