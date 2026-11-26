/**
 * Releases (versions) and components (Phase 5), Jira semantics:
 * - A version belongs to a space; work items list it in "Fix versions". Versions are unreleased → released, and can be
 *   archived. Releasing can move unfinished work to another version. Deleting can move its work to another version.
 * - A component belongs to a space (optional lead); work items list theirs in "Components".
 * - Both are many-to-many with work items; every change writes History ("Fix Version" / "Component").
 * Managing versions needs MANAGE_VERSIONS, components ADMINISTER_PROJECTS (space admins); anyone who can edit a work
 * item can set its fix versions and components.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from './db.js';
import type { AuthUser } from './auth.js';
import { h, bad, notFound, forbidden } from './http.js';
import { projectByKey, roleIn } from './access.js';
import { can, type Permission } from './permissions.js';

export const REL = {
  versions: { table: 'versions', link: 'issue_versions', col: 'version_id', field: 'Fix Version', label: 'version' },
  components: { table: 'components', link: 'issue_components', col: 'component_id', field: 'Component', label: 'component' },
} as const;
export type RelKind = keyof typeof REL;

type Log = (q: Db, issueId: number, actorId: number, field: string, from: { s?: unknown }, to: { s?: unknown }) => Promise<void>;

const refName = (x: any) => String(x?.id ?? x?.name ?? x ?? '').trim();

/** Resolve {id}|{name}|"name" refs to rows of this space. */
async function resolve(q: Db, kind: RelKind, projectId: number, refs: unknown[]) {
  const R = REL[kind];
  const out: { id: number; name: string }[] = [];
  for (const ref of refs) {
    const v = refName(ref);
    if (!v) continue;
    const [row] = await q.query(
      `SELECT id, name FROM ${R.table} WHERE project_id = $1 AND (id::text = $2 OR lower(name) = lower($2))`,
      [projectId, v],
    );
    if (!row) throw bad(`No ${R.label} "${v}" in this space`);
    if (!out.some((o) => o.id === row.id)) out.push(row);
  }
  return out;
}

async function current(q: Db, kind: RelKind, issueId: number) {
  const R = REL[kind];
  return (await q.query(
    `SELECT e.id, e.name FROM ${R.link} x JOIN ${R.table} e ON e.id = x.${R.col} WHERE x.issue_id = $1 ORDER BY e.position, e.id`,
    [issueId],
  )) as { id: number; name: string }[];
}

/** SET / ADD / REMOVE fix versions or components on one work item, with History. */
export async function setRelation(
  q: Db, actorId: number, row: { id: number; project_id: number }, kind: RelKind, operation: 'SET' | 'ADD' | 'REMOVE', value: unknown, log: Log,
) {
  const R = REL[kind];
  const refs = value == null ? [] : Array.isArray(value) ? value : [value];
  const items = await resolve(q, kind, row.project_id, refs);
  const before = await current(q, kind, row.id);
  let next = operation === 'SET' ? items
    : operation === 'ADD' ? [...before, ...items.filter((i) => !before.some((b) => b.id === i.id))]
    : before.filter((b) => !items.some((i) => i.id === b.id));
  next = next.filter((v, i, a) => a.findIndex((x) => x.id === v.id) === i);
  if (kind === 'versions' && operation !== 'REMOVE') {
    const archived = await q.query(`SELECT name FROM versions WHERE id = ANY($1::int[]) AND archived`, [items.map((i) => i.id)]);
    if (archived.length) throw bad(`Version ${archived[0].name} is archived`);
  }
  await q.query(`DELETE FROM ${R.link} WHERE issue_id = $1`, [row.id]);
  for (const n of next) await q.query(`INSERT INTO ${R.link} (issue_id, ${R.col}) VALUES ($1,$2)`, [row.id, n.id]);
  await q.query(`UPDATE issues SET updated_at = now() WHERE id = $1`, [row.id]);
  await log(q, row.id, actorId, R.field, { s: before.map((b) => b.name).join(', ') }, { s: next.map((n) => n.name).join(', ') });
}

