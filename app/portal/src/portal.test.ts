/** Owner portal tests:  npm --prefix app run test:portal */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openPortalDb } from './db.js';
import { buildPortal, licenseState } from './app.js';
import { verifyLicense } from '../../server/src/license.js';

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
};

const dir = mkdtempSync(join(tmpdir(), 'portal-test-'));
const kp = generateKeyPairSync('ed25519');
const keyPath = join(dir, 'vendor-private.pem');
writeFileSync(keyPath, kp.privateKey.export({ type: 'pkcs8', format: 'pem' }));
const pub = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const mails: { to: string; subject: string; text: string }[] = [];
const db = await openPortalDb('memory://');
const app = buildPortal({ db, privateKeyPath: keyPath, publicKey: pub, sendMail: async (m) => { mails.push(m); } });
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

let jar = '';
const req = async (method: string, path: string, form?: Record<string, string>, cookie = jar) => {
  const res = await fetch(base + path, {
    method, redirect: 'manual',
    headers: { ...(cookie ? { cookie } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) jar = /tp_session=([^;]*)/.exec(set)![1] ? `tp_session=${/tp_session=([^;]*)/.exec(set)![1]}` : '';
  return { status: res.status, location: res.headers.get('location') ?? '', text: await res.text(), headers: res.headers };
};
const csrfOf = (html: string) => /name="_csrf" value="([^"]+)"/.exec(html)![1];

console.log('owner portal');
try {
  await test('first run: everything leads to setup; weak passwords refused; setup signs you in', async () => {
    assert.equal((await req('GET', '/')).location, '/login');
    assert.equal((await req('GET', '/login')).location, '/setup');
    assert.equal((await req('POST', '/setup', { name: 'Jai', email: 'owner@example.com', password: 'short' })).status, 400);
    const ok = await req('POST', '/setup', { name: 'Jai', email: 'owner@example.com', password: 'a-long-owner-password' });
    assert.equal(ok.location, '/');
    assert.match(ok.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
    assert.match((await req('GET', '/')).text, /Dashboard/);
    assert.equal((await req('GET', '/setup')).location, '/login', 'setup only once');
    const h = (await req('GET', '/')).headers;
    assert.match(h.get('content-security-policy')!, /frame-ancestors 'none'/);
  });

  let csrf = '';
  await test('forms need the session’s CSRF token', async () => {
    csrf = csrfOf((await req('GET', '/customers')).text);
    assert.equal((await req('POST', '/customers', { company: 'Evil' })).status, 403);
    assert.equal((await req('POST', '/customers', { company: 'Evil', _csrf: 'forged' })).status, 403);
  });

  let cust = '';
  const install = 'd4985f24-1bcf-4b18-ab80-820868cd4c51';
  await test('customers and installations, names shown safely', async () => {
    const r = await req('POST', '/customers', { _csrf: csrf, company: 'Acme <script>alert(1)</script>', contact_name: 'Ann', contact_email: 'ann@acme.example' });
    cust = /\/customers\/(\d+)/.exec(r.location)![1];
    const p = await req('GET', `/customers/${cust}`);
    assert.ok(p.text.includes('Acme &lt;script&gt;') && !p.text.includes('<script>alert'), 'escaped');
    assert.match((await req('POST', `/customers/${cust}/installations`, { _csrf: csrf, install_id: 'bad id!' })).location, /err=/);
    assert.match((await req('POST', `/customers/${cust}/installations`, { _csrf: csrf, install_id: install, label: 'Production' })).location, /ok=/);
    const other = /\/customers\/(\d+)/.exec((await req('POST', '/customers', { _csrf: csrf, company: 'Globex' })).location)![1];
    assert.match(decodeURIComponent((await req('POST', `/customers/${other}/installations`, { _csrf: csrf, install_id: install })).location), /already belongs to Acme/);
  });

  let licUrl = '', firstKey = '';
  await test('issue a licence: signed by your key, bound to the installation, the right users and dates', async () => {
    assert.match((await req('POST', `/customers/${cust}/licenses`, { _csrf: csrf, install: 'someone-elses-install', seats: '10', from: '2026-12-01', months: '1' })).location, /err=/);
    assert.match((await req('POST', `/customers/${cust}/licenses`, { _csrf: csrf, install, seats: '0', from: '2026-12-01', months: '1' })).location, /err=/);
    const r = await req('POST', `/customers/${cust}/licenses`, { _csrf: csrf, install, seats: '25', from: '2026-12-01', months: '1', note: 'Invoice 42' });
    licUrl = r.location.split('?')[0];
    const page = await req('GET', licUrl);
    firstKey = /<div class="key" id="key">([^<]+)<\/div>/.exec(page.text)![1];
    const v = verifyLicense(firstKey, pub);
    assert.ok(v.ok);
    if (v.ok) {
      assert.equal(v.payload.install, install);
      assert.equal(v.payload.seats, 25);
      assert.equal(v.payload.issued.slice(0, 10), '2026-12-01');
      assert.equal(v.payload.expires.slice(0, 10), '2027-01-01');
      assert.match(v.payload.customer, /^Acme/);
    }
  });

  await test('renewal starts when the current licence ends; history lists both', async () => {
    const page = await req('GET', `/customers/${cust}`);
    assert.match(page.text, /name="from" type="date" value="2027-01-01"/, 'renewal form continues from the expiry');
    const r = await req('POST', `/customers/${cust}/licenses`, { _csrf: csrf, install, seats: '25', from: '2027-01-01', months: '1' });
    const key = /<div class="key" id="key">([^<]+)<\/div>/.exec((await req('GET', r.location.split('?')[0])).text)![1];
    const v = verifyLicense(key, pub);
    assert.ok(v.ok && v.payload.issued.slice(0, 10) === '2027-01-01' && v.payload.expires.slice(0, 10) === '2027-02-01');
    assert.equal(((await req('GET', `/customers/${cust}`)).text.match(/href="\/licenses\/\d+"/g) ?? []).length, 2);
  });

  await test('email the key to the customer; download it; activity records it all', async () => {
    const r = await req('POST', `${licUrl}/send`, { _csrf: csrf, to: 'ann@acme.example' });
    assert.match(r.location, /ok=/);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'ann@acme.example');
    assert.ok(mails[0].text.includes(firstKey) && /Administration → Licence/.test(mails[0].text));
    assert.match((await req('GET', licUrl)).text, /Sent<\/th><td>[^<]+ to ann@acme\.example/);
    const dl = await req('GET', `${licUrl}/download`);
    assert.match(dl.headers.get('content-disposition')!, /attachment; filename="tracker-licence-L-/);
    assert.ok(dl.text.includes(firstKey));
    const act = (await req('GET', '/activity')).text;
    for (const a of ['Created the owner account', 'Added a customer', 'Issued a licence', 'Emailed a licence']) assert.ok(act.includes(a), a);
  });

  await test('statuses, sign-out, sign-in lockout', async () => {
    const day = 86400_000, now = new Date();
    assert.equal(licenseState(new Date(now.getTime() + 30 * day)).key, 'active');
    assert.equal(licenseState(new Date(now.getTime() + 5 * day)).key, 'renew');
    assert.equal(licenseState(new Date(now.getTime() - 5 * day)).key, 'grace');
    assert.equal(licenseState(new Date(now.getTime() - 30 * day)).key, 'expired');
    await req('POST', '/logout', { _csrf: csrf });
    assert.equal((await req('GET', '/customers', undefined, '')).location, '/login');
    for (let i = 0; i < 5; i++) assert.match((await req('POST', '/login', { email: 'owner@example.com', password: `wrong${i}` }, '')).location, /e=1/);
    assert.match((await req('POST', '/login', { email: 'owner@example.com', password: 'a-long-owner-password' }, '')).location, /e=2/, 'locked out for 15 minutes');
  });

  console.log(`\n${passed} passed`);
} finally {
  server.close();
  await db.close();
  rmSync(dir, { recursive: true, force: true });
}
