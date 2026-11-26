/**
 * Outgoing webhooks (Phase 5). Site admins register a URL and pick events; Tracker POSTs a JSON payload
 * (Jira-shaped: webhookEvent, timestamp, user, issue, changelog/comment) whenever one happens.
 *
 * - Signed: `X-Tracker-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>` so receivers can verify origin
 *   and reject replays. Also `X-Tracker-Event` and `X-Tracker-Delivery` (id, for de-duplication).
 * - Reliable: deliveries are rows; sent right after the change and retried with backoff (1, 2, 4, 8, 16, 32 min)
 *   by the scheduler; claimed with SKIP LOCKED so several instances never double-send.
 * - Safe: http(s) only, no redirects, 10 s timeout, and private/loopback/link-local addresses are refused at connect
 *   time (checked on the resolved IP, so DNS tricks don't help) unless WEBHOOK_ALLOW_PRIVATE=1.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from './db.js';
import type { AuthUser } from './auth.js';
import { h, forbidden, notFound, bad } from './http.js';
import { audit } from './audit.js';

export const WEBHOOK_EVENTS = ['issue_created', 'issue_updated', 'issue_deleted', 'comment_created'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
const JIRA_NAME: Record<WebhookEvent, string> = {
  issue_created: 'jira:issue_created', issue_updated: 'jira:issue_updated', issue_deleted: 'jira:issue_deleted', comment_created: 'comment_created',
};
const MAX_ATTEMPTS = 7;
const TIMEOUT_MS = 10_000;

export const allowPrivate = () => process.env.WEBHOOK_ALLOW_PRIVATE === '1' || process.env.WEBHOOK_ALLOW_PRIVATE === 'true';

/** Loopback, private, link-local (incl. cloud metadata 169.254.169.254), CGNAT, unique-local, unspecified, multicast. */
export function isPrivateAddress(ip: string) {
  const v = ip.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(v) === 4) {
    const [a, b] = v.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') ||
    v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

/** dns.lookup wrapper used at connect time: refuses private targets. */
function safeLookup(hostname: string, options: any, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) {
  dnsLookup(hostname, { ...options, all: true }, (err, addrs: LookupAddress[]) => {
    if (err) return cb(err, '', 0);
    if (!allowPrivate() && addrs.some((a) => isPrivateAddress(a.address))) {
      const e: NodeJS.ErrnoException = new Error(`Refusing to send to a private address (${hostname})`);
      e.code = 'EPRIVATE';
      return cb(e, '', 0);
    }
    if (options?.all) return cb(null, addrs);
    return cb(null, addrs[0].address, addrs[0].family);
  });
}

export function checkUrl(raw: string) {
  let u: URL;
  try { u = new URL(raw); } catch { throw bad('Enter a full URL, e.g. https://example.com/hooks/tracker'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad('Webhook URLs must use http or https');
  if (u.username || u.password) throw bad('Put credentials in the receiver, not in the URL');
  if (!allowPrivate() && (u.hostname === 'localhost' || (isIP(u.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(u.hostname.replace(/^\[|\]$/g, ''))))) {
    throw bad('Webhook URLs can’t point to private or local addresses');
  }
  return u.toString();
}

export const sign = (secret: string, t: number, body: string) => createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

/** POST one payload. Resolves with the HTTP status; rejects on network/policy errors. */
function post(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    // Node doesn't call `lookup` for IP literals, so check those here (hostnames are checked on the resolved IP)
    const literal = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate() && (u.hostname === 'localhost' || (isIP(literal) && isPrivateAddress(literal)))) {
      reject(new Error(`Refusing to send to a private address (${u.hostname})`));
      return;
    }
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, {
      method: 'POST', lookup: safeLookup as any, timeout: TIMEOUT_MS,
      headers: { 'content-type': 'application/json', 'user-agent': 'Tracker-Webhooks/1', 'content-length': Buffer.byteLength(body), ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (text.length < 500) text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: text.slice(0, 500) }));
    });
    req.on('timeout', () => req.destroy(new Error('Timed out after 10 s')));
    req.on('error', reject);
    req.end(body);
  });
}

// ------------------------------------------------------------------ queueing

