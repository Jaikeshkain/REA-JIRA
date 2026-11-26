/**
 * Account security (must-haves):
 * - One-time links for password reset (1 h), email verification (7 days) and invitations (7 days). Only a SHA-256 hash
 *   of each token is stored; links carry the token in the URL fragment (#token=…), so it never reaches server logs.
 *   Using a link consumes it. A reset signs out every session.
 * - "Forgot password" always answers the same way, whether or not the email exists (no account discovery).
 * - Rate limits (shared across instances, in the database): sign-in 5 failures / 15 min per email and 20 per IP;
 *   forgot-password 3 / hour per email and 10 per IP. Over the limit → 429 with Retry-After.
 * - Idle sessions end after SESSION_IDLE_HOURS (default 12) without activity; all sessions last at most 14 days.
 */
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Db } from './db.js';
import { HttpError, h, bad } from './http.js';
import { APP_URL, deliver, esc, frame, queueEmail } from './mail.js';
import { audit } from './audit.js';

export const IDLE_HOURS = () => Number(process.env.SESSION_IDLE_HOURS || 12);
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const TTL = { reset: '1 hour', verify: '7 days', invite: '7 days' } as const;
type Kind = keyof typeof TTL;
const Password = z.string().min(8, 'Use at least 8 characters').max(200);

// ------------------------------------------------------------------ rate limiting

const LIMITS = {
  login: { window: '15 minutes', perEmail: 5, perIp: 20, minutes: 15 },
  forgot: { window: '1 hour', perEmail: 3, perIp: 10, minutes: 60 },
} as const;

export async function checkRate(db: Db, kind: keyof typeof LIMITS, email: string, ip: string | undefined) {
  const L = LIMITS[kind];
  const [r] = await db.query(
    `SELECT count(*) FILTER (WHERE email = $2)::int AS by_email, count(*) FILTER (WHERE ip = $3)::int AS by_ip
     FROM auth_failures WHERE kind = $1 AND created_at > now() - $4::interval`,
    [kind, email.toLowerCase(), ip ?? '', L.window],
  );
  if (r.by_email >= L.perEmail || r.by_ip >= L.perIp) {
    const e = new HttpError(429, `Too many attempts. Try again in ${L.minutes} minutes.`);
    (e as any).retryAfter = L.minutes * 60;
    throw e;
  }
}
export async function recordFailure(db: Db, kind: keyof typeof LIMITS, email: string, ip: string | undefined) {
  await db.query(`INSERT INTO auth_failures (kind, email, ip) VALUES ($1,$2,$3)`, [kind, email.toLowerCase(), ip ?? '']);
  await db.query(`DELETE FROM auth_failures WHERE created_at < now() - interval '1 day'`);
}

// ------------------------------------------------------------------ one-time links

export async function issueToken(db: Db, userId: number, kind: Kind) {
  const token = randomBytes(32).toString('base64url');
  await db.query(`UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND kind = $2 AND used_at IS NULL`, [userId, kind]); // one live link per kind
  await db.query(
    `INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at) VALUES ($1,$2,$3, now() + $4::interval)`,
    [userId, kind, sha(token), TTL[kind]],
  );
  return token;
}
/** Look a token up (and optionally consume it). Returns the user row or null. */
async function useToken(db: Db, token: string, kind: Kind, consume: boolean) {
  const [t] = await db.query(
    `SELECT t.id AS token_id, u.* FROM auth_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND t.kind = $2 AND t.used_at IS NULL AND t.expires_at > now()`,
    [sha(token), kind],
  );
  if (!t) return null;
  if (consume) await db.query(`UPDATE auth_tokens SET used_at = now() WHERE id = $1`, [t.token_id]);
  return t;
}

const send = async (db: Db, u: { id: number; tenant_id: number; email: string; display_name: string }, kind: Kind, token: string, by?: string) => {
  const link = `${APP_URL}/${kind === 'reset' ? 'reset' : kind === 'verify' ? 'verify' : 'invite'}#token=${token}`;
  const copy = {
    reset: { subject: 'Reset your Tracker password', body: 'Someone (hopefully you) asked to reset your password. The link works once, for 1 hour.', cta: 'Choose a new password', footer: 'If you didn’t ask for this, ignore this email; your password stays the same.' },
    verify: { subject: 'Confirm your email for Tracker', body: 'Confirm this is your email address so you can get notifications and reset your password.', cta: 'Confirm my email', footer: 'The link works for 7 days.' },
    invite: { subject: `${by ?? 'Someone'} invited you to Tracker`, body: `${by ?? 'A site admin'} invited you to join Tracker. Set your password to get started.`, cta: 'Accept the invitation', footer: 'The invitation works for 7 days.' },
  }[kind];
  await queueEmail(db, {
    tenantId: u.tenant_id, userId: u.id, to: u.email, kind: `account-${kind}`, subject: copy.subject,
    text: `Hi ${u.display_name},\n\n${copy.body}\n\n${copy.cta}: ${link}\n\n${copy.footer}`,
    html: frame(copy.subject, `<p>Hi ${esc(u.display_name)},</p><p>${esc(copy.body)}</p>
      <p><a href="${esc(link)}" style="display:inline-block;background:#0c66e4;color:#fff;padding:8px 14px;border-radius:4px;text-decoration:none;font-weight:600">${esc(copy.cta)}</a></p>`, esc(copy.footer)),
  });
  void deliver(db).catch((e) => console.error('email delivery failed', e)); // don't wait for the scheduler
};
export const sendAccountEmail = send;

export async function hashPassword(p: string) { return bcrypt.hash(p, 10); }

// ------------------------------------------------------------------ routes (public: mounted under /api/auth)

