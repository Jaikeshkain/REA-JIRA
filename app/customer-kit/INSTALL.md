# Installing Tracker

Tracker runs on your own server, with your own database. Your data never leaves your network. You need a licence
key from your Tracker supplier; a new installation runs as a 14-day trial until you add one.

## What you need

- A Linux server (2 CPU, 2 GB RAM is plenty for 100 people) with **Docker** and **Docker Compose** installed.
- **PostgreSQL 14 or newer** with an empty database, or use the bundled PostgreSQL (step 3).
- An address for it, e.g. `tracker.yourcompany.com`, and an HTTPS certificate (step 6).
- From your supplier: the **image** (a file or registry access) and later your **licence key**.

## 1. Get the image

Your supplier gives you either an image file or access to a registry:

```bash
docker load -i tracker-1.0.0.tar                  # image file: then TRACKER_IMAGE=tracker:1.0.0 in .env
# or
docker login <registry from your supplier>        # registry: with the username and token you were given
```

## 2. Configure

Put `docker-compose.yml` and `.env.example` from this kit in a folder, e.g. `/opt/tracker`, then:

```bash
cp .env.example .env
nano .env        # set TRACKER_IMAGE, DATABASE_URL and APP_URL at least
```

## 3. Start

```bash
docker compose up -d                       # with your own PostgreSQL (DATABASE_URL)
# or
docker compose --profile postgres up -d    # with the bundled PostgreSQL
docker compose logs -f tracker             # wait for "Tracker listening on http://0.0.0.0:4000"
```

Tracker creates its tables on first start and updates them automatically after upgrades.

## 4. Create the first admin and lock down sign-up

1. Open your Tracker address and **sign up**. The first account becomes the **site admin**.
2. Go to **Administration → Settings** and set **Who can sign up** to *invitation only* (or your company's email
   domain). Optionally set **Who can create spaces** to *site admins only*.
3. Invite your colleagues in **Administration → Users**.

## 5. Install the licence

1. Open **Administration → Licence** and copy the **Installation ID**.
2. Send it to your supplier. They send back a licence key (it starts with `TRK1.`).
3. Paste it into **Install a licence key**.

Keys are renewed **monthly**: paste each new key the same way. Seven days before expiry, admins see a reminder.
If a key runs out, Tracker keeps working for **14 more days**, then becomes **read-only** until a renewed key is
installed. Nothing is deleted and everyone can still sign in, view, search and export.

The licence covers a number of **active people**, wherever they work. Deactivated people don't count.

## 6. HTTPS and access from every office

People use Tracker in a browser at one address. Choose how they reach the server:

- **Over the internet:** put a reverse proxy with HTTPS in front (e.g. Caddy: `tracker.yourcompany.com { reverse_proxy 127.0.0.1:4000 }`),
  set `TRACKER_PORT=127.0.0.1:4000` and `TRUST_PROXY=1` in `.env`. Single sign-on (Microsoft, Google, Okta…) is recommended.
- **Private network only:** keep the server internal; other offices connect through your VPN.
- **Secure tunnel:** Cloudflare Tunnel, Tailscale or similar, with no ports opened to the internet.

Several Tracker containers can share one database behind a load balancer; they share the same licence.

## 7. Backups

Back up **the database** and **the `tracker-data` volume** (attachments):

```bash
pg_dump -Fc "$DATABASE_URL" > tracker-$(date +%F).dump       # restore with pg_restore
docker run --rm -v tracker_tracker-data:/data -v "$PWD":/backup alpine tar czf /backup/tracker-files-$(date +%F).tgz /data
```

Keep copies away from the server and test a restore.

## 8. Upgrading

Your supplier tells you the new image version:

```bash
nano .env                      # change the version in TRACKER_IMAGE
docker compose pull && docker compose up -d
```

## Help

- **"Read-only" banner:** the licence has run out. Install the renewed key in Administration → Licence.
- **"The licence key is for a different installation":** the key was made for another server. Send your
  Installation ID to your supplier for the right key.
- **No emails arrive:** set `SMTP_URL`. Until then, emails wait in Administration → Email outbox.
