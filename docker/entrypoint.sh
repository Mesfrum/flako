#!/bin/sh
# Container entrypoint: optional Litestream backups around flako-server, FAIL-OPEN.
#
# The overriding rule: nothing backup-related may stop the server from starting or keep it down.
# So this script deliberately does NOT use `set -e`, never exits because of a restore, runs the
# server as the main process with Litestream BESIDE it (not as its parent), and treats every
# Litestream failure as a logged warning.
#
# Order: (1) restore the DB from the replica if all R2_* vars are set, within a hard time budget;
# (2) start the server; (3) once it answers, start `litestream replicate` in the background;
# (4) on SIGTERM stop the server first, then Litestream (final upload, <= 15 s).

log() { echo "entrypoint: $*" >&2; }

DB_PATH="${DB_PATH:-/data/notes.db}"
export DB_PATH
CONFIG=/app/litestream.yml
BACKUPS=0

if [ -n "$R2_ACCOUNT_ID" ] && [ -n "$R2_BUCKET" ] && [ -n "$R2_ACCESS_KEY_ID" ] && [ -n "$R2_SECRET_ACCESS_KEY" ]; then
  BACKUPS=1
  # LITESTREAM_ENDPOINT is TEST-ONLY (points the harness at a local S3 server). Unset in production.
  LITESTREAM_ENDPOINT="${LITESTREAM_ENDPOINT:-https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com}"
  export LITESTREAM_ENDPOINT
else
  log "backups off (set R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY to enable)"
fi

restore_db() {
  if [ -s "$DB_PATH" ]; then
    log "restore skipped: $DB_PATH already exists (a persistent disk wins over the backup)"
    return 0
  fi
  tmp="$(dirname "$DB_PATH")/.restore-$$.db" # same directory => same filesystem => atomic mv
  rm -f "$tmp" "$tmp-wal" "$tmp-shm"
  log "restoring from the replica (time limit 15 s)..."
  timeout -s KILL 15 litestream restore -config "$CONFIG" -o "$tmp" -if-replica-exists "$DB_PATH"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    log "WARNING: restore failed or timed out (exit $rc); starting with an EMPTY database"
    rm -f "$tmp" "$tmp-wal" "$tmp-shm"
    return 1
  fi
  if [ ! -s "$tmp" ]; then
    log "no backup exists yet; starting with an empty database"
    rm -f "$tmp" "$tmp-wal" "$tmp-shm"
    return 0
  fi
  check="$(timeout -s KILL 5 sqlite3 "$tmp" "PRAGMA integrity_check" 2>/dev/null)"
  if [ "$check" != "ok" ]; then
    log "WARNING: restored database failed integrity_check ('$check'); starting with an EMPTY database"
    rm -f "$tmp" "$tmp-wal" "$tmp-shm"
    return 1
  fi
  rm -f "$DB_PATH-wal" "$DB_PATH-shm" # stale sidecars would corrupt the restored file
  if mv "$tmp" "$DB_PATH"; then
    rm -f "$tmp-wal" "$tmp-shm"
    log "restored $DB_PATH from the replica"
  else
    log "WARNING: could not move the restored database into place; starting EMPTY"
    rm -f "$tmp" "$tmp-wal" "$tmp-shm"
    return 1
  fi
  return 0
}

# restore_db returns 0 for "restored", "no backup yet" and "local DB kept"; 1 for a FAILED restore.
# After a failed restore the server still boots (empty DB) but Litestream is NOT started for this
# boot: replicating an empty DB after an R2 hiccup could replace the good backup with nothing.
REPLICATE=0
if [ "$BACKUPS" = 1 ]; then
  if restore_db; then
    REPLICATE=1
  else
    log "WARNING: BACKUPS PAUSED FOR THIS BOOT - restore failed, so replication is off to protect the existing backup"
  fi
else
  # Backups off: be exactly the old image - the server is PID 1 and receives signals directly.
  exec flako-server
fi

SERVER_PID=""
LS_PID=""
STOPPING=0

on_signal() {
  STOPPING=1
  [ -n "$SERVER_PID" ] && kill -TERM "$SERVER_PID" 2>/dev/null
}
trap on_signal TERM INT

flako-server &
SERVER_PID=$!

if [ "$REPLICATE" = 1 ]; then
  # Start replication only once the server is listening (it creates and migrates the DB first).
  PORT="${ADDR##*:}"
  PORT="${PORT:-8080}"
  i=0
  while [ "$STOPPING" = 0 ] && [ "$i" -lt 60 ] && kill -0 "$SERVER_PID" 2>/dev/null; do
    wget -q -O /dev/null "http://127.0.0.1:$PORT/healthz" 2>/dev/null && break
    i=$((i + 1))
    sleep 1
  done
  if [ "$STOPPING" = 0 ] && kill -0 "$SERVER_PID" 2>/dev/null && [ -f "$DB_PATH" ]; then
    litestream replicate -config "$CONFIG" &
    LS_PID=$!
    log "litestream replicating (pid $LS_PID)"
  else
    log "WARNING: not starting litestream (server not up in time or already stopping)"
  fi
fi

# Wait for the server. `wait` returns early when a trapped signal arrives, so loop until the
# server is really gone; its exit code becomes the container's.
rc=0
while :; do
  wait "$SERVER_PID"
  rc=$?
  kill -0 "$SERVER_PID" 2>/dev/null || break
done

# Server is down (SIGTERM or on its own). Stop Litestream so it uploads the final changes.
if [ -n "$LS_PID" ]; then
  kill -TERM "$LS_PID" 2>/dev/null
  # `wait` reaps the child immediately even if it already died (a bare `kill -0` would see a
  # zombie as alive). A watchdog SIGKILLs it if it has not stopped within 15 s.
  ( sleep 15; kill -KILL "$LS_PID" 2>/dev/null ) &
  WATCHDOG=$!
  wait "$LS_PID" 2>/dev/null
  kill "$WATCHDOG" 2>/dev/null
fi

exit "$rc"
