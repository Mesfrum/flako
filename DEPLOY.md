# Deploying flako

Production runs on **Render (free tier, Docker)**, auto-deployed on every push to `master`. The
domain `flako.in` is proxied by **Cloudflare**, and **UptimeRobot** pings the `onrender.com` URL
so the free instance stays warm. The image is built from the `Dockerfile` (Go binary with the UI
embedded, SQLite on local disk). Render's free disk is ephemeral, so every deploy starts with an
empty `/data`: notes survive because **Litestream** continuously replicates the SQLite file to a
private **Cloudflare R2** bucket and the container restores it on boot.

Everything in the bucket is ciphertext (the server never sees note names or text), so the backup
is only as sensitive as the notes themselves.

## How the backups work

`docker/entrypoint.sh` is the image entrypoint (config: `docker/litestream.yml`, Litestream v0.5.17).

| Env var | Meaning |
|---|---|
| `R2_ACCOUNT_ID` | Cloudflare account id (builds the R2 endpoint URL) |
| `R2_BUCKET` | bucket name, e.g. `flako-db` |
| `R2_ACCESS_KEY_ID` | R2 API token access key id |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret access key |

- **One replica path per boot.** Every boot gets a boot id (UTC time + random suffix, e.g.
  `20261019T120000Z-0a1b2c`) and replicates to `flako/<boot id>/notes.db` in the bucket. On boot
  the entrypoint lists `flako/` (`flako-server newest-replica`, one signed S3 ListObjectsV2
  request) and restores from the **newest** boot's path. A boot never writes into another boot's
  path. (Why: see "Overlapping deploys" below.)
- **All four set:** on boot the entrypoint finds the newest replica (time limit 4 s), restores it
  (11 s), and checks it with `PRAGMA integrity_check` (5 s): 20 s worst case. It then starts the
  server and, once `/healthz` answers, a small supervisor that runs `litestream replicate` beside
  it. Changes upload every 10 s, a full snapshot is taken daily, and about 72 h of history is
  kept. If Litestream dies, the supervisor restarts it (after 5 s, doubling up to 60 s); the server
  is never touched. Every 12 h the entrypoint writes one tiny row (`_backup_keepalive` table) so
  an idle instance still gets fresh daily snapshots (Litestream only snapshots a DB that changed,
  and the lifecycle rule below would otherwise expire an idle instance's only snapshot). On
  SIGTERM the server stops first, then Litestream does a final upload (it gives up after 10 s,
  `shutdown-sync-timeout`; the entrypoint kills it at 15 s; Compose `stop_grace_period` is 30 s).
- **Any one missing or empty:** backups are off and the server is exec'd exactly as before.
- **Fail-open:** nothing backup-related may keep the server down. If listing or the restore fails,
  times out, or yields a corrupt file, the server boots anyway and the log says
  `BACKUPS PAUSED FOR THIS BOOT`. Replication is deliberately off for that boot: otherwise its
  near-empty DB would become the newest replica and the next boot would restore that instead of
  the good backup. The entrypoint also writes a marker file `/data/.restore-failed`.
- **Restore-failed marker (matters only with a persistent disk, i.e. the VPS):** while
  `/data/.restore-failed` exists, every boot retries the restore and does **not** replicate, even
  though a local DB exists. A successful restore puts the backup in place (the local DB is kept
  beside it as `notes.db.pre-restore-<boot id>`, never deleted), removes the marker and resumes
  replication. To keep the local DB instead and make it the backup (only if you know it is the
  better copy): stop the app, delete the marker
  (`docker run --rm -v flako_sqlite_data:/data alpine rm /data/.restore-failed`), start the app.
- **Existing local DB, no marker:** the restore is skipped (a persistent volume, e.g. the Compose
  one, wins) and the local DB is replicated to this boot's new path.
- `LITESTREAM_ENDPOINT` and `FLAKO_KEEPALIVE_SECS` are test-only overrides used by
  `docker/test/backup-scenarios.sh`. Never set them in production.

**Overlapping deploys.** Render keeps the old instance (A) serving while the new one (B) boots, so
for a short window both run Litestream. Litestream has no "second writer" check: with one shared
path, A and B would upload replica files with the *same names* (they are numbered by transaction
id) but contents from two different databases, and a later restore could mix pages of both. With
per-boot paths A keeps writing to its own path, B to its own, and the next boot restores B's (the
newest) path: B's history stays intact. What is lost is A's writes made after B restored (the
whole overlap window, typically seconds to a minute). Open tabs repair that themselves: a tab
notices the server's log has been rewound (it compares the IV fingerprint of the last op it saw)
and re-sends whatever the server lacks.

## One-time setup (owner)

### 1. Cloudflare R2

1. Cloudflare dashboard -> **R2 Object Storage** -> enable R2. This needs a payment method on file;
   the free tier (10 GB storage, 1M writes, 10M reads per month) is far more than flako uses, since
   10 s sync costs about 260k writes a month.
