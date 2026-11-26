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
 * - Several server instances: every event also goes out on Postgres NOTIFY (channel `tracker_events`) and each
 *   instance LISTENs, so a change made through one instance reaches browsers connected to any other. An instance
 *   delivers its own events directly and ignores their echo; big events are split to stay under NOTIFY's 8 KB
 *   payload limit. If the listener connection drops, it reconnects and tells connected browsers to refresh.
 */
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Db } from './db.js';
import type { AuthUser } from './auth.js';

export interface ChangeEvent { type: 'change'; projectKey: string; keys: string[]; actor: string; scope: 'issue' | 'space' }
type Sub = { id: number; user: AuthUser; res: Response; projects: Set<number>; refreshed: number };

const HEARTBEAT_MS = 25_000;
const MEMBERSHIP_TTL_MS = 30_000;
const MAX_STREAMS_PER_USER = 8;
export const BUS_CHANNEL = 'tracker_events';
const KEYS_PER_MESSAGE = 100; // keeps each NOTIFY payload well under 8000 bytes
const IDS_PER_MESSAGE = 200;

type BusMessage =
  | { i: string; k: 'change'; tenantId: number; projectId: number; ev: ChangeEvent }
  | { i: string; k: 'ping'; users: number[] }
  | { i: string; k: 'inv'; userId?: number };

const chunk = <T,>(a: T[], n: number): T[][] =>
  a.length ? Array.from({ length: Math.ceil(a.length / n) }, (_, j) => a.slice(j * n, (j + 1) * n)) : [a];

// Any open hub will do for pings: they reach other instances (and other hubs in this process) through the bus.
const hubs = new Set<Hub>();

export class Hub {
  private subs = new Map<number, Sub>();
  private seq = 0;
  private timer: NodeJS.Timeout;
  private unlisten: (() => Promise<void>) | null = null;
  private closed = false;
  readonly instanceId = randomUUID();
  /** Resolves once this instance listens on the bus (or immediately if the database has no LISTEN). */
  readonly ready: Promise<void>;
  constructor(private db: Db) {
    this.timer = setInterval(() => this.broadcastRaw(': ping\n\n'), HEARTBEAT_MS);
    this.timer.unref?.();
    hubs.add(this);
    this.ready = (async () => {
      if (!db.listen) return;
      try {
        const off = await db.listen(BUS_CHANNEL, (p) => this.onBus(p), () => this.resync());
        if (this.closed) await off(); else this.unlisten = off;
      } catch (e) {
        console.error('realtime: could not LISTEN; live updates stay on this instance only', e);
      }
    })();
  }

  // ---- bus: events from other instances
  private onBus(payload: string) {
    let m: BusMessage;
    try { m = JSON.parse(payload); } catch { return; }
    if (!m || m.i === this.instanceId) return; // our own echo: already delivered locally
    if (m.k === 'change') this.deliverChange(m.tenantId, m.projectId, m.ev).catch((e) => console.error('realtime deliver failed', e));
    else if (m.k === 'ping') m.users.forEach((u) => this.deliverPing(u));
    else if (m.k === 'inv') this.deliverInvalidate(m.userId);
  }
  private async send(m: { k: 'change'; tenantId: number; projectId: number; ev: ChangeEvent } | { k: 'ping'; users: number[] } | { k: 'inv'; userId?: number }) {
    if (!this.db.listen || this.closed) return;
    try {
      await this.db.query('SELECT pg_notify($1, $2)', [BUS_CHANNEL, JSON.stringify({ ...m, i: this.instanceId })]);
    } catch (e) {
      console.error('realtime: NOTIFY failed', e);
    }
  }
  /** After a listener gap anything may have changed, so connected browsers refetch. */
  private resync() {
    for (const s of this.subs.values()) { s.refreshed = 0; this.write(s, 'resync', {}); }
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

  /** Tell everyone who can browse the space that something in it changed (on every instance). */
  async publishChange(tenantId: number, projectId: number, ev: ChangeEvent) {
    await this.deliverChange(tenantId, projectId, ev);
    for (const keys of chunk(ev.keys, KEYS_PER_MESSAGE)) await this.send({ k: 'change', tenantId, projectId, ev: { ...ev, keys } });
  }
  private async deliverChange(tenantId: number, projectId: number, ev: ChangeEvent) {
    for (const s of this.subs.values()) {
      if (s.user.tenantId !== tenantId) continue;
      await this.membership(s);
      if (s.projects.has(projectId)) this.write(s, 'change', ev);
    }
  }

  /** Ping these people's open tabs (on every instance) that they have new notifications. */
  pingUsers(userIds: number[]) {
    userIds.forEach((u) => this.deliverPing(u));
    for (const users of chunk(userIds, IDS_PER_MESSAGE)) if (users.length) void this.send({ k: 'ping', users });
  }
  pingUser(userId: number) { this.pingUsers([userId]); }
  private deliverPing(userId: number) {
    for (const s of this.subs.values()) if (s.user.id === userId) this.write(s, 'notification', {});
  }

  /** Membership changed (added to a space): refresh on next event, on every instance. */
  invalidate(userId?: number) {
    this.deliverInvalidate(userId);
    void this.send({ k: 'inv', userId });
  }
  private deliverInvalidate(userId?: number) {
    for (const s of this.subs.values()) if (!userId || s.user.id === userId) s.refreshed = 0;
  }

  close() {
    this.closed = true;
    hubs.delete(this);
    void this.unlisten?.();
    clearInterval(this.timer);
    for (const s of this.subs.values()) { try { s.res.end(); } catch { /* gone */ } }
    this.subs.clear();
  }
}

// ------------------------------------------------------------------ notification pings
// notify() runs inside request transactions; ping shortly after so the recipient's refetch sees committed rows.
/** Kept for compatibility: hubs register themselves when created and unregister on close. */
export const setHub = (_h: Hub | null) => {};
export function pingLater(userIds: number[]) {
  if (!userIds.length) return;
  setTimeout(() => {
    const hub = hubs.values().next().value as Hub | undefined;
    hub?.pingUsers(userIds);
  }, 150);
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
