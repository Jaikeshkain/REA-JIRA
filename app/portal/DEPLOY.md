# Running the owner portal on your VPS

The portal holds your **private signing key**. Anyone who gets into it, or onto the server, can make licence keys for
any customer. So it runs behind HTTPS, at its own address, reachable **only from your own IP address or your VPN**.

## 1. Copy your private key to the VPS (once)

From your computer (PowerShell):

```powershell
scp "$env:USERPROFILE\.tracker-licensing\vendor-private.pem" root@YOUR_VPS_IP:/opt/tracker/app/portal/secrets/vendor-private.pem
```

On the VPS:

```bash
mkdir -p /opt/tracker/app/portal/secrets
chown 1000:1000 /opt/tracker/app/portal/secrets/vendor-private.pem   # the portal runs as user 1000
chmod 400 /opt/tracker/app/portal/secrets/vendor-private.pem
```

Keep your offline backup of the key as well. The VPS copy is for convenience, not the only copy.

## 2. Email settings (optional)

`/opt/tracker/app/portal/.env`:

```bash
PORTAL_SMTP_URL=smtp://USER:PASSWORD@smtp.yourprovider.com:587
PORTAL_MAIL_FROM=Tracker licensing <licensing@yourdomain.com>
```

## 3. Start it

```bash
cd /opt/tracker
docker compose -f app/portal/docker-compose.yml up -d --build
docker compose -f app/portal/docker-compose.yml logs -f portal     # "Tracker owner portal on http://0.0.0.0:4600"
```

It listens on `127.0.0.1:4600` only, so nothing outside the VPS can reach it directly.

## 4. HTTPS + access only from you (Caddy)

Add a DNS record such as `owner.yourdomain.com` pointing to the VPS, then add to `/etc/caddy/Caddyfile`:

```
owner.yourdomain.com {
    @notme not remote_ip YOUR.HOME.IP.ADDRESS
    respond @notme "Not found" 404
    reverse_proxy 127.0.0.1:4600
}
```

Reload Caddy (`systemctl reload caddy`, or `caddy reload --config /etc/caddy/Caddyfile`).

**Already running Caddy in Docker?** Inside its container, `127.0.0.1` is the container itself. Put the portal on
Caddy's Docker network (add `networks: [<caddy's network>]` to the portal service, declared as `external: true`) and use
`reverse_proxy portal:4600` instead, keeping the `ports:` line bound to 127.0.0.1 or removing it.

Then open `https://owner.yourdomain.com` and **create your owner account straight away**
(the first visitor creates it, which is why the IP restriction matters).

If your home IP changes often, use a VPN instead: e.g. Tailscale on the VPS and your laptop, and in Caddy allow only
`remote_ip 100.64.0.0/10`. Or skip public DNS entirely and open the portal through an SSH tunnel:
`ssh -L 4600:127.0.0.1:4600 root@YOUR_VPS_IP`, then `http://127.0.0.1:4600` on your computer.

## 5. Backups

The portal's data (customers, installations, every licence issued) is in the Docker volume `portal_portal-data`:

```bash
docker run --rm -v portal_portal-data:/data -v /root/backups:/backup alpine tar czf /backup/portal-$(date +%F).tgz /data
```

Copy it off the server regularly, together with your private key backup.

## 6. Updating

```bash
cd /opt/tracker && git pull && docker compose -f app/portal/docker-compose.yml up -d --build
```

## If the VPS is ever compromised

Assume the private key is known. Make a new key pair (`npm run license -- keygen --out <new folder>`), put the new
public key in `app/server/src/license-key.ts`, release a new Tracker version, and issue every customer a new key with
the portal.
