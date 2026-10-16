# Deploying to an Oracle Cloud free VPS

One VM runs two containers: `app` (the Go binary with the UI embedded, SQLite in a volume)
and `caddy` (HTTPS with automatic Let's Encrypt certificates, reverse proxy to `app`).

## 1. Create the instance

- **Shape:** prefer **Ampere A1 (arm64)** — the free tier allows up to 4 OCPU / 24 GB. All images used
  here (`node`, `golang`, `alpine`, `caddy`) are multi-arch, so building *on the VM* just works.
  The free AMD `E2.1.Micro` (1 GB RAM) also runs the app, but `npm ci` + the Vite build may run out
  of memory there: add swap first (`sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile &&
  sudo mkswap /swapfile && sudo swapon /swapfile`).
- **Image:** Ubuntu 24.04. Keep the SSH key it gives you.
- Note the **public IP**.

## 2. Open ports 80 and 443 — in TWO places

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

## 3. Pick a hostname (HTTPS is mandatory)

Browsers only allow WebCrypto — which does all the encryption — on HTTPS origins, so a bare
`http://<ip>` will not work. Either:

- point a domain's A record at the public IP, or
- use **sslip.io** for free: `203-0-113-7.sslip.io` resolves to `203.0.113.7`. Caddy can get a
  real certificate for it.

## 4. Install Docker and start

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker

git clone https://github.com/Mesfrum/shribe2e.git && cd shribe2e
cp .env.example .env && nano .env        # set DOMAIN=...
docker compose up -d --build
docker compose logs -f caddy             # watch it obtain the certificate
```

Open `https://<DOMAIN>`. Note links look like `https://<DOMAIN>/#/<name>`: the part after `#` never
leaves the browser, so the server never sees note names. Share links in that form.

## 5. Update

```bash
git pull && docker compose up -d --build
```

## 6. Back up the notes

The database lives in the `shribe2e_sqlite_data` volume. Until Litestream (Phase 5), copy it out:

```bash
docker run --rm -v shribe2e_sqlite_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/notes-$(date +%F).tgz -C /data .
```

It's all ciphertext, so the backup is safe to store anywhere — but it is only as good as your
note names.
