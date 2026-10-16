package store

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"time"
)

// migrate applies every migrations/*.sql file in fsys that has not been applied
// yet, in lexical order (so name them 001_, 002_, ...). Each file runs in its
// own transaction together with its bookkeeping row: all of it or none of it.
// Never edit a migration that has shipped — add a new file instead.
func migrate(ctx context.Context, db *sql.DB, fsys fs.FS) error {
	const createTable = `CREATE TABLE IF NOT EXISTS schema_migrations (
		version    TEXT PRIMARY KEY,
		applied_at INTEGER NOT NULL
	)`
	if _, err := db.ExecContext(ctx, createTable); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	files, err := fs.Glob(fsys, "migrations/*.sql")
	if err != nil {
		return fmt.Errorf("list migrations: %w", err)
	}
	sort.Strings(files)

	for _, file := range files {
		version := path.Base(file)

		var applied int
		err := db.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM schema_migrations WHERE version = ?`, version).Scan(&applied)
		if err != nil {
			return fmt.Errorf("check migration %s: %w", version, err)
		}
		if applied > 0 {
			continue
		}

		body, err := fs.ReadFile(fsys, file)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", version, err)
		}
		if err := applyMigration(ctx, db, version, string(body)); err != nil {
			return err
		}
	}
	return nil
}

func applyMigration(ctx context.Context, db *sql.DB, version, body string) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin migration %s: %w", version, err)
	}
	defer tx.Rollback() // no-op after a successful Commit

	if _, err := tx.ExecContext(ctx, body); err != nil {
		return fmt.Errorf("apply migration %s: %w", version, err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
		version, time.Now().UnixMilli()); err != nil {
		return fmt.Errorf("record migration %s: %w", version, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit migration %s: %w", version, err)
	}
	return nil
}
