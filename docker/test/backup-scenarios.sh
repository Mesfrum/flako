#!/bin/sh
# Backup/fail-open scenarios against the real image + a local S3 server (SeaweedFS) standing in for R2.
# Run from anywhere:  sh docker/test/backup-scenarios.sh [scenario-number ...]
# The rule under test: nothing backup-related may stop the server or keep it down, so every
# failure scenario still demands a healthy /healthz within 30 s.
cd "$(dirname "$0")/../.." || exit 1
ROOT=$(pwd)
URL=http://127.0.0.1:18080
ID=abcdefghijklmnopqrstuvwxyzabcdefghijklmnopq # 43 chars: a valid note id
WS="ws://127.0.0.1:18080/api/notes/$ID/live"
BUCKET=flako-test

DC="docker compose -p flako-bktest -f docker/test/compose.minio.yaml"
export MSYS_NO_PATHCONV=1 # Git Bash: don't rewrite /paths inside docker args

EXT=""
case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) EXT=.exe ;; esac
WSC="$ROOT/docker/test/wsclient/wsclient$EXT" # built by this script; git-ignored

say() { printf '    %s\n' "$*"; }

# --- scenario environment (read by compose.minio.yaml); each scenario starts from the defaults ---
defaults() {
  export T_ACCOUNT=test T_BUCKET=$BUCKET T_KEY=testkey T_SECRET=testsecret T_ENDPOINT=http://s3:8333 T_KEEPALIVE=
}

teardown() { extra_down; $DC --profile tools down -v --remove-orphans >/dev/null 2>&1; }

# Fresh world: no containers, no volumes.
reset() {
  teardown
  defaults
}

# extra_up NAME HOSTPORT: another app container from the same image, env and network as `app`,
# for the overlap scenario. Torn down by extra_down / teardown.
extra_up() {
  docker rm -f "$1" >/dev/null 2>&1
  docker run -d --name "$1" --network flako-bktest_default -p "127.0.0.1:$2:8080"     -e ADDR=:8080 -e DB_PATH=/data/notes.db -e R2_ACCOUNT_ID="$T_ACCOUNT" -e R2_BUCKET="$T_BUCKET"     -e R2_ACCESS_KEY_ID="$T_KEY" -e R2_SECRET_ACCESS_KEY="$T_SECRET" -e LITESTREAM_ENDPOINT="$T_ENDPOINT"     flako-bktest-app >/dev/null
}
extra_down() { docker rm -f flako-bktest-b flako-bktest-c >/dev/null 2>&1; }

healthy_at() { # healthy_at PORT N
  i=0
  while [ "$i" -lt "$2" ]; do
    curl -fsS -m 2 "http://127.0.0.1:$1/healthz" >/dev/null 2>&1 && return 0
    i=$((i + 1))
    sleep 1
  done
  return 1
}

AWS="aws --endpoint-url http://s3:8333"

# s3_up: start the S3 stand-in (SeaweedFS) and create the bucket, retrying until it is ready.
s3_up() {
  $DC up -d s3 >/dev/null 2>&1 || return 1
  $DC --profile tools run --rm --no-deps -T aws -c     "for i in \$(seq 60); do $AWS s3 mb s3://$BUCKET >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1" >/dev/null 2>&1
}

app_up() { $DC up -d --force-recreate --no-deps app >/dev/null 2>&1; }

# healthy N: /healthz must answer within N seconds.
healthy() {
  i=0
  while [ "$i" -lt "$1" ]; do
    curl -fsS -m 2 "$URL/healthz" >/dev/null 2>&1 && return 0
    i=$((i + 1))
    sleep 1
  done
  return 1
}

write_op() { "$WSC" write "$WS" 2>/dev/null; }
note_seq() { "$WSC" seq "$WS" 2>/dev/null | sed 's/^seq //'; }

# expect_seq N: the server holds exactly N ops for the note.
# expect_paused: the entrypoint must have logged that replication is off for this boot.
expect_paused() {
  $DC logs app 2>&1 | grep -q "BACKUPS PAUSED" || {
    say "expected 'BACKUPS PAUSED' log line"
    return 1
  }
  $DC exec -T app sh -c 'pgrep litestream' >/dev/null 2>&1 && {
    say "litestream is running but must not be after a failed restore"
    return 1
  }
  return 0
}