2. **Create bucket**, e.g. `flako-db`, Standard storage class, keep it **private** (no public
   access, no custom domain).
3. Copy the **Account ID** (R2 overview page, right-hand side).
4. R2 -> **Manage API tokens** -> **Create API token**: permission **Object Read & Write**,
   limited to that one bucket, TTL **forever**. After creating it, copy the **Access Key ID** and
   **Secret Access Key** (not the "token value"). The secret is shown only once. Object Read &
   Write covers everything the container does: Cloudflare documents it as "read, write, and list
   objects in specific buckets", and listing is how a boot finds the newest replica.
5. Bucket -> **Settings** -> **Object Lifecycle Rules** -> **Add rule**: name `expire-old-boots`,
   prefix `flako/`, action **delete objects** after **7 days** (keep N >= 7). Every boot leaves a
   replica path behind; this rule cleans up old ones. The *current* boot's path is unaffected in
   practice: Litestream rewrites its snapshot daily (the 12 h keepalive guarantees a change to
   snapshot) and its own 72 h retention deletes older files first, so its newest restorable set is
   always less than ~2 days old. R2 deletes expired objects within about 24 h of expiry. (R2's
   default rule that aborts unfinished multipart uploads after 7 days can stay.)

### 2. Render

1. Service -> **Environment**: add `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`.
2. Service -> **Settings** -> **Health Check Path**: `/healthz` (so a deploy only takes over once
   the new instance answers).
3. Leave `LITESTREAM_ENDPOINT` unset; `ADDR` already defaults to `:8080` in the image.
4. Deploy, then check the logs for `restored ... from the replica (flako/<boot id>)` (or
   `no backup exists yet` on the very first boot) and `litestream replicating to flako/<boot id>`.

**First deploy with backups — read before pushing:**
- **Current production data is NOT in R2 yet.** The first boot with backups starts on Render's
  empty disk, logs `no backup exists yet`, and from then on backs up whatever it holds. Anything
  only on the running instance is gone at that deploy (as on every deploy so far), except what open
  tabs re-send. If some note matters, keep a tab open on it across the deploy, or copy its text
  out first.
- **Reload every open tab after that deploy.** Tabs still running the pre-deploy JavaScript don't
  know how to detect a rewound server or repair it; a reload loads the new client.

Keys never go in the repo, in chat, or in a committed `.env`. To rotate: create a new token, update
the Render env vars, then delete the old token in Cloudflare.

### 3. Keep it warm

Point UptimeRobot at the `onrender.com` URL (not flako.in; Cloudflare may cache or block it). Free
instances sleep after inactivity; a cold start costs a restore, so staying warm is cheap insurance.

## Turning backups off

Remove any one of the four `R2_*` variables (or clear it) and redeploy. The server then starts
exactly as it did before backups existed. The bucket contents are left untouched.

## Restoring by hand

Easiest is to use the production image itself (it has Litestream, `sqlite3`, the config and the
replica lister). From the repo root, with Docker:

```bash
docker build -t flako .
# r2.env holds the credentials, one VAR=value per line; keep it outside the repo and delete it after:
#   R2_ACCOUNT_ID=...  R2_BUCKET=flako-db  R2_ACCESS_KEY_ID=...  R2_SECRET_ACCESS_KEY=...
#   LITESTREAM_ENDPOINT=https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
mkdir -p restore
R="docker run --rm --user 0 --env-file $HOME/r2.env -v $PWD/restore:/out --entrypoint"

$R flako-server flako newest-replica       # prints the newest boot id, e.g. 20261019T120000Z-0a1b2c
# Restore one boot's replica (the newest, or any older id you saw in the bucket under flako/):
$R litestream -e FLAKO_REPLICA=<boot id> flako \
  restore -config /app/litestream.yml -o /out/notes.db /data/notes.db
$R sqlite3 flako /out/notes.db "PRAGMA integrity_check"    # must print: ok
```

(Docker options such as `-e` go before the image name `flako`, as shown.)
Notes on `litestream restore` (v0.5.17):
- It refuses to overwrite an existing output file; add `-force` to replace it.
- `-timestamp 2026-10-20T12:00:00Z` restores the state as of that moment (within the ~72 h
  retention), e.g. to get back to just before a bad write.
- It has `-if-replica-exists` (exit 0 when there is no backup), but the manual command above
  doesn't use it: an empty or missing path then fails loudly, which is what you want by hand.
- `flako-server newest-replica` only lists; it never writes.

### Runbook: the backup chain is bad (boots log `BACKUPS PAUSED`, or a restore looks wrong)

1. **Find a good copy.** Look at the boot ids under `flako/` in the R2 dashboard (newest last).
   Restore the newest one as above; if it fails or the integrity check isn't `ok`, try the
   previous boot id, or the same id with `-timestamp` a bit earlier. Repeat until you have a
   `restore/notes.db` that checks `ok` and has the notes you expect.
