/**
 * Real-time updates (Phase 4) over Server-Sent Events.
 *
 * - One stream per browser tab: GET /api/events, authenticated with the normal Authorization header
 *   (the client reads it with fetch streaming, so the token never goes in a URL or server log).
 * - Events are scoped: "change" events reach only people who can browse that space; "notification"
 *   pings reach only their recipient. Nothing else is sent — clients refetch through the normal,
 *   permission-checked API, so the stream never carries issue content.
 * - Change events are published only after a write request has finished successfully (status < 400),
 *   i.e. after its transaction committed, so a failed or rolled-back change never triggers refreshes.
 */
import type { Request, Response, NextFunction } from 'express';
import type { Db } from './db.js';
import type { AuthUser } from './auth.js';

export interface ChangeEvent { type: 'change'; projectKey: string; keys: string[]; actor: string; scope: 'issue' | 'space' }
type Sub = { id: number; user: AuthUser; res: Response; projects: Set<number>; refreshed: number };

const HEARTBEAT_MS = 25_000;
const MEMBERSHIP_TTL_MS = 30_000;
const MAX_STREAMS_PER_USER = 8;

export class Hub {
  private subs = new Map<number, Sub>();
  private seq = 0;
  private timer: NodeJS.Timeout;
  constructor(private db: Db) {
    this.timer = setInterval(() => this.broadcastRaw(': ping\n\n'), HEARTBEAT_MS);
    this.timer.unref?.();
  }

  get size() { return this.subs.size; }

  private async membership(sub: Sub) {
    if (Date.now() - sub.refreshed < MEMBERSHIP_TTL_MS) return;
    const rows = await this.db.query(
      sub.user.isSiteAdmin
        ? `SELECT id FROM projects WHERE tenant_id = $1`
        : `SELECT p.id FROM projects p JOIN project_members pm ON pm.project_id = p.id WHERE p.tenant_id = $1 AND pm.user_id = $2`,
      sub.user.isSiteAdmin ? [sub.user.tenantId] : [sub.user.tenantId, sub.user.id],
    );
    sub.projects = new Set(rows.map((r) => r.id));
    sub.refreshed = Date.now();
  }

