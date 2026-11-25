/**
 * Saved filters (Phase 3). A filter is a named JQL query with an owner and a share scope.
 * Results are always computed with the *viewer's* permissions, so sharing a filter never exposes issues
 * the viewer could not otherwise browse (same rule as Jira).
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from './db.js';
import type { AuthUser } from './auth.js';
import { h, bad, notFound, forbidden } from './http.js';
import { projectByKey, roleIn, userRef } from './access.js';
import { can } from './permissions.js';
import { parse, compile } from './jql.js';
import { jqlCtx } from './customfields.js';

export type Share = 'private' | 'project' | 'site';

/** SQL predicate: rows of `alias` (filters/dashboards) the user may see. Params: $u user id, $t tenant id. */
export const visibleTo = (alias: string, u: string, t: string) => `(${alias}.tenant_id = ${t} AND (
  ${alias}.owner_id = ${u} OR ${alias}.share = 'site'
  OR (${alias}.share = 'project' AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = ${alias}.project_id AND pm.user_id = ${u}))))`;

/** Validate JQL by compiling it for this user; returns the parse error message as a 400. */
export async function checkJql(db: Db, jql: string, user: AuthUser) {
  compile(parse(jql), await jqlCtx(db, user), []);
}

export async function resolveShare(db: Db, user: AuthUser, share: Share, projectKey?: string | null) {
  if (share !== 'project') return null;
  if (!projectKey) throw bad('Choose a space to share with', { projectKey: 'required' });
  const p = await projectByKey(db, user, projectKey);
  const role = await roleIn(db, user, p.id);
  if (!can(role, 'BROWSE_PROJECTS', user.isSiteAdmin)) throw notFound('Project');
  return p.id as number;
}

const filterJson = (f: any, userId: number) => ({
  id: String(f.id),
  name: f.name,
  description: f.description,
  jql: f.jql,
  owner: userRef(f.owner_id, f.owner_name, null, f.owner_color),
  share: { type: f.share, project: f.project_key ? { key: f.project_key, name: f.project_name } : null },
  favourite: !!f.favourite,
  favouriteCount: f.fav_count ?? 0,
  editable: f.owner_id === userId,
  updated: f.updated_at,
});

const SELECT = `
  SELECT f.*, u.display_name AS owner_name, u.avatar_color AS owner_color, p.key AS project_key, p.name AS project_name,
         EXISTS (SELECT 1 FROM filter_favourites ff WHERE ff.filter_id = f.id AND ff.user_id = $1) AS favourite,
         (SELECT count(*)::int FROM filter_favourites ff WHERE ff.filter_id = f.id) AS fav_count
  FROM filters f JOIN users u ON u.id = f.owner_id LEFT JOIN projects p ON p.id = f.project_id`;

export async function loadFilter(db: Db, user: AuthUser, id: string | number) {
  const [f] = await db.query(`${SELECT} WHERE f.id = $3 AND ${visibleTo('f', '$1', '$2')}`, [user.id, user.tenantId, Number(id)]);
  if (!f) throw notFound('Filter');
  return f;
}

const FilterInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).optional(),
  jql: z.string().trim().min(1).max(4000),
  share: z.enum(['private', 'project', 'site']).default('private'),
  projectKey: z.string().nullish(),
});

