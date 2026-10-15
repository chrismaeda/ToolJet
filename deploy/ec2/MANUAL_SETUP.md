# Manual VM deployment (lts-v2.67)

How to set up ToolJet from this repo on a fresh Linux VM (e.g. EC2) with an
external PostgreSQL database (e.g. RDS), without Docker or the Packer AMI.

This setup assumes:

- ToolJet Database is **off** (`ENABLE_TOOLJET_DB=false`), so no PostgREST
- Sign-in is by password and/or Google SSO
- The app runs as a systemd service on port 3000 behind a reverse proxy or
  Cloudflare Tunnel that terminates TLS

The Packer/AMI flow (`setup_machine.sh` + `setup_app`) automates a similar
setup using OpenResty; this document is the manual equivalent.

## 0. Prerequisites

**VM**

- Ubuntu 22.04 or 24.04, x86_64 or arm64
- At least 2 vCPU and 4 GB RAM. The frontend build is the memory-heavy
  step; if it gets killed, add swap or build on a larger instance.
- 20 GB disk (dependencies and build output take several GB)
- Security group: inbound 22 (SSH), plus 80 and 443 (HTTP/HTTPS) unless
  you use a Cloudflare Tunnel (step 8, option C), which needs no inbound
  ports

**Database**

- PostgreSQL 16, 17 or 18 (tested on 18)
- A user that can create databases (the RDS master user works), or a
  pre-created database owned by the ToolJet user (see step 6)
- The database's security group must allow 5432 from the VM
- RDS for PostgreSQL 15+ requires SSL by default. ToolJet only uses SSL when
  the connection is given as `DATABASE_URL`, so use that (step 4).

**DNS**

- A hostname (e.g. `tooljet.example.com`) pointing at the VM or its load
  balancer. With a Cloudflare Tunnel, Cloudflare creates the record when you
  add the route.

## 1. Clone the repo

Clone to `/home/ubuntu/app` so the paths match `nest.service`:

```bash
git clone -b lts-v2.67 https://github.com/chrismaeda/ToolJet.git ~/app
cd ~/app
```

## 2. Install system packages

```bash
sudo apt-get update
sudo apt-get install -y git curl build-essential python3 postgresql-client nginx
```

- `postgresql-client` provides `createdb`, which `db:setup:prod` uses
- `build-essential` and `python3` let native modules compile from source if a
  prebuilt binary isn't available
- `nginx` is only needed for step 8, option B; leave it out otherwise

## 3. Install Node.js 24

Install nvm, then the version pinned in `.nvmrc` (24.16.0):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
source ~/.nvm/nvm.sh
cd ~/app && nvm install        # reads .nvmrc
node -v                        # v24.16.0
```

`nest.service` runs `/usr/bin/npm`, so link the nvm binaries there:

```bash
sudo ln -sf "$(which node)" /usr/bin/node
sudo ln -sf "$(which npm)" /usr/bin/npm
```

After a future Node upgrade, re-run these two commands.

## 4. Create `.env`

Create `~/app/.env`. The server reads it from the repo root.

```bash
cat > ~/app/.env <<EOF
TOOLJET_HOST=https://tooljet.example.com
PORT=3000
SERVE_CLIENT=true
NODE_ENV=production
DEPLOYMENT_PLATFORM=ec2

LOCKBOX_MASTER_KEY=$(openssl rand -hex 32)
SECRET_KEY_BASE=$(openssl rand -hex 64)

DATABASE_URL=postgres://<user>:<password>@<rds-endpoint>:5432/tooljet_production
ENABLE_TOOLJET_DB=false

CHECK_FOR_UPDATES=false
DISABLE_TOOLJET_TELEMETRY=true
EOF
chmod 600 ~/app/.env
```

Notes:

- **Back up `LOCKBOX_MASTER_KEY`.** Data source credentials are encrypted
  with it; if it is lost they cannot be recovered.
- `TOOLJET_HOST` must be the public `https://` URL users open. It is also
  used to build the Google SSO redirect URL.
- URL-encode special characters in the database password (e.g. `@` → `%40`).
  Avoid `$` and spaces in values; this file is also read by bash and systemd.
- If the database port isn't 5432, also set `PG_PORT=<port>`. The database
  setup scripts ignore the port in `DATABASE_URL`.
- If you created the database yourself, or the database user can't create
  databases, add `PG_DB_OWNER=false` and follow "Using a pre-created
  database" in step 6.
