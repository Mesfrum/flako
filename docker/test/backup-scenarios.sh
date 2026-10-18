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

teardown() { $DC --profile tools down -v --remove-orphans >/dev/null 2>&1; }

# Fresh world: no containers, no volumes.
reset() {
  teardown
  defaults
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
  expect_seq 0
}

s4() { # endpoint unreachable (blackhole address: connections hang rather than fail fast)
  reset
  export T_ENDPOINT=http://10.255.255.1:9000
  app_up
  healthy 30
}

s5() { # restore hangs (S3 server paused after a good backup exists)
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
  $DC unpause s3 >/dev/null 2>&1
  return $r
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
  expect_seq 0
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

s8a() { # docker stop -t 30 with S3 unreachable: exits in < 30 s
  reset
  export T_ENDPOINT=http://10.255.255.1:9000
  app_up
  healthy 30 || return 1
  t0=$(date +%s)
  $DC stop -t 30 app >/dev/null 2>&1
  dt=$(($(date +%s) - t0))
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

if [ "$#" -gt 0 ]; then WANT="$*"; else WANT="1 2 3 4 5 6 7 8a 8b"; fi
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