/** Snapshot of a work item for payloads (read after commit). */
async function issueSnapshot(db: Db, issueId: number) {
  const [r] = await db.query(
    `SELECT i.id, i.key, i.summary, i.project_id, i.tenant_id, i.updated_at, i.created_at, p.key AS pkey, p.name AS pname,
            s.name AS sname, s.category AS scat, t.name AS tname, pr.name AS prname, a.id AS aid, a.display_name AS aname
     FROM issues i JOIN projects p ON p.id = i.project_id JOIN statuses s ON s.id = i.status_id JOIN issue_types t ON t.id = i.type_id
     LEFT JOIN priorities pr ON pr.id = i.priority_id LEFT JOIN users a ON a.id = i.assignee_id WHERE i.id = $1`,
    [issueId],
  );
  if (!r) return null;
  return {
    tenantId: r.tenant_id as number, projectId: r.project_id as number,
    issue: {
      id: String(r.id), key: r.key,
      fields: {
        summary: r.summary, project: { key: r.pkey, name: r.pname }, issuetype: { name: r.tname },
        status: { name: r.sname, statusCategory: { key: r.scat } }, priority: r.prname ? { name: r.prname } : null,
        assignee: r.aid ? { accountId: String(r.aid), displayName: r.aname } : null, created: r.created_at, updated: r.updated_at,
      },
    },
  };
}

let kick: NodeJS.Timeout | null = null;
const deliverSoon = (db: Db) => {
  if (kick) return;
  kick = setTimeout(() => { kick = null; deliverWebhooks(db).catch((e) => console.error('webhook delivery failed', e)); }, 100);
  kick.unref?.();
};

/**
 * Called after a change committed. Never throws (a webhook problem must not fail the user's change).
 * `snapshot` is passed for deletes (the row is already gone).
 */
export async function emitWebhook(
  db: Db, event: WebhookEvent, actor: AuthUser,
  opts: { issueId?: number; snapshot?: Awaited<ReturnType<typeof issueSnapshot>>; changelog?: { field: string; afterId: number }; comment?: { id: string; text: string } },
) {
  try {
    const snap = opts.snapshot ?? (opts.issueId ? await issueSnapshot(db, opts.issueId) : null);
    if (!snap) return;
    const hooks = await db.query(
      `SELECT * FROM webhooks WHERE tenant_id = $1 AND enabled AND $2 = ANY(events) AND (project_id IS NULL OR project_id = $3)`,
      [snap.tenantId, event, snap.projectId],
    );
    if (!hooks.length) return;
    let changelog: any;
    if (opts.changelog && opts.issueId) {
      const items = await db.query(
        `SELECT field, from_string, to_string FROM changelog WHERE issue_id = $1 AND actor_id = $2 AND field = $3 AND id > $4 ORDER BY id DESC LIMIT 1`,
        [opts.issueId, actor.id, opts.changelog.field, opts.changelog.afterId],
      );
      changelog = { items: items.map((c) => ({ field: c.field, fromString: c.from_string, toString: c.to_string })) };
      if (!items.length) return; // nothing actually changed
    }
    const payload = {
      webhookEvent: JIRA_NAME[event], event, timestamp: Date.now(),
      user: { accountId: String(actor.id), displayName: actor.displayName },
      issue: snap.issue,
      ...(changelog ? { changelog } : {}),
      ...(opts.comment ? { comment: { id: opts.comment.id, body: opts.comment.text.slice(0, 2000) } } : {}),
    };
    for (const hook of hooks) {
      await db.query(`INSERT INTO webhook_deliveries (webhook_id, event, payload) VALUES ($1,$2,$3::jsonb)`, [hook.id, event, JSON.stringify(payload)]);
    }
    deliverSoon(db);
  } catch (e) {
    console.error('webhook queue failed', e);
  }
}
export { issueSnapshot };

