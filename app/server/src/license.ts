/**
 * Licensing for self-hosted installs.
 *
 * A licence key is `TRK1.<payload>.<signature>`: the payload (base64url JSON) is signed with the vendor's Ed25519
 * private key, which never ships. This build only contains the public key, so it can check keys but not make them,
 * and it checks them offline (no phoning home).
 *
 * States: development (running from source: not enforced) · trial (first 14 days of a new install, no key) · valid ·
 * expiring (≤ 7 days left) · grace (expired ≤ 14 days ago: still works, red banner) · read-only (expired, trial over,
 * or no valid key). Read-only never deletes or hides data: people can sign in, view, search and export.
 *
 * Keys are tied to one installation (its ID is shown in Administration → Licence) unless issued for "*", carry a
 * user limit, and expire (normally monthly).
 *
 * Clock tampering:
 * - "now" is the latest of: the app server clock, the database server clock, the newest recorded activity (History,
 *   audit log) and the latest time this install has ever seen — so winding a clock back changes nothing;
 * - a usage counter adds up running time (every few minutes, at most 10 minutes per step, never backwards). A key
 *   allows as many days of use as it covers plus the grace period, counted from when it was first installed, so a
 *   clock that's frozen or reset on every restart still runs out. The trial is limited the same way.
 * Wiping the licensing data creates a new installation ID, which no existing key matches.
 */
import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, randomUUID } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Db } from './db.js';
import { HttpError, h, bad, forbidden } from './http.js';
import { audit } from './audit.js';
import { VENDOR_PUBLIC_KEY } from './license-key.js';

declare const __RELEASE__: boolean | undefined;
/** True only in the bundled release build (set by the build), so running from source is never locked. */
export const RELEASE_BUILD = typeof __RELEASE__ !== 'undefined' && __RELEASE__ === true;

export const TRIAL_DAYS = 14;
export const GRACE_DAYS = 14;
export const WARN_DAYS = 7;
const DAY = 86400_000;
const TICK_MS = 5 * 60_000;      // count running time this often
const MAX_STEP_MS = 10 * 60_000; // never count more than this per step (server off / clock jumps)

export interface LicensePayload {
  v: 1; lid: string; customer: string; seats: number; issued: string; expires: string; install: string; features?: string[];
}
export type LicenseState = 'development' | 'trial' | 'valid' | 'expiring' | 'grace' | 'read-only';
export interface LicenseStatus {
  state: LicenseState; readOnly: boolean; message: string; daysLeft: number | null;
  license: LicensePayload | null; installationId: string; seats: number | null; usedSeats: number; problem?: string;
  usage?: { usedDays: number; allowedDays: number } | null;
}

const b64u = (b: Buffer) => b.toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');

/** Vendor side: sign a licence (needs the private key PEM). */
export function signLicense(p: LicensePayload, privateKeyPem: string) {
  const body = b64u(Buffer.from(JSON.stringify(p)));
  const sig = edSign(null, Buffer.from(`TRK1.${body}`), createPrivateKey(privateKeyPem));
  return `TRK1.${body}.${b64u(sig)}`;
}

/** Check a key's signature and shape. Returns the payload or a reason. Doesn't look at dates. */
export function verifyLicense(key: string, publicKeyPem: string): { ok: true; payload: LicensePayload } | { ok: false; reason: string } {
  const parts = key.trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'TRK1') return { ok: false, reason: 'That isn’t a Tracker licence key' };
  let valid = false;
  try { valid = edVerify(null, Buffer.from(`TRK1.${parts[1]}`), createPublicKey(publicKeyPem), fromB64u(parts[2])); } catch { valid = false; }
  if (!valid) return { ok: false, reason: 'The licence key’s signature is invalid (it was changed or isn’t from us)' };
  try {
    const p = JSON.parse(fromB64u(parts[1]).toString('utf8'));
    if (p.v !== 1 || typeof p.lid !== 'string' || typeof p.customer !== 'string' || !Number.isInteger(p.seats) || p.seats < 1 ||
        Number.isNaN(Date.parse(p.expires)) || Number.isNaN(Date.parse(p.issued)) || typeof p.install !== 'string') {
      return { ok: false, reason: 'The licence key is malformed' };
    }
    return { ok: true, payload: p };
  } catch {
    return { ok: false, reason: 'The licence key is malformed' };
  }
}

