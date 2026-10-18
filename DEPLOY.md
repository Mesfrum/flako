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

- **All four set:** on boot the entrypoint restores `/data/notes.db` from the bucket (time limit
  15 s, then a 5 s integrity check; about 20 s worst case), starts the server, and once `/healthz`
  answers starts `litestream replicate` beside it. Changes upload every 10 s, a full snapshot is
  taken daily, and about 72 h of history is kept. On SIGTERM the server stops first, then
  Litestream does a final upload (up to 15 s; Compose `stop_grace_period` is 30 s).
- **Any one missing or empty:** backups are off and the server is exec'd exactly as before.
- **Fail-open:** nothing backup-related may keep the server down. If the restore fails, times out,
  or yields a corrupt file, the server boots with an empty database and the log says
  `BACKUPS PAUSED FOR THIS BOOT`. Replication is deliberately off for that boot so an empty DB
  cannot overwrite the good backup. Fix the cause (credentials, R2 outage) and redeploy.
- **Existing local DB:** the restore is skipped (a persistent volume, e.g. the Compose one, wins).
- `LITESTREAM_ENDPOINT` is a test-only override used by `docker/test/backup-scenarios.sh`. Never
  set it in production.

**Overlapping deploys.** Render keeps the old instance serving while the new one boots, so for a
short window two instances may both write to the bucket. Tested (scenario 9): a restore never came
out corrupt, but the losing writer's writes made in the overlap window can be missing from the
backup. Open tabs repair this themselves: a tab notices the server's log has been rewound (it
compares the IV fingerprint of the last op it saw) and re-sends whatever the server lacks.

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
   **Secret Access Key** (not the "token value"). The secret is shown only once.

### 2. Render

1. Service -> **Environment**: add `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`.
2. Service -> **Settings** -> **Health Check Path**: `/healthz` (so a deploy only takes over once
   the new instance answers).
3. Do not set `PORT` handling or `LITESTREAM_ENDPOINT`; neither is needed.
4. Deploy, then check the logs for `restored ... from the replica` (or `no backup exists yet` on
   the very first boot) and `litestream replicating`.

Keys never go in the repo, in chat, or in a committed `.env`. To rotate: create a new token, update
the Render env vars, then delete the old token in Cloudflare.

### 3. Keep it warm

Point UptimeRobot at the `onrender.com` URL (not flako.in; Cloudflare may cache or block it). Free
instances sleep after inactivity; a cold start costs a restore, so staying warm is cheap insurance.

## Turning backups off

Remove any one of the four `R2_*` variables (or clear it) and redeploy. The server then starts
exactly as it did before backups existed. The bucket contents are left untouched.

## Restoring by hand

To pull the latest backup to your machine (for example to inspect it, or to seed a fresh server),
install [Litestream](https://litestream.io/install/) v0.5.x and run, from the repo root:

```bash
export R2_ACCOUNT_ID=... R2_BUCKET=flako-db R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
export LITESTREAM_ENDPOINT="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
export DB_PATH=/data/notes.db      # only names the database inside the config; nothing is written there
litestream restore -config docker/litestream.yml -o ./notes.db "$DB_PATH"
sqlite3 notes.db "PRAGMA integrity_check"
```

This is the same command the entrypoint runs. Add `-timestamp 2026-10-20T12:00:00Z` to restore to a
point in time within the retention window. To put the file back in production, either let the
container restore on boot (empty `/data`), or on the VPS copy it into the `flako_sqlite_data`
volume while the app is stopped.

## Testing the backup path locally

```bash
sh docker/test/backup-scenarios.sh        # about 10+ minutes; scenarios 1-9, needs Docker
```

It builds the real image and points it at a SeaweedFS container acting as R2 (compose project
`flako-bktest`, host port 18080). Scenarios: 1 backups off, 2 restore round trip, 3 wrong keys,
4 unreachable endpoint, 5 hanging restore, 6 corrupt backup, 7 Litestream killed, 8 shutdown with
S3 down / final upload, 9 overlapping deploys. Every failure case must still end with a healthy
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

The database lives in the `flako_sqlite_data` volume. Either set the four `R2_*` variables in `.env` (see below; Litestream then backs it up the same way as on Render), or copy it out by hand:

```bash
docker run --rm -v flako_sqlite_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/notes-$(date +%F).tgz -C /data .
```

It's all ciphertext, so the backup is safe to store anywhere — but it is only as good as your
note names.