- Optional: `SMTP_*` and `DEFAULT_FROM_EMAIL` for invite and password-reset
  emails, `DISABLE_SIGNUPS`, `USER_SESSION_EXPIRY` (minutes). See
  `.env.example` for more.

## 5. Build

Build the plugins, frontend and server:

```bash
cd ~/app
NODE_OPTIONS=--max-old-space-size=4096 npm run build
```

This takes several minutes. Webpack warnings are expected; the build has
succeeded if it ends without an `npm error` and `server/dist/src/main.js`
exists.

## 6. Set up the database

Create the database and run all migrations:

```bash
cd ~/app
set -a; source .env; set +a
npm run db:setup:prod
```

You should see `Created database tooljet_production` (or that it already
exists), followed by the migrations running. It finishes with the last
migration's `executed successfully` message.

### Using a pre-created database

If the database already exists, or the ToolJet user can't create databases,
create and prepare it as an admin (e.g. the RDS master user), then run only
the migrations.

1. As the admin, create the database and give it to the ToolJet user.
   PostgreSQL 15+ only lets the owner of the `public` schema create tables
   in it, so transfer that too:

   ```sql
   CREATE USER <tooljet_user> WITH ENCRYPTED PASSWORD 'XXXXX';
   CREATE DATABASE tooljet_production LC_COLLATE "en_US.UTF-8" LC_CTYPE "en_US.UTF-8" TEMPLATE template0;
   ALTER DATABASE tooljet_production OWNER TO <tooljet_user>;
   \c tooljet_production
   ALTER SCHEMA public OWNER TO <tooljet_user>;
   CREATE EXTENSION IF NOT EXISTS pgcrypto;
   CREATE EXTENSION IF NOT EXISTS citext;
   ```

   On RDS, if `ALTER ... OWNER TO` fails with `must be able to SET ROLE`,
   first run `GRANT <tooljet_user> TO <master_user>;`.

2. Add `PG_DB_OWNER=false` to `.env`. Without it, the setup scripts run
   `createdb` and fail when the ToolJet user lacks permission to create
   databases. It also skips creating `pgcrypto` in the migrations, which is
   why step 1 creates it.

3. Run the migrations:

   ```bash
   cd ~/app
   set -a; source .env; set +a
   npm run db:migrate:prod
   ```

   With `PG_DB_OWNER=false`, `npm run db:setup:prod` also works; it skips
   database creation and runs the same migrations.

## 7. Run as a systemd service

Install the service unit from this directory:

```bash
sudo cp ~/app/deploy/ec2/nest.service /etc/systemd/system/nest.service
sudo systemctl daemon-reload
sudo systemctl enable --now nest
```

Check that it started:

```bash
journalctl -u nest -f                 # look for "Ready to use at ..."
curl -s localhost:3000/api/health     # HTTP 200
```

## 8. Reverse proxy and TLS

Pick one of these options.

**Option A: AWS load balancer (recommended on EC2).** Put an Application
Load Balancer with an ACM certificate in front of the VM. It should forward
HTTPS to the instance on port 3000, with health check path `/api/health`.
ALB passes WebSocket connections through automatically. Restrict the
instance's port 3000 to the load balancer's security group.

**Option B: nginx on the VM with Let's Encrypt.**

```bash
sudo tee /etc/nginx/conf.d/tooljet.conf > /dev/null <<'EOF'
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 80;
  server_name tooljet.example.com;
  client_max_body_size 100M;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
  }
}
EOF
sudo nginx -t && sudo systemctl reload nginx

sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d tooljet.example.com
```

**Option C: Cloudflare Tunnel.** `cloudflared` on the VM opens an outbound
connection to Cloudflare, which serves HTTPS for the hostname. The VM needs
no inbound ports apart from SSH, and no reverse proxy: point the tunnel
straight at the server.

1. In Cloudflare Zero Trust, go to **Networks → Tunnels** and create a tunnel
   (type *Cloudflared*), or open an existing one for this VM.
2. If `cloudflared` isn't on the VM yet, run the install command the
   dashboard shows for Debian. It installs the package and runs
   `sudo cloudflared service install <token>`, which sets it up as a systemd
   service that starts on boot.
3. Under **Public Hostnames**, add the ToolJet hostname with service type
   **HTTP** and URL **`localhost:3000`**. Use HTTP, not HTTPS: the server
   serves plain HTTP and Cloudflare handles TLS. WebSockets need no extra
   settings.

Check it:

