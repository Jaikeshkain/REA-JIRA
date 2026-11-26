/**
 * Multi-instance check against a real PostgreSQL (needs DATABASE_URL; skipped otherwise).
 * Two "servers" = two independent connection pools + two apps, as separate processes would have.
 *   DATABASE_URL=postgres://… npm --prefix server run test:multi
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb, type Db } from './db.js';
import { buildApp } from './app.js';
import { seedIfEmpty, DEMO_USERS } from './seed.js';
import { tick, SCHEDULER_LOCK } from './scheduler.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.log('multi-instance: DATABASE_URL not set — skipped');
  process.exit(0);
}

let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await sleep(25);
  return cond();
};

const db1 = await openDb({ url });
await seedIfEmpty(db1);
const db2 = await openDb({ url });
const apps = [buildApp(db1, { oidc: null }), buildApp(db2, { oidc: null })];
const servers = apps.map((a) => a.listen(0));
const bases = servers.map((s) => `http://127.0.0.1:${(s.address() as AddressInfo).port}/api`);
await Promise.all(apps.map((a) => (a.locals.hub as { ready: Promise<void> }).ready));

const call = async (base: string, token: string | null, method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const login = async (base: string, email: string) => (await call(base, null, 'POST', '/auth/login', { email, password: DEMO_USERS[0].password })).body.token as string;
const stream = async (base: string, token: string) => {
  const ctl = new AbortController();
  const events: { event: string; data: any }[] = [];
  const res = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${token}` }, signal: ctl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : null });
        }
      }
    } catch { /* aborted */ }
  })();
  await until(() => events.some((e) => e.event === 'hello'));
  return { events, close: () => ctl.abort(), changes: () => events.filter((e) => e.event === 'change') };
};

console.log('multi-instance (real Postgres)');
const streams: { close(): void }[] = [];
try {
  const dev = await login(bases[0], 'dev@tracker.test');
  const viewerOn2 = await login(bases[1], 'viewer@tracker.test');
  const devOn2 = await login(bases[1], 'dev@tracker.test');

  await test('a change made on instance A reaches a browser on instance B, once', async () => {
    const vic = await stream(bases[1], viewerOn2); streams.push(vic);
    const danaA = await stream(bases[0], dev); streams.push(danaA);
    const r = await call(bases[0], dev, 'PATCH', '/issue/DEMO-7/fields/summary', { value: `Wallet integration ${Date.now()}` });
    assert.ok(r.status < 300, String(r.status));
    assert.ok(await until(() => vic.changes().length > 0), 'B got it over LISTEN/NOTIFY');
    assert.deepEqual(vic.changes()[0].data.keys, ['DEMO-7']);
    await sleep(400);
    assert.equal(vic.changes().length, 1, 'exactly once on B');
    assert.equal(danaA.changes().length, 1, 'exactly once on A (own echo ignored)');
  });

  await test('notification pings cross instances', async () => {
    const vic = await stream(bases[1], viewerOn2); streams.push(vic);
    assert.equal((await call(bases[1], viewerOn2, 'POST', '/issue/DEMO-7/watchers', {})).status, 200); // viewer watches (on B)
    await call(bases[0], dev, 'POST', '/issue/DEMO-7/comment', { body: 'cross-instance ping' });
    assert.ok(await until(() => vic.events.some((e) => e.event === 'notification')));
  });

  await test('large events are split under the NOTIFY size limit', async () => {
    const vic = await stream(bases[1], viewerOn2); streams.push(vic);
    const [p] = await db1.query(`SELECT id, tenant_id FROM projects WHERE key = 'DEMO'`);
    const keys = Array.from({ length: 250 }, (_, i) => `DEMO-${10_000 + i}`);
    await (apps[0].locals.hub as any).publishChange(p.tenant_id, p.id, { type: 'change', projectKey: 'DEMO', keys, actor: '1', scope: 'issue' });
    assert.ok(await until(() => vic.changes().flatMap((e) => e.data.keys).length === 250), 'all keys arrive');
    assert.equal(vic.changes().length, 3, '100 + 100 + 50');
  });

  await test('scheduler: only one instance runs a pass at a time', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const holder = db1.withLock!(SCHEDULER_LOCK, () => held); // instance A is mid-pass
    await sleep(100);
    assert.deepEqual(await tick(db2), { skipped: true }, 'B skips while A holds the lock');
    release();
    assert.equal((await holder).ran, true);
    const r = await tick(db2);
    assert.ok(!('skipped' in r), 'B runs once A is done');
    const [{ n }] = await db1.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`);
    assert.equal(n, 0, 'lock released');
  });

  await test('listener connection dropped → reconnects, browsers told to resync, events flow again', async () => {
    const vic = await stream(bases[1], viewerOn2); streams.push(vic);
    // kill every LISTEN connection (both instances), as a database failover would
    await db1.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query ILIKE 'LISTEN %' AND pid <> pg_backend_pid()`);
    assert.ok(await until(() => vic.events.some((e) => e.event === 'resync'), 8000), 'resync sent after reconnect');
    const before = vic.changes().length;
    await call(bases[0], dev, 'PATCH', '/issue/DEMO-7/fields/summary', { value: `After failover ${Date.now()}` });
    assert.ok(await until(() => vic.changes().length > before), 'live again');
  });

  await test('instance B serves the same data (shared database)', async () => {
    assert.equal((await call(bases[1], devOn2, 'GET', '/issue/DEMO-7')).status, 200);
  });

  console.log(`\n${passed} passed`);
} finally {
  streams.forEach((s) => s.close());
  for (const a of apps) (a.locals.hub as { close(): void }).close();
  servers.forEach((s) => s.close());
  await sleep(100);
  await (db1 as Db).close();
  await (db2 as Db).close();
}
