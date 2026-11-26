import { Router } from 'express';
import { emitWebhook, issueSnapshot } from './webhooks.js';
import { z } from 'zod';
import type { Db } from './db.js';
import type { AuthUser } from './auth.js';
import { h, bad, notFound, forbidden } from './http.js';
import { projectByKey, requirePerm, roleIn, userRef } from './access.js';
import { can } from './permissions.js';
import { sanitizeAdf, adfToText } from './adf.js';
import { rankBetween } from './lexorank.js';
import { parse, compile, FROM } from './jql.js';
import { setIssueSprint } from './sprints.js';
import { fireAutomation } from './automation.js';
import { excerpt, linkMentions, mentionedIds, notify, watch, watchersOf } from './notifications.js';
import { transitionsFor, applyTransition, trJson } from './workflow.js';
import { appliesTo, cfKey, fieldJson, fieldsOf, jqlCtx, normalise, setValue, valuesFor } from './customfields.js';
import { linksFor } from './links.js';
import { attachmentsFor, type FileStore } from './attachments.js';
import { setRelation, REL } from './versions.js';
import { parseDuration, setEstimate, timeFields } from './timetracking.js';

// ------------------------------------------------------------------ shaping

const SELECT = `
  SELECT i.*, p.key AS p_key, p.name AS p_name,
         s.name AS s_name, s.category AS s_category,
         t.name AS t_name, t.hierarchy_level AS t_level, t.color AS t_color,
         pr.name AS pr_name, pr.color AS pr_color, pr.position AS pr_position,
         a.display_name AS a_name, a.email AS a_email, a.avatar_color AS a_color,
         r.display_name AS r_name, r.email AS r_email, r.avatar_color AS r_color,
         par.key AS parent_key, par.summary AS parent_summary, part.name AS parent_type,
         sp.name AS sp_name, sp.state AS sp_state,
         (SELECT count(*)::int FROM watchers w WHERE w.issue_id = i.id) AS watch_count,
         (SELECT coalesce(json_agg(json_build_object('id', v.id::text, 'name', v.name, 'released', v.released, 'archived', v.archived) ORDER BY v.position, v.id), '[]'::json)
            FROM issue_versions iv JOIN versions v ON v.id = iv.version_id WHERE iv.issue_id = i.id) AS fix_versions,
         (SELECT coalesce(json_agg(json_build_object('id', c.id::text, 'name', c.name) ORDER BY lower(c.name), c.id), '[]'::json)
            FROM issue_components ic JOIN components c ON c.id = ic.component_id WHERE ic.issue_id = i.id) AS components,
         (SELECT coalesce(sum(wl.time_spent_s), 0)::int FROM worklogs wl WHERE wl.issue_id = i.id) AS time_spent_s`;
export const SELECT_FROM = `${SELECT} ${FROM}
  LEFT JOIN issues par ON par.id = i.parent_id
  LEFT JOIN issue_types part ON part.id = par.type_id`;

const CATEGORY_NAME = { todo: 'To Do', in_progress: 'In Progress', done: 'Done' } as const;

export function issueJson(r: any) {
  return {
    id: String(r.id),
    key: r.key,
    fields: {
      summary: r.summary,
      description: r.description ?? null,
      project: { id: String(r.project_id), key: r.p_key, name: r.p_name },
      issuetype: { id: String(r.type_id), name: r.t_name, hierarchyLevel: r.t_level, color: r.t_color },
      status: {
        id: String(r.status_id),
        name: r.s_name,
        statusCategory: { key: r.s_category, name: CATEGORY_NAME[r.s_category as keyof typeof CATEGORY_NAME] },
      },
      priority: r.priority_id ? { id: String(r.priority_id), name: r.pr_name, color: r.pr_color } : null,
      assignee: userRef(r.assignee_id, r.a_name, r.a_email, r.a_color),
      reporter: userRef(r.reporter_id, r.r_name, r.r_email, r.r_color),
      creator: { accountId: String(r.creator_id) },
      parent: r.parent_id ? { id: String(r.parent_id), key: r.parent_key, summary: r.parent_summary, issuetype: r.parent_type } : null,
      labels: r.labels ?? [],
      duedate: r.due_date ? toDate(r.due_date) : null,
      startdate: r.start_date ? toDate(r.start_date) : null,
      storypoints: r.story_points == null ? null : Number(r.story_points),
      resolution: r.resolution ? { name: r.resolution } : null,
      resolutiondate: r.resolved_at,
      created: r.created_at,
      updated: r.updated_at,
      rank: r.rank,
      watches: { watchCount: r.watch_count ?? 0 },
      sprint: r.sprint_id ? { id: String(r.sprint_id), name: r.sp_name, state: r.sp_state } : null,
      fixVersions: r.fix_versions ?? [],
      components: r.components ?? [],
      ...timeFields(r),
    },
  };
}

const toDate = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

export async function loadIssue(db: Db, user: AuthUser, key: string) {
  const [row] = await db.query(`${SELECT_FROM} WHERE i.tenant_id = $1 AND upper(i.key) = upper($2)`, [user.tenantId, key]);
  if (!row) throw notFound(`Issue ${key}`);
  const role = await roleIn(db, user, row.project_id);
  if (!can(role, 'BROWSE_PROJECTS', user.isSiteAdmin)) throw notFound(`Issue ${key}`);
  return { row, role };
}

