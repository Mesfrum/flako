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
  export T_ACCOUNT=test T_BUCKET=$BUCKET T_KEY=testkey T_SECRET=testsecret T_ENDPOINT=http://s3:8333
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

s5() { # restore hangs (S3 paused after a good backup); then S3 recovers and the note comes back
  reset
  s3_up || return 1
  app_up
  healthy 30 || return 1
  write_op >/dev/null || return 1
  sleep 12
  $DC pause s3 >/dev/null 2>&1
  app_up
  healthy 30 || {
    $DC unpause s3 >/dev/null 2>&1
    return 1
  }
  r=0
  expect_seq 0 || r=1
  expect_paused || r=1
  write_op >/dev/null # a write during the paused boot must not reach (or damage) the backup
  $DC unpause s3 >/dev/null 2>&1
  [ "$r" = 0 ] || return 1
  sleep 3
  app_up # next boot, S3 healthy again: the ORIGINAL note must be restored
  healthy 30 || return 1
  got=$(note_seq)
  [ "${got:-0}" -ge 1 ] || {
    say "note not restored after S3 recovered (seq '$got')"
    return 1
  }
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

s7() { # kill -9 Litestream: server keeps answering
  reset
  s3_up || return 1
  app_up
  healthy 30 || return 1
  sleep 3
  $DC exec -T app sh -c 'pkill -9 litestream' >/dev/null 2>&1 || say "(no litestream process found to kill)"
  sleep 3
  healthy 5 || return 1
  write_op >/dev/null # and the server still works end to end
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
  extra_down
  [ "$restored" = 1 ] && [ "$paused" = 0 ] && [ "$integ" = ok ]
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

if [ "$#" -gt 0 ]; then WANT="$*"; else WANT="1 2 3 4 5 6 7 8a 8b 9"; fi
FAILED=0
for n in $WANT; do
  if "s$n"; then
    echo "PASS scenario $n"
  else
    echo "FAIL scenario $n"
    $DC logs --tail 15 app 2>&1 | sed 's/^/      | /'
    FAILED=$((FAILED + 1))
  fi
done
echo "failed: $FAILED"
[ "$FAILED" -eq 0 ]