export function filterRoutes(db: Db) {
  const r = Router();

  /** scope: all (visible) | mine | starred ; q = name contains */
  r.get(
    '/filter/search',
    h(async (req) => {
      const user = req.user!;
      const scope = String(req.query.scope ?? 'all');
      const params: unknown[] = [user.id, user.tenantId];
      let extra = '';
      if (scope === 'mine') extra += ' AND f.owner_id = $1';
      if (scope === 'starred') extra += ' AND EXISTS (SELECT 1 FROM filter_favourites ff WHERE ff.filter_id = f.id AND ff.user_id = $1)';
      if (req.query.q) { params.push(`%${String(req.query.q)}%`); extra += ` AND f.name ILIKE $${params.length}`; }
      const rows = await db.query(`${SELECT} WHERE ${visibleTo('f', '$1', '$2')}${extra} ORDER BY lower(f.name)`, params);
      return { values: rows.map((f) => filterJson(f, user.id)) };
    }),
  );

  r.post(
    '/filter',
    h(async (req, res) => {
      const user = req.user!;
      const body = FilterInput.parse(req.body);
      await checkJql(db, body.jql, user);
      const projectId = await resolveShare(db, user, body.share, body.projectKey);
      const dup = await db.query(`SELECT 1 FROM filters WHERE tenant_id = $1 AND owner_id = $2 AND lower(name) = lower($3)`, [user.tenantId, user.id, body.name]);
      if (dup.length) throw bad(`You already have a filter named "${body.name}"`, { name: 'taken' });
      const [f] = await db.query(
        `INSERT INTO filters (tenant_id, owner_id, name, description, jql, share, project_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [user.tenantId, user.id, body.name, body.description ?? '', body.jql, body.share, projectId],
      );
      // Jira stars filters you create
      await db.query(`INSERT INTO filter_favourites (filter_id, user_id) VALUES ($1,$2)`, [f.id, user.id]);
      res.status(201);
      return filterJson(await loadFilter(db, user, f.id), user.id);
    }),
  );

  r.get('/filter/:id', h(async (req) => filterJson(await loadFilter(db, req.user!, String(req.params.id)), req.user!.id)));

  r.put(
    '/filter/:id',
    h(async (req) => {
      const user = req.user!;
      const f = await loadFilter(db, user, String(req.params.id));
      if (f.owner_id !== user.id) throw forbidden('Only the owner can edit this filter');
      const body = FilterInput.partial().parse(req.body ?? {});
      if (body.jql) await checkJql(db, body.jql, user);
      const share = body.share ?? f.share;
      const projectId = body.share || body.projectKey !== undefined ? await resolveShare(db, user, share, body.projectKey ?? f.project_key) : f.project_id;
      if (body.name && body.name.toLowerCase() !== f.name.toLowerCase()) {
        const dup = await db.query(`SELECT 1 FROM filters WHERE tenant_id = $1 AND owner_id = $2 AND lower(name) = lower($3)`, [user.tenantId, user.id, body.name]);
        if (dup.length) throw bad(`You already have a filter named "${body.name}"`, { name: 'taken' });
      }
      await db.query(
        `UPDATE filters SET name = $1, description = $2, jql = $3, share = $4, project_id = $5, updated_at = now() WHERE id = $6`,
        [body.name ?? f.name, body.description ?? f.description, body.jql ?? f.jql, share, projectId, f.id],
      );
      return filterJson(await loadFilter(db, user, f.id), user.id);
    }),
  );

  r.delete(
    '/filter/:id',
    h(async (req, res) => {
      const user = req.user!;
      const f = await loadFilter(db, user, String(req.params.id));
      if (f.owner_id !== user.id) throw forbidden('Only the owner can delete this filter');
      await db.query(`DELETE FROM filters WHERE id = $1`, [f.id]);
      res.status(204).end();
      return undefined;
    }),
  );

  r.post(
    '/filter/:id/favourite',
    h(async (req) => {
      const user = req.user!;
      const f = await loadFilter(db, user, String(req.params.id));
      await db.query(`INSERT INTO filter_favourites (filter_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [f.id, user.id]);
      return { favourite: true };
    }),
  );
  r.delete(
    '/filter/:id/favourite',
    h(async (req) => {
      const user = req.user!;
      const f = await loadFilter(db, user, String(req.params.id));
      await db.query(`DELETE FROM filter_favourites WHERE filter_id = $1 AND user_id = $2`, [f.id, user.id]);
      return { favourite: false };
    }),
  );

  return r;
}
