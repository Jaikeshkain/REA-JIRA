/**
 * Workflows (Phase 3). Statuses + transitions per space, editable by space admins, with two rule types
 * (JIRA_REQUIREMENTS §3.5):
 *   - validator: fields that must be filled before the transition (e.g. Assignee before Done)
 *   - condition: which project roles may perform it (NULL = anyone with TRANSITION_ISSUES)
 * Team-managed default: one "any status → X" transition per status.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from './db.js';
import type { AuthUser } from './auth.js';
import { h, bad, notFound, forbidden } from './http.js';
import { projectByKey, requirePerm } from './access.js';
import type { Role } from './permissions.js';
import { adfToText } from './adf.js';
import { cfKey } from './customfields.js';
import { notify, watchersOf } from './notifications.js';

/** Built-in fields a validator can require (id → label). Custom fields use `customfield_<id>`. */
export const REQUIRABLE: Record<string, string> = {
  assignee: 'Assignee', priority: 'Priority', duedate: 'Due date', startdate: 'Start date',
  storypoints: 'Story points', labels: 'Labels', description: 'Description',
};

const roleOk = (allowed: string[] | null, role: Role | null, user: AuthUser) =>
  user.isSiteAdmin || !allowed || allowed.length === 0 || (!!role && allowed.includes(role));

/** Transitions available from a status for this user (conditions applied). */
export async function transitionsFor(db: Db, user: AuthUser, role: Role | null, projectId: number, statusId: number) {
  const rows = await db.query(
    `SELECT tr.id, tr.name, tr.required_fields, tr.allowed_roles, s.id AS to_id, s.name AS to_name, s.category AS to_category
     FROM transitions tr JOIN statuses s ON s.id = tr.to_status_id
     WHERE tr.project_id = $1 AND (tr.from_status_id IS NULL OR tr.from_status_id = $2) AND tr.to_status_id <> $2
     ORDER BY s.position, tr.from_status_id NULLS LAST`,
    [projectId, statusId],
  );
  return rows.filter((t) => roleOk(t.allowed_roles, role, user));
}

export const trJson = (t: any) => ({
  id: String(t.id),
  name: t.name,
  to: { id: String(t.to_id), name: t.to_name, statusCategory: { key: t.to_category } },
  requiredFields: t.required_fields ?? [],
});

/** Apply a transition: condition, validator, then status + resolution + History. `issue` is an issue row (i.*). */
export async function applyTransition(q: Db, user: AuthUser, role: Role | null, issue: any, transitionId: number) {
  const [tr] = await q.query(
    `SELECT tr.*, s.name AS to_name, s.category AS to_category FROM transitions tr JOIN statuses s ON s.id = tr.to_status_id
     WHERE tr.id = $1 AND tr.project_id = $2 AND (tr.from_status_id IS NULL OR tr.from_status_id = $3)`,
    [transitionId, issue.project_id, issue.status_id],
  );
  if (!tr) throw bad(`Transition ${transitionId} is not valid for ${issue.key} in its current status`);
  if (tr.to_status_id === issue.status_id) return;
  if (!roleOk(tr.allowed_roles, role, user)) {
    throw forbidden(`Only ${(tr.allowed_roles as string[]).join(' / ')} can move work to ${tr.to_name}`);
  }
  const missing = await missingFields(q, issue, tr.required_fields ?? []);
  if (missing.length) {
    throw bad(`Fill in ${missing.map((m) => m.label).join(', ')} before moving to ${tr.to_name}`, { missing: missing.map((m) => m.id) });
  }
  const resolution = tr.to_category === 'done' ? 'Done' : null;
  await q.query(
    `UPDATE issues SET status_id = $1, resolution = $2,
       resolved_at = CASE WHEN $2::text IS NULL THEN NULL ELSE coalesce(resolved_at, now()) END, updated_at = now()
     WHERE id = $3`,
    [tr.to_status_id, resolution, issue.id],
  );
  const [from] = await q.query(`SELECT name FROM statuses WHERE id = $1`, [issue.status_id]);
  await q.query(
    `INSERT INTO changelog (issue_id, actor_id, field, from_value, from_string, to_value, to_string) VALUES ($1,$2,'status',$3,$4,$5,$6)`,
    [issue.id, user.id, issue.status_id, from?.name ?? null, tr.to_status_id, tr.to_name],
  );
  await notify(q, {
    actorId: user.id, issueId: issue.id, kind: 'status', recipients: await watchersOf(q, issue.id),
    data: { from: from?.name ?? null, to: tr.to_name, category: tr.to_category },
  });
  if ((issue.resolution ?? null) !== resolution) {
    await q.query(`INSERT INTO changelog (issue_id, actor_id, field, from_string, to_string) VALUES ($1,$2,'resolution',$3,$4)`, [
      issue.id, user.id, issue.resolution ?? null, resolution,
    ]);
  }
}

