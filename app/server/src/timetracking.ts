/**
 * Time tracking (Phase 5), Jira semantics.
 * - Durations are written like "1w 2d 3h 30m" (1d = 8h, 1w = 5d — Jira's defaults) and stored as seconds.
 * - Original estimate and remaining estimate live on the work item; time spent is the sum of its work log.
 *   Setting an original estimate when there's no remaining estimate sets remaining too (Jira does the same).
 * - Logging work adjusts the remaining estimate: auto (reduce by time spent, not below 0), leave, new (set it),
 *   manual (reduce by a given amount). Deleting a log can add its time back (auto) or not.
 * - Every change writes History (timeoriginalestimate / timeestimate / timespent), like Jira.
 * Permissions: log work = WORK_ON_ISSUES; edit/delete own vs all logs; estimates need EDIT_ISSUES.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from './db.js';
import type { AuthUser } from './auth.js';
import { h, bad, notFound, forbidden } from './http.js';
import { can } from './permissions.js';
import { userRef } from './access.js';
import { assertNotArchived } from './votes.js';

export const HOURS_PER_DAY = 8;
export const DAYS_PER_WEEK = 5;
const UNIT: Record<string, number> = { w: DAYS_PER_WEEK * HOURS_PER_DAY * 3600, d: HOURS_PER_DAY * 3600, h: 3600, m: 60 };
const MAX = 52 * UNIT.w;

/** "1w 2d 3h 30m", "1.5h", "90m", "2h30m" → seconds. Plain numbers are minutes (as in Jira). Throws on nonsense. */
export function parseDuration(input: unknown, opts: { allowZero?: boolean } = {}): number {
  if (typeof input === 'number' && Number.isFinite(input)) return check(Math.round(input), opts); // seconds from the API
  const s = String(input ?? '').trim().toLowerCase();
  if (!s) throw bad('Enter a time, e.g. 2h 30m');
  if (/^\d+(\.\d+)?$/.test(s)) return check(Math.round(Number(s) * 60), opts);
  const re = /(\d+(?:\.\d+)?)\s*([wdhm])/g;
  let total = 0, used = '';
  for (const m of s.matchAll(re)) { total += Number(m[1]) * UNIT[m[2]]; used += m[0]; }
  if (!used || s.replace(/\s+/g, '') !== used.replace(/\s+/g, '')) throw bad(`"${input}" isn't a valid time. Use w, d, h and m, e.g. 1d 4h`);
  return check(Math.round(total), opts);
}
function check(sec: number, opts: { allowZero?: boolean }) {
  if (sec < 0 || (!opts.allowZero && sec === 0)) throw bad('Time must be more than zero');
  if (sec > MAX) throw bad('That’s more than a year');
  return sec;
}

/** seconds → "1w 2d 3h 30m" (largest units first, zeros dropped); 0 → "0m". */
export function formatDuration(sec: number | null | undefined): string | null {
  if (sec == null) return null;
  let left = Math.max(0, Math.round(sec / 60)) * 60;
  if (!left) return '0m';
  const parts: string[] = [];
  for (const u of ['w', 'd', 'h', 'm']) {
    const n = Math.floor(left / UNIT[u]);
    if (n) { parts.push(`${n}${u}`); left -= n * UNIT[u]; }
  }
  return parts.join(' ');
}

/** Jira-shaped time fields for issueJson. */
export function timeFields(r: { original_estimate_s?: number | null; remaining_estimate_s?: number | null; time_spent_s?: number | null }) {
  const orig = r.original_estimate_s ?? null, rem = r.remaining_estimate_s ?? null, spent = r.time_spent_s ? Number(r.time_spent_s) : null;
  return {
    timeoriginalestimate: orig, timeestimate: rem, timespent: spent,
    timetracking: {
      ...(orig != null ? { originalEstimate: formatDuration(orig), originalEstimateSeconds: orig } : {}),
      ...(rem != null ? { remainingEstimate: formatDuration(rem), remainingEstimateSeconds: rem } : {}),
      ...(spent ? { timeSpent: formatDuration(spent), timeSpentSeconds: spent } : {}),
    },
  };
}

type Log = (q: Db, issueId: number, actorId: number, field: string, from: { v?: unknown; s?: unknown }, to: { v?: unknown; s?: unknown }) => Promise<void>;
type Row = { id: number; original_estimate_s: number | null; remaining_estimate_s: number | null };

