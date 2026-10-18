#!/bin/sh
# Container entrypoint: optional Litestream backups around flako-server, FAIL-OPEN.
#
# The overriding rule: nothing backup-related may stop the server from starting or keep it down.
# So this script deliberately does NOT use `set -e`, never exits because of a restore, runs the
# server as the main process with Litestream BESIDE it (not as its parent), and treats every
# Litestream failure as a logged warning.
#
# Order: (1) restore the DB from the newest boot's replica if all R2_* vars are set, within a hard
# 20 s budget; (2) start the server; (3) once it answers, start a supervisor that runs
# `litestream replicate` into THIS boot's own replica path and restarts it if it dies;
# (4) on SIGTERM stop the server first, then Litestream (final upload, <= 15 s).
#
# Per-boot replica paths: every boot replicates to flako/<boot id>/notes.db (boot id = UTC time +
# random suffix, so names sort by boot time) and restores from the newest existing one. During a
# deploy the old and new instance run side by side; with one shared path both Litestreams would
# upload files with the same names but different contents (Litestream has no second-writer
# check), so a later restore could mix pages of two databases. With per-boot paths they never
# share files: the next boot restores the newest boot's history, and only the old instance's
# writes during the overlap are lost (open tabs re-send them).

log() { echo "entrypoint: $*" >&2; }

DB_PATH="${DB_PATH:-/data/notes.db}"
export DB_PATH
DATA_DIR="$(dirname "$DB_PATH")"
# Marker left by a boot whose restore FAILED: its local DB is not the backup. While it exists,
# replication stays off (so a near-empty DB never becomes the "newest" backup) and every boot
# retries the restore. Cleared by a successful restore (or by hand - see DEPLOY.md).
MARKER="$DATA_DIR/.restore-failed"
CONFIG=/app/litestream.yml
BACKUPS=0

if [ -n "$R2_ACCOUNT_ID" ] && [ -n "$R2_BUCKET" ] && [ -n "$R2_ACCESS_KEY_ID" ] && [ -n "$R2_SECRET_ACCESS_KEY" ]; then
  BACKUPS=1
  # LITESTREAM_ENDPOINT is TEST-ONLY (points the harness at a local S3 server). Unset in production.
  LITESTREAM_ENDPOINT="${LITESTREAM_ENDPOINT:-https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com}"
  export LITESTREAM_ENDPOINT
else
  log "backups off (set R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY to enable)"
  # Backups off: be exactly the old image - the server is PID 1 and receives signals directly.
  exec flako-server
fi

BOOT_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"

# fetch_backup: restore the newest boot's replica into $TMP_DB and integrity-check it.
# Returns 0 = restored into $TMP_DB, 2 = no backup exists yet, 1 = FAILED (any error or timeout).
# Budget: list 4 s + restore 11 s + integrity_check 5 s = 20 s.
TMP_DB="$DATA_DIR/.restore-$$.db" # same directory => same filesystem => atomic mv
fetch_backup() {
  rm -f "$TMP_DB" "$TMP_DB-wal" "$TMP_DB-shm"
  newest="$(timeout -s KILL 4 flako-server newest-replica)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    log "WARNING: could not list replicas in the bucket (exit $rc)"
    return 1
  fi
  if [ -z "$newest" ]; then
    return 2
  fi
  log "restoring from replica flako/$newest (time limit 11 s)..."
  FLAKO_REPLICA="$newest" timeout -s KILL 11 litestream restore -config "$CONFIG" -o "$TMP_DB" "$DB_PATH"
  rc=$?
  if [ "$rc" -ne 0 ] || [ ! -s "$TMP_DB" ]; then
    log "WARNING: restore failed or timed out (exit $rc)"
    rm -f "$TMP_DB" "$TMP_DB-wal" "$TMP_DB-shm"
    return 1
  fi
  check="$(timeout -s KILL 5 sqlite3 "$TMP_DB" "PRAGMA integrity_check" 2>/dev/null)"
  if [ "$check" != "ok" ]; then
    log "WARNING: restored database failed integrity_check ('$check')"
    rm -f "$TMP_DB" "$TMP_DB-wal" "$TMP_DB-shm"
    return 1
  fi
  return 0
}

# install_restored: move $TMP_DB into place. An existing local DB (only possible on a persistent
# disk after a failed-restore boot) is kept beside it, never deleted.
install_restored() {
  if [ -s "$DB_PATH" ]; then
    aside="$DB_PATH.pre-restore-$BOOT_ID"
    mv "$DB_PATH" "$aside" || return 1
    [ -e "$DB_PATH-wal" ] && mv "$DB_PATH-wal" "$aside-wal"
    [ -e "$DB_PATH-shm" ] && mv "$DB_PATH-shm" "$aside-shm"
    log "kept the previous local database as $aside"
  fi
  rm -f "$DB_PATH-wal" "$DB_PATH-shm" # stale sidecars would corrupt the restored file
  mv "$TMP_DB" "$DB_PATH" || return 1
  rm -f "$TMP_DB-wal" "$TMP_DB-shm"
  return 0
}