/** Latest History entry id for a work item (webhooks report only entries written after it). */
const lastChangeId = async (db: Db, issueId: number) =>
  Number((await db.query(`SELECT coalesce(max(id), 0) AS m FROM changelog WHERE issue_id = $1`, [issueId]))[0].m);

export async function logChange(
  q: Db, issueId: number, actorId: number, field: string,
  from: { v?: unknown; s?: unknown }, to: { v?: unknown; s?: unknown },
) {
  const str = (x: unknown) => (x == null || x === '' ? null : Array.isArray(x) ? x.join(' ') : String(x));
  if (str(from.v) === str(to.v) && str(from.s) === str(to.s)) return;
  await q.query(
    `INSERT INTO changelog (issue_id, actor_id, field, from_value, from_string, to_value, to_string) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [issueId, actorId, field, str(from.v), str(from.s), str(to.v), str(to.s)],
  );
}

async function userInTenant(q: Db, tenantId: number, accountId: unknown): Promise<{ id: number; display_name: string } | null> {
  if (accountId == null || accountId === '') return null;
  const [u] = await q.query(`SELECT id, display_name FROM users WHERE tenant_id = $1 AND id = $2 AND active`, [
    tenantId,
    Number(accountId),
  ]);
  if (!u) throw bad(`User ${accountId} not found`);
  return u;
}

// ------------------------------------------------------------------ validation

const Ref = z.object({ id: z.union([z.string(), z.number()]).optional(), key: z.string().optional(), name: z.string().optional() });
const CreateIssue = z.object({
  fields: z.object({
    project: Ref,
    issuetype: Ref,
    summary: z.string().trim().min(1).max(255),
    description: z.any().optional(),
    priority: Ref.nullish(),
    assignee: z.object({ accountId: z.union([z.string(), z.number()]) }).nullish(),
    reporter: z.object({ accountId: z.union([z.string(), z.number()]) }).nullish(),
    parent: Ref.nullish(),
    labels: z.array(z.string().trim().min(1).max(255).regex(/^\S+$/, 'labels cannot contain spaces')).optional(),
    duedate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    startdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    storypoints: z.number().nonnegative().nullish(),
    sprint: z.object({ id: z.union([z.string(), z.number()]) }).nullish(),
    fixVersions: z.array(z.any()).optional(),
    components: z.array(z.any()).optional(),
    timetracking: z.object({ originalEstimate: z.union([z.string(), z.number()]).nullish(), remainingEstimate: z.union([z.string(), z.number()]).nullish() }).nullish(),
  }).passthrough(), // customfield_<id> keys are validated against the space's fields
  watchers: z.array(z.union([z.string(), z.number()])).optional(),
});
const FieldEdit = z.object({ operation: z.enum(['SET', 'ADD', 'REMOVE']).default('SET'), value: z.any() });

// ------------------------------------------------------------------ operations (shared by routes, bulk change, import)
// Each fires automation and webhooks after its transaction commits.

/** Create a work item (whole field map, Jira create semantics). Fires automation after commit. */
export async function createIssue(db: Db, user: AuthUser, input: unknown): Promise<{ id: number; key: string }> {
  const { fields, watchers } = CreateIssue.parse(input);
  let project;
  if (fields.project.key) project = await projectByKey(db, user, fields.project.key);
  else {
    [project] = await db.query(`SELECT * FROM projects WHERE tenant_id = $1 AND id::text = $2`, [
      user.tenantId,
      String(fields.project.id ?? ''),
    ]);
    if (!project) throw notFound('Project');
  }
  const role = await requirePerm(db, user, project.id, 'CREATE_ISSUES');

  const created = await db.tx(async (q) => {
    const [type] = await q.query(
      `SELECT * FROM issue_types WHERE project_id = $1 AND (id::text = $2 OR lower(name) = lower($3))`,
      [project.id, String(fields.issuetype.id ?? ''), fields.issuetype.name ?? ''],
    );
    if (!type) throw bad('Invalid issue type', { issuetype: 'not in this project' });

    let parentId: number | null = null;
    if (fields.parent?.key || fields.parent?.id) {
      const [par] = await q.query(
        `SELECT i.id, t.hierarchy_level FROM issues i JOIN issue_types t ON t.id = i.type_id
         WHERE i.tenant_id = $1 AND (upper(i.key) = upper($2) OR i.id::text = $3)`,
        [user.tenantId, fields.parent.key ?? '', String(fields.parent.id ?? '')],
      );
      if (!par) throw bad('Parent not found', { parent: 'not found' });
      if (par.hierarchy_level !== type.hierarchy_level + 1) {
        throw bad('Parent must be one level above this issue type', { parent: 'invalid hierarchy' });
      }
      parentId = par.id;
    } else if (type.hierarchy_level === -1) {
      throw bad('Subtasks need a parent', { parent: 'required' });
    }

    let priorityId: number | null = null;
    if (fields.priority) {
      const [pr] = await q.query(`SELECT id FROM priorities WHERE id::text = $1 OR lower(name) = lower($2)`, [
        String(fields.priority.id ?? ''),
        fields.priority.name ?? '',
      ]);
      if (!pr) throw bad('Invalid priority');
      priorityId = pr.id;
    } else {
      [{ id: priorityId }] = await q.query(`SELECT id FROM priorities WHERE name = 'Medium'`);
    }

    const assignee = fields.assignee
      ? await userInTenant(q, user.tenantId, fields.assignee.accountId)
      : project.default_assignee_id ? { id: project.default_assignee_id } : null;
    if (fields.assignee && !can(role, 'ASSIGN_ISSUES', user.isSiteAdmin)) throw forbidden('ASSIGN_ISSUES');
    const reporter = fields.reporter ? await userInTenant(q, user.tenantId, fields.reporter.accountId) : { id: user.id };
    if (fields.reporter && reporter!.id !== user.id && !can(role, 'MODIFY_REPORTER', user.isSiteAdmin)) throw forbidden('MODIFY_REPORTER');

    // custom fields: validate every supplied value and enforce "required" for this work type
    const cfs = await fieldsOf(q, project.id);
    const cfValues: { id: number; value: unknown }[] = [];
    for (const f of cfs) {
      const raw = (fields as Record<string, unknown>)[cfKey(f.id)];
      if (!appliesTo(f, type.id)) {
        if (raw != null) throw bad(`${f.name} does not apply to ${type.name}`, { [cfKey(f.id)]: 'not applicable' });
        continue;
      }
      const v = await normalise(q, user.tenantId, f, raw);
      if (v == null && f.required) throw bad(`${f.name} is required`, { [cfKey(f.id)]: 'required' });
      if (v != null) cfValues.push({ id: f.id, value: v });
    }
    const unknown = Object.keys(fields).filter((k) => /^customfield_/.test(k) && !cfs.some((f) => cfKey(f.id) === k));
    if (unknown.length) throw bad(`Unknown field ${unknown[0]} for this space`);

    if (fields.startdate && fields.duedate && fields.startdate > fields.duedate) {
      throw bad('Start date must be on or before the due date', { startdate: 'order' });
    }
    const [first] = await q.query(`SELECT id FROM statuses WHERE project_id = $1 ORDER BY position LIMIT 1`, [project.id]);
    // Atomic per-project counter → stable key KEY-N
    const [{ issue_counter: n }] = await q.query(
      `UPDATE projects SET issue_counter = issue_counter + 1 WHERE id = $1 RETURNING issue_counter`,
      [project.id],
    );
    const [{ max }] = await q.query(`SELECT max(rank) AS max FROM issues WHERE project_id = $1`, [project.id]);
    const key = `${project.key}-${n}`;
    const [row] = await q.query(
      `INSERT INTO issues (tenant_id, project_id, number, key, type_id, status_id, priority_id, summary, description,
          assignee_id, reporter_id, creator_id, parent_id, labels, due_date, start_date, story_points, rank)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [
        user.tenantId, project.id, n, key, type.id, first.id, priorityId, fields.summary,
        sanitizeAdf(fields.description), assignee?.id ?? null, reporter!.id, user.id, parentId,
        [...new Set(fields.labels ?? [])], fields.duedate ?? null, fields.startdate ?? null, fields.storypoints ?? null,
        rankBetween(max ?? null, null),
      ],
    );
    if (fields.sprint?.id != null) {
      if (type.hierarchy_level !== 0) throw bad('Only stories, tasks and bugs can be planned into a sprint', { sprint: 'invalid type' });
      await setIssueSprint(q, user.id, { id: row.id, project_id: project.id, sprint_id: null }, Number(fields.sprint.id));
    }
    for (const cv of cfValues) {
      await q.query(`INSERT INTO issue_custom_values (issue_id, field_id, value) VALUES ($1,$2,$3::jsonb)`, [row.id, cv.id, JSON.stringify(cv.value)]);
    }
    const watcherIds = new Set<number>([user.id, ...(watchers ?? []).map(Number)]);
    if (assignee?.id) watcherIds.add(assignee.id);
    for (const w of watcherIds) {
      await q.query(`INSERT INTO watchers (issue_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [row.id, w]);
    }
    if (assignee?.id) await notify(q, { actorId: user.id, issueId: row.id, kind: 'assigned', recipients: [assignee.id] });
    const target = { id: row.id, project_id: project.id };
    if (fields.fixVersions?.length) await setRelation(q, user.id, target, 'versions', 'SET', fields.fixVersions, logChange);
    if (fields.components?.length) await setRelation(q, user.id, target, 'components', 'SET', fields.components, logChange);
    const tt = fields.timetracking;
    if (tt?.originalEstimate != null || tt?.remainingEstimate != null) {
      const orig = tt.originalEstimate != null ? parseDuration(tt.originalEstimate) : null;
      const rem = tt.remainingEstimate != null ? parseDuration(tt.remainingEstimate, { allowZero: true }) : orig;
      await q.query(`UPDATE issues SET original_estimate_s = $1, remaining_estimate_s = $2 WHERE id = $3`, [orig, rem, row.id]);
    }
    await logChange(q, row.id, user.id, 'created', {}, { v: row.id, s: key });
    return { id: row.id, key };
  });
  await fireAutomation(db, { type: 'issue_created', issueId: created.id, actorId: user.id });
  await emitWebhook(db, 'issue_created', user, { issueId: created.id });
  return created;
}

/** Per-field edit (Jira issuefieldvalue mutation). Writes History, notifies, fires automation after commit. */
export async function editField(db: Db, user: AuthUser, key: string, fieldId: string, input: unknown) {
  const { row, role } = await loadIssue(db, user, key);
  const { operation, value } = FieldEdit.parse(input ?? {});
  const field = fieldId.toLowerCase();
  const need = field === 'assignee' ? 'ASSIGN_ISSUES' : field === 'reporter' ? 'MODIFY_REPORTER' : 'EDIT_ISSUES';
  if (!can(role, need as any, user.isSiteAdmin)) throw forbidden(need);
  const afterId = await lastChangeId(db, row.id);

  await db.tx(async (q) => {
    const set = async (col: string, v: unknown, from: { v?: unknown; s?: unknown }, to: { v?: unknown; s?: unknown }) => {
      await q.query(`UPDATE issues SET ${col} = $1, updated_at = now() WHERE id = $2`, [v, row.id]);
      await logChange(q, row.id, user.id, field, from, to);
    };
    switch (field) {
      case 'summary': {
        const s = z.string().trim().min(1).max(255).parse(value);
        return set('summary', s, { s: row.summary }, { s });
      }
      case 'description': {
        const doc = await linkMentions(q, row.project_id, sanitizeAdf(value));
        await set('description', doc, { s: adfToText(row.description) }, { s: adfToText(doc) });
        const before = new Set(mentionedIds(row.description));
        await notify(q, { actorId: user.id, issueId: row.id, kind: 'mentioned', recipients: mentionedIds(doc).filter((id) => !before.has(id)), data: { where: 'description', excerpt: excerpt(adfToText(doc)) } });
        return;
      }
      case 'assignee': case 'reporter': {
        const u = await userInTenant(q, user.tenantId, value?.accountId ?? value);
        if (field === 'reporter' && !u) throw bad('Reporter is required');
        const col = field === 'assignee' ? 'assignee_id' : 'reporter_id';
        const prevName = field === 'assignee' ? row.a_name : row.r_name;
        await set(col, u?.id ?? null, { v: row[col], s: prevName }, { v: u?.id, s: u?.display_name });
        if (field === 'assignee' && u && u.id !== row.assignee_id) {
          await watch(q, row.id, u.id);
          await notify(q, { actorId: user.id, issueId: row.id, kind: 'assigned', recipients: [u.id] });
        }
        return;
      }
      case 'priority': {
        const [pr] = await q.query(`SELECT * FROM priorities WHERE id::text = $1 OR lower(name) = lower($1)`, [
          String(value?.id ?? value?.name ?? value),
        ]);
        if (!pr) throw bad('Invalid priority');
        return set('priority_id', pr.id, { v: row.priority_id, s: row.pr_name }, { v: pr.id, s: pr.name });
      }
      case 'timeoriginalestimate': case 'originalestimate': case 'timeestimate': case 'remainingestimate': {
        return setEstimate(q, user.id, row, field.includes('original') ? 'original' : 'remaining', value, logChange);
      }
      case 'timetracking': {
        const t = z.object({ originalEstimate: z.union([z.string(), z.number()]).nullish(), remainingEstimate: z.union([z.string(), z.number()]).nullish() }).parse(value ?? {});
        if (t.originalEstimate !== undefined) await setEstimate(q, user.id, row, 'original', t.originalEstimate, logChange);
        if (t.remainingEstimate !== undefined) {
          const [fresh] = await q.query(`SELECT id, original_estimate_s, remaining_estimate_s FROM issues WHERE id = $1`, [row.id]);
          await setEstimate(q, user.id, fresh, 'remaining', t.remainingEstimate, logChange);
        }
        return;
      }
      case 'fixversions': case 'fixversion': case 'components': case 'component': {
        return setRelation(q, user.id, row, field.startsWith('fix') ? 'versions' : 'components', operation, value, logChange);
      }
      case 'labels': {
        const items = z.array(z.string().trim().min(1).regex(/^\S+$/)).parse(Array.isArray(value) ? value : [value]);
        const cur: string[] = row.labels ?? [];
        const next =
          operation === 'ADD' ? [...new Set([...cur, ...items])]
          : operation === 'REMOVE' ? cur.filter((l) => !items.includes(l))
          : [...new Set(items)];
        return set('labels', next, { s: cur }, { s: next });
      }
      case 'duedate': case 'startdate': {
        const d = value == null || value === '' ? null : z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(value);
        const col = field === 'duedate' ? 'due_date' : 'start_date';
        // Timeline bars need start <= due
        const other = field === 'duedate' ? row.start_date : row.due_date;
        if (d && other) {
          const [start, due] = field === 'duedate' ? [toDate(other), d] : [d, toDate(other)];
          if (start > due) throw bad('Start date must be on or before the due date', { [field]: 'order' });
        }
        return set(col, d, { s: row[col] ? toDate(row[col]) : null }, { s: d });
      }
      case 'storypoints': {
        const n = value == null || value === '' ? null : z.coerce.number().nonnegative().parse(value);
        // re-estimating work in the active sprint changes its scope (burndown shows it)
        await q.query(
          `UPDATE sprint_scope SET points = $1 WHERE issue_id = $2 AND removed_at IS NULL
             AND sprint_id IN (SELECT id FROM sprints WHERE state = 'active')`,
          [n, row.id],
        );
        return set('story_points', n, { s: row.story_points }, { s: n });
      }
      case 'sprint': {
        const id = value?.id ?? value;
        if (row.t_level !== 0) throw bad('Only stories, tasks and bugs can be planned into a sprint');
        return setIssueSprint(q, user.id, row, id == null || id === '' ? null : Number(id));
      }
      case 'parent': {
        const k = value?.key ?? value;
        if (k == null || k === '') return set('parent_id', null, { s: row.parent_key }, { s: null });
        const [par] = await q.query(
          `SELECT i.id, i.key, t.hierarchy_level FROM issues i JOIN issue_types t ON t.id = i.type_id
           WHERE i.tenant_id = $1 AND upper(i.key) = upper($2)`,
          [user.tenantId, String(k)],
        );
        if (!par) throw bad('Parent not found');
        if (par.id === row.id) throw bad('An issue cannot be its own parent');
        if (par.hierarchy_level !== row.t_level + 1) throw bad('Parent must be one level above this issue type');
        return set('parent_id', par.id, { s: row.parent_key }, { s: par.key });
      }
      case 'issuetype': {
        const [t] = await q.query(`SELECT * FROM issue_types WHERE project_id = $1 AND (id::text = $2 OR lower(name) = lower($2))`, [
          row.project_id,
          String(value?.id ?? value?.name ?? value),
        ]);
        if (!t) throw bad('Invalid issue type');
        if (t.hierarchy_level !== row.t_level) throw bad('Changing hierarchy level (e.g. Task → Epic) is not supported yet');
        return set('type_id', t.id, { v: row.type_id, s: row.t_name }, { v: t.id, s: t.name });
      }
      default: {
        const m = /^customfield_(\d+)$/.exec(field);
        if (m) {
          const [f] = await q.query(`SELECT * FROM custom_fields WHERE id = $1 AND project_id = $2`, [Number(m[1]), row.project_id]);
          if (!f) throw bad(`Unknown field ${field} for this space`);
          return setValue(q, user.id, user.tenantId, row, f, value);
        }
        throw bad(`Field '${fieldId}' cannot be edited here${field === 'status' ? ' — use transitions' : ''}`);
      }
    }
  });
  await fireAutomation(db, { type: 'field_changed', issueId: row.id, actorId: user.id, field });
  const logged = field.startsWith('fixversion') ? REL.versions.field : field.startsWith('component') ? REL.components.field : field;
  await emitWebhook(db, 'issue_updated', user, { issueId: row.id, changelog: { field: logged, afterId } });
}

/** Move a work item by transition id (conditions + validators apply). Fires automation after commit. */
export async function transitionIssue(db: Db, user: AuthUser, key: string, transitionId: number) {
  const { row, role } = await loadIssue(db, user, key);
  if (!can(role, 'TRANSITION_ISSUES', user.isSiteAdmin)) throw forbidden('TRANSITION_ISSUES');
  const afterId = await lastChangeId(db, row.id);
  await db.tx((q) => applyTransition(q, user, role, row, transitionId));
  const [now] = await db.query(`SELECT status_id FROM issues WHERE id = $1`, [row.id]);
  if (now && now.status_id !== row.status_id) {
    await fireAutomation(db, { type: 'issue_transitioned', issueId: row.id, actorId: user.id, fromStatusId: row.status_id, toStatusId: now.status_id });
    await emitWebhook(db, 'issue_updated', user, { issueId: row.id, changelog: { field: 'status', afterId } });
  }
}

/** Move to a status by picking an allowed transition into it (bulk change). */
export async function moveToStatus(db: Db, user: AuthUser, key: string, statusId: number) {
  const { row, role } = await loadIssue(db, user, key);
  if (row.status_id === statusId) return;
  const options = await transitionsFor(db, user, role, row.project_id, row.status_id);
  const tr = options.find((t: any) => t.to_id === statusId);
  if (!tr) throw bad(`No transition to that status from ${row.s_name}`);
  await transitionIssue(db, user, key, tr.id);
}

/** Delete a work item (and, if allowed, its children) plus their attachment files. */
export async function deleteIssue(db: Db, user: AuthUser, store: FileStore, key: string, deleteSubtasks: boolean) {
  const { row, role } = await loadIssue(db, user, key);
  if (!can(role, 'DELETE_ISSUES', user.isSiteAdmin)) throw forbidden('DELETE_ISSUES');
  const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM issues WHERE parent_id = $1`, [row.id]);
  if (n > 0 && !deleteSubtasks) throw bad(`${row.key} has ${n} child issue(s); pass deleteSubtasks=true`);
  const snapshot = await issueSnapshot(db, row.id); // for the webhook: the row is about to go
  const files = await db.tx(async (q) => {
    const keys = (
      await q.query(`SELECT storage_key FROM attachments WHERE issue_id IN (SELECT id FROM issues WHERE id = $1 OR parent_id = $1)`, [row.id])
    ).map((a) => a.storage_key as string);
    await q.query(`DELETE FROM issues WHERE parent_id = $1`, [row.id]);
    await q.query(`DELETE FROM issues WHERE id = $1`, [row.id]);
    return keys;
  });
  await store.remove(files); // after commit: rows are gone, so the bytes can go too
  if (snapshot) await emitWebhook(db, 'issue_deleted', user, { snapshot });
}

// ------------------------------------------------------------------ routes

export function issueRoutes(db: Db, store: FileStore) {
  const r = Router();

  /** Create: whole field map at once, reporter + watcher default to creator (observed in Jira, §8.1). */
  r.post(
    '/issue',
    h(async (req, res) => {
      const created = await createIssue(db, req.user!, req.body);
      res.status(201);
      return { id: String(created.id), key: created.key, self: `/api/issue/${created.key}` };
    }),
  );

  r.get(
    '/issue/:key',
    h(async (req) => {
      const user = req.user!;
      const { row, role } = await loadIssue(db, user, String(req.params.key));
      const expand = String(req.query.expand ?? '').split(',');
      const out: any = issueJson(row);
      out.children = (
        await db.query(`${SELECT_FROM} WHERE i.parent_id = $1 ORDER BY i.rank`, [row.id])
      ).map(issueJson);
      const [watching] = await db.query(`SELECT 1 FROM watchers WHERE issue_id = $1 AND user_id = $2`, [row.id, user.id]);
      out.fields.watches.isWatching = !!watching;
      out.permissions = Object.fromEntries(
        ['EDIT_ISSUES', 'ASSIGN_ISSUES', 'TRANSITION_ISSUES', 'DELETE_ISSUES', 'ADD_COMMENTS', 'MANAGE_WATCHERS'].map((p) => [
          p,
          can(role, p as any, user.isSiteAdmin),
        ]),
      );
      if (expand.includes('transitions')) out.transitions = (await transitionsFor(db, user, role, row.project_id, row.status_id)).map(trJson);
      if (expand.includes('changelog')) out.changelog = await changelogFor(db, row.id);
      out.fields.issuelinks = await linksFor(db, user, row.id);
      out.fields.attachment = await attachmentsFor(db, row.id);
      // custom fields that apply to this work type: definitions + values (customfield_<id>)
      const cfs = (await fieldsOf(db, row.project_id)).filter((f) => appliesTo(f, row.type_id));
      out.customFields = cfs.map(fieldJson);
      Object.assign(out.fields, await valuesFor(db, row.id, cfs));
      out.permissions.LINK_ISSUES = can(role, 'LINK_ISSUES', user.isSiteAdmin);
      out.permissions.CREATE_ATTACHMENTS = can(role, 'CREATE_ATTACHMENTS', user.isSiteAdmin);
      out.permissions.DELETE_OWN_ATTACHMENTS = can(role, 'DELETE_OWN_ATTACHMENTS', user.isSiteAdmin);
      out.permissions.DELETE_ALL_ATTACHMENTS = can(role, 'DELETE_ALL_ATTACHMENTS', user.isSiteAdmin);
      for (const p of ['WORK_ON_ISSUES', 'EDIT_OWN_WORKLOGS', 'EDIT_ALL_WORKLOGS', 'DELETE_OWN_WORKLOGS', 'DELETE_ALL_WORKLOGS'] as const) {
        out.permissions[p] = can(role, p, user.isSiteAdmin);
      }
      if (req.query.updateHistory !== 'false') {
        await db.query(
          `INSERT INTO recent_views (user_id, entity_type, entity_id) VALUES ($1,'issue',$2)
           ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE SET viewed_at = now()`,
          [user.id, row.id],
        );
      }
      return out;
    }),
  );

  /** Per-field edit, mirroring Jira's issuefieldvalue/{issueId}/{fieldId} mutations (§8.1). */
  r.patch(
    '/issue/:key/fields/:fieldId',
    h(async (req) => {
      const user = req.user!;
      await editField(db, user, String(req.params.key), String(req.params.fieldId), req.body);
      const { row: fresh } = await loadIssue(db, user, String(req.params.key));
      return issueJson(fresh);
    }),
  );

  r.get(
    '/issue/:key/transitions',
    h(async (req) => {
      const user = req.user!;
      const { row, role } = await loadIssue(db, user, String(req.params.key));
      return { transitions: (await transitionsFor(db, user, role, row.project_id, row.status_id)).map(trJson) };
    }),
  );

  r.post(
    '/issue/:key/transitions',
    h(async (req) => {
      const user = req.user!;
      const id = Number(z.object({ transition: z.object({ id: z.union([z.string(), z.number()]) }) }).parse(req.body).transition.id);
      await transitionIssue(db, user, String(req.params.key), id);
      const { row: fresh } = await loadIssue(db, user, String(req.params.key));
      return issueJson(fresh);
    }),
  );

  /** Board drag-and-drop: optional status change (via a valid transition) + rank between neighbours. */
  r.post(
    '/issue/:key/rank',
    h(async (req) => {
      const user = req.user!;
      const { row, role } = await loadIssue(db, user, String(req.params.key));
      const body = z
        .object({
          statusId: z.union([z.string(), z.number()]).optional(),
          // backlog drag: move between sprint containers; null = backlog, omitted = unchanged
          sprintId: z.union([z.string(), z.number()]).nullish(),
          prevKey: z.string().nullish(),
          nextKey: z.string().nullish(),
        })
        .parse(req.body ?? {});
      await db.tx(async (q) => {
        if (body.sprintId !== undefined) {
          if (!can(role, 'SCHEDULE_ISSUES', user.isSiteAdmin)) throw forbidden('SCHEDULE_ISSUES');
          await setIssueSprint(q, user.id, row, body.sprintId == null || body.sprintId === '' ? null : Number(body.sprintId));
        }
        if (body.statusId != null && Number(body.statusId) !== row.status_id) {
          if (!can(role, 'TRANSITION_ISSUES', user.isSiteAdmin)) throw forbidden('TRANSITION_ISSUES');
          const [tr] = await q.query(
            `SELECT id FROM transitions WHERE project_id = $1 AND to_status_id = $2 AND (from_status_id IS NULL OR from_status_id = $3)
             ORDER BY from_status_id NULLS LAST LIMIT 1`,
            [row.project_id, Number(body.statusId), row.status_id],
          );
          if (!tr) throw bad('No transition to that status from the current one');
          await applyTransition(q, user, role, row, tr.id);
        }
        if (body.prevKey !== undefined || body.nextKey !== undefined) {
          if (!can(role, 'SCHEDULE_ISSUES', user.isSiteAdmin)) throw forbidden('SCHEDULE_ISSUES');
          const rankOf = async (k: string | null | undefined) => {
            if (!k) return null;
            const [x] = await q.query(`SELECT rank FROM issues WHERE tenant_id = $1 AND upper(key) = upper($2)`, [user.tenantId, k]);
            if (!x) throw bad(`Issue ${k} not found`);
            return x.rank as string;
          };
          let lo = await rankOf(body.prevKey);
          let hi = await rankOf(body.nextKey);
          if (lo && hi && lo >= hi) [lo, hi] = [null, hi]; // neighbours out of order (stale client) → place before next
          const rank = rankBetween(lo, hi);
          await q.query(`UPDATE issues SET rank = $1 WHERE id = $2`, [rank, row.id]);
          await logChange(q, row.id, user.id, 'Rank', {}, { s: body.prevKey ? `after ${body.prevKey}` : `before ${body.nextKey}` });
        }
      });
      const [now] = await db.query(`SELECT status_id FROM issues WHERE id = $1`, [row.id]);
      if (now && now.status_id !== row.status_id) await fireAutomation(db, { type: 'issue_transitioned', issueId: row.id, actorId: user.id, fromStatusId: row.status_id, toStatusId: now.status_id });
      const { row: fresh } = await loadIssue(db, user, String(req.params.key));
      return issueJson(fresh);
    }),
  );

  r.delete(
    '/issue/:key',
    h(async (req, res) => {
      await deleteIssue(db, req.user!, store, String(req.params.key), req.query.deleteSubtasks === 'true');
      res.status(204).end();
      return undefined;
    }),
  );

  // ---- comments
  r.get(
    '/issue/:key/comment',
    h(async (req) => {
      const { row } = await loadIssue(db, req.user!, String(req.params.key));
      const rows = await db.query(
        `SELECT c.*, u.display_name, u.email, u.avatar_color FROM comments c JOIN users u ON u.id = c.author_id
         WHERE c.issue_id = $1 ORDER BY c.created_at ${req.query.orderBy === 'created' ? 'ASC' : 'DESC'}`,
        [row.id],
      );
      return { comments: rows.map(commentJson), total: rows.length };
    }),
  );

  r.post(
    '/issue/:key/comment',
    h(async (req, res) => {
      const user = req.user!;
      const { row, role } = await loadIssue(db, user, String(req.params.key));
      if (!can(role, 'ADD_COMMENTS', user.isSiteAdmin)) throw forbidden('ADD_COMMENTS');
      const body = z.object({ body: z.any(), parentId: z.union([z.string(), z.number()]).nullish() }).parse(req.body);
      const doc = await linkMentions(db, row.project_id, sanitizeAdf(body.body));
      if (!doc || !adfToText(doc)) throw bad('Comment cannot be empty');
      const c = await db.tx(async (q) => {
        const [c] = await q.query(
          `INSERT INTO comments (issue_id, author_id, parent_id, body) VALUES ($1,$2,$3,$4) RETURNING *`,
          [row.id, user.id, body.parentId ? Number(body.parentId) : null, doc],
        );
        await q.query(`UPDATE issues SET updated_at = now() WHERE id = $1`, [row.id]);
        // Jira: commenting watches the work item; @mentions are Direct, everyone else watching gets "commented"
        const data = { commentId: String(c.id), excerpt: excerpt(adfToText(doc)) };
        const mentioned = await notify(q, { actorId: user.id, issueId: row.id, kind: 'mentioned', recipients: mentionedIds(doc), data });
        const watchers = (await watchersOf(q, row.id)).filter((id) => !mentioned.includes(id));
        await notify(q, { actorId: user.id, issueId: row.id, kind: 'commented', recipients: watchers, data });
        await watch(q, row.id, user.id);
        return c;
      });
      res.status(201);
      await fireAutomation(db, { type: 'comment_added', issueId: row.id, actorId: user.id });
      await emitWebhook(db, 'comment_created', user, { issueId: row.id, comment: { id: String(c.id), text: adfToText(doc) } });
      return commentJson({ ...c, display_name: user.displayName, email: user.email, avatar_color: user.avatarColor });
    }),
  );

  r.put(
    '/issue/:key/comment/:id',
    h(async (req) => {
      const user = req.user!;
      const { row, role } = await loadIssue(db, user, String(req.params.key));
      const [c] = await db.query(`SELECT * FROM comments WHERE id = $1 AND issue_id = $2`, [Number(req.params.id), row.id]);
      if (!c) throw notFound('Comment');
      const perm = c.author_id === user.id ? 'EDIT_OWN_COMMENTS' : 'EDIT_ALL_COMMENTS';
      if (!can(role, perm, user.isSiteAdmin)) throw forbidden(perm);
      const doc = await linkMentions(db, row.project_id, sanitizeAdf(req.body?.body));
      if (!doc || !adfToText(doc)) throw bad('Comment cannot be empty');
      const [u] = await db.query(`UPDATE comments SET body = $1, updated_at = now() WHERE id = $2 RETURNING *`, [doc, c.id]);
      const before = new Set(mentionedIds(c.body));
      await notify(db, {
        actorId: user.id, issueId: row.id, kind: 'mentioned', recipients: mentionedIds(doc).filter((id) => !before.has(id)),
        data: { commentId: String(c.id), excerpt: excerpt(adfToText(doc)) },
      });
      return commentJson({ ...u, display_name: user.displayName });
    }),
  );

  r.delete(
    '/issue/:key/comment/:id',
    h(async (req, res) => {
      const user = req.user!;
      const { row, role } = await loadIssue(db, user, String(req.params.key));
      const [c] = await db.query(`SELECT * FROM comments WHERE id = $1 AND issue_id = $2`, [Number(req.params.id), row.id]);
      if (!c) throw notFound('Comment');
      const perm = c.author_id === user.id ? 'DELETE_OWN_COMMENTS' : 'DELETE_ALL_COMMENTS';
      if (!can(role, perm, user.isSiteAdmin)) throw forbidden(perm);
      await db.query(`DELETE FROM comments WHERE id = $1`, [c.id]);
      res.status(204).end();
      return undefined;
    }),
  );

  // ---- watchers
  r.post(
    '/issue/:key/watchers',
    h(async (req) => {
      const user = req.user!;
      const { row, role } = await loadIssue(db, user, String(req.params.key));
      const target = req.body?.accountId ? Number(req.body.accountId) : user.id;
      if (target !== user.id && !can(role, 'MANAGE_WATCHERS', user.isSiteAdmin)) throw forbidden('MANAGE_WATCHERS');
      await userInTenant(db, user.tenantId, target);
      await db.query(`INSERT INTO watchers (issue_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [row.id, target]);
      return { ok: true };
    }),
  );
  r.delete(
    '/issue/:key/watchers',
    h(async (req) => {
      const user = req.user!;
      const { row, role } = await loadIssue(db, user, String(req.params.key));
      const target = req.query.accountId ? Number(req.query.accountId) : user.id;
      if (target !== user.id && !can(role, 'MANAGE_WATCHERS', user.isSiteAdmin)) throw forbidden('MANAGE_WATCHERS');
      await db.query(`DELETE FROM watchers WHERE issue_id = $1 AND user_id = $2`, [row.id, target]);
      return { ok: true };
    }),
  );

  // ---- search
  const search = h(async (req) => {
    const user = req.user!;
    const src = { ...req.query, ...(req.body ?? {}) };
    const jql = String(src.jql ?? '');
    const startAt = Math.max(0, Number(src.startAt ?? 0) || 0);
    const maxResults = Math.min(200, Math.max(1, Number(src.maxResults ?? 50) || 50));
    const params: unknown[] = [];
    const { where, order } = compile(parse(jql), await jqlCtx(db, user), params);
    const [{ total }] = await db.query(`SELECT count(*)::int AS total ${FROM} WHERE ${where}`, params);
    const rows = await db.query(
      `${SELECT_FROM} WHERE ${where} ORDER BY ${order} LIMIT ${maxResults} OFFSET ${startAt}`,
      params,
    );
    return { jql, startAt, maxResults, total, issues: rows.map(issueJson) };
  });
  r.get('/search/jql', search);
  r.post('/search/jql', search);

  r.get(
    '/recent',
    h(async (req) => {
      const user = req.user!;
      const rows = await db.query(
        `${SELECT_FROM} JOIN recent_views rv ON rv.entity_type = 'issue' AND rv.entity_id = i.id AND rv.user_id = $1
         WHERE i.tenant_id = $2 ORDER BY rv.viewed_at DESC LIMIT 20`,
        [user.id, user.tenantId],
      );
      return { issues: rows.map(issueJson) };
    }),
  );

  return r;
}

const commentJson = (c: any) => ({
  id: String(c.id),
  author: userRef(c.author_id, c.display_name, c.email, c.avatar_color),
  body: c.body,
  parentId: c.parent_id ? String(c.parent_id) : null,
  created: c.created_at,
  updated: c.updated_at,
});

export async function changelogFor(db: Db, issueId: number) {
  const rows = await db.query(
    `SELECT c.*, u.display_name, u.avatar_color FROM changelog c JOIN users u ON u.id = c.actor_id
     WHERE c.issue_id = $1 ORDER BY c.created_at DESC, c.id DESC`,
    [issueId],
  );
  return rows.map((c) => ({
    id: String(c.id),
    author: userRef(c.actor_id, c.display_name, null, c.avatar_color),
    created: c.created_at,
    items: [{ field: c.field, from: c.from_value, fromString: c.from_string, to: c.to_value, toString: c.to_string }],
  }));
}