async function missingFields(q: Db, issue: any, required: string[]) {
  const out: { id: string; label: string }[] = [];
  for (const f of required) {
    if (f in REQUIRABLE) {
      const filled =
        f === 'assignee' ? issue.assignee_id != null
        : f === 'priority' ? issue.priority_id != null
        : f === 'duedate' ? issue.due_date != null
        : f === 'startdate' ? issue.start_date != null
        : f === 'storypoints' ? issue.story_points != null
        : f === 'labels' ? (issue.labels ?? []).length > 0
        : !!adfToText(issue.description);
      if (!filled) out.push({ id: f, label: REQUIRABLE[f] });
      continue;
    }
    const m = /^customfield_(\d+)$/.exec(f);
    if (!m) continue;
    const [cf] = await q.query(`SELECT name, issue_type_ids FROM custom_fields WHERE id = $1`, [Number(m[1])]);
    if (!cf || (cf.issue_type_ids && !cf.issue_type_ids.includes(issue.type_id))) continue; // n/a for this work type
    const [v] = await q.query(`SELECT 1 FROM issue_custom_values WHERE issue_id = $1 AND field_id = $2`, [issue.id, Number(m[1])]);
    if (!v) out.push({ id: f, label: cf.name });
  }
  return out;
}

// ------------------------------------------------------------------ editor API

const RoleList = z.array(z.enum(['admin', 'member', 'viewer', 'guest'])).nullish();
const TransitionInput = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  from: z.union([z.string(), z.number()]).nullish(), // null = any status
  to: z.union([z.string(), z.number()]),
  requiredFields: z.array(z.string()).max(20).optional(),
  allowedRoles: RoleList,
});