async function setRemaining(q: Db, actorId: number, issueId: number, before: number | null, after: number | null, log: Log) {
  if (before === after) return;
  await q.query(`UPDATE issues SET remaining_estimate_s = $1, updated_at = now() WHERE id = $2`, [after, issueId]);
  await log(q, issueId, actorId, 'timeestimate', { v: before, s: formatDuration(before) }, { v: after, s: formatDuration(after) });
}

/** Per-field edit of an estimate (called from editField inside its transaction). null clears it. */
export async function setEstimate(q: Db, actorId: number, row: Row, which: 'original' | 'remaining', value: unknown, log: Log) {
  const v = value == null || value === '' ? null : parseDuration(value, { allowZero: which === 'remaining' });
  if (which === 'original') {
    if (v === row.original_estimate_s) return;
    await q.query(`UPDATE issues SET original_estimate_s = $1, updated_at = now() WHERE id = $2`, [v, row.id]);
    await log(q, row.id, actorId, 'timeoriginalestimate', { v: row.original_estimate_s, s: formatDuration(row.original_estimate_s) }, { v, s: formatDuration(v) });
    if (row.remaining_estimate_s == null && v != null) await setRemaining(q, actorId, row.id, null, v, log);
  } else {
    await setRemaining(q, actorId, row.id, row.remaining_estimate_s, v, log);
  }
}

async function spentOf(q: Db, issueId: number) {
  return Number((await q.query(`SELECT coalesce(sum(time_spent_s), 0)::int AS s FROM worklogs WHERE issue_id = $1`, [issueId]))[0].s);
}

const Adjust = z.object({
  adjustEstimate: z.enum(['auto', 'leave', 'new', 'manual']).default('auto'),
  newEstimate: z.union([z.string(), z.number()]).optional(),
  reduceBy: z.union([z.string(), z.number()]).optional(),
  increaseBy: z.union([z.string(), z.number()]).optional(),
});
const WorklogInput = z.object({
  timeSpent: z.string().optional(),
  timeSpentSeconds: z.number().int().positive().optional(),
  started: z.string().datetime({ offset: true }).optional(),
  comment: z.string().max(5000).optional(),
}).merge(Adjust.partial());

const worklogJson = (w: any) => ({
  id: String(w.id), issueId: String(w.issue_id),
  author: userRef(w.author_id, w.display_name, w.email, w.avatar_color),
  comment: w.comment ?? '', started: w.started_at, created: w.created_at, updated: w.updated_at,
  timeSpent: formatDuration(w.time_spent_s), timeSpentSeconds: w.time_spent_s,
});

/** Remaining estimate after a change of `delta` seconds of logged time (positive = more logged). */
function adjusted(row: Row, delta: number, a: z.infer<typeof Adjust>, deleting: boolean) {
  const cur = row.remaining_estimate_s ?? row.original_estimate_s ?? null;
  switch (a.adjustEstimate) {
    case 'leave': return row.remaining_estimate_s;
    case 'new':
      if (a.newEstimate === undefined) throw bad('Enter the new remaining estimate');
      return parseDuration(a.newEstimate, { allowZero: true });
    case 'manual': {
      const by = deleting ? a.increaseBy : a.reduceBy;
      if (by === undefined) throw bad(deleting ? 'Enter how much to add back' : 'Enter how much to reduce the estimate by');
      const n = parseDuration(by, { allowZero: true });
      return Math.max(0, (cur ?? 0) + (deleting ? n : -n));
    }
    default: // auto
      if (cur == null) return null; // nothing to adjust
      return Math.max(0, cur - delta);
  }
}

type LoadIssue = (db: Db, user: AuthUser, key: string) => Promise<{ row: any; role: any }>;