/** Move every work item from one version/component to another (or just remove it), with History. */
async function moveItems(q: Db, kind: RelKind, fromId: number, toId: number | null, actorId: number, log: Log, onlyUnresolved = false) {
  const R = REL[kind];
  const issues = await q.query(
    `SELECT x.issue_id FROM ${R.link} x JOIN issues i ON i.id = x.issue_id JOIN statuses s ON s.id = i.status_id
     WHERE x.${R.col} = $1 ${onlyUnresolved ? `AND s.category <> 'done'` : ''}`,
    [fromId],
  );
  for (const { issue_id } of issues) {
    const before = await current(q, kind, issue_id);
    await q.query(`DELETE FROM ${R.link} WHERE issue_id = $1 AND ${R.col} = $2`, [issue_id, fromId]);
    if (toId) await q.query(`INSERT INTO ${R.link} (issue_id, ${R.col}) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [issue_id, toId]);
    const after = await current(q, kind, issue_id);
    await log(q, issue_id, actorId, R.field, { s: before.map((b) => b.name).join(', ') }, { s: after.map((a) => a.name).join(', ') });
  }
  return issues.length;
}

// ------------------------------------------------------------------ JSON

const toDate = (d: unknown) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const today = () => new Date().toISOString().slice(0, 10);

async function versionCounts(db: Db, ids: number[]) {
  if (!ids.length) return new Map<number, any>();
  const rows = await db.query(
    `SELECT x.version_id AS id, count(*)::int AS total,
            count(*) FILTER (WHERE s.category = 'todo')::int AS todo,
            count(*) FILTER (WHERE s.category = 'in_progress')::int AS in_progress,
            count(*) FILTER (WHERE s.category = 'done')::int AS done
     FROM issue_versions x JOIN issues i ON i.id = x.issue_id JOIN statuses s ON s.id = i.status_id
     WHERE x.version_id = ANY($1::int[]) GROUP BY x.version_id`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id, r]));
}
const versionJson = (v: any, c?: any) => {
  const releaseDate = toDate(v.release_date);
  return {
    id: String(v.id), name: v.name, description: v.description ?? '', projectId: String(v.project_id),
    startDate: toDate(v.start_date), releaseDate, released: v.released, archived: v.archived,
    overdue: !v.released && !!releaseDate && releaseDate < today(),
    ...(c !== undefined ? { issues: { total: c?.total ?? 0, todo: c?.todo ?? 0, inProgress: c?.in_progress ?? 0, done: c?.done ?? 0 } } : {}),
  };
};
const componentJson = (c: any) => ({
  id: String(c.id), name: c.name, description: c.description ?? '', projectId: String(c.project_id),
  lead: c.lead_id ? { accountId: String(c.lead_id), displayName: c.lead_name } : null, issueCount: c.issue_count ?? 0,
});

// ------------------------------------------------------------------ routes

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish();
const VersionInput = z.object({
  name: z.string().trim().min(1).max(100), description: z.string().max(2000).optional(),
  startDate: DateStr, releaseDate: DateStr, released: z.boolean().optional(), archived: z.boolean().optional(),
});
const ComponentInput = z.object({
  name: z.string().trim().min(1).max(100), description: z.string().max(2000).optional(),
  leadAccountId: z.union([z.string(), z.number()]).nullish(),
});

export function versionRoutes(db: Db, log: Log) {
  const r = Router();

  const space = async (user: AuthUser, key: string, perm?: Permission) => {
    const p = await projectByKey(db, user, key);
    const role = await roleIn(db, user, p.id);
    if (!can(role, 'BROWSE_PROJECTS', user.isSiteAdmin)) throw notFound(`Project ${key}`);
    if (perm && !can(role, perm, user.isSiteAdmin)) throw forbidden(perm);
    return p;
  };
  const entity = async (user: AuthUser, kind: RelKind, id: string, perm?: Permission) => {
    const [e] = await db.query(
      `SELECT e.*, p.key AS pkey FROM ${REL[kind].table} e JOIN projects p ON p.id = e.project_id WHERE e.id = $1 AND p.tenant_id = $2`,
      [Number(id), user.tenantId],
    );
    if (!e) throw notFound(kind === 'versions' ? 'Version' : 'Component');
    await space(user, e.pkey, perm);
    return e;
  };
  const unique = async (kind: RelKind, projectId: number, name: string, exceptId = 0) => {
    const [dup] = await db.query(`SELECT 1 FROM ${REL[kind].table} WHERE project_id = $1 AND lower(name) = lower($2) AND id <> $3`, [projectId, name, exceptId]);
    if (dup) throw bad(`A ${REL[kind].label} named "${name}" already exists in this space`);
  };
  const dates = (start?: string | null, release?: string | null) => {
    if (start && release && start > release) throw bad('The start date must be on or before the release date');
  };
  const sameSpace = async (kind: RelKind, projectId: number, id: unknown) => {
    if (id == null || id === '') return null;
    const [t] = await db.query(`SELECT id FROM ${REL[kind].table} WHERE id = $1 AND project_id = $2`, [Number(id), projectId]);
    if (!t) throw bad(`Pick a ${REL[kind].label} from the same space`);
    return t.id as number;
  };

  // ---- versions
  r.get('/project/:key/versions', h(async (req) => {
    const p = await space(req.user!, String(req.params.key));
    const rows = await db.query(`SELECT * FROM versions WHERE project_id = $1 ORDER BY position, id`, [p.id]);
    const counts = await versionCounts(db, rows.map((v) => v.id));
    return rows.map((v) => versionJson(v, counts.get(v.id) ?? null));
  }));
  r.get('/version/:id', h(async (req) => {
    const v = await entity(req.user!, 'versions', String(req.params.id));
    return versionJson(v, (await versionCounts(db, [v.id])).get(v.id) ?? null);
  }));
  r.post('/version', h(async (req, res) => {
    const user = req.user!;
    const body = VersionInput.extend({ project: z.string().min(1) }).parse(req.body ?? {});
    const p = await space(user, body.project, 'MANAGE_VERSIONS');
    await unique('versions', p.id, body.name);
    dates(body.startDate, body.releaseDate);
    const [{ pos }] = await db.query(`SELECT coalesce(max(position), 0) + 1 AS pos FROM versions WHERE project_id = $1`, [p.id]);
    const [v] = await db.query(
      `INSERT INTO versions (project_id, name, description, start_date, release_date, position) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [p.id, body.name, body.description ?? '', body.startDate ?? null, body.releaseDate ?? null, pos],
    );
    res.status(201);
    return versionJson(v, null);
  }));
  r.put('/version/:id', h(async (req) => {
    const user = req.user!;
    const v = await entity(user, 'versions', String(req.params.id), 'MANAGE_VERSIONS');
    const body = VersionInput.partial().parse(req.body ?? {});
    if (body.name) await unique('versions', v.project_id, body.name, v.id);
    const start = body.startDate !== undefined ? body.startDate : toDate(v.start_date);
    const release = body.releaseDate !== undefined ? body.releaseDate : toDate(v.release_date);
    dates(start, release);
    const released = body.released ?? v.released;
    const [u] = await db.query(
      `UPDATE versions SET name = $2, description = $3, start_date = $4, release_date = $5, released = $6, archived = $7,
         released_at = CASE WHEN $6 AND NOT released THEN now() WHEN NOT $6 THEN NULL ELSE released_at END
       WHERE id = $1 RETURNING *`,
      [v.id, body.name ?? v.name, body.description ?? v.description, start, released && !release ? today() : release, released, body.archived ?? v.archived],
    );
    return versionJson(u, (await versionCounts(db, [u.id])).get(u.id) ?? null);
  }));
  /** Release; unfinished work can move to another (unreleased) version first. */
  r.post('/version/:id/release', h(async (req) => {
    const user = req.user!;
    const v = await entity(user, 'versions', String(req.params.id), 'MANAGE_VERSIONS');
    if (v.released) throw bad(`${v.name} is already released`);
    const body = z.object({ releaseDate: DateStr, moveUnresolvedTo: z.union([z.string(), z.number()]).nullish() }).parse(req.body ?? {});
    const target = await sameSpace('versions', v.project_id, body.moveUnresolvedTo);
    if (target === v.id) throw bad('Pick a different version');
    if (target) {
      const [t] = await db.query(`SELECT released, archived, name FROM versions WHERE id = $1`, [target]);
      if (t.released || t.archived) throw bad(`Move unfinished work to an unreleased version, not ${t.name}`);
    }
    const moved = await db.tx(async (q) => {
      const n = target ? await moveItems(q, 'versions', v.id, target, user.id, log, true) : 0;
      await q.query(`UPDATE versions SET released = true, released_at = now(), release_date = coalesce($2, release_date, CURRENT_DATE) WHERE id = $1`, [v.id, body.releaseDate ?? null]);
      return n;
    });
    const [u] = await db.query(`SELECT * FROM versions WHERE id = $1`, [v.id]);
    return { ...versionJson(u, (await versionCounts(db, [u.id])).get(u.id) ?? null), moved };
  }));
  r.delete('/version/:id', h(async (req, res) => {
    const user = req.user!;
    const v = await entity(user, 'versions', String(req.params.id), 'MANAGE_VERSIONS');
    const target = await sameSpace('versions', v.project_id, req.query.moveFixIssuesTo);
    if (target === v.id) throw bad('Pick a different version');
    await db.tx(async (q) => {
      await moveItems(q, 'versions', v.id, target, user.id, log);
      await q.query(`DELETE FROM versions WHERE id = $1`, [v.id]);
    });
    res.status(204).end();
    return undefined;
  }));

  // ---- components
  const componentRows = (where: string, params: unknown[]) => db.query(
    `SELECT c.*, u.display_name AS lead_name, (SELECT count(*)::int FROM issue_components x WHERE x.component_id = c.id) AS issue_count
     FROM components c LEFT JOIN users u ON u.id = c.lead_id WHERE ${where} ORDER BY lower(c.name), c.id`,
    params,
  );
  const leadId = async (projectId: number, ref: unknown) => {
    if (ref == null || ref === '') return null;
    const [m] = await db.query(`SELECT user_id FROM project_members WHERE project_id = $1 AND user_id = $2`, [projectId, Number(ref)]);
    if (!m) throw bad('The component lead must be a member of this space');
    return m.user_id as number;
  };
  r.get('/project/:key/components', h(async (req) => {
    const p = await space(req.user!, String(req.params.key));
    return (await componentRows('c.project_id = $1', [p.id])).map(componentJson);
  }));
  r.post('/component', h(async (req, res) => {
    const user = req.user!;
    const body = ComponentInput.extend({ project: z.string().min(1) }).parse(req.body ?? {});
    const p = await space(user, body.project, 'ADMINISTER_PROJECTS');
    await unique('components', p.id, body.name);
    const [c] = await db.query(
      `INSERT INTO components (project_id, name, description, lead_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [p.id, body.name, body.description ?? '', await leadId(p.id, body.leadAccountId)],
    );
    res.status(201);
    return componentJson((await componentRows('c.id = $1', [c.id]))[0]);
  }));
  r.put('/component/:id', h(async (req) => {
    const user = req.user!;
    const c = await entity(user, 'components', String(req.params.id), 'ADMINISTER_PROJECTS');
    const body = ComponentInput.partial().parse(req.body ?? {});
    if (body.name) await unique('components', c.project_id, body.name, c.id);
    await db.query(`UPDATE components SET name = $2, description = $3, lead_id = $4 WHERE id = $1`, [
      c.id, body.name ?? c.name, body.description ?? c.description, body.leadAccountId !== undefined ? await leadId(c.project_id, body.leadAccountId) : c.lead_id,
    ]);
    return componentJson((await componentRows('c.id = $1', [c.id]))[0]);
  }));
  r.delete('/component/:id', h(async (req, res) => {
    const user = req.user!;
    const c = await entity(user, 'components', String(req.params.id), 'ADMINISTER_PROJECTS');
    const target = await sameSpace('components', c.project_id, req.query.moveIssuesTo);
    if (target === c.id) throw bad('Pick a different component');
    await db.tx(async (q) => {
      await moveItems(q, 'components', c.id, target, user.id, log);
      await q.query(`DELETE FROM components WHERE id = $1`, [c.id]);
    });
    res.status(204).end();
    return undefined;
  }));

  return r;
}
