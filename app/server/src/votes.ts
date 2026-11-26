/**
 * Votes and archiving (Phase 5), Jira semantics.
 * - Votes: anyone who can see a work item can vote once, except its reporter and not once it's resolved.
 *   Voter names need VIEW_VOTERS_AND_WATCHERS.
 * - Archiving (space admins): archived work (and its child items) disappears from boards, backlogs, lists and search;
 *   it stays readable by key or link, can't be edited, and `archived = true` in JQL finds it. Restoring brings it back.
 */
import { Router } from 'express';
import type { Db } from './db.js';
import type { AuthUser } from './auth.js';
import { h, bad, forbidden } from './http.js';
import { can } from './permissions.js';
import { userRef } from './access.js';

type LoadIssue = (db: Db, user: AuthUser, key: string) => Promise<{ row: any; role: any }>;
type Log = (q: Db, issueId: number, actorId: number, field: string, from: { v?: unknown; s?: unknown }, to: { v?: unknown; s?: unknown }) => Promise<void>;

/** Writes to archived work are refused with a clear message. */
export function assertNotArchived(row: { archived_at?: unknown; key?: string }) {
  if (row.archived_at) throw bad(`${row.key ?? 'This work item'} is archived. Restore it to make changes.`);
}

export function voteRoutes(db: Db, loadIssue: LoadIssue, log: Log) {
  const r = Router();
  const state = async (user: AuthUser, row: any, role: any) => {
    const voters = await db.query(
      `SELECT u.id, u.display_name, u.email, u.avatar_color FROM votes v JOIN users u ON u.id = v.user_id WHERE v.issue_id = $1 ORDER BY v.created_at`,
      [row.id],
    );
    return {
      votes: voters.length, hasVoted: voters.some((v) => v.id === user.id),
      ...(can(role, 'VIEW_VOTERS_AND_WATCHERS', user.isSiteAdmin) ? { voters: voters.map((v) => userRef(v.id, v.display_name, v.email, v.avatar_color)) } : {}),
    };
  };

  r.get('/issue/:key/votes', h(async (req) => {
    const { row, role } = await loadIssue(db, req.user!, String(req.params.key));
    return state(req.user!, row, role);
  }));
  r.post('/issue/:key/votes', h(async (req) => {
    const user = req.user!;
    const { row, role } = await loadIssue(db, user, String(req.params.key));
    if (row.reporter_id === user.id) throw bad('You can’t vote for work you reported');
    if (row.resolution) throw bad('You can’t vote for resolved work');
    assertNotArchived(row);
    await db.query(`INSERT INTO votes (issue_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [row.id, user.id]);
    return state(user, row, role);
  }));
  r.delete('/issue/:key/votes', h(async (req) => {
    const user = req.user!;
    const { row, role } = await loadIssue(db, user, String(req.params.key));
    await db.query(`DELETE FROM votes WHERE issue_id = $1 AND user_id = $2`, [row.id, user.id]);
    return state(user, row, role);
  }));

  const archive = (on: boolean) => h(async (req) => {
    const user = req.user!;
    const { row, role } = await loadIssue(db, user, String(req.params.key));
    const perm = on ? 'ARCHIVE_ISSUES' : 'UNARCHIVE_ISSUES';
    if (!can(role, perm, user.isSiteAdmin)) throw forbidden(perm);
    if (!!row.archived_at === on) throw bad(on ? `${row.key} is already archived` : `${row.key} isn't archived`);
    if (on && row.parent_id) {
      const [par] = await db.query(`SELECT archived_at FROM issues WHERE id = $1`, [row.parent_id]);
      if (!par?.archived_at && row.t_level < 0) throw bad('Archive the parent work item instead; its subtasks go with it');
    }
    const n = await db.tx(async (q) => {
      const ids = (await q.query(`SELECT id FROM issues WHERE id = $1 OR parent_id = $1`, [row.id])).map((x) => x.id as number);
      await q.query(
        `UPDATE issues SET archived_at = ${on ? 'now()' : 'NULL'}, archived_by = $2, updated_at = now() WHERE id = ANY($1::int[])`,
        [ids, on ? user.id : null],
      );
      for (const id of ids) await log(q, id, user.id, 'archived', { s: on ? null : 'Archived' }, { s: on ? 'Archived' : null });
      return ids.length;
    });
    return { key: row.key, archived: on, count: n };
  });
  r.post('/issue/:key/archive', archive(true));
  r.post('/issue/:key/restore', archive(false));

  return r;
}
