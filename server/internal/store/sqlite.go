package store

import (
	"bytes"
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite" // registers the "sqlite" driver with database/sql
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// SQLite is the production Store: one database file on disk.
type SQLite struct {
	db *sql.DB
}

var _ Store = (*SQLite)(nil)

// OpenSQLite opens (creating if needed) the database at path and applies migrations.
func OpenSQLite(ctx context.Context, path string) (*SQLite, error) {
	db, err := openDB(ctx, path)
	if err != nil {
		return nil, err
	}
	if err := migrate(ctx, db, migrationsFS); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return &SQLite{db: db}, nil
}

// openDB opens the database with our pragmas applied to every pooled connection.
func openDB(ctx context.Context, path string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("create db directory: %w", err)
	}
	// busy_timeout first, so a connection waits for the lock while switching to WAL.
	dsn := path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	return db, nil
}

func (s *SQLite) Close() error { return s.db.Close() }

func (s *SQLite) GetNote(ctx context.Context, id string) (Note, error) {
	var (
		n                Note
		created, updated int64
	)
	err := s.db.QueryRowContext(ctx,
		`SELECT id, ciphertext, iv, version, created_at, updated_at FROM notes WHERE id = ?`, id,
	).Scan(&n.ID, &n.Ciphertext, &n.IV, &n.Version, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return Note{}, ErrNotFound
	}
	if err != nil {
		return Note{}, fmt.Errorf("get note: %w", err)
	}
	n.CreatedAt = time.UnixMilli(created).UTC()
	n.UpdatedAt = time.UnixMilli(updated).UTC()
	return n, nil
}

func (s *SQLite) PutNote(ctx context.Context, n Note, baseVersion int64) (Note, error) {
	now := nowMilli()
	if baseVersion == 0 {
		return s.create(ctx, n, now)
	}
	return s.update(ctx, n, baseVersion, now)
}

// create inserts version 1. ON CONFLICT DO NOTHING makes "insert if absent" a
// single atomic statement: of N concurrent creates, exactly one affects a row.
func (s *SQLite) create(ctx context.Context, n Note, now time.Time) (Note, error) {
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO notes (id, ciphertext, iv, version, created_at, updated_at)
		 VALUES (?, ?, ?, 1, ?, ?)
		 ON CONFLICT(id) DO NOTHING`,
		n.ID, n.Ciphertext, n.IV, now.UnixMilli(), now.UnixMilli())
	if err != nil {
		return Note{}, fmt.Errorf("create note: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return Note{}, fmt.Errorf("create note: %w", err)
	}
	if affected == 0 {
		return Note{}, s.conflict(ctx, n.ID)
	}
	return Note{
		ID: n.ID, Ciphertext: bytes.Clone(n.Ciphertext), IV: bytes.Clone(n.IV),
		Version: 1, CreatedAt: now, UpdatedAt: now,
	}, nil
}

// update only matches the row if its version is still baseVersion.
func (s *SQLite) update(ctx context.Context, n Note, baseVersion int64, now time.Time) (Note, error) {
	var version, created int64
	err := s.db.QueryRowContext(ctx,
		`UPDATE notes
		 SET ciphertext = ?, iv = ?, version = version + 1, updated_at = ?
		 WHERE id = ? AND version = ?
		 RETURNING version, created_at`,
		n.Ciphertext, n.IV, now.UnixMilli(), n.ID, baseVersion,
	).Scan(&version, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return Note{}, s.conflict(ctx, n.ID)
	}
	if err != nil {
		return Note{}, fmt.Errorf("update note: %w", err)
	}
	return Note{
		ID: n.ID, Ciphertext: bytes.Clone(n.Ciphertext), IV: bytes.Clone(n.IV),
		Version: version, CreatedAt: time.UnixMilli(created).UTC(), UpdatedAt: now,
	}, nil
}

// conflict builds a *ConflictError carrying the current version (0 if missing).
func (s *SQLite) conflict(ctx context.Context, id string) error {
	var current int64
	err := s.db.QueryRowContext(ctx, `SELECT version FROM notes WHERE id = ?`, id).Scan(&current)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("read current version: %w", err)
	}
	return &ConflictError{Current: current}
}
