/**
 * Dashboards + gadgets (Phase 3). Layout: two columns of ordered gadgets. Gadget data is computed per request
 * with the viewer's permissions through the JQL compiler, so a shared dashboard shows each person only what
 * they can browse.
 *
 * Gadgets (Jira equivalents):
 *   filter-results       → "Filter results"
 *   breakdown            → "Pie chart" (rendered as ranked bars: easier to compare than slices)
 *   created-vs-resolved  → "Created vs. resolved chart"
 *   assigned-to-me       → "Assigned to me"
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from './db.js';
import type { AuthUser } from './auth.js';
import { h, bad, notFound, forbidden } from './http.js';
import { userRef } from './access.js';
import { parse, compile, FROM } from './jql.js';
import { visibleTo, resolveShare, loadFilter } from './filters.js';
import { issueJson, SELECT_FROM } from './issues.js';

export const GADGET_TYPES = ['filter-results', 'breakdown', 'created-vs-resolved', 'assigned-to-me'] as const;
const BREAKDOWN_FIELDS: Record<string, string> = {
  status: 's.name', statusCategory: 's.category', assignee: `coalesce(a.display_name, 'Unassigned')`,
  priority: `coalesce(pr.name, 'None')`, type: 't.name', project: 'p.name', reporter: `coalesce(r.display_name, 'Unknown')`,
};

const ConfigSchemas = {
  'filter-results': z.object({ filterId: z.string(), max: z.number().int().min(1).max(50).default(10) }),
  breakdown: z.object({
    filterId: z.string(),
    field: z.enum(['status', 'statusCategory', 'assignee', 'priority', 'type', 'project', 'reporter', 'labels']).default('status'),
  }),
  'created-vs-resolved': z.object({ filterId: z.string(), days: z.number().int().min(7).max(90).default(30) }),
  'assigned-to-me': z.object({ max: z.number().int().min(1).max(50).default(10) }),
} as const;

const DashInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).optional(),
  share: z.enum(['private', 'project', 'site']).default('private'),
  projectKey: z.string().nullish(),
});

const SELECT = `
  SELECT d.*, u.display_name AS owner_name, u.avatar_color AS owner_color, p.key AS project_key, p.name AS project_name
  FROM dashboards d JOIN users u ON u.id = d.owner_id LEFT JOIN projects p ON p.id = d.project_id`;

const dashJson = (d: any, userId: number) => ({
  id: String(d.id), name: d.name, description: d.description,
  owner: userRef(d.owner_id, d.owner_name, null, d.owner_color),
  share: { type: d.share, project: d.project_key ? { key: d.project_key, name: d.project_name } : null },
  editable: d.owner_id === userId, updated: d.updated_at,
});
const gadgetJson = (g: any) => ({ id: String(g.id), type: g.type, column: g.col, position: g.position, config: g.config });

async function loadDash(db: Db, user: AuthUser, id: string) {
  const [d] = await db.query(`${SELECT} WHERE d.id = $3 AND ${visibleTo('d', '$1', '$2')}`, [user.id, user.tenantId, Number(id)]);
  if (!d) throw notFound('Dashboard');
  return d;
}
async function ownDash(db: Db, user: AuthUser, id: string) {
  const d = await loadDash(db, user, id);
  if (d.owner_id !== user.id) throw forbidden('Only the owner can change this dashboard');
  return d;
}

/** Compile JQL for this viewer → `{ where, params }` usable after `${FROM}`. */
function scoped(jql: string, user: AuthUser) {
  const params: unknown[] = [];
  const { where, order } = compile(parse(jql), { userId: user.id, tenantId: user.tenantId, isSiteAdmin: user.isSiteAdmin }, params);
  return { where, order, params };
}

