package live

// Wire format, mirroring client/src/live/protocol.ts field for field.
// The server reads only the outside (t, have, cid, seq, upTo); ct/iv are sealed payloads.

// inMsg is any client message; which fields matter depends on T.
type inMsg struct {
	T    string `json:"t"`
	Have int64  `json:"have"`
	Cid  string `json:"cid"`
	Ct   string `json:"ct"`
	IV   string `json:"iv"`
	UpTo int64  `json:"upTo"`
}

type sealedSnapshot struct {
	UpTo int64  `json:"upTo"`
	Ct   string `json:"ct"`
	IV   string `json:"iv"`
}

type welcomeMsg struct {
	T        string          `json:"t"` // "welcome"
	Seq      int64           `json:"seq"`
	Here     int             `json:"here"`
	Snapshot *sealedSnapshot `json:"snapshot"` // null when not sent
}

type opMsg struct {
	T   string `json:"t"` // "op"
	Seq int64  `json:"seq"`
	Ct  string `json:"ct"`
	IV  string `json:"iv"`
}

type ackMsg struct {
	T   string `json:"t"` // "ack"
	Cid string `json:"cid"`
	Seq int64  `json:"seq"`
}

type syncedMsg struct {
	T   string `json:"t"` // "synced"
	Seq int64  `json:"seq"`
}

type presenceMsg struct {
	T    string `json:"t"` // "presence"
	From int    `json:"from"`
	Ct   string `json:"ct"`
	IV   string `json:"iv"`
}

type leftMsg struct {
	T    string `json:"t"` // "left"
	From int    `json:"from"`
}

type hereMsg struct {
	T string `json:"t"` // "here"
	N int    `json:"n"`
}

type pongMsg struct {
	T string `json:"t"` // "pong"
}