expect_seq() {
  got=$(note_seq)
  [ "$got" = "$1" ] || {
    say "expected seq $1, got '$got'"
    return 1
  }
}

# --- scenarios ---------------------------------------------------------------------------------

s1() { # no R2_* vars
  reset
  export T_ACCOUNT= T_BUCKET= T_KEY= T_SECRET= T_ENDPOINT=
  app_up
  healthy 30 || return 1
  $DC logs app 2>&1 | grep -q "backups off" || {
    say "log line 'backups off' missing"
    return 1
  }
  # exec: the server itself must be PID 1, exactly like the pre-Litestream image.
  [ "$($DC exec -T app cat /proc/1/comm 2>/dev/null | tr -d '
')" = "flako-server" ] || {
    say "PID 1 is not flako-server"
    return 1
  }
}

s2() { # empty bucket, write 3 ops, wait for a sync, recreate: ops survive
  reset
  s3_up || return 1
  app_up
  healthy 30 || return 1
  write_op >/dev/null && write_op >/dev/null && write_op >/dev/null || return 1
  sleep 12
  app_up # --force-recreate: brand-new empty /data
  healthy 30 || return 1
  expect_seq 3
}

s3() { # wrong keys
  reset
  s3_up || return 1
  export T_SECRET=wrong-secret
  app_up
  healthy 30 || return 1
  expect_seq 0 || return 1
  expect_paused
}

s4() { # endpoint unreachable (blackhole address: connections hang rather than fail fast)
  reset
  export T_ENDPOINT=http://10.255.255.1:9000
  app_up
  healthy 30 || return 1
  expect_paused
}

s5() { # restore hangs (S3 paused after a good backup); restarts on a kept disk stay paused (marker); S3 recovers -> note back
  reset
  s3_up || return 1
  app_up
  healthy 30 || return 1
  write_op >/dev/null && write_op >/dev/null || return 1 # the good backup: 2 ops
  sleep 12
  $DC pause s3 >/dev/null 2>&1
  app_up # fresh disk, S3 hanging: restore fails
  healthy 30 || {
    $DC unpause s3 >/dev/null 2>&1
    return 1
  }
  r=0
  expect_seq 0 || r=1
  expect_paused || r=1
  has_marker || {
    say "no restore-failed marker after the failed restore"
    r=1
  }
  write_op >/dev/null # a write during the paused boot must not reach (or damage) the backup
  # Restart on the SAME disk (like Compose restarting on the VPS), S3 still hanging: the local
  # near-empty DB is served but must NOT be replicated, and the marker must stay.
  $DC restart -t 30 app >/dev/null 2>&1
  healthy 30 || r=1
  expect_seq 1 || r=1
  has_marker || {
    say "marker lost on restart"
    r=1
  }
  $DC exec -T app sh -c 'pgrep litestream' >/dev/null 2>&1 && {
    say "litestream running while the marker exists"
    r=1
  }
  $DC unpause s3 >/dev/null 2>&1
  [ "$r" = 0 ] || return 1
  # Restart again with S3 healthy: the marker makes it retry the restore -> the ORIGINAL 2 ops.
  $DC restart -t 30 app >/dev/null 2>&1
  healthy 30 || return 1
  expect_seq 2 || return 1
  has_marker && {
    say "marker not cleared after a successful restore"
    return 1
  }
  wait_litestream 15 || {
    say "litestream not running after the successful restore"
    return 1
  }
  sleep 12 # let this boot replicate
  app_up   # and a fresh-disk boot restores the newest path, which is the recovered one
  healthy 30 || return 1
  expect_seq 2
}

has_marker() { $DC exec -T app sh -c 'test -e /data/.restore-failed' >/dev/null 2>&1; }

# wait_litestream N: a litestream process shows up inside `app` within N seconds.
wait_litestream() {
  i=0
  while [ "$i" -lt "$1" ]; do
    $DC exec -T app sh -c 'pgrep -x litestream' >/dev/null 2>&1 && return 0
    i=$((i + 1))
    sleep 1
  done
  return 1
}

