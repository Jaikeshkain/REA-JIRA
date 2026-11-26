/**
 * Phase 5: personal API tokens + the admin audit log.
 *
 * API tokens ("trk_…") let scripts and other tools call the REST API as you: `Authorization: Bearer trk_…`, or Basic
 * auth with `email:token` (Jira-style). Only a SHA-256 hash is stored; the token is shown once. Tokens can't be used
 * to create more tokens (that needs a signed-in session), can expire, and can be revoked any time.
 *
 * The audit log records who changed configuration or security settings and when: spaces, members/roles, workflows,
 * fields, automation, webhooks, tokens, sign-ins. It never stores request bodies (they can hold secrets).
 */
import { createHash, randomBytes } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Db } from './db.js';
import type { AuthUser } from './auth.js';
import { HttpError, h, forbidden, notFound, bad } from './http.js';

export const TOKEN_PREFIX = 'trk_';
const MAX_TOKENS = 20;
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

// ------------------------------------------------------------------ audit

export type AuditCategory = 'spaces' | 'permissions' | 'workflow' | 'fields' | 'automation' | 'webhooks' | 'security' | 'admin' | 'sign-in' | 'releases';

export async function audit(
  db: Db,
  e: { tenantId: number; actorId: number | null; actorName?: string | null; category: AuditCategory; action: string; target?: string | null; ip?: string | null },
) {
  try {
    await db.query(
      `INSERT INTO audit_log (tenant_id, actor_id, actor_name, category, action, target, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [e.tenantId, e.actorId, e.actorName ?? null, e.category, e.action.slice(0, 200), e.target?.slice(0, 200) ?? null, e.ip ?? null],
    );
  } catch (err) {
    console.error('audit write failed', err);
  }
}

/** Successful configuration writes, recognised by route. Order matters: first match wins. */
const RULES: [RegExp, string | null, AuditCategory, string][] = [
  [/^\/api\/project$/, 'POST', 'spaces', 'Created space'],
  [/^\/api\/project\/([^/]+)$/, 'PUT', 'spaces', 'Updated space settings'],
  [/^\/api\/project\/([^/]+)$/, 'DELETE', 'spaces', 'Deleted space'],
  [/^\/api\/project\/([^/]+)\/members(\/[^/]+)?$/, 'POST', 'permissions', 'Added or changed a space member'],
  [/^\/api\/project\/([^/]+)\/members(\/[^/]+)?$/, 'PUT', 'permissions', 'Changed a member’s role'],
  [/^\/api\/project\/([^/]+)\/members(\/[^/]+)?$/, 'DELETE', 'permissions', 'Removed a space member'],
  [/^\/api\/project\/([^/]+)\/(statuses|status|transitions|transition|workflow)/, null, 'workflow', 'Changed the workflow'],
  [/^\/api\/(status|transition)\/\d+/, null, 'workflow', 'Changed the workflow'],
  [/^\/api\/project\/([^/]+)\/fields?/, null, 'fields', 'Changed custom fields'],
  [/^\/api\/field\/\d+/, null, 'fields', 'Changed custom fields'],
  [/^\/api\/project\/([^/]+)\/automation/, null, 'automation', 'Changed automation rules'],
  [/^\/api\/automation\/\d+/, null, 'automation', 'Changed automation rules'],
  [/^\/api\/admin\/scheduler\/run$/, 'POST', 'admin', 'Ran the scheduler'],
  [/^\/api\/version\/\d+\/release$/, 'POST', 'releases', 'Released a version'],
  [/^\/api\/version(\/\d+)?$/, null, 'releases', 'Changed versions'],
  [/^\/api\/component(\/\d+)?$/, null, 'releases', 'Changed components'],
  [/^\/api\/project\/([^/]+)\/security-levels$/, 'POST', 'permissions', 'Created a security level'],
  [/^\/api\/security-level\/\d+$/, null, 'permissions', 'Changed a security level'],
  [/^\/api\/issue\/([^/]+)\/archive$/, 'POST', 'spaces', 'Archived a work item'],
  [/^\/api\/issue\/([^/]+)\/restore$/, 'POST', 'spaces', 'Restored a work item'],
];
const methodVerb: Record<string, string> = { POST: 'created', PUT: 'updated', PATCH: 'updated', DELETE: 'deleted' };

/** Middleware (after auth): writes an audit entry for successful configuration changes. */
export function auditTrail(db: Db) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const path = req.originalUrl.split('?')[0];
    const rule = RULES.find(([re, m]) => re.test(path) && (!m || m === req.method));
    if (!rule) return next();
    res.on('finish', () => {
      const user = req.user;
      if (!user || res.statusCode >= 400) return;
      const [re, m, category, label] = rule;
      const space = re.exec(path)?.[1];
      const target = category === 'spaces' && req.method === 'POST' ? String(req.body?.key ?? '') : space ? decodeURIComponent(space).toUpperCase() : path.replace(/^\/api/, '');
      void audit(db, {
        tenantId: user.tenantId, actorId: user.id, actorName: user.displayName, category,
        action: m ? label : `${label} (${methodVerb[req.method] ?? req.method.toLowerCase()})`, target, ip: req.ip,
      });
    });
    next();
  };
}

// ------------------------------------------------------------------ API tokens

/** Resolve an API token to its (active) user row, or null. Updates last-used at most once a minute. */
export async function userForToken(db: Db, token: string, email?: string) {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 100) return null;
  const [row] = await db.query(
    `SELECT u.*, t.id AS token_id, t.last_used_at FROM api_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now()) AND u.active`,
    [hashToken(token)],
  );
  if (!row || (email !== undefined && row.email !== email.toLowerCase())) return null;
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60_000) {
    await db.query(`UPDATE api_tokens SET last_used_at = now() WHERE id = $1`, [row.token_id]);
  }
  return row;
}

const tokenJson = (t: any) => ({
  id: String(t.id), name: t.name, hint: `${TOKEN_PREFIX}${t.prefix}…`, created: t.created_at, lastUsed: t.last_used_at,
  expires: t.expires_at, revoked: !!t.revoked_at,
});

export function auditRoutes(db: Db) {
  const r = Router();
  const actor = (u: AuthUser, req: Request) => ({ tenantId: u.tenantId, actorId: u.id, actorName: u.displayName, ip: req.ip });

  r.get('/myself/tokens', h(async (req) => {
    const rows = await db.query(`SELECT * FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL ORDER BY id DESC`, [req.user!.id]);
    return rows.map(tokenJson);
  }));

  r.post('/myself/tokens', h(async (req, res) => {
    const user = req.user!;
    if (req.authKind !== 'session') throw new HttpError(403, 'Create API tokens while signed in to the app, not with another token');
    const body = z.object({ name: z.string().trim().min(1).max(80), expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365)]).nullable().default(90) }).parse(req.body ?? {});
    const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL`, [user.id]);
    if (n >= MAX_TOKENS) throw bad(`You can have at most ${MAX_TOKENS} API tokens. Revoke one first.`);
    const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const [t] = await db.query(
      `INSERT INTO api_tokens (user_id, name, token_hash, prefix, expires_at)
       VALUES ($1,$2,$3,$4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + ($5::int || ' days')::interval END) RETURNING *`,
      [user.id, body.name, hashToken(token), token.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 6), body.expiresInDays],
    );
    await audit(db, { ...actor(user, req), category: 'security', action: 'Created an API token', target: body.name });
    res.status(201);
    return { ...tokenJson(t), token }; // the only time the token is shown
  }));

  r.delete('/myself/tokens/:id', h(async (req, res) => {
    const user = req.user!;
    const [t] = await db.query(`UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING *`, [Number(req.params.id), user.id]);
    if (!t) throw notFound('API token');
    await audit(db, { ...actor(user, req), category: 'security', action: 'Revoked an API token', target: t.name });
    res.status(204).end();
    return undefined;
  }));

  r.get('/admin/audit', h(async (req) => {
    const user = req.user!;
    if (!user.isSiteAdmin) throw forbidden('ADMINISTER');
    const q = z.object({
      category: z.string().max(30).optional(), actor: z.string().max(20).optional(),
      startAt: z.coerce.number().int().min(0).default(0), maxResults: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(req.query);
    const where = ['tenant_id = $1'];
    const params: unknown[] = [user.tenantId];
    if (q.category) { params.push(q.category); where.push(`category = $${params.length}`); }
    if (q.actor) { params.push(Number(q.actor)); where.push(`actor_id = $${params.length}`); }
    const [{ total }] = await db.query(`SELECT count(*)::int AS total FROM audit_log WHERE ${where.join(' AND ')}`, params);
    const rows = await db.query(
      `SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${q.maxResults} OFFSET ${q.startAt}`,
      params,
    );
    return {
      total, startAt: q.startAt, maxResults: q.maxResults,
      values: rows.map((a) => ({
        id: String(a.id), created: a.created_at, category: a.category, action: a.action, target: a.target, ip: a.ip,
        actor: a.actor_id ? { accountId: String(a.actor_id), displayName: a.actor_name } : null,
      })),
    };
  }));

  return r;
}
