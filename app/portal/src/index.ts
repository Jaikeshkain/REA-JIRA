/**
 * Start the owner portal:  npm --prefix app run portal   →  http://127.0.0.1:4600
 *
 *   PORTAL_DATA         where the portal keeps its database (default ~/.tracker-licensing/portal-data)
 *   PORTAL_PRIVATE_KEY  your private signing key (default ~/.tracker-licensing/vendor-private.pem)
 *   PORTAL_PORT / PORTAL_HOST   default 4600 / 127.0.0.1 (local only — keep it that way or put it behind a VPN)
 *   PORTAL_SMTP_URL, PORTAL_MAIL_FROM   to email licence keys to customers
 *   PORTAL_SECURE_COOKIES=1     when serving it over HTTPS
 *   PORTAL_TRUST_PROXY=1        behind a reverse proxy (Caddy) on the same machine
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openPortalDb } from './db.js';
import { buildPortal } from './app.js';
import { VENDOR_PUBLIC_KEY } from '../../server/src/license-key.js';

const base = join(homedir(), '.tracker-licensing');
const db = await openPortalDb(process.env.PORTAL_DATA || join(base, 'portal-data'));
const app = buildPortal({
  db,
  privateKeyPath: process.env.PORTAL_PRIVATE_KEY || join(base, 'vendor-private.pem'),
  publicKey: VENDOR_PUBLIC_KEY,
  smtpUrl: process.env.PORTAL_SMTP_URL || undefined,
  mailFrom: process.env.PORTAL_MAIL_FROM || undefined,
  secureCookies: process.env.PORTAL_SECURE_COOKIES === '1',
  trustProxy: process.env.PORTAL_TRUST_PROXY === '1',
});
const host = process.env.PORTAL_HOST || '127.0.0.1';
const port = Number(process.env.PORTAL_PORT || 4600);
const server = app.listen(port, host, () => console.log(`Tracker owner portal on http://${host}:${port}`));
const stop = async () => { server.close(); await db.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
