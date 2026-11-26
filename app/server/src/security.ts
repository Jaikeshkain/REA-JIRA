/**
 * Work-item security levels (Phase 5, Jira "issue security"). A space defines levels; each level lists which roles and
 * which people may see work items set to it, plus (optionally) the reporter and assignee. Work with no level is
 * visible to everyone who can browse the space. Site admins see everything.
 *
 * `visibleSql` is the single rule; it's applied wherever work items are listed or opened: search/JQL (so filters,
 * dashboards, CSV and bulk), board, backlog, summary counts, activity, links, recent items, notifications and loading
 * one work item. Hidden work answers "not found", exactly like work in a space you can't browse.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from './db.js';
import type { AuthUser } from './auth.js';
import { h, bad, notFound, forbidden } from './http.js';
import { projectByKey, roleIn } from './access.js';
import { can } from './permissions.js';

/** SQL: can user `uid` (an SQL expression / placeholder) see work item `alias`? */
export function visibleSql(uid: string, siteAdmin: boolean, alias = 'i') {
  if (siteAdmin) return 'TRUE';
  return `(${alias}.security_level_id IS NULL OR EXISTS (
    SELECT 1 FROM security_levels sl WHERE sl.id = ${alias}.security_level_id AND (
      ${uid} = ANY(sl.user_ids)
      OR (sl.include_reporter AND ${alias}.reporter_id = ${uid})
      OR (sl.include_assignee AND ${alias}.assignee_id = ${uid})
      OR (SELECT pm.role FROM project_members pm WHERE pm.project_id = ${alias}.project_id AND pm.user_id = ${uid}) = ANY(sl.roles))))`;
}
/** Same rule where the "site admin" flag is a column (e.g. notification recipients). */
export const visibleToRow = (uid: string, adminCol: string, alias = 'i') => `(${adminCol} OR ${visibleSql(uid, false, alias)})`;

export async function canSee(db: Db, user: AuthUser, issueId: number) {
  if (user.isSiteAdmin) return true;
  const [r] = await db.query(`SELECT ${visibleSql('$1', false)} AS ok FROM issues i WHERE i.id = $2`, [user.id, issueId]);
  return !!r?.ok;
}

const levelJson = (l: any) => ({
  id: String(l.id), name: l.name, description: l.description ?? '', roles: l.roles ?? [], users: (l.user_ids ?? []).map(String),
  includeReporter: l.include_reporter, includeAssignee: l.include_assignee, issueCount: l.issue_count ?? 0,
});
const Input = z.object({
  name: z.string().trim().min(1).max(60), description: z.string().max(500).optional(),
  roles: z.array(z.enum(['admin', 'member', 'viewer', 'guest'])).default(['admin']),
  users: z.array(z.union([z.string(), z.number()])).default([]),
  includeReporter: z.boolean().default(true), includeAssignee: z.boolean().default(true),
});

/** Validate and store a work item's level (called from editField inside its transaction). */
export async function setLevel(
  q: Db, user: AuthUser, row: { id: number; project_id: number; security_level_id: number | null }, value: unknown,
  log: (q: Db, issueId: number, actorId: number, field: string, from: { v?: unknown; s?: unknown }, to: { v?: unknown; s?: unknown }) => Promise<void>,
) {
  const ref = value == null || value === '' ? null : String((value as any)?.id ?? (value as any)?.name ?? value);
  let level: any = null;
  if (ref) {
    [level] = await q.query(`SELECT * FROM security_levels WHERE project_id = $1 AND (id::text = $2 OR lower(name) = lower($2))`, [row.project_id, ref]);
    if (!level) throw bad(`No security level "${ref}" in this space`);
    // you can't hide work from yourself (Jira: only levels you belong to are offered)
    if (!user.isSiteAdmin) {
      const role = await roleIn(q, user, row.project_id);
      const mine = (level.roles ?? []).includes(role) || (level.user_ids ?? []).includes(user.id) || level.include_reporter || level.include_assignee;
      if (!mine) throw bad(`You aren't in security level ${level.name}`);
    }
  }
  const [prev] = row.security_level_id ? await q.query(`SELECT name FROM security_levels WHERE id = $1`, [row.security_level_id]) : [];
  if ((level?.id ?? null) === row.security_level_id) return;
  await q.query(`UPDATE issues SET security_level_id = $1, updated_at = now() WHERE id = $2`, [level?.id ?? null, row.id]);
  await log(q, row.id, user.id, 'security', { v: row.security_level_id, s: prev?.name ?? null }, { v: level?.id ?? null, s: level?.name ?? null });
}