export function accountRoutes(db: Db, newSession: (db: Db, userId: number) => Promise<string>, userJsonOf: (row: any) => unknown) {
  const r = Router();
  const ip = (req: Request) => req.ip;

  r.post('/forgot', h(async (req) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body ?? {});
    await checkRate(db, 'forgot', email, ip(req));
    await recordFailure(db, 'forgot', email, ip(req)); // every request counts toward the limit
    const [u] = await db.query(`SELECT * FROM users WHERE email = lower($1) AND active`, [email]);
    // SSO-only accounts (no password) and unknown emails get the same answer, and no email
    if (u && String(u.password_hash).startsWith('$2')) {
      await send(db, u, 'reset', await issueToken(db, u.id, 'reset'));
      await audit(db, { tenantId: u.tenant_id, actorId: u.id, actorName: u.display_name, category: 'security', action: 'Asked for a password reset', target: u.email, ip: ip(req) });
    }
    return { ok: true, message: 'If there’s an account for that email, we’ve sent a link to reset the password.' };
  }));

  r.post('/reset', h(async (req) => {
    const body = z.object({ token: z.string().min(10).max(200), password: Password }).parse(req.body ?? {});
    const u = await useToken(db, body.token, 'reset', true);
    if (!u || !u.active) throw bad('This reset link has expired or was already used. Ask for a new one.');
    await db.tx(async (q) => {
      await q.query(`UPDATE users SET password_hash = $2, email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1`, [u.id, await hashPassword(body.password)]);
      await q.query(`DELETE FROM sessions WHERE user_id = $1`, [u.id]); // sign out everywhere
    });
    await audit(db, { tenantId: u.tenant_id, actorId: u.id, actorName: u.display_name, category: 'security', action: 'Reset their password', target: u.email, ip: ip(req) });
    const token = await newSession(db, u.id);
    return { token, user: userJsonOf({ ...u, email_verified_at: u.email_verified_at ?? new Date() }) };
  }));

  r.post('/verify', h(async (req) => {
    const { token } = z.object({ token: z.string().min(10).max(200) }).parse(req.body ?? {});
    const u = await useToken(db, token, 'verify', true);
    if (!u) throw bad('This link has expired or was already used.');
    await db.query(`UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1`, [u.id]);
    return { ok: true, email: u.email };
  }));

  r.get('/invite', h(async (req) => {
    const u = await useToken(db, String(req.query.token ?? ''), 'invite', false);
    if (!u) throw bad('This invitation has expired or was already used. Ask a site admin to send a new one.');
    return { email: u.email, displayName: u.display_name };
  }));
  r.post('/accept-invite', h(async (req) => {
    const body = z.object({ token: z.string().min(10).max(200), password: Password, displayName: z.string().trim().min(1).max(80).optional() }).parse(req.body ?? {});
    const u = await useToken(db, body.token, 'invite', true);
    if (!u || !u.active) throw bad('This invitation has expired or was already used. Ask a site admin to send a new one.');
    await db.query(
      `UPDATE users SET password_hash = $2, display_name = coalesce($3, display_name), email_verified_at = now() WHERE id = $1`,
      [u.id, await hashPassword(body.password), body.displayName ?? null],
    );
    await audit(db, { tenantId: u.tenant_id, actorId: u.id, actorName: body.displayName ?? u.display_name, category: 'security', action: 'Accepted an invitation', target: u.email, ip: ip(req) });
    const token = await newSession(db, u.id);
    const [fresh] = await db.query(`SELECT * FROM users WHERE id = $1`, [u.id]);
    return { token, user: userJsonOf(fresh) };
  }));

  return r;
}

/** Signed-in routes (mounted under /api, after auth). */
export function myAccountRoutes(db: Db) {
  const r = Router();
  r.post('/myself/password', h(async (req) => {
    const user = req.user!;
    if (req.authKind !== 'session') throw new HttpError(403, 'Change your password while signed in to the app');
    const body = z.object({ currentPassword: z.string().min(1), newPassword: Password }).parse(req.body ?? {});
    await checkRate(db, 'login', user.email, req.ip);
    const [u] = await db.query(`SELECT password_hash FROM users WHERE id = $1`, [user.id]);
    if (!String(u.password_hash).startsWith('$2') || !(await bcrypt.compare(body.currentPassword, u.password_hash))) {
      await recordFailure(db, 'login', user.email, req.ip);
      throw bad('Your current password isn’t right');
    }
    const current = (req.header('authorization') ?? '').replace(/^Bearer /, '');
    await db.tx(async (q) => {
      await q.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [user.id, await hashPassword(body.newPassword)]);
      await q.query(`DELETE FROM sessions WHERE user_id = $1 AND token <> $2`, [user.id, current]); // other devices sign out
    });
    await audit(db, { tenantId: user.tenantId, actorId: user.id, actorName: user.displayName, category: 'security', action: 'Changed their password', target: user.email, ip: req.ip });
    return { ok: true };
  }));
  r.post('/myself/verify-email', h(async (req) => {
    const user = req.user!;
    const [u] = await db.query(`SELECT * FROM users WHERE id = $1`, [user.id]);
    if (u.email_verified_at) return { ok: true, alreadyVerified: true };
    await checkRate(db, 'forgot', user.email, req.ip);
    await recordFailure(db, 'forgot', user.email, req.ip);
    await send(db, u, 'verify', await issueToken(db, u.id, 'verify'));
    return { ok: true };
  }));
  r.post('/myself/sign-out-everywhere', h(async (req) => {
    const user = req.user!;
    await db.query(`DELETE FROM sessions WHERE user_id = $1`, [user.id]);
    return { ok: true };
  }));
  return r;
}