s6() { # corrupt backup: every replica object overwritten with junk
  reset
  s3_up || return 1
  app_up
  healthy 30 || return 1
  write_op >/dev/null || return 1
  sleep 12
  $DC stop -t 30 app >/dev/null 2>&1
  $DC --profile tools run --rm --no-deps -T aws -c     "for k in \$($AWS s3api list-objects-v2 --bucket $BUCKET --query 'Contents[].Key' --output text | tr '	' ' '); do echo junk-junk-junk | $AWS s3 cp - s3://$BUCKET/\$k >/dev/null; done; $AWS s3 ls s3://$BUCKET --recursive | wc -l" 2>/dev/null | tail -1 | sed 's/^/    objects sabotaged: /'
  app_up
  healthy 30 || return 1
  expect_seq 0 || return 1
  expect_paused
}

s7() { # kill -9 Litestream: server keeps answering, and the supervisor brings Litestream back
  reset
  s3_up || return 1
  app_up
  healthy 30 || return 1
  wait_litestream 15 || {
    say "litestream never started"
    return 1
  }
  $DC exec -T app sh -c 'pkill -9 -x litestream' >/dev/null 2>&1 || {
    say "no litestream process found to kill"
    return 1
  }
  sleep 1
  healthy 5 || return 1
  write_op >/dev/null || return 1 # the server still works end to end
  wait_litestream 15 || {
    say "litestream was not restarted"
    return 1
  }
  $DC logs app 2>&1 | grep -q "litestream exited" || {
    say "no restart log line"
    return 1
  }
  sleep 12 # and the restarted Litestream really replicates: a fresh boot gets the write
  app_up
  healthy 30 || return 1
  expect_seq 1
}

s8a() { # S3 goes unreachable with data pending: stop -t 30 still exits in < 30 s
  reset
  s3_up || return 1
  app_up
  healthy 30 || return 1
  sleep 3 # let replication start
  write_op >/dev/null || return 1 # pending data => the final upload has real work and will hang
  $DC pause s3 >/dev/null 2>&1
  t0=$(date +%s)
  $DC stop -t 30 app >/dev/null 2>&1
  dt=$(($(date +%s) - t0))
  $DC unpause s3 >/dev/null 2>&1
  say "stopped in ${dt}s"
  [ "$dt" -lt 30 ]
}

s8b() { # S3 up: the last write before stop (no 10 s wait) is restored on next boot
  reset
  s3_up || return 1
  app_up
  healthy 30 || return 1
  sleep 3
  write_op >/dev/null || return 1
  write_op >/dev/null || return 1
  $DC stop -t 30 app >/dev/null 2>&1 # SIGTERM -> final upload
  app_up
  healthy 30 || return 1
  expect_seq 2
}

s9() { # deploy overlap: A and B replicate to the same path at once; a third boot (C) must still restore
  reset
  s3_up || return 1
  app_up # A on :18080
  healthy 30 || return 1
  write_op >/dev/null && write_op >/dev/null || return 1
  sleep 12 # base: 2 ops safely in the replica
  extra_up flako-bktest-b 18081 || return 1 # B restores A's backup, then also replicates
  healthy_at 18081 40 || {
    say "B not healthy"
    return 1
  }
  a=0
  b=0
  t0=$(date +%s)
  while [ $(($(date +%s) - t0)) -lt 30 ]; do # both write for 30 s
    write_op >/dev/null && a=$((a + 1))
    "$WSC" write "ws://127.0.0.1:18081/api/notes/$ID/live" >/dev/null 2>&1 && b=$((b + 1))
    sleep 3
  done
  write_op >/dev/null && a=$((a + 1)) # A's very last write, right before TERM
  $DC stop -t 30 app >/dev/null 2>&1
  extra_up flako-bktest-c 18082 || return 1 # C restores from whatever the two writers left behind
  healthy_at 18082 40 || {
    say "C not healthy"
    docker logs flako-bktest-c 2>&1 | tail -15 | sed 's/^/      | /'
    return 1
  }
  restored=0
  docker logs flako-bktest-c 2>&1 | grep -q "restored /data/notes.db from the replica" && restored=1
  paused=0
  docker logs flako-bktest-c 2>&1 | grep -q "BACKUPS PAUSED" && paused=1
  cseq=$("$WSC" seq "ws://127.0.0.1:18082/api/notes/$ID/live" 2>/dev/null | sed 's/^seq //')
  integ=$(docker exec flako-bktest-c sqlite3 /data/notes.db "PRAGMA integrity_check" 2>&1 | tr -d '[:space:]')
  say "A wrote $a after base 2 (A total $((2 + a))); B wrote $b (B total $((2 + b))); C seq '$cseq' restored=$restored paused=$paused integrity=$integ"
  r=0
  expect_replicating flako-bktest-b B || r=1
  [ "$restored" = 1 ] && [ "$paused" = 0 ] && [ "$integ" = ok ] || r=1
  [ "${cseq:-0}" -ge 2 ] || {
    say "C lost the base ops (seq '$cseq' < 2)"
    r=1
  }
  extra_down
  return "$r"
}

