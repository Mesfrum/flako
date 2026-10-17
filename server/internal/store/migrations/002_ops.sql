-- Encrypted CRDT operations, in server-assigned order. Never deleted (Phase 3 history).
CREATE TABLE ops (
  note_id     TEXT    NOT NULL,
  seq         INTEGER NOT NULL,   -- 1, 2, 3 … per note
  ciphertext  BLOB    NOT NULL,
  iv          BLOB    NOT NULL,
  created_at  INTEGER NOT NULL,   -- unix ms
  PRIMARY KEY (note_id, seq)
);
-- Client-made encrypted snapshots of the CRDT state. All kept.
CREATE TABLE snapshots (
  note_id     TEXT    NOT NULL,
  up_to_seq   INTEGER NOT NULL,
  ciphertext  BLOB    NOT NULL,
  iv          BLOB    NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (note_id, up_to_seq)
);