export function worklogRoutes(db: Db, loadIssue: LoadIssue, log: Log) {
  const r = Router();
  const rows = (where: string, params: unknown[]) => db.query(
    `SELECT w.*, u.display_name, u.email, u.avatar_color FROM worklogs w JOIN users u ON u.id = w.author_id WHERE ${where} ORDER BY w.started_at, w.id`,
    params,
  );
  const one = async (issueId: number, id: string) => {
    const [w] = await rows('w.issue_id = $1 AND w.id = $2', [issueId, Number(id)]);
    if (!w) throw notFound('Work log');
    return w;
  };
  const spentLog = (q: Db, user: AuthUser, issueId: number, before: number, after: number) =>
    log(q, issueId, user.id, 'timespent', { v: before || null, s: formatDuration(before || null) }, { v: after || null, s: formatDuration(after || null) });

  r.get('/issue/:key/worklog', h(async (req) => {
    const { row } = await loadIssue(db, req.user!, String(req.params.key));
    const list = await rows('w.issue_id = $1', [row.id]);
    return { startAt: 0, maxResults: list.length, total: list.length, worklogs: list.map(worklogJson) };
  }));

  r.post('/issue/:key/worklog', h(async (req, res) => {
    const user = req.user!;
    const { row, role } = await loadIssue(db, user, String(req.params.key));
    if (!can(role, 'WORK_ON_ISSUES', user.isSiteAdmin)) throw forbidden('WORK_ON_ISSUES');
    assertNotArchived(row);
    const body = WorklogInput.parse({ ...req.query, ...(req.body ?? {}) });
    const secs = body.timeSpentSeconds ?? parseDuration(body.timeSpent);
    const a = Adjust.parse(body);
    const w = await db.tx(async (q) => {
      const before = await spentOf(q, row.id);
      const [w] = await q.query(
        `INSERT INTO worklogs (issue_id, author_id, started_at, time_spent_s, comment) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [row.id, user.id, body.started ?? new Date().toISOString(), secs, body.comment?.trim() || null],
      );
      await q.query(`UPDATE issues SET updated_at = now() WHERE id = $1`, [row.id]);
      await spentLog(q, user, row.id, before, before + secs);
      await setRemaining(q, user.id, row.id, row.remaining_estimate_s, adjusted(row, secs, a, false), log);
      return w;
    });
    res.status(201);
    return worklogJson(await one(row.id, String(w.id)));
  }));

  r.put('/issue/:key/worklog/:id', h(async (req) => {
    const user = req.user!;
    const { row, role } = await loadIssue(db, user, String(req.params.key));
    const w = await one(row.id, String(req.params.id));
    const perm = w.author_id === user.id ? 'EDIT_OWN_WORKLOGS' : 'EDIT_ALL_WORKLOGS';
    if (!can(role, perm, user.isSiteAdmin)) throw forbidden(perm);
    const body = WorklogInput.parse({ ...req.query, ...(req.body ?? {}) });
    const secs = body.timeSpentSeconds ?? (body.timeSpent !== undefined ? parseDuration(body.timeSpent) : w.time_spent_s);
    const a = Adjust.parse(body);
    await db.tx(async (q) => {
      const before = await spentOf(q, row.id);
      await q.query(`UPDATE worklogs SET time_spent_s = $2, started_at = $3, comment = $4, updated_at = now() WHERE id = $1`, [
        w.id, secs, body.started ?? w.started_at, body.comment !== undefined ? body.comment.trim() || null : w.comment,
      ]);
      if (secs !== w.time_spent_s) {
        await spentLog(q, user, row.id, before, before - w.time_spent_s + secs);
        await setRemaining(q, user.id, row.id, row.remaining_estimate_s, adjusted(row, secs - w.time_spent_s, a, false), log);
      }
    });
    return worklogJson(await one(row.id, String(w.id)));
  }));

  r.delete('/issue/:key/worklog/:id', h(async (req, res) => {
    const user = req.user!;
    const { row, role } = await loadIssue(db, user, String(req.params.key));
    const w = await one(row.id, String(req.params.id));
    const perm = w.author_id === user.id ? 'DELETE_OWN_WORKLOGS' : 'DELETE_ALL_WORKLOGS';
    if (!can(role, perm, user.isSiteAdmin)) throw forbidden(perm);
    const a = Adjust.parse({ ...req.query, ...(req.body ?? {}) });
    await db.tx(async (q) => {
      const before = await spentOf(q, row.id);
      await q.query(`DELETE FROM worklogs WHERE id = $1`, [w.id]);
      await spentLog(q, user, row.id, before, before - w.time_spent_s);
      await setRemaining(q, user.id, row.id, row.remaining_estimate_s, adjusted(row, -w.time_spent_s, a, true), log);
    });
    res.status(204).end();
    return undefined;
  }));

  return r;
}
