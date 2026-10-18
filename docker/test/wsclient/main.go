// wsclient is a tiny test driver for docker/test/backup-scenarios.sh. It talks the live-note wire
// protocol with dummy sealed payloads (the server never decrypts), so the harness can write real
// ops through the real server and read back how many the server holds.
//
//	wsclient write ws://host/api/notes/<43-char-id>/live   # append one op, print "ack <seq>"
//	wsclient seq   ws://host/api/notes/<43-char-id>/live   # print "seq <n>" (ops stored for the note)
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/coder/websocket"
)

type msg struct {
	T   string `json:"t"`
	Seq int64  `json:"seq"`
}

func main() {
	if len(os.Args) != 3 || (os.Args[1] != "write" && os.Args[1] != "seq") {
		fmt.Fprintln(os.Stderr, "usage: wsclient write|seq ws://.../api/notes/<id>/live")
		os.Exit(2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, os.Args[2], nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, "dial:", err)
		os.Exit(1)
	}
	defer conn.CloseNow()

	send := func(v any) {
		b, _ := json.Marshal(v)
		if err := conn.Write(ctx, websocket.MessageText, b); err != nil {
			fmt.Fprintln(os.Stderr, "write:", err)
			os.Exit(1)
		}
	}
	// next reads messages until one of type want arrives (catch-up ops, "here", "synced" are skipped).
	next := func(want string) msg {
		for {
			_, b, err := conn.Read(ctx)
			if err != nil {
				fmt.Fprintln(os.Stderr, "read:", err)
				os.Exit(1)
			}
			var m msg
			_ = json.Unmarshal(b, &m)
			if m.T == want {
				return m
			}
		}
	}

	send(map[string]any{"t": "hello", "have": 0})
	welcome := next("welcome")
	if os.Args[1] == "seq" {
		// Catch-up ops arrive before the welcome only if the server has them; welcome.seq is the
		// latest stored seq either way. Snapshot-less notes (our case) report their true op count.
		fmt.Println("seq", welcome.Seq)
		return
	}
	ct := make([]byte, 32) // >= 16 bytes (GCM tag size); content is never decrypted here
	iv := make([]byte, 12)
	_, _ = rand.Read(ct)
	_, _ = rand.Read(iv)
	send(map[string]any{
		"t":   "ops",
		"cid": "harness",
		"ct":  base64.StdEncoding.EncodeToString(ct),
		"iv":  base64.StdEncoding.EncodeToString(iv),
	})
	ack := next("ack")
	fmt.Println("ack", ack.Seq)
}