# Decide what to do with the database. REPLICATE=1 only when the local DB is the backup (restored,
# or there is no backup yet, or a persistent disk kept a DB from a healthy earlier boot).
REPLICATE=0
if [ -e "$MARKER" ] || [ ! -s "$DB_PATH" ]; then
  [ -e "$MARKER" ] && log "a previous boot failed to restore ($MARKER exists); retrying the restore"
  fetch_backup
  case $? in
    0)
      if install_restored; then
        rm -f "$MARKER"
        log "restored $DB_PATH from the replica (flako/$newest)"
        REPLICATE=1
      else
        log "WARNING: could not move the restored database into place"
        rm -f "$TMP_DB" "$TMP_DB-wal" "$TMP_DB-shm"
      fi
      ;;
    2)
      log "no backup exists yet; starting with $([ -s "$DB_PATH" ] && echo 'the local' || echo 'an empty') database"
      rm -f "$MARKER"
      REPLICATE=1
      ;;
  esac
  if [ "$REPLICATE" = 0 ]; then
    : >"$MARKER" 2>/dev/null
    log "WARNING: BACKUPS PAUSED FOR THIS BOOT - restore failed, so replication is off to protect the existing backup (starting with $([ -s "$DB_PATH" ] && echo 'the local' || echo 'an EMPTY') database)"
  fi
else
  log "restore skipped: $DB_PATH already exists (a persistent disk wins over the backup)"
  REPLICATE=1
fi

if [ "$REPLICATE" = 1 ]; then
  # Local Litestream state belongs to an earlier boot's replica path; this boot starts a new one.
  rm -rf "$DATA_DIR/.$(basename "$DB_PATH")-litestream"
  export FLAKO_REPLICA="$BOOT_ID"
fi

# supervise: run `litestream replicate`, restarting it with backoff (5 s doubling to 60 s) if it
# exits on its own. It never touches the server. On TERM it stops Litestream (final upload) and
# exits once Litestream has.
supervise() {
  STOP=0
  LS=""
  SL=""
  trap 'STOP=1; [ -n "$LS" ] && kill -TERM "$LS" 2>/dev/null; [ -n "$SL" ] && kill "$SL" 2>/dev/null' TERM
  delay=5
  while [ "$STOP" = 0 ]; do
    litestream replicate -config "$CONFIG" &
    LS=$!
    [ "$STOP" = 1 ] && kill -TERM "$LS" 2>/dev/null
    log "litestream replicating to flako/$FLAKO_REPLICA (pid $LS)"
    t0=$(date +%s)
    # `wait` returns early when the trap runs, so loop until Litestream is really gone.
    while :; do
      wait "$LS"
      rc=$?
      kill -0 "$LS" 2>/dev/null || break
    done
    LS=""
    [ "$STOP" = 1 ] && break
    [ $(($(date +%s) - t0)) -ge 300 ] && delay=5 # it ran fine for a while: reset the backoff
    log "WARNING: litestream exited (code $rc); restarting it in ${delay}s"
    sleep "$delay" &
    SL=$!
    wait "$SL"
    SL=""
    delay=$((delay * 2))
    [ "$delay" -gt 60 ] && delay=60
  done
}

# keepalive: Litestream writes a fresh snapshot only when the DB changed, so an idle note store
# would leave this boot's replica files ageing until the bucket's lifecycle rule deletes them.
# A tiny write every 12 h keeps the newest snapshot < ~2 days old (see DEPLOY.md, lifecycle).
keepalive() {
  while :; do
    sleep "${FLAKO_KEEPALIVE_SECS:-43200}"
    sqlite3 -cmd ".timeout 5000" "$DB_PATH" \
      "CREATE TABLE IF NOT EXISTS _backup_keepalive (id INTEGER PRIMARY KEY, at TEXT); INSERT OR REPLACE INTO _backup_keepalive VALUES (1, datetime('now'));" \
      >/dev/null 2>&1 || log "WARNING: keepalive write failed"
  done
}

SERVER_PID=""
SUP_PID=""
KA_PID=""
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
    supervise &
    SUP_PID=$!
    keepalive &
    KA_PID=$!
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

[ -n "$KA_PID" ] && kill "$KA_PID" 2>/dev/null

# Server is down (SIGTERM or on its own). Stop Litestream so it uploads the final changes.
if [ -n "$SUP_PID" ]; then
  kill -TERM "$SUP_PID" 2>/dev/null
  # A watchdog SIGKILLs Litestream (and the supervisor) if they have not stopped within 15 s.
  (
    sleep 15
    pkill -KILL -x litestream 2>/dev/null
    kill -KILL "$SUP_PID" 2>/dev/null
  ) &
  WATCHDOG=$!
  wait "$SUP_PID" 2>/dev/null
  kill "$WATCHDOG" 2>/dev/null
fi

exit "$rc"
