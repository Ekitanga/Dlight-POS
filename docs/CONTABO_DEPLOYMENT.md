# Dlight POS Contabo VPS Deployment

This guide deploys Dlight POS on a Contabo Ubuntu VPS using Docker Compose, PostgreSQL, Caddy, and free Let's Encrypt SSL.

## Required Inputs

- VPS IP address: `169.58.30.49`
- A domain or subdomain for the POS, for example `pos.dlightgiftshop.com`
- DNS access for the domain, or the temporary free `sslip.io` hostname below
- Root login for first setup only

Do not keep using the root password shared during setup. Change it after deployment and create a non-root administrator user.

## DNS

Create this DNS record before running Caddy:

| Type | Name | Value |
|---|---|---|
| `A` | `pos` | `169.58.30.49` |

If using another subdomain, point that subdomain to `169.58.30.49`.

Free SSL will only work after DNS points correctly to the server.

### No-DNS temporary hostname

If the business domain is not ready, use the free automatic hostname:

```text
169-58-30-49.sslip.io
```

Set:

```env
APP_DOMAIN=169-58-30-49.sslip.io
```

This lets Caddy request a free Let's Encrypt certificate without creating DNS records. Replace it with the branded subdomain later.

## First Server Login

From Windows PowerShell:

```powershell
ssh root@169.58.30.49
```

After login, update the server:

```bash
apt update && apt upgrade -y
```

## Create Admin User

```bash
adduser dlight
usermod -aG sudo dlight
```

After confirming the `dlight` user works, change the root password:

```bash
passwd root
```

## Firewall

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
ufw status
```

## Install Docker

```bash
apt install -y ca-certificates curl gnupg git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker dlight
```

Log out and log in again as `dlight`.

## Clone Project

```bash
cd /opt
sudo git clone https://github.com/Ekitanga/Dlight-POS.git dlight-pos
sudo chown -R dlight:dlight /opt/dlight-pos
cd /opt/dlight-pos
```

## Configure Production Environment

```bash
cp deploy/contabo/.env.example deploy/contabo/.env
nano deploy/contabo/.env
```

Set:

- `APP_DOMAIN`
- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `JWT_REFRESH_SECRET`

Generate secrets:

```bash
openssl rand -hex 48
openssl rand -hex 48
openssl rand -base64 36
```

Use different values for every secret.

## Build and Start

```bash
docker compose -f deploy/contabo/docker-compose.yml up -d --build
docker compose -f deploy/contabo/docker-compose.yml ps
```

## Fast Bootstrap Option

On a new VPS, the fastest deployment path is:

```bash
curl -fsSL https://raw.githubusercontent.com/Ekitanga/Dlight-POS/main/deploy/contabo/bootstrap.sh -o /tmp/dlight-bootstrap.sh
bash /tmp/dlight-bootstrap.sh
```

By default this uses:

```text
https://169-58-30-49.sslip.io
```

To use a branded domain later:

```bash
APP_DOMAIN=pos.dlightgiftshop.com bash /tmp/dlight-bootstrap.sh
```

## Apply Database Schema

Run this only on a fresh empty production database:

```bash
bash deploy/contabo/apply-migrations.sh
```

Then restart the app:

```bash
docker compose -f deploy/contabo/docker-compose.yml restart app
```

## Create First Admin Login

Run this after the schema is applied. Replace the password with a private strong password that is not saved in chat or documentation:

```bash
docker compose -f deploy/contabo/docker-compose.yml exec \
  -e SEED_ADMIN_EMAIL='owner@example.com' \
  -e SEED_ADMIN_NAME='Owner Name' \
  -e SEED_ADMIN_PASSWORD='CHANGE_TO_PRIVATE_STRONG_PASSWORD' \
  app node packages/backend/dist/seed.js
```

This creates the first administrator and default setup records if they do not already exist.

## Verify

```bash
curl -I https://YOUR_DOMAIN/health
docker compose -f deploy/contabo/docker-compose.yml logs --tail=80 app
docker compose -f deploy/contabo/docker-compose.yml logs --tail=80 caddy
```

Open:

```text
https://YOUR_DOMAIN
```

## Backups

Contabo Auto Backup protects the server, but the application still needs database backups.

Manual database backup:

```bash
mkdir -p database/backups
docker compose -f deploy/contabo/docker-compose.yml exec -T db pg_dump \
  -U dlight_app \
  -d dlight_pos \
  --format=custom \
  > database/backups/dlight_pos_$(date +%Y%m%d_%H%M%S).dump
```

Verify backup:

```bash
docker compose -f deploy/contabo/docker-compose.yml exec -T db pg_restore --list /migrations/backups/FILE_NAME.dump
```

Download important backups off the VPS.

## Updates

```bash
cd /opt/dlight-pos
git pull
docker compose -f deploy/contabo/docker-compose.yml up -d --build
docker compose -f deploy/contabo/docker-compose.yml restart app
```

Apply new migrations only when a release includes them.

## Emergency Commands

View logs:

```bash
docker compose -f deploy/contabo/docker-compose.yml logs -f app
docker compose -f deploy/contabo/docker-compose.yml logs -f caddy
docker compose -f deploy/contabo/docker-compose.yml logs -f db
```

Restart:

```bash
docker compose -f deploy/contabo/docker-compose.yml restart
```

Stop:

```bash
docker compose -f deploy/contabo/docker-compose.yml down
```