export function securityRoutes(db: Db) {
  const r = Router();
  const admin = async (user: AuthUser, key: string) => {
    const p = await projectByKey(db, user, key);
    const role = await roleIn(db, user, p.id);
    if (!can(role, 'BROWSE_PROJECTS', user.isSiteAdmin)) throw notFound(`Project ${key}`);
    return { p, role };
  };
  const users = async (projectId: number, ids: (string | number)[]) => {
    const n = ids.map(Number);
    if (!n.length) return [];
    const ok = await db.query(`SELECT user_id FROM project_members WHERE project_id = $1 AND user_id = ANY($2::int[])`, [projectId, n]);
    if (ok.length !== new Set(n).size) throw bad('People on a security level must be members of the space');
    return [...new Set(n)];
  };

  r.get('/project/:key/security-levels', h(async (req) => {
    const { p } = await admin(req.user!, String(req.params.key));
    const rows = await db.query(
      `SELECT sl.*, (SELECT count(*)::int FROM issues i WHERE i.security_level_id = sl.id) AS issue_count FROM security_levels sl WHERE project_id = $1 ORDER BY lower(name)`,
      [p.id],
    );
    return rows.map(levelJson);
  }));
  r.post('/project/:key/security-levels', h(async (req, res) => {
    const user = req.user!;
    const { p, role } = await admin(user, String(req.params.key));
    if (!can(role, 'ADMINISTER_PROJECTS', user.isSiteAdmin)) throw forbidden('ADMINISTER_PROJECTS');
    const b = Input.parse(req.body ?? {});
    const [dup] = await db.query(`SELECT 1 FROM security_levels WHERE project_id = $1 AND lower(name) = lower($2)`, [p.id, b.name]);
    if (dup) throw bad(`A level named "${b.name}" already exists`);
    const [l] = await db.query(
      `INSERT INTO security_levels (project_id, name, description, roles, user_ids, include_reporter, include_assignee) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [p.id, b.name, b.description ?? '', b.roles, await users(p.id, b.users), b.includeReporter, b.includeAssignee],
    );
    res.status(201);
    return levelJson(l);
  }));
  const load = async (user: AuthUser, id: string) => {
    const [l] = await db.query(`SELECT sl.*, p.key AS pkey FROM security_levels sl JOIN projects p ON p.id = sl.project_id WHERE sl.id = $1 AND p.tenant_id = $2`, [Number(id), user.tenantId]);
    if (!l) throw notFound('Security level');
    const { role } = await admin(user, l.pkey);
    if (!can(role, 'ADMINISTER_PROJECTS', user.isSiteAdmin)) throw forbidden('ADMINISTER_PROJECTS');
    return l;
  };
  r.put('/security-level/:id', h(async (req) => {
    const user = req.user!;
    const l = await load(user, String(req.params.id));
    const b = Input.partial().parse(req.body ?? {});
    const [u] = await db.query(
      `UPDATE security_levels SET name = $2, description = $3, roles = $4, user_ids = $5, include_reporter = $6, include_assignee = $7 WHERE id = $1 RETURNING *`,
      [l.id, b.name ?? l.name, b.description ?? l.description, b.roles ?? l.roles, b.users ? await users(l.project_id, b.users) : l.user_ids,
        b.includeReporter ?? l.include_reporter, b.includeAssignee ?? l.include_assignee],
    );
    return levelJson(u);
  }));
  /** Delete; its work items become visible to the whole space (or move to another level). */
  r.delete('/security-level/:id', h(async (req, res) => {
    const user = req.user!;
    const l = await load(user, String(req.params.id));
    const to = req.query.moveTo ? Number(req.query.moveTo) : null;
    if (to) {
      const [t] = await db.query(`SELECT 1 FROM security_levels WHERE id = $1 AND project_id = $2 AND id <> $3`, [to, l.project_id, l.id]);
      if (!t) throw bad('Pick another level from the same space');
    }
    await db.tx(async (q) => {
      await q.query(`UPDATE issues SET security_level_id = $2 WHERE security_level_id = $1`, [l.id, to]);
      await q.query(`DELETE FROM security_levels WHERE id = $1`, [l.id]);
    });
    res.status(204).end();
    return undefined;
  }));
  return r;
}