# expect_replicating CONTAINER LABEL: the container restored from the replica and started
# replicating, and never paused backups.
expect_replicating() {
  lg=$(docker logs "$1" 2>&1)
  echo "$lg" | grep -q "restored /data/notes.db from the replica" || {
    say "$2 did not restore from the replica"
    return 1
  }
  echo "$lg" | grep -q "litestream replicating" || {
    say "$2 never started litestream"
    return 1
  }
  if echo "$lg" | grep -q "BACKUPS PAUSED"; then
    say "$2 paused backups"
    return 1
  fi
  return 0
}

s9b() { # deploy overlap, then the survivor (B) keeps writing: the NEXT boot (C) must get B's history intact
  reset
  s3_up || return 1
  app_up # A on :18080
  healthy 30 || return 1
  write_op >/dev/null && write_op >/dev/null || return 1
  sleep 12
  extra_up flako-bktest-b 18081 || return 1
  healthy_at 18081 40 || {
    say "B not healthy"
    return 1
  }
  BWS="ws://127.0.0.1:18081/api/notes/$ID/live"
  t0=$(date +%s)
  while [ $(($(date +%s) - t0)) -lt 25 ]; do # overlap: both write ~1 KB ops
    "$WSC" write "$WS" "${S9B_A_OPS:-5}" 1000 >/dev/null 2>&1 # S9B_A_OPS: make A outpace B
    "$WSC" write "$BWS" 5 1000 >/dev/null 2>&1
    sleep 2
  done
  $DC stop -t 30 app >/dev/null 2>&1 # A gets SIGTERM, makes its final upload, exits
  i=0
  while [ "$i" -lt 8 ]; do # B serves on alone: ~320 more 1 KB ops over > 2 sync intervals (page splits)
    "$WSC" write "$BWS" 40 1000 >/dev/null 2>&1 || {
      say "B write failed"
      return 1
    }
    i=$((i + 1))
    sleep 3
  done
  sleep 13 # > one sync interval: B's last writes are in the replica
  bseq=$("$WSC" seq "$BWS" 2>/dev/null | sed 's/^seq //')
  extra_up flako-bktest-c 18082 || return 1 # next deploy: C boots while B still runs
  healthy_at 18082 40 || {
    say "C not healthy"
    docker logs flako-bktest-c 2>&1 | tail -15 | sed 's/^/      | /'
    return 1
  }
  cseq=$("$WSC" seq "ws://127.0.0.1:18082/api/notes/$ID/live" 2>/dev/null | sed 's/^seq //')
  integ=$(docker exec flako-bktest-c sqlite3 /data/notes.db "PRAGMA integrity_check" 2>&1 | tr -d '[:space:]')
  say "B seq '$bseq'; C seq '$cseq' integrity=$integ"
  r=0
  expect_replicating flako-bktest-b B || r=1
  expect_replicating flako-bktest-c C || r=1
  # Per-boot replica paths: A and B never share one, and C restored from B's (the newest).
  aid=$($DC logs app 2>&1 | sed -n 's/.*replicating to flako\/\([^ ]*\) .*/\1/p' | head -1)
  bid=$(docker logs flako-bktest-b 2>&1 | sed -n 's/.*replicating to flako\/\([^ ]*\) .*/\1/p' | head -1)
  [ -n "$aid" ] && [ -n "$bid" ] && [ "$aid" != "$bid" ] || {
    say "A and B do not have separate replica paths ('$aid' / '$bid')"
    r=1
  }
  docker logs flako-bktest-c 2>&1 | grep -q "from the replica (flako/$bid)" || {
    say "C did not restore from B's path ($bid)"
    r=1
  }
  [ "$integ" = ok ] || r=1
  [ -n "$bseq" ] && [ "$cseq" = "$bseq" ] || {
    say "C does not hold B's history (want seq '$bseq', got '$cseq')"
    r=1
  }
  [ "$r" = 0 ] || docker logs flako-bktest-c 2>&1 | tail -12 | sed 's/^/      C| /'
  extra_down
  return "$r"
}

