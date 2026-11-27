/**
 * Vendor licence tool — for YOU only. Never ship this folder or your private key to customers.
 *
 *   npm run license -- keygen                         create your key pair (once; back up the private key!)
 *   npm run license -- issue --customer "Acme Ltd" --seats 25 --install <installation-id> [--months 1 | --days 30 | --until 2027-01-31] [--from 2026-12-01]
 *   npm run license -- inspect <key>                  decode and check a key against the public key in this build
 *
 * Private key location: TRACKER_LICENSE_PRIVATE_KEY, or ~/.tracker-licensing/vendor-private.pem
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { signLicense, verifyLicense, type LicensePayload } from '../server/src/license.js';
import { VENDOR_PUBLIC_KEY } from '../server/src/license-key.js';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const keyPath = process.env.TRACKER_LICENSE_PRIVATE_KEY || join(homedir(), '.tracker-licensing', 'vendor-private.pem');
const die = (m: string) => { console.error(m); process.exit(1); };

if (cmd === 'keygen') {
  const out = opt('out') ? join(opt('out')!, 'vendor-private.pem') : keyPath;
  if (existsSync(out)) die(`A private key already exists at ${out}. Refusing to overwrite it (keys issued with it would stop working).`);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log(`Private key written to ${out}\nKEEP IT SECRET and BACK IT UP. Anyone with it can make licence keys; if you lose it you can't renew customers.\n`);
  console.log('Public key (put this in app/server/src/license-key.ts):\n');
  console.log(publicKey.export({ type: 'spki', format: 'pem' }));
} else if (cmd === 'issue') {
  if (!existsSync(keyPath)) die(`No private key at ${keyPath}. Run: npm run license -- keygen`);
  const customer = opt('customer'); const seats = Number(opt('seats')); const install = opt('install');
  if (!customer || !Number.isInteger(seats) || seats < 1 || !install) die('Usage: issue --customer "Name" --seats N --install <installation-id or *> [--months 1 | --days N | --until YYYY-MM-DD] [--from YYYY-MM-DD]');
  const from = opt('from') ? new Date(`${opt('from')}T00:00:00Z`) : new Date();
  let until: Date;
  if (opt('until')) until = new Date(`${opt('until')}T23:59:59Z`);
  else if (opt('days')) until = new Date(from.getTime() + Number(opt('days')) * 86400_000);
  else { until = new Date(from); until.setUTCMonth(until.getUTCMonth() + Number(opt('months') ?? 1)); }
  if (Number.isNaN(until.getTime()) || until <= from) die('The end date must be after the start date');
  const payload: LicensePayload = {
    v: 1, lid: `L-${from.toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex')}`, customer, seats,
    issued: from.toISOString(), expires: until.toISOString(), install,
  };
  const key = signLicense(payload, readFileSync(keyPath, 'utf8'));
  const check = verifyLicense(key, VENDOR_PUBLIC_KEY);
  if (!check.ok) die(`The key doesn't verify against the public key in this build (${check.reason}). Is license-key.ts from the same key pair?`);
  console.log(`Licence ${payload.lid} for ${customer}: ${seats} users, until ${payload.expires.slice(0, 10)}, installation ${install}\n`);
  console.log(key);
} else if (cmd === 'inspect') {
  const key = rest[0] ?? die('Usage: inspect <key>');
  const v = verifyLicense(String(key), VENDOR_PUBLIC_KEY);
  if (!v.ok) die(`Invalid: ${v.reason}`);
  console.log(JSON.stringify(v.payload, null, 2));
} else {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
}