2. **Make it the newest replica**, so the next boot restores it. Upload it under a NEW boot id
   that sorts after every existing one (current UTC time), by running Litestream once against the
   file:
   ```bash
   ID="$(date -u +%Y%m%dT%H%M%SZ)-0000aa"      # must match YYYYMMDDTHHMMSSZ-<hex>
   $R sh -e DB_PATH=/out/notes.db -e FLAKO_REPLICA="$ID" flako -c \
     'litestream replicate -config /app/litestream.yml & p=$!; sleep 30; kill -TERM $p; wait $p'
   $R flako-server flako newest-replica       # must print $ID now
   ```
3. **Redeploy / restart** the app (Render: "Manual Deploy"; VPS: if `/data/.restore-failed`
   exists, just restart, the marker makes it retry the restore; otherwise stop the app, delete
   the volume's `notes.db*` files, start it). Its log must say
   `restored /data/notes.db from the replica (flako/<your ID>)`.

Caveat: until that redeploy, the running instance keeps writing to its own (older) path; anything
it writes after step 2 is not in your uploaded copy. On the VPS you can instead copy the good file
into the `flako_sqlite_data` volume while the app is stopped (remove `notes.db-wal`/`-shm` and the
marker too).

## Testing the backup path locally

```bash
sh docker/test/backup-scenarios.sh        # about 20 minutes; all scenarios, needs Docker
```

It builds the real image and points it at a SeaweedFS container acting as R2 (compose project
`flako-bktest`, host port 18080). Scenarios: 1 backups off, 2 restore round trip, 3 wrong keys,
4 unreachable endpoint, 5 hanging restore, 6 corrupt backup, 7 Litestream killed, 8 shutdown with
S3 down / final upload, 9 overlapping deploys, 9b overlap then the survivor keeps writing,
10 keepalive, 11 the manual-restore runbook (5 also covers the restore-failed marker). Every failure case must still end with a healthy
`/healthz`. Pass scenario numbers to run only some.

## Alternative: an Oracle Cloud free VPS (Docker Compose + Caddy)

This path still works but is no longer what production uses.

One VM runs two containers: `app` (the Go binary with the UI embedded, SQLite in a volume)
and `caddy` (HTTPS with automatic Let's Encrypt certificates, reverse proxy to `app`).

### 1. Create the instance

- **Shape:** prefer **Ampere A1 (arm64)** — the free tier allows up to 4 OCPU / 24 GB. All images used
  here (`node`, `golang`, `alpine`, `caddy`) are multi-arch, so building *on the VM* just works.
  The free AMD `E2.1.Micro` (1 GB RAM) also runs the app, but `npm ci` + the Vite build may run out
  of memory there: add swap first (`sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile &&
  sudo mkswap /swapfile && sudo swapon /swapfile`).
- **Image:** Ubuntu 24.04. Keep the SSH key it gives you.
- Note the **public IP**.

### 2. Open ports 80 and 443 — in TWO places

Oracle blocks traffic twice; forgetting the second one is the classic "why is it unreachable".

1. **VCN security list** (console → Networking → your VCN → Security Lists → Default → Add Ingress
   Rules): source `0.0.0.0/0`, TCP, destination ports `80` and `443` (and UDP `443` for HTTP/3).
2. **The instance's own iptables** (Oracle's Ubuntu image ships with REJECT rules):
   ```bash
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   sudo iptables -I INPUT 6 -m state --state NEW -p udp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```

### 3. Pick a hostname (HTTPS is mandatory)

Browsers only allow WebCrypto — which does all the encryption — on HTTPS origins, so a bare
`http://<ip>` will not work. Either:

- point a domain's A record at the public IP, or
- use **sslip.io** for free: `203-0-113-7.sslip.io` resolves to `203.0.113.7`. Caddy can get a
  real certificate for it.

### 4. Install Docker and start

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker

git clone https://github.com/Mesfrum/flako.git && cd flako
cp .env.example .env && nano .env        # set DOMAIN=...
docker compose up -d --build
docker compose logs -f caddy             # watch it obtain the certificate
```

Open `https://<DOMAIN>`. Note links look like `https://<DOMAIN>/#/<name>`: the part after `#` never
leaves the browser, so the server never sees note names. Share links in that form.

### 5. Update

```bash
git pull && docker compose up -d --build
```

### Backing up on the VPS

The database lives in the `flako_sqlite_data` volume. Either set the four `R2_*` variables in `.env` (see `.env.example`; Litestream then backs it up the same way as on Render, and the restore-failed marker described above applies), or copy it out by hand:

```bash
docker run --rm -v flako_sqlite_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/notes-$(date +%F).tgz -C /data .
```

It's all ciphertext, so the backup is safe to store anywhere — but it is only as good as your
note names.