/** Pure state machine (tested on its own). */
export function evaluate(
  o: { enforce: boolean; payload: LicensePayload | null; problem?: string; installationId: string; installedAt: Date; now: Date; usedDays?: number | null },
): Omit<LicenseStatus, 'usedSeats' | 'seats'> {
  const base = { license: o.payload, installationId: o.installationId };
  if (!o.enforce) return { ...base, state: 'development', readOnly: false, daysLeft: null, message: 'Development build: licensing isn’t enforced.' };
  const days = (ms: number) => Math.ceil(ms / DAY);
  const used = o.usedDays ?? 0;
  if (!o.payload) {
    const left = Math.min(days(o.installedAt.getTime() + TRIAL_DAYS * DAY - o.now.getTime()), Math.ceil(TRIAL_DAYS - used));
    if (left > 0) return { ...base, state: 'trial', readOnly: false, daysLeft: left, message: `Trial: ${left} day${left === 1 ? '' : 's'} left. Install a licence key to keep using Tracker.` };
    return { ...base, state: 'read-only', readOnly: true, daysLeft: 0, problem: o.problem,
      message: o.problem ? `Read-only: ${o.problem}.` : 'Read-only: the trial has ended. Install a licence key to make changes again.' };
  }
  // usage allowance: the days the key covers + grace, counted in running time since it was first installed
  const covered = (Date.parse(o.payload.expires) - Date.parse(o.payload.issued)) / DAY;
  if (used > covered + GRACE_DAYS) {
    return { ...base, state: 'read-only', readOnly: true, daysLeft: 0, message: 'Read-only: the licence’s time is used up. Install a renewed licence key to make changes again.' };
  }
  const left = Math.min(days(Date.parse(o.payload.expires) - o.now.getTime()), Math.ceil(covered - used));
  if (left > WARN_DAYS) return { ...base, state: 'valid', readOnly: false, daysLeft: left, message: `Licensed to ${o.payload.customer}.` };
  if (left > 0) return { ...base, state: 'expiring', readOnly: false, daysLeft: left, message: `The licence expires in ${left} day${left === 1 ? '' : 's'}. Install the renewed key in Administration → Licence.` };
  const graceLeft = GRACE_DAYS + left; // left ≤ 0
  if (graceLeft > 0) return { ...base, state: 'grace', readOnly: false, daysLeft: graceLeft, message: `The licence has expired. Tracker becomes read-only in ${graceLeft} day${graceLeft === 1 ? '' : 's'} unless a renewed key is installed.` };
  return { ...base, state: 'read-only', readOnly: true, daysLeft: 0, message: 'Read-only: the licence has expired. Install a renewed licence key to make changes again.' };
}

// ------------------------------------------------------------------ the running app

export class Licensing {
  private cache: { at: number; status: LicenseStatus } | null = null;
  private timer: NodeJS.Timeout | null = null;
  constructor(private db: Db, readonly enforce: boolean, private publicKey: string) {}