s10() { # keepalive: an idle instance still writes a tiny row so its replica keeps getting fresh snapshots
  reset
  s3_up || return 1
  export T_KEEPALIVE=2
  app_up
  healthy 30 || return 1
  i=0
  while [ "$i" -lt 20 ]; do
    rows=$($DC exec -T app sqlite3 /data/notes.db "SELECT count(*) FROM _backup_keepalive" 2>/dev/null | tr -d '[:space:]')
    [ "$rows" = 1 ] && return 0
    i=$((i + 1))
    sleep 1
  done
  say "no keepalive row after 20 s"
  return 1
}

s11() { # the DEPLOY.md runbook: restore a boot's replica by hand, re-upload it under a newer boot id, next boot restores it
  reset
  s3_up || return 1
  app_up
  healthy 30 || return 1
  write_op >/dev/null && write_op >/dev/null && write_op >/dev/null || return 1
  sleep 12
  $DC stop -t 30 app >/dev/null 2>&1
  docker volume rm -f flako-bktest-runbook >/dev/null 2>&1
  # Same commands as DEPLOY.md, with -e flags instead of --env-file and the harness network.
  R="docker run --rm --user 0 --network flako-bktest_default -e R2_ACCOUNT_ID=test -e R2_BUCKET=$BUCKET -e R2_ACCESS_KEY_ID=testkey -e R2_SECRET_ACCESS_KEY=testsecret -e LITESTREAM_ENDPOINT=http://s3:8333 -v flako-bktest-runbook:/out --entrypoint"
  old=$($R flako-server flako-bktest-app newest-replica 2>/dev/null)
  [ -n "$old" ] || {
    say "newest-replica printed nothing"
    return 1
  }
  $R litestream -e FLAKO_REPLICA="$old" flako-bktest-app restore -config /app/litestream.yml -o /out/notes.db /data/notes.db >/dev/null 2>&1 || {
    say "manual restore of $old failed"
    return 1
  }
  [ "$($R sqlite3 flako-bktest-app /out/notes.db "PRAGMA integrity_check" 2>/dev/null | tr -d '[:space:]')" = ok ] || {
    say "manual restore not ok"
    return 1
  }
  # Mark the copy so the next boot provably restores IT: drop the newest op (seq 3 -> 2).
  $R sqlite3 flako-bktest-app /out/notes.db "DELETE FROM ops WHERE seq = 3" >/dev/null 2>&1 || return 1
  ID="$(date -u +%Y%m%dT%H%M%SZ)-0000aa"
  $R sh -e DB_PATH=/out/notes.db -e FLAKO_REPLICA="$ID" flako-bktest-app -c \
    'litestream replicate -config /app/litestream.yml & p=$!; sleep 30; kill -TERM $p; wait $p' >/dev/null 2>&1
  now=$($R flako-server flako-bktest-app newest-replica 2>/dev/null)
  docker volume rm -f flako-bktest-runbook >/dev/null 2>&1
  [ "$now" = "$ID" ] || {
    say "newest replica is '$now', want '$ID'"
    return 1
  }
  app_up
  healthy 30 || return 1
  $DC logs app 2>&1 | grep -q "from the replica (flako/$ID)" || {
    say "boot did not restore the uploaded copy"
    return 1
  }
  expect_seq 2
}

# --- runner ------------------------------------------------------------------------------------
trap teardown EXIT

echo "building harness client and image..."
(cd docker/test/wsclient && go build -o "wsclient$EXT" .) || {
  echo "cannot build wsclient"
  exit 1
}
defaults
$DC build app >/dev/null 2>&1 || {
  echo "image build failed"
  exit 1
}

if [ "$#" -gt 0 ]; then WANT="$*"; else WANT="1 2 3 4 5 6 7 8a 8b 9 9b 10 11"; fi
FAILED=0
for scen in $WANT; do
  if "s$scen"; then
    echo "PASS scenario $scen"
  else
    echo "FAIL scenario $scen"
    $DC logs --tail 15 app 2>&1 | sed 's/^/      | /'
    FAILED=$((FAILED + 1))
  fi
done
echo "failed: $FAILED"
[ "$FAILED" -eq 0 ]