  /** Express handler for GET /api/events (auth middleware already ran). */
  open = async (req: Request, res: Response) => {
    const user = req.user!;
    const mine = [...this.subs.values()].filter((s) => s.user.id === user.id);
    if (mine.length >= MAX_STREAMS_PER_USER) mine[0].res.end(); // drop the oldest tab instead of refusing
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const sub: Sub = { id: ++this.seq, user, res, projects: new Set(), refreshed: 0 };
    await this.membership(sub);
    this.subs.set(sub.id, sub);
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ connection: sub.id })}\n\n`);
    req.on('close', () => this.subs.delete(sub.id));
  };

  private write(sub: Sub, event: string, data: unknown) {
    try { sub.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { this.subs.delete(sub.id); }
  }
  private broadcastRaw(text: string) {
    for (const s of this.subs.values()) { try { s.res.write(text); } catch { this.subs.delete(s.id); } }
  }

  /** Tell everyone who can browse the space that something in it changed. */
  async publishChange(tenantId: number, projectId: number, ev: ChangeEvent) {
    for (const s of this.subs.values()) {
      if (s.user.tenantId !== tenantId) continue;
      await this.membership(s);
      if (s.projects.has(projectId)) this.write(s, 'change', ev);
    }
  }

  /** Ping one person's open tabs that they have new notifications. */
  pingUser(userId: number) {
    for (const s of this.subs.values()) if (s.user.id === userId) this.write(s, 'notification', {});
  }

  /** Membership changed (added to a space): refresh on next event. */
  invalidate(userId?: number) {
    for (const s of this.subs.values()) if (!userId || s.user.id === userId) s.refreshed = 0;
  }

  close() {
    clearInterval(this.timer);
    for (const s of this.subs.values()) { try { s.res.end(); } catch { /* gone */ } }
    this.subs.clear();
  }
}

// ------------------------------------------------------------------ notification pings
// notify() runs inside request transactions; ping shortly after so the recipient's refetch sees committed rows.
let current: Hub | null = null;
export const setHub = (h: Hub | null) => { current = h; };
export function pingLater(userIds: number[]) {
  if (!current || !userIds.length) return;
  const hub = current;
  setTimeout(() => userIds.forEach((id) => hub.pingUser(id)), 150);
}

// ------------------------------------------------------------------ change tracking

const KEY = /\/api\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/|$)/;
const PROJECT = /\/api\/project\/([A-Za-z][A-Za-z0-9]*)(?:\/|$)/;

/**
 * After a successful write, work out which space (and work items) it touched and publish one event per space.
 * Covers every mutating route generically, so new endpoints don't need wiring.
 */
export function changeTracker(db: Db, hub: Hub) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const path = req.originalUrl.split('?')[0];
    if (/\/api\/(auth|notifications|filter|dashboard|events)\b/.test(path)) return next();
    // deletes: resolve what's affected *before* the rows disappear
    const pre = req.method === 'DELETE' && req.user ? resolveTargets(db, req.user, path, req.body).catch(() => []) : null;
    res.on('finish', () => {
      const user = req.user;
      if (!user || res.statusCode >= 400) return;
      (pre ?? resolveTargets(db, user, path, req.body)).then(async (targets) => {
        if (/\/project\/[^/]+\/members$/.test(path)) hub.invalidate();
        for (const t of targets) {
          await hub.publishChange(user.tenantId, t.projectId, {
            type: 'change', projectKey: t.projectKey, keys: [...t.keys], actor: String(user.id), scope: t.keys.size ? 'issue' : 'space',
          });
        }
      }).catch((e) => console.error('realtime publish failed', e));
    });
    next();
  };
}

type Target = { projectId: number; projectKey: string; keys: Set<string> };

async function resolveTargets(db: Db, user: AuthUser, path: string, body: any): Promise<Target[]> {
  const byProject = new Map<number, Target>();
  const addIssues = async (keys: string[]) => {
    if (!keys.length) return;
    const rows = await db.query(
      `SELECT i.key, p.id, p.key AS pkey FROM issues i JOIN projects p ON p.id = i.project_id WHERE i.tenant_id = $1 AND upper(i.key) = ANY($2::text[])`,
      [user.tenantId, keys.map((k) => k.toUpperCase())],
    );
    for (const r of rows) {
      const t = byProject.get(r.id) ?? { projectId: r.id, projectKey: r.pkey, keys: new Set<string>() };
      t.keys.add(r.key);
      byProject.set(r.id, t);
    }
    // deleted work items no longer resolve: still tell their space (key prefix)
    for (const k of keys) {
      if (rows.some((r) => r.key.toUpperCase() === k.toUpperCase())) continue;
      await addProject(k.split('-')[0], k.toUpperCase());
    }
  };
  const addProject = async (pkey: string, key?: string) => {
    const [p] = await db.query(`SELECT id, key FROM projects WHERE tenant_id = $1 AND upper(key) = upper($2)`, [user.tenantId, pkey]);
    if (!p) return;
    const t = byProject.get(p.id) ?? { projectId: p.id, projectKey: p.key, keys: new Set<string>() };
    if (key) t.keys.add(key);
    byProject.set(p.id, t);
  };
  const addProjectId = async (sql: string, id: unknown) => {
    const [p] = await db.query(sql, [Number(id)]);
    if (p) await addProject(p.key);
  };

  const m = KEY.exec(path);
  if (m) await addIssues([m[1]]);
  const pm = PROJECT.exec(path);
  if (pm) await addProject(pm[1]);
  if (/\/api\/issue$/.test(path)) {
    // create: the response doesn't pass through here, so announce the space
    const k = body?.fields?.project?.key;
    if (k) await addProject(String(k));
    else if (body?.fields?.project?.id) await addProjectId(`SELECT key FROM projects WHERE id = $1`, body.fields.project.id);
  }
  if (/\/api\/bulk$/.test(path) && Array.isArray(body?.keys)) await addIssues(body.keys.map(String));
  if (/\/api\/issueLink$/.test(path)) await addIssues([body?.outwardIssue?.key, body?.inwardIssue?.key].filter(Boolean));
  const id = /\/api\/(sprint|status|transition|field|automation|attachment|issueLink)\/(\d+)/.exec(path);
  if (id) {
    const sql: Record<string, string> = {
      sprint: `SELECT p.key FROM sprints s JOIN projects p ON p.id = s.project_id WHERE s.id = $1`,
      status: `SELECT p.key FROM statuses s JOIN projects p ON p.id = s.project_id WHERE s.id = $1`,
      transition: `SELECT p.key FROM transitions t JOIN projects p ON p.id = t.project_id WHERE t.id = $1`,
      field: `SELECT p.key FROM custom_fields f JOIN projects p ON p.id = f.project_id WHERE f.id = $1`,
      automation: `SELECT p.key FROM automation_rules a JOIN projects p ON p.id = a.project_id WHERE a.id = $1`,
      attachment: `SELECT p.key FROM attachments a JOIN issues i ON i.id = a.issue_id JOIN projects p ON p.id = i.project_id WHERE a.id = $1`,
      issueLink: `SELECT NULL AS key WHERE false`,
    };
    await addProjectId(sql[id[1]], id[2]);
  }
  return [...byProject.values()];
}
