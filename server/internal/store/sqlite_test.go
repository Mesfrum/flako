package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"testing/fstest"
)

func openTestSQLite(t *testing.T, path string) *SQLite {
	t.Helper()
	s, err := OpenSQLite(context.Background(), path)
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestSQLiteContract(t *testing.T) {
	runContract(t, func(t *testing.T) Store {
		return openTestSQLite(t, filepath.Join(t.TempDir(), "notes.db"))
	})
}

func TestSQLiteCreatesParentDirectory(t *testing.T) {
	openTestSQLite(t, filepath.Join(t.TempDir(), "nested", "dir", "notes.db"))
}

func TestSQLiteDataSurvivesReopen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "notes.db")

	first, err := OpenSQLite(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.PutNote(ctx, sampleNote("persisted"), 0); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}

	second := openTestSQLite(t, path) // migrations run again: must be a no-op
	got, err := second.GetNote(ctx, testID)
	if err != nil {
		t.Fatalf("GetNote after reopen: %v", err)
	}
	if string(got.Ciphertext) != "persisted" || got.Version != 1 {
		t.Errorf("got %q v%d, want %q v1", got.Ciphertext, got.Version, "persisted")
	}
}

func TestMigrateIsIdempotent(t *testing.T) {
	ctx := context.Background()
	db := openRawDB(t)
	fsys := fstest.MapFS{"migrations/001_a.sql": {Data: []byte("CREATE TABLE a (x INTEGER);")}}

	for range 2 {
		if err := migrate(ctx, db, fsys); err != nil {
			t.Fatalf("migrate: %v", err)
		}
	}
	if n := countRows(t, db, "schema_migrations"); n != 1 {
		t.Errorf("schema_migrations rows = %d, want 1", n)
	}
}

func TestMigrateRollsBackAFailedMigration(t *testing.T) {
	ctx := context.Background()
	db := openRawDB(t)
	fsys := fstest.MapFS{
		"migrations/001_ok.sql":  {Data: []byte("CREATE TABLE ok_table (x INTEGER);")},
		"migrations/002_bad.sql": {Data: []byte("CREATE TABLE half_done (x INTEGER); THIS IS NOT SQL;")},
	}

	if err := migrate(ctx, db, fsys); err == nil {
		t.Fatal("migrate succeeded, want error from 002_bad.sql")
	}
	if n := countRows(t, db, "schema_migrations"); n != 1 {
		t.Errorf("schema_migrations rows = %d, want 1 (only 001)", n)
	}
	var name string
	err := db.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name='half_done'`).Scan(&name)
	if err != sql.ErrNoRows {
		t.Errorf("table half_done exists (err=%v); the failed migration was not rolled back", err)
	}
}

func openRawDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := openDB(context.Background(), filepath.Join(t.TempDir(), "raw.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func countRows(t *testing.T, db *sql.DB, table string) int {
	t.Helper()
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