```bash
systemctl is-enabled cloudflared nest      # both "enabled"
journalctl -u cloudflared | grep -E 'Registered tunnel|Updated to new configuration'
```

The configuration line should list the ToolJet hostname with
`http://localhost:3000`.

Notes:

- **Use a hostname one level below the zone**, e.g. `tooljet-stg.example.com`,
  not `tooljet.stg.example.com`. Cloudflare's free certificate covers only
  `example.com` and `*.example.com`; a deeper name fails with
  `ERR_SSL_VERSION_OR_CIPHER_MISMATCH` unless you buy Advanced Certificate
  Manager.
- `TOOLJET_HOST` must be the tunnel hostname, e.g.
  `https://tooljet-stg.example.com`.
- If a Cloudflare Access policy covers the hostname, users sign in to Access
  before reaching ToolJet. Browser sign-in, including ToolJet's Google
  sign-in, still works; server-to-server calls to the ToolJet API (e.g.
  webhooks) need an Access service token or a bypass policy.
- Cloudflare limits request bodies to 100 MB on Free and Pro plans.
- Close 80, 443 and 3000 in the security group. You can also reach SSH
  through the tunnel and close 22.

With any option, WebSocket upgrades must reach the server. The server
uses `/ws` for realtime events and `/yjs` for multiplayer editing.

## 9. Create the first admin

Open `TOOLJET_HOST` in a browser. The first account created becomes the
super admin and owns the first workspace.

## 10. Google sign-in (optional)

1. In Google Cloud Console, create an OAuth client ID of type *Web
   application*.
   - Authorized JavaScript origin: your `TOOLJET_HOST`
   - To restrict sign-in to your Google Workspace, set the OAuth consent
     screen's user type to *Internal*
2. In ToolJet, go to **Workspace settings → Workspace login → Google**.
   Turn it on and click **Save** with the Client ID empty. This generates
   the redirect URL, `<TOOLJET_HOST>/sso/google/<config-id>`.
3. Add that redirect URL to the Google OAuth client. Then paste the Client ID
   into ToolJet and save.
4. In the same settings, set **Allowed domains** to your Google Workspace
   domain.

## Upgrading

Pull the latest code, rebuild, run migrations and restart:

```bash
cd ~/app
git pull
NODE_OPTIONS=--max-old-space-size=4096 npm run build
set -a; source .env; set +a
npm run db:setup:prod
sudo systemctl restart nest
```

Take an RDS snapshot before upgrading.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `no pg_hba.conf entry ... no encryption` | The server is connecting without SSL. Use `DATABASE_URL` instead of `PG_HOST`/`PG_USER`/`PG_PASS`. |
| `createdb: ... port 5432 failed` on a non-5432 database | Set `PG_PORT`; the setup scripts ignore the port in `DATABASE_URL`. |
| `createdb: ... permission denied to create database` | The database user can't create databases. Pre-create the database and set `PG_DB_OWNER=false` (step 6, "Using a pre-created database"). |
| `permission denied for schema public` during migrations | The ToolJet user doesn't own the database's `public` schema (PostgreSQL 15+). Run `ALTER SCHEMA public OWNER TO <tooljet_user>;` in `tooljet_production` (step 6). |
| `Unsupported engine` / `EBADENGINE` during `npm install` | Node or npm is older than 18.18.2 / 9.8.1. Run `nvm use` in the repo. |
| Build killed / `heap out of memory` | Not enough RAM. Add swap or use a larger instance. |
| Pages load but editing or live updates don't work | The proxy isn't passing WebSocket upgrades for `/ws` and `/yjs`. |
| `ERR_SSL_VERSION_OR_CIPHER_MISMATCH` through a Cloudflare Tunnel | The hostname is two levels below the zone (e.g. `tooljet.stg.example.com`), which Cloudflare's free certificate doesn't cover. Use a one-level name like `tooljet-stg.example.com` (step 8, option C). |
| Every request redirects to `<team>.cloudflareaccess.com` | A Cloudflare Access policy covers the hostname. Sign in to Access in the browser; for API callers, use a service token or bypass policy. |
| Cloudflare `502 Bad Gateway` through the tunnel | The server isn't up yet (it takes ~30 s after boot) or the route's service isn't `http://localhost:3000`. Check `journalctl -u nest` and the tunnel's public hostname. |
| Google sign-in fails with `redirect_uri_mismatch` | The redirect URL in Google doesn't exactly match `<TOOLJET_HOST>/sso/google/<config-id>`. |