export function dashboardRoutes(db: Db) {
  const r = Router();

  r.get(
    '/dashboard',
    h(async (req) => {
      const user = req.user!;
      const rows = await db.query(`${SELECT} WHERE ${visibleTo('d', '$1', '$2')} ORDER BY d.owner_id = $1 DESC, lower(d.name)`, [user.id, user.tenantId]);
      return { dashboards: rows.map((d) => dashJson(d, user.id)) };
    }),
  );

  r.post(
    '/dashboard',
    h(async (req, res) => {
      const user = req.user!;
      const body = DashInput.parse(req.body);
      const projectId = await resolveShare(db, user, body.share, body.projectKey);
      const [d] = await db.query(
        `INSERT INTO dashboards (tenant_id, owner_id, name, description, share, project_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [user.tenantId, user.id, body.name, body.description ?? '', body.share, projectId],
      );
      // start useful: everyone gets "Assigned to me"
      await db.query(`INSERT INTO gadgets (dashboard_id, type, col, position, config) VALUES ($1,'assigned-to-me',0,0,'{"max":10}')`, [d.id]);
      res.status(201);
      return dashJson(await loadDash(db, user, String(d.id)), user.id);
    }),
  );

  r.get(
    '/dashboard/:id',
    h(async (req) => {
      const user = req.user!;
      const d = await loadDash(db, user, String(req.params.id));
      const gadgets = await db.query(`SELECT * FROM gadgets WHERE dashboard_id = $1 ORDER BY col, position, id`, [d.id]);
      return { ...dashJson(d, user.id), gadgets: gadgets.map(gadgetJson) };
    }),
  );

  r.put(
    '/dashboard/:id',
    h(async (req) => {
      const user = req.user!;
      const d = await ownDash(db, user, String(req.params.id));
      const body = DashInput.partial().parse(req.body ?? {});
      const share = body.share ?? d.share;
      const projectId = body.share || body.projectKey !== undefined ? await resolveShare(db, user, share, body.projectKey ?? d.project_key) : d.project_id;
      await db.query(`UPDATE dashboards SET name = $1, description = $2, share = $3, project_id = $4, updated_at = now() WHERE id = $5`, [
        body.name ?? d.name, body.description ?? d.description, share, projectId, d.id,
      ]);
      return dashJson(await loadDash(db, user, String(d.id)), user.id);
    }),
  );

  r.delete(
    '/dashboard/:id',
    h(async (req, res) => {
      const d = await ownDash(db, req.user!, String(req.params.id));
      await db.query(`DELETE FROM dashboards WHERE id = $1`, [d.id]);
      res.status(204).end();
      return undefined;
    }),
  );

  // ---- gadgets
  const parseConfig = (type: string, config: unknown) => {
    const schema = ConfigSchemas[type as keyof typeof ConfigSchemas];
    if (!schema) throw bad(`Unknown gadget type ${type}`, { type: GADGET_TYPES.join(', ') });
    return schema.parse(config ?? {});
  };

  r.post(
    '/dashboard/:id/gadgets',
    h(async (req, res) => {
      const user = req.user!;
      const d = await ownDash(db, user, String(req.params.id));
      const body = z.object({ type: z.string(), column: z.number().int().min(0).max(1).default(0), config: z.any() }).parse(req.body);
      const config = parseConfig(body.type, body.config);
      if ('filterId' in config) await loadFilter(db, user, config.filterId);
      const [{ next }] = await db.query(`SELECT coalesce(max(position) + 1, 0) AS next FROM gadgets WHERE dashboard_id = $1 AND col = $2`, [d.id, body.column]);
      const [g] = await db.query(`INSERT INTO gadgets (dashboard_id, type, col, position, config) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [
        d.id, body.type, body.column, next, config,
      ]);
      await db.query(`UPDATE dashboards SET updated_at = now() WHERE id = $1`, [d.id]);
      res.status(201);
      return gadgetJson(g);
    }),
  );

  /** Update config and/or move: {column, position} reorders the target column densely. */
  r.put(
    '/dashboard/:id/gadgets/:gid',
    h(async (req) => {
      const user = req.user!;
      const d = await ownDash(db, user, String(req.params.id));
      const [g] = await db.query(`SELECT * FROM gadgets WHERE id = $1 AND dashboard_id = $2`, [Number(req.params.gid), d.id]);
      if (!g) throw notFound('Gadget');
      const body = z.object({ config: z.any().optional(), column: z.number().int().min(0).max(1).optional(), position: z.number().int().min(0).optional() }).parse(req.body ?? {});
      await db.tx(async (q) => {
        if (body.config !== undefined) {
          const config = parseConfig(g.type, { ...g.config, ...body.config });
          if ('filterId' in config) await loadFilter(q, user, config.filterId);
          await q.query(`UPDATE gadgets SET config = $1 WHERE id = $2`, [config, g.id]);
        }
        if (body.column !== undefined || body.position !== undefined) {
          const col = body.column ?? g.col;
          const others = (await q.query(`SELECT id FROM gadgets WHERE dashboard_id = $1 AND col = $2 AND id <> $3 ORDER BY position, id`, [d.id, col, g.id])).map((x) => x.id);
          const at = Math.min(body.position ?? others.length, others.length);
          others.splice(at, 0, g.id);
          for (const [i, id] of others.entries()) await q.query(`UPDATE gadgets SET col = $1, position = $2 WHERE id = $3`, [col, i, id]);
          if (col !== g.col) {
            const old = (await q.query(`SELECT id FROM gadgets WHERE dashboard_id = $1 AND col = $2 ORDER BY position, id`, [d.id, g.col])).map((x) => x.id);
            for (const [i, id] of old.entries()) await q.query(`UPDATE gadgets SET position = $1 WHERE id = $2`, [i, id]);
          }
        }
      });
      const [fresh] = await db.query(`SELECT * FROM gadgets WHERE id = $1`, [g.id]);
      return gadgetJson(fresh);
    }),
  );

  r.delete(
    '/dashboard/:id/gadgets/:gid',
    h(async (req, res) => {
      const d = await ownDash(db, req.user!, String(req.params.id));
      await db.query(`DELETE FROM gadgets WHERE id = $1 AND dashboard_id = $2`, [Number(req.params.gid), d.id]);
      res.status(204).end();
      return undefined;
    }),
  );

  /** Gadget data, computed for the viewer. A missing/unshared filter yields a 200 with `unavailable` so one broken gadget doesn't break the page. */
  r.get(
    '/dashboard/:id/gadgets/:gid/data',
    h(async (req) => {
      const user = req.user!;
      const d = await loadDash(db, user, String(req.params.id));
      const [g] = await db.query(`SELECT * FROM gadgets WHERE id = $1 AND dashboard_id = $2`, [Number(req.params.gid), d.id]);
      if (!g) throw notFound('Gadget');
      const cfg = g.config ?? {};
      let filter: any = null;
      if (g.type !== 'assigned-to-me') {
        try { filter = await loadFilter(db, user, cfg.filterId); } catch {
          return { unavailable: 'The filter for this gadget was deleted or is not shared with you.' };
        }
      }
      const source = filter ? { id: String(filter.id), name: filter.name, jql: filter.jql } : null;

      switch (g.type) {
        case 'filter-results':
        case 'assigned-to-me': {
          const jql = filter?.jql ?? 'assignee = currentUser() AND resolution = Unresolved ORDER BY priority DESC, updated DESC';
          const { where, order, params } = scoped(jql, user);
          const [{ total }] = await db.query(`SELECT count(*)::int AS total ${FROM} WHERE ${where}`, params);
          const max = Number(cfg.max ?? 10);
          const rows = await db.query(
            `${SELECT_FROM} WHERE ${where} ORDER BY ${order} LIMIT ${max}`,
            params,
          );
          return { source, jql, total, issues: rows.map(issueJson) };
        }
        case 'breakdown': {
          const { where, params } = scoped(filter.jql, user);
          const field = String(cfg.field ?? 'status');
          let rows: any[];
          if (field === 'labels') {
            rows = await db.query(
              `SELECT l AS name, count(*)::int AS count FROM (
                 SELECT unnest(CASE WHEN cardinality(i.labels) = 0 THEN ARRAY['(no label)'] ELSE i.labels END) AS l ${FROM} WHERE ${where}
               ) x GROUP BY l ORDER BY count DESC, name`,
              params,
            );
          } else {
            const expr = BREAKDOWN_FIELDS[field];
            if (!expr) throw bad(`Cannot break down by ${field}`);
            rows = await db.query(`SELECT ${expr} AS name, count(*)::int AS count ${FROM} WHERE ${where} GROUP BY 1 ORDER BY 2 DESC, 1`, params);
          }
          const [{ total }] = await db.query(`SELECT count(*)::int AS total ${FROM} WHERE ${where}`, params);
          const CAT: Record<string, string> = { todo: 'To Do', in_progress: 'In Progress', done: 'Done' };
          return { source, field, total, groups: rows.map((x) => ({ name: field === 'statusCategory' ? CAT[x.name] ?? x.name : x.name, count: x.count })) };
        }
        case 'created-vs-resolved': {
          const { where, params } = scoped(filter.jql, user);
          const days = Number(cfg.days ?? 30);
          params.push(days);
          const n = `$${params.length}`;
          const rows = await db.query(
            `WITH d AS (SELECT generate_series(date_trunc('day', now()) - (${n}::int - 1) * interval '1 day', date_trunc('day', now()), interval '1 day') AS day)
             SELECT d.day,
               (SELECT count(*)::int ${FROM} WHERE ${where} AND i.created_at >= d.day AND i.created_at < d.day + interval '1 day') AS created,
               (SELECT count(*)::int ${FROM} WHERE ${where} AND i.resolved_at >= d.day AND i.resolved_at < d.day + interval '1 day') AS resolved
             FROM d ORDER BY d.day`,
            params,
          );
          const created = rows.reduce((s, x) => s + x.created, 0);
          const resolved = rows.reduce((s, x) => s + x.resolved, 0);
          return { source, days, totals: { created, resolved }, series: rows.map((x) => ({ date: x.day, created: x.created, resolved: x.resolved })) };
        }
        default:
          throw bad(`Unknown gadget type ${g.type}`);
      }
    }),
  );

  return r;
}