  /** Count running time in the background (enforced builds only). */
  start() {
    if (!this.enforce || this.timer) return;
    this.timer = setInterval(() => { this.installation().then((i) => this.tick(i)).catch(() => undefined); }, TICK_MS);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Add running time since the last step: never negative, at most MAX_STEP_MS. Returns the total in seconds. */
  private async tick(inst: { usage_seconds: number | string; usage_tick_at: Date | null }) {
    const real = Date.now();
    const last = inst.usage_tick_at ? new Date(inst.usage_tick_at).getTime() : real;
    const add = Math.floor(Math.min(Math.max(real - last, 0), MAX_STEP_MS) / 1000);
    const [r] = await this.db.query(
      `UPDATE installation SET usage_seconds = usage_seconds + $1, usage_tick_at = $2 WHERE id = 1 RETURNING usage_seconds`,
      [add, new Date(real).toISOString()],
    );
    return Number(r.usage_seconds);
  }

  /** Stable installation ID (created on first start). */
  async installation() {
    await this.db.query(`INSERT INTO installation (id, install_id) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`, [randomUUID()]);
    const [r] = await this.db.query(`SELECT * FROM installation WHERE id = 1`);
    return r as { install_id: string; created_at: Date; max_seen_at: Date | null; license_key: string | null; usage_seconds: number | string; usage_tick_at: Date | null };
  }

  /** "Now": the latest of the app clock, the database clock, the newest recorded activity and the latest time seen. */
  private async now(inst: { max_seen_at: Date | null }) {
    const [r] = await this.db.query(
      `SELECT now() AS db_now,
              (SELECT created_at FROM changelog ORDER BY id DESC LIMIT 1) AS last_change,
              (SELECT created_at FROM audit_log ORDER BY id DESC LIMIT 1) AS last_audit`,
    );
    const t = (d: unknown) => (d ? new Date(d as string).getTime() : 0);
    const seen = t(inst.max_seen_at);
    const latest = Math.max(Date.now(), t(r.db_now), t(r.last_change), t(r.last_audit), seen);
    if (latest > seen + 3600_000 || !inst.max_seen_at) await this.db.query(`UPDATE installation SET max_seen_at = $1 WHERE id = 1`, [new Date(latest).toISOString()]);
    return new Date(latest);
  }

  private check(key: string | null, installId: string): { payload: LicensePayload | null; problem?: string } {
    if (!key) return { payload: null };
    const v = verifyLicense(key, this.publicKey);
    if (!v.ok) return { payload: null, problem: v.reason };
    if (v.payload.install !== '*' && v.payload.install !== installId) return { payload: null, problem: 'the licence key is for a different installation' };
    return { payload: v.payload };
  }

  async status(fresh = false): Promise<LicenseStatus> {
    if (!fresh && this.cache && Date.now() - this.cache.at < 30_000) return this.cache.status;
    const inst = await this.installation();
    const key = inst.license_key ?? process.env.LICENSE_KEY ?? null;
    const { payload, problem } = this.check(key, inst.install_id);
    const now = await this.now(inst);
    const usage = await this.tick(inst);
    let start = 0;
    if (payload) {
      await this.db.query(`INSERT INTO license_usage (lid, usage_start) VALUES ($1,$2) ON CONFLICT (lid) DO NOTHING`, [payload.lid, usage]);
      start = Number((await this.db.query(`SELECT usage_start FROM license_usage WHERE lid = $1`, [payload.lid]))[0].usage_start);
    }
    const usedDays = (usage - start) / 86400;
    const s = evaluate({ enforce: this.enforce, payload, problem, installationId: inst.install_id, installedAt: new Date(inst.created_at), now, usedDays });
    const [{ n }] = await this.db.query(
      `SELECT count(*)::int AS n FROM users WHERE active AND email NOT LIKE '%@tracker.system'`,
    );
    const allowedDays = payload ? (Date.parse(payload.expires) - Date.parse(payload.issued)) / DAY + GRACE_DAYS : TRIAL_DAYS;
    const status: LicenseStatus = {
      ...s, seats: this.enforce && payload ? payload.seats : null, usedSeats: n,
      usage: this.enforce ? { usedDays: Math.round(usedDays * 10) / 10, allowedDays: Math.round(allowedDays) } : null,
    };
    this.cache = { at: Date.now(), status };
    return status;
  }
  invalidate() { this.cache = null; }

  /** Throw unless `extra` more people fit in the licence. */
  async assertSeats(extra = 1) {
    const s = await this.status(true);
    if (s.seats != null && s.usedSeats + extra > s.seats) {
      throw new HttpError(403, `Your licence covers ${s.seats} active user${s.seats === 1 ? '' : 's'} and ${s.usedSeats} are in use. Deactivate someone or ask us for more seats.`);
    }
  }

  async install(key: string) {
    const inst = await this.installation();
    const { payload, problem } = this.check(key, inst.install_id);
    if (!payload) throw bad(`That key can’t be used: ${problem}`);
    const now = await this.now(inst);
    if (Date.parse(payload.expires) + GRACE_DAYS * DAY <= now.getTime()) throw bad('That licence key has already expired');
    const usage = await this.tick(inst);
    await this.db.query(`INSERT INTO license_usage (lid, usage_start) VALUES ($1,$2) ON CONFLICT (lid) DO NOTHING`, [payload.lid, usage]);
    await this.db.query(`UPDATE installation SET license_key = $1, license_installed_at = now() WHERE id = 1`, [key.trim()]);
    this.invalidate();
    return payload;
  }
}

// read-like requests allowed in read-only mode (besides GET): signing in/out, searching, the licence page itself
const ALLOWED_WHEN_READ_ONLY = [
  /^\/api\/auth\//, /^\/api\/search\/(jql|table)$/, /^\/api\/admin\/license$/, /^\/api\/myself\/password$/,
  /^\/api\/myself\/sign-out-everywhere$/, /^\/api\/notifications\/read$/, /^\/api\/myself\/verify-email$/,
];

/** Middleware: refuse changes while read-only. */
export function readOnlyGuard(lic: Licensing) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || !lic.enforce) return next();
    const path = req.originalUrl.split('?')[0];
    if (ALLOWED_WHEN_READ_ONLY.some((re) => re.test(path))) return next();
    try {
      const s = await lic.status();
      if (s.readOnly) return next(new HttpError(403, `Tracker is read-only: ${s.message.replace(/^Read-only: /, '')} Ask your site admin.`));
      next();
    } catch (e) { next(e); }
  };
}

export function licenseRoutes(db: Db, lic: Licensing) {
  const r = Router();
  /** Everyone: what to show in the banner. Site admins also get the details. */
  r.get('/license/status', h(async (req) => {
    const s = await lic.status();
    const basic = { state: s.state, readOnly: s.readOnly, message: s.message, daysLeft: s.daysLeft };
    if (!req.user!.isSiteAdmin) return basic;
    return {
      ...basic, installationId: s.installationId, seats: s.seats, usedSeats: s.usedSeats, problem: s.problem ?? null, usage: s.usage ?? null,
      license: s.license ? { id: s.license.lid, customer: s.license.customer, seats: s.license.seats, issued: s.license.issued, expires: s.license.expires, install: s.license.install } : null,
    };
  }));
  r.put('/admin/license', h(async (req) => {
    const u = req.user!;
    if (!u.isSiteAdmin) throw forbidden('ADMINISTER');
    const { key } = z.object({ key: z.string().trim().min(20).max(5000) }).parse(req.body ?? {});
    const p = await lic.install(key);
    await audit(db, { tenantId: u.tenantId, actorId: u.id, actorName: u.displayName, category: 'admin', action: 'Installed a licence key', target: `${p.customer} · ${p.seats} users · until ${p.expires.slice(0, 10)}`, ip: req.ip });
    return lic.status(true);
  }));
  return r;
}

export const defaultPublicKey = () => VENDOR_PUBLIC_KEY;
