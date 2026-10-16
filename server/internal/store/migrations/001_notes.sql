-- Notes are opaque encrypted blobs. The server never sees names or plaintext.
CREATE TABLE notes (
  id          TEXT PRIMARY KEY,   -- base64url(HKDF(master, "id")), 43 chars
  ciphertext  BLOB NOT NULL,
  iv          BLOB NOT NULL,      -- 12 bytes
  version     INTEGER NOT NULL,   -- 1 on first save, +1 per save
  created_at  INTEGER NOT NULL,   -- unix ms
  updated_at  INTEGER NOT NULL    -- unix ms
);