/** Send due deliveries (fresh ones and retries). Safe to run on several instances at once. */
export async function deliverWebhooks(db: Db, now = new Date()) {
  // crashed mid-send long ago → back in the queue
  await db.query(`UPDATE webhook_deliveries SET status = 'queued' WHERE status = 'sending' AND claimed_at < $1`, [new Date(now.getTime() - 5 * 60_000).toISOString()]);
  const due = await db.query(
    `UPDATE webhook_deliveries SET status = 'sending', attempts = attempts + 1, claimed_at = $1
     WHERE id IN (SELECT id FROM webhook_deliveries WHERE status = 'queued' AND next_try_at <= $1 ORDER BY id LIMIT 25 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [now.toISOString()],
  );
  let sent = 0, failed = 0;
  for (const d of due) {
    const [hook] = await db.query(`SELECT * FROM webhooks WHERE id = $1`, [d.webhook_id]);
    if (!hook) continue;
    const body = JSON.stringify(d.payload);
    const t = Math.floor(Date.now() / 1000);
    let status = 0, text = '', error: string | null = null;
    try {
      ({ status, text } = await post(hook.url, {
        'x-tracker-event': d.event, 'x-tracker-delivery': String(d.id), 'x-tracker-signature': `t=${t},v1=${sign(hook.secret, t, body)}`,
      }, body));
      if (status < 200 || status >= 300) error = `HTTP ${status}`;
    } catch (e: any) {
      error = String(e?.message ?? e).slice(0, 300);
    }
    if (!error) {
      sent++;
      await db.query(`UPDATE webhook_deliveries SET status = 'success', response_status = $2, response_text = $3, error = NULL, delivered_at = now() WHERE id = $1`, [d.id, status, text]);
    } else {
      failed++;
      const done = d.attempts >= MAX_ATTEMPTS || status === 410; // 410 Gone: receiver asked us to stop
      await db.query(
        `UPDATE webhook_deliveries SET status = $2, response_status = $3, response_text = $4, error = $5,
           next_try_at = $6 WHERE id = $1`,
        [d.id, done ? 'failed' : 'queued', status || null, text, error, new Date(now.getTime() + 2 ** (d.attempts - 1) * 60_000).toISOString()],
      );
    }
  }
  return { sent, failed };
}

// ------------------------------------------------------------------ admin API

const Input = z.object({
  name: z.string().trim().min(1).max(80),
  url: z.string().trim().max(2000),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
  projectKey: z.string().trim().max(20).nullish(),
  enabled: z.boolean().default(true),
});
const hookJson = (w: any, stats?: any) => ({
  id: String(w.id), name: w.name, url: w.url, events: w.events, enabled: w.enabled, project: w.pkey ? { key: w.pkey } : null,
  created: w.created_at, secretHint: `${String(w.secret).slice(0, 10)}…`,
  stats: stats ? { success: stats.success, failed: stats.failed, pending: stats.pending, last: stats.last } : undefined,
});

export function webhookRoutes(db: Db) {
  const r = Router();
  const admin = (u: AuthUser) => { if (!u.isSiteAdmin) throw forbidden('ADMINISTER'); };
  const load = async (u: AuthUser, id: string) => {
    const [w] = await db.query(`SELECT w.*, p.key AS pkey FROM webhooks w LEFT JOIN projects p ON p.id = w.project_id WHERE w.id = $1 AND w.tenant_id = $2`, [Number(id), u.tenantId]);
    if (!w) throw notFound('Webhook');
    return w;
  };
  const projectId = async (u: AuthUser, key?: string | null) => {
    if (!key) return null;
    const [p] = await db.query(`SELECT id FROM projects WHERE tenant_id = $1 AND upper(key) = upper($2)`, [u.tenantId, key]);
    if (!p) throw bad(`No space with key ${key}`);
    return p.id;
  };
  const log = (u: AuthUser, ip: string | undefined, action: string, target: string) =>
    audit(db, { tenantId: u.tenantId, actorId: u.id, actorName: u.displayName, category: 'webhooks', action, target, ip });

  r.get('/webhooks', h(async (req) => {
    admin(req.user!);
    const rows = await db.query(
      `SELECT w.*, p.key AS pkey,
         (SELECT count(*)::int FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'success') AS success,
         (SELECT count(*)::int FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'failed') AS failed,
         (SELECT count(*)::int FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status IN ('queued','sending')) AS pending,
         (SELECT max(created_at) FROM webhook_deliveries d WHERE d.webhook_id = w.id) AS last
       FROM webhooks w LEFT JOIN projects p ON p.id = w.project_id WHERE w.tenant_id = $1 ORDER BY w.id`,
      [req.user!.tenantId],
    );
    return { events: WEBHOOK_EVENTS, webhooks: rows.map((w) => hookJson(w, w)) };
  }));

  r.post('/webhooks', h(async (req, res) => {
    const u = req.user!;
    admin(u);
    const body = Input.parse(req.body ?? {});
    const url = checkUrl(body.url);
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const [w] = await db.query(
      `INSERT INTO webhooks (tenant_id, name, url, events, project_id, enabled, secret, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [u.tenantId, body.name, url, body.events, await projectId(u, body.projectKey), body.enabled, secret, u.id],
    );
    await log(u, req.ip, 'Created a webhook', body.name);
    res.status(201);
    return { ...hookJson({ ...w, pkey: body.projectKey?.toUpperCase() }), secret }; // secret shown in full only now (and on rotate)
  }));

  r.put('/webhook/:id', h(async (req) => {
    const u = req.user!;
    admin(u);
    const w = await load(u, String(req.params.id));
    const body = Input.partial().parse(req.body ?? {});
    const url = body.url !== undefined ? checkUrl(body.url) : w.url;
    const pid = body.projectKey !== undefined ? await projectId(u, body.projectKey) : w.project_id;
    await db.query(`UPDATE webhooks SET name = $2, url = $3, events = $4, project_id = $5, enabled = $6 WHERE id = $1`, [
      w.id, body.name ?? w.name, url, body.events ?? w.events, pid, body.enabled ?? w.enabled,
    ]);
    await log(u, req.ip, body.enabled === false ? 'Turned off a webhook' : body.enabled === true && !w.enabled ? 'Turned on a webhook' : 'Updated a webhook', body.name ?? w.name);
    return hookJson(await load(u, String(w.id)));
  }));

  r.post('/webhook/:id/secret', h(async (req) => {
    const u = req.user!;
    admin(u);
    const w = await load(u, String(req.params.id));
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    await db.query(`UPDATE webhooks SET secret = $2 WHERE id = $1`, [w.id, secret]);
    await log(u, req.ip, 'Rotated a webhook secret', w.name);
    return { secret };
  }));

  r.delete('/webhook/:id', h(async (req, res) => {
    const u = req.user!;
    admin(u);
    const w = await load(u, String(req.params.id));
    await db.query(`DELETE FROM webhooks WHERE id = $1`, [w.id]);
    await log(u, req.ip, 'Deleted a webhook', w.name);
    res.status(204).end();
    return undefined;
  }));

  r.get('/webhook/:id/deliveries', h(async (req) => {
    const u = req.user!;
    admin(u);
    const w = await load(u, String(req.params.id));
    const rows = await db.query(`SELECT * FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY id DESC LIMIT 50`, [w.id]);
    return rows.map((d) => ({
      id: String(d.id), event: d.event, status: d.status, attempts: d.attempts, responseStatus: d.response_status,
      error: d.error, created: d.created_at, delivered: d.delivered_at, nextTry: d.status === 'queued' ? d.next_try_at : null,
      issueKey: d.payload?.issue?.key ?? null,
    }));
  }));

  /** Send a sample payload now (doesn't wait for the scheduler). */
  r.post('/webhook/:id/test', h(async (req) => {
    const u = req.user!;
    admin(u);
    const w = await load(u, String(req.params.id));
    const payload = { webhookEvent: 'tracker:ping', event: 'ping', timestamp: Date.now(), user: { accountId: String(u.id), displayName: u.displayName }, webhook: { id: String(w.id), name: w.name } };
    const [d] = await db.query(`INSERT INTO webhook_deliveries (webhook_id, event, payload) VALUES ($1,'ping',$2::jsonb) RETURNING id`, [w.id, JSON.stringify(payload)]);
    await deliverWebhooks(db);
    await db.query(`UPDATE webhook_deliveries SET status = 'failed' WHERE id = $1 AND status = 'queued'`, [d.id]); // test pings aren't retried
    const [res] = await db.query(`SELECT status, response_status, error FROM webhook_deliveries WHERE id = $1`, [d.id]);
    return { ok: res.status === 'success', status: res.status, responseStatus: res.response_status, error: res.error };
  }));

  return r;
}
