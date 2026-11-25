/**
 * In-app notifications (Phase 3). Jira splits them into "Direct" (assigned to you, @mentioned) and "Watching"
 * (comments and status changes on work you watch). Rules:
 *   - the person who made the change is never notified;
 *   - recipients must still be able to browse the work item (project member or site admin);
 *   - one notification per person per event (a mention outranks a "commented" for the same comment).
 * Email delivery is a later phase; the rows here are what an email worker would send.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from './db.js';
import { h } from './http.js';
import { userRef } from './access.js';
import type { AdfNode } from './adf.js';
import { pingLater } from './realtime.js';

export type Kind = 'assigned' | 'mentioned' | 'commented' | 'status';
export const DIRECT: Kind[] = ['assigned', 'mentioned'];

export async function notify(
  q: Db,
  ev: { actorId: number; issueId: number; kind: Kind; recipients: Iterable<number>; data?: Record<string, unknown> },
) {
  const ids = [...new Set(ev.recipients)].filter((id) => id !== ev.actorId);
  if (!ids.length) return [];
  const rows = await q.query(
    `INSERT INTO notifications (tenant_id, user_id, actor_id, issue_id, kind, data)
     SELECT i.tenant_id, u.id, $2, i.id, $3, $4::jsonb
     FROM issues i JOIN users u ON u.tenant_id = i.tenant_id AND u.active
     WHERE i.id = $1 AND u.id = ANY($5::int[])
       AND (u.is_site_admin OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = i.project_id AND pm.user_id = u.id))
     RETURNING user_id`,
    [ev.issueId, ev.actorId, ev.kind, JSON.stringify(ev.data ?? {}), ids],
  );
  const recipients = rows.map((r) => r.user_id as number);
  pingLater(recipients); // live bell update
  return recipients;
}

export const watchersOf = async (q: Db, issueId: number) =>
  (await q.query(`SELECT user_id FROM watchers WHERE issue_id = $1`, [issueId])).map((r) => r.user_id as number);

export const watch = (q: Db, issueId: number, userId: number) =>
  q.query(`INSERT INTO watchers (issue_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [issueId, userId]);

/** Account ids mentioned in an ADF document (mention nodes carry attrs.id). */
export function mentionedIds(doc: AdfNode | null | undefined): number[] {
  const out: number[] = [];
  const walk = (n: AdfNode) => {
    if (n.type === 'mention' && /^\d+$/.test(String(n.attrs?.id ?? ''))) out.push(Number(n.attrs!.id));
    n.content?.forEach(walk);
  };
  if (doc) walk(doc);
  return [...new Set(out)];
}

/**
 * Turn plain "@Display Name" text into ADF mention nodes for people who can see the work item.
 * Longest names match first so "@Dana Dev" wins over a user called "Dana".
 */
export async function linkMentions(q: Db, projectId: number, doc: AdfNode | null): Promise<AdfNode | null> {
  if (!doc) return doc;
  const people = (
    await q.query(
      `SELECT u.id, u.display_name FROM users u
       WHERE u.active AND (u.is_site_admin OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = $1 AND pm.user_id = u.id))`,
      [projectId],
    )
  ).sort((a, b) => b.display_name.length - a.display_name.length);
  if (!people.length) return doc;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`@(${people.map((p) => esc(p.display_name)).join('|')})(?![\\w])`, 'gi');
  const walk = (n: AdfNode): AdfNode[] => {
    if (n.type === 'text' && n.text && !n.marks?.some((m) => m.type === 'code')) {
      const parts: AdfNode[] = [];
      let last = 0;
      for (const m of n.text.matchAll(re)) {
        const p = people.find((x) => x.display_name.toLowerCase() === m[1].toLowerCase())!;
        if (m.index! > last) parts.push({ ...n, text: n.text.slice(last, m.index) });
        parts.push({ type: 'mention', attrs: { id: String(p.id), text: `@${p.display_name}` } });
        last = m.index! + m[0].length;
      }
      if (!parts.length) return [n];
      if (last < n.text.length) parts.push({ ...n, text: n.text.slice(last) });
      return parts;
    }
    return [{ ...n, ...(n.content ? { content: n.content.flatMap(walk) } : {}) }];
  };
  return walk(doc)[0];
}

const excerpt = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export { excerpt };

export function notificationRoutes(db: Db) {
  const r = Router();

  /** tab: direct | watching | all ; unread=true limits to unread */
  r.get(
    '/notifications',
    h(async (req) => {
      const user = req.user!;
      const tab = String(req.query.tab ?? 'all');
      const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 30) || 30));
      const params: unknown[] = [user.id];
      let where = 'n.user_id = $1';
      if (tab === 'direct') where += ` AND n.kind IN ('assigned','mentioned')`;
      if (tab === 'watching') where += ` AND n.kind IN ('commented','status')`;
      if (req.query.unread === 'true') where += ' AND n.read_at IS NULL';
      const rows = await db.query(
        `SELECT n.*, a.display_name AS actor_name, a.avatar_color AS actor_color, i.key, i.summary
         FROM notifications n JOIN users a ON a.id = n.actor_id JOIN issues i ON i.id = n.issue_id
         WHERE ${where} ORDER BY n.created_at DESC, n.id DESC LIMIT ${limit}`,
        params,
      );
      const [counts] = await db.query(
        `SELECT count(*) FILTER (WHERE read_at IS NULL)::int AS unread,
                count(*) FILTER (WHERE read_at IS NULL AND kind IN ('assigned','mentioned'))::int AS direct,
                count(*) FILTER (WHERE read_at IS NULL AND kind IN ('commented','status'))::int AS watching
         FROM notifications WHERE user_id = $1`,
        [user.id],
      );
      return {
        unread: counts,
        items: rows.map((n) => ({
          id: String(n.id), kind: n.kind, data: n.data, read: !!n.read_at, created: n.created_at,
          actor: userRef(n.actor_id, n.actor_name, null, n.actor_color),
          issue: { key: n.key, summary: n.summary },
        })),
      };
    }),
  );

  /** Mark read: {ids:[…]} or {all:true[, tab]} */
  r.post(
    '/notifications/read',
    h(async (req) => {
      const user = req.user!;
      const body = z.object({ ids: z.array(z.union([z.string(), z.number()])).optional(), all: z.boolean().optional(), tab: z.enum(['direct', 'watching', 'all']).optional() }).parse(req.body ?? {});
      if (body.all) {
        const kinds = body.tab === 'direct' ? ['assigned', 'mentioned'] : body.tab === 'watching' ? ['commented', 'status'] : ['assigned', 'mentioned', 'commented', 'status'];
        await db.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND kind = ANY($2::text[])`, [user.id, kinds]);
      } else if (body.ids?.length) {
        await db.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND id = ANY($2::int[])`, [user.id, body.ids.map(Number)]);
      }
      return { ok: true };
    }),
  );

  return r;
}