export function workflowRoutes(db: Db) {
  const r = Router();

  const admin = async (user: AuthUser, key: string) => {
    const p = await projectByKey(db, user, key);
    await requirePerm(db, user, p.id, 'ADMINISTER_PROJECTS');
    return p;
  };
  const statusOf = async (user: AuthUser, id: string) => {
    const [s] = await db.query(
      `SELECT s.* FROM statuses s JOIN projects p ON p.id = s.project_id WHERE s.id = $1 AND p.tenant_id = $2`,
      [Number(id), user.tenantId],
    );
    if (!s) throw notFound('Status');
    await requirePerm(db, user, s.project_id, 'ADMINISTER_PROJECTS');
    return s;
  };
  const checkFields = async (projectId: number, ids: string[] = []) => {
    for (const f of ids) {
      if (f in REQUIRABLE) continue;
      const m = /^customfield_(\d+)$/.exec(f);
      const ok = m && (await db.query(`SELECT 1 FROM custom_fields WHERE id = $1 AND project_id = $2`, [Number(m[1]), projectId])).length;
      if (!ok) throw bad(`Unknown field "${f}" in required fields`);
    }
    return [...new Set(ids)];
  };
  const statusIn = async (projectId: number, id: unknown) => {
    const [s] = await db.query(`SELECT id FROM statuses WHERE id = $1 AND project_id = $2`, [Number(id), projectId]);
    if (!s) throw bad('Status not found in this space');
    return s.id as number;
  };

  const workflow = async (projectId: number) => {
    const statuses = await db.query(
      `SELECT s.*, (SELECT count(*)::int FROM issues i WHERE i.status_id = s.id) AS issue_count FROM statuses s WHERE project_id = $1 ORDER BY position`,
      [projectId],
    );
    const transitions = await db.query(`SELECT * FROM transitions WHERE project_id = $1 ORDER BY to_status_id, from_status_id NULLS FIRST, id`, [projectId]);
    const fields = await db.query(`SELECT id, name FROM custom_fields WHERE project_id = $1 ORDER BY position, id`, [projectId]);
    return {
      statuses: statuses.map((s) => ({ id: String(s.id), name: s.name, statusCategory: { key: s.category }, position: s.position, issueCount: s.issue_count, wipLimit: s.wip_limit ?? null })),
      transitions: transitions.map((t) => ({
        id: String(t.id), name: t.name, from: t.from_status_id == null ? null : String(t.from_status_id), to: String(t.to_status_id),
        requiredFields: t.required_fields, allowedRoles: t.allowed_roles,
      })),
      requirableFields: [
        ...Object.entries(REQUIRABLE).map(([id, name]) => ({ id, name })),
        ...fields.map((f) => ({ id: cfKey(f.id), name: f.name })),
      ],
    };
  };

  r.get('/project/:key/workflow', h(async (req) => {
    const user = req.user!;
    const p = await projectByKey(db, user, String(req.params.key));
    await requirePerm(db, user, p.id, 'BROWSE_PROJECTS');
    return workflow(p.id);
  }));

  // ---- statuses
  r.post('/project/:key/statuses', h(async (req, res) => {
    const p = await admin(req.user!, String(req.params.key));
    const body = z.object({ name: z.string().trim().min(1).max(40), category: z.enum(['todo', 'in_progress', 'done']) }).parse(req.body);
    const dup = await db.query(`SELECT 1 FROM statuses WHERE project_id = $1 AND lower(name) = lower($2)`, [p.id, body.name]);
    if (dup.length) throw bad(`Status "${body.name}" already exists`);
    await db.tx(async (q) => {
      const [{ next }] = await q.query(`SELECT coalesce(max(position) + 1, 0) AS next FROM statuses WHERE project_id = $1`, [p.id]);
      const [s] = await q.query(`INSERT INTO statuses (project_id, name, category, position) VALUES ($1,$2,$3,$4) RETURNING id`, [p.id, body.name, body.category, next]);
      // team-managed default so the new column is reachable straight away
      await q.query(`INSERT INTO transitions (project_id, name, from_status_id, to_status_id) VALUES ($1,$2,NULL,$3)`, [p.id, body.name, s.id]);
    });
    res.status(201);
    return workflow(p.id);
  }));

  r.put('/status/:id', h(async (req) => {
    const user = req.user!;
    const s = await statusOf(user, String(req.params.id));
    const body = z.object({
      name: z.string().trim().min(1).max(40).optional(),
      category: z.enum(['todo', 'in_progress', 'done']).optional(),
      position: z.number().int().min(0).optional(),
      wipLimit: z.number().int().min(1).max(999).nullable().optional(),
    }).parse(req.body ?? {});
    if (body.name && body.name.toLowerCase() !== s.name.toLowerCase()) {
      const dup = await db.query(`SELECT 1 FROM statuses WHERE project_id = $1 AND lower(name) = lower($2)`, [s.project_id, body.name]);
      if (dup.length) throw bad(`Status "${body.name}" already exists`);
    }
    await db.tx(async (q) => {
      await q.query(`UPDATE statuses SET name = $1, category = $2, wip_limit = $4 WHERE id = $3`, [body.name ?? s.name, body.category ?? s.category, s.id, body.wipLimit !== undefined ? body.wipLimit : s.wip_limit]);
      if (body.name) await q.query(`UPDATE transitions SET name = $1 WHERE to_status_id = $2 AND from_status_id IS NULL AND name = $3`, [body.name, s.id, s.name]);
      // moving into/out of the Done category resolves/unresolves the work already in it
      if (body.category && body.category !== s.category) {
        if (body.category === 'done') {
          await q.query(`UPDATE issues SET resolution = 'Done', resolved_at = coalesce(resolved_at, now()) WHERE status_id = $1`, [s.id]);
        } else if (s.category === 'done') {
          await q.query(`UPDATE issues SET resolution = NULL, resolved_at = NULL WHERE status_id = $1`, [s.id]);
        }
      }
      if (body.position !== undefined) {
        const ids = (await q.query(`SELECT id FROM statuses WHERE project_id = $1 AND id <> $2 ORDER BY position, id`, [s.project_id, s.id])).map((x) => x.id);
        ids.splice(Math.min(body.position, ids.length), 0, s.id);
        for (const [i, id] of ids.entries()) await q.query(`UPDATE statuses SET position = $1 WHERE id = $2`, [i, id]);
      }
    });
    return workflow(s.project_id);
  }));

  /** Delete a status; its work moves to `moveTo` (required when it has work). Keeps at least one status. */
  r.delete('/status/:id', h(async (req) => {
    const user = req.user!;
    const s = await statusOf(user, String(req.params.id));
    const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM statuses WHERE project_id = $1`, [s.project_id]);
    if (n <= 1) throw bad('A space needs at least one status');
    const [{ work }] = await db.query(`SELECT count(*)::int AS work FROM issues WHERE status_id = $1`, [s.id]);
    let target: any = null;
    if (work > 0) {
      if (!req.query.moveTo) throw bad(`${work} work item(s) are in ${s.name}; choose a status to move them to`, { moveTo: 'required' });
      [target] = await db.query(`SELECT * FROM statuses WHERE id = $1 AND project_id = $2 AND id <> $3`, [Number(req.query.moveTo), s.project_id, s.id]);
      if (!target) throw bad('Choose a different status in this space');
    }
    await db.tx(async (q) => {
      if (target) {
        const ids = (await q.query(`SELECT id FROM issues WHERE status_id = $1`, [s.id])).map((x) => x.id);
        const resolution = target.category === 'done' ? 'Done' : null;
        await q.query(
          `UPDATE issues SET status_id = $1, resolution = $2, resolved_at = CASE WHEN $2::text IS NULL THEN NULL ELSE coalesce(resolved_at, now()) END,
             updated_at = now() WHERE id = ANY($3::int[])`,
          [target.id, resolution, ids],
        );
        for (const id of ids) {
          await q.query(`INSERT INTO changelog (issue_id, actor_id, field, from_value, from_string, to_value, to_string) VALUES ($1,$2,'status',$3,$4,$5,$6)`, [
            id, user.id, s.id, s.name, target.id, target.name,
          ]);
        }
      }
      await q.query(`DELETE FROM statuses WHERE id = $1`, [s.id]); // transitions cascade
      const ids = (await q.query(`SELECT id FROM statuses WHERE project_id = $1 ORDER BY position, id`, [s.project_id])).map((x) => x.id);
      for (const [i, id] of ids.entries()) await q.query(`UPDATE statuses SET position = $1 WHERE id = $2`, [i, id]);
    });
    return workflow(s.project_id);
  }));

  // ---- transitions
  r.post('/project/:key/transitions', h(async (req, res) => {
    const p = await admin(req.user!, String(req.params.key));
    const body = TransitionInput.parse(req.body);
    const to = await statusIn(p.id, body.to);
    const from = body.from == null || body.from === '' ? null : await statusIn(p.id, body.from);
    if (from === to) throw bad('A transition must go to a different status');
    const dup = await db.query(
      `SELECT 1 FROM transitions WHERE project_id = $1 AND to_status_id = $2 AND from_status_id IS NOT DISTINCT FROM $3`,
      [p.id, to, from],
    );
    if (dup.length) throw bad('That transition already exists');
    const [toRow] = await db.query(`SELECT name FROM statuses WHERE id = $1`, [to]);
    await db.query(
      `INSERT INTO transitions (project_id, name, from_status_id, to_status_id, required_fields, allowed_roles) VALUES ($1,$2,$3,$4,$5,$6)`,
      [p.id, body.name ?? toRow.name, from, to, await checkFields(p.id, body.requiredFields), body.allowedRoles?.length ? body.allowedRoles : null],
    );
    res.status(201);
    return workflow(p.id);
  }));

  r.put('/transition/:id', h(async (req) => {
    const user = req.user!;
    const [t] = await db.query(
      `SELECT tr.* FROM transitions tr JOIN projects p ON p.id = tr.project_id WHERE tr.id = $1 AND p.tenant_id = $2`,
      [Number(req.params.id), user.tenantId],
    );
    if (!t) throw notFound('Transition');
    await requirePerm(db, user, t.project_id, 'ADMINISTER_PROJECTS');
    const body = TransitionInput.partial().parse(req.body ?? {});
    await db.query(`UPDATE transitions SET name = $1, required_fields = $2, allowed_roles = $3 WHERE id = $4`, [
      body.name ?? t.name,
      body.requiredFields !== undefined ? await checkFields(t.project_id, body.requiredFields) : t.required_fields,
      body.allowedRoles !== undefined ? (body.allowedRoles?.length ? body.allowedRoles : null) : t.allowed_roles,
      t.id,
    ]);
    return workflow(t.project_id);
  }));

  r.delete('/transition/:id', h(async (req) => {
    const user = req.user!;
    const [t] = await db.query(
      `SELECT tr.* FROM transitions tr JOIN projects p ON p.id = tr.project_id WHERE tr.id = $1 AND p.tenant_id = $2`,
      [Number(req.params.id), user.tenantId],
    );
    if (!t) throw notFound('Transition');
    await requirePerm(db, user, t.project_id, 'ADMINISTER_PROJECTS');
    await db.query(`DELETE FROM transitions WHERE id = $1`, [t.id]);
    return workflow(t.project_id);
  }));

  return r;
}
