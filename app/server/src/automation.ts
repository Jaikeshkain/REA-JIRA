/**
 * Automation rules (Phase 4) — "when <trigger>, if <JQL condition>, then <actions>", per space, with an audit log.
 * Mirrors Jira Automation basics (REA capture: Space settings → Automation, issue panel "Rule executions").
 *
 * - Rules run after the triggering change has committed, as the space's "Automation" user (cannot log in).
 * - Changes made by rules never trigger rules (Jira's default "allow rule trigger" = off) → no loops.
 * - Each rule's actions run in one transaction: if any action fails, that rule's changes roll back and the
 *   run is logged as an error. Workflow validators still apply to automated transitions.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from './db.js';
import type { AuthUser } from './auth.js';
import { h, bad, notFound } from './http.js';
import { projectByKey, requirePerm, roleIn, userRef } from './access.js';
import { can } from './permissions.js';
import { parse, compile, FROM } from './jql.js';
import { jqlCtx, setValue, type CfRow } from './customfields.js';
import { applyTransition } from './workflow.js';
import { notify, watch, watchersOf, linkMentions, mentionedIds, excerpt } from './notifications.js';
import { textToAdf, adfToText } from './adf.js';

export type TriggerType = 'issue_created' | 'issue_transitioned' | 'field_changed' | 'comment_added' | 'scheduled';
export interface AutomationEvent {
  type: TriggerType;
  issueId: number;
  actorId: number;
  fromStatusId?: number;
  toStatusId?: number;
  field?: string;
}

const BOT_EMAIL = 'automation@tracker.system';

/** The non-login system user that rule actions are attributed to (one per site). */
export async function botFor(db: Db, tenantId: number): Promise<number> {
  const [u] = await db.query(`SELECT id FROM users WHERE tenant_id = $1 AND email = $2`, [tenantId, BOT_EMAIL]);
  if (u) return u.id;
  const [c] = await db.query(
    `INSERT INTO users (tenant_id, email, display_name, password_hash, avatar_color, active)
     VALUES ($1,$2,'Automation','!disabled',$3,false) ON CONFLICT (tenant_id, email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
    [tenantId, BOT_EMAIL, '#626f86'],
  );
  return c.id;
}

const smart = (text: string, v: { key: string; summary: string; status: string; initiator: string }) =>
  text
    .replace(/\{\{\s*issue\.key\s*\}\}/g, v.key)
    .replace(/\{\{\s*issue\.summary\s*\}\}/g, v.summary)
    .replace(/\{\{\s*issue\.status\s*\}\}/g, v.status)
    .replace(/\{\{\s*initiator(?:\.displayName)?\s*\}\}/g, v.initiator);

const issueRow = async (q: Db, id: number) =>
  (await q.query(`SELECT i.*, s.name AS s_name FROM issues i JOIN statuses s ON s.id = i.status_id WHERE i.id = $1`, [id]))[0];

/** Evaluate all enabled rules for an event. Never throws: failures are recorded in the rule's audit log. */
export async function fireAutomation(db: Db, ev: AutomationEvent) {
  try {
    const issue = await issueRow(db, ev.issueId);
    if (!issue) return;
    const botId = await botFor(db, issue.tenant_id);
    if (ev.actorId === botId) return; // rule-made changes don't trigger rules
    const rules = await db.query(
      `SELECT * FROM automation_rules WHERE project_id = $1 AND enabled AND trigger->>'type' = $2 ORDER BY id`,
      [issue.project_id, ev.type],
    );
    for (const rule of rules) await runRule(db, rule, ev, botId, issue.tenant_id);
  } catch (e) {
    console.error('automation failed to evaluate', e);
  }
}

export async function runRule(db: Db, rule: any, ev: AutomationEvent, botId: number, tenantId: number) {
  const t = rule.trigger ?? {};
  if (ev.type === 'issue_transitioned') {
    if (t.toStatusId && Number(t.toStatusId) !== ev.toStatusId) return;
    if (t.fromStatusId && Number(t.fromStatusId) !== ev.fromStatusId) return;
  }
  if (ev.type === 'field_changed' && t.field && t.field !== ev.field) return;

  const bot: AuthUser = { id: botId, tenantId, email: BOT_EMAIL, displayName: 'Automation', avatarColor: '#626f86', isSiteAdmin: true };
  const log = (status: string, message: string, actions: string[] = []) =>
    db.query(
      `INSERT INTO automation_runs (rule_id, issue_id, status, message, actions, initiator_id) VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [rule.id, ev.issueId, status, message, JSON.stringify(actions), ev.actorId],
    );

  // condition: the work item must match the rule's JQL (evaluated without user restrictions)
  if (rule.condition_jql) {
    try {
      const params: unknown[] = [];
      const ctx = { ...(await jqlCtx(db, bot)), isSiteAdmin: true };
      const { where } = compile(parse(rule.condition_jql), ctx, params);
      params.push(ev.issueId);
      const hit = await db.query(`SELECT 1 ${FROM} WHERE ${where} AND i.id = $${params.length}`, params);
      if (!hit.length) return log('no_action', 'Condition did not match');
    } catch (e: any) {
      return log('error', `Condition: ${e?.message ?? e}`);
    }
  }

  const [initiator] = await db.query(`SELECT display_name FROM users WHERE id = $1`, [ev.actorId]);
  const done: string[] = [];
  try {
    await db.tx(async (q) => {
      for (const a of rule.actions as any[]) {
        const row = await issueRow(q, ev.issueId);
        const vars = { key: row.key, summary: row.summary, status: row.s_name, initiator: initiator?.display_name ?? 'someone' };
        done.push(await runAction(q, bot, row, a, ev, vars));
      }
    });
    await log('success', `${done.length} action${done.length === 1 ? '' : 's'} performed`, done);
  } catch (e: any) {
    await log('error', e?.message ?? String(e), done);
  }
}

async function runAction(q: Db, bot: AuthUser, row: any, a: any, ev: AutomationEvent, vars: Parameters<typeof smart>[1]): Promise<string> {
  const change = (field: string, from: unknown, to: unknown) =>
    q.query(`INSERT INTO changelog (issue_id, actor_id, field, from_string, to_string) VALUES ($1,$2,$3,$4,$5)`, [row.id, bot.id, field, from ?? null, to ?? null]);
  switch (a.type) {
    case 'transition': {
      const [tr] = await q.query(
        `SELECT tr.id, s.name FROM transitions tr JOIN statuses s ON s.id = tr.to_status_id
         WHERE tr.project_id = $1 AND tr.to_status_id = $2 AND (tr.from_status_id IS NULL OR tr.from_status_id = $3)
         ORDER BY tr.from_status_id NULLS LAST LIMIT 1`,
        [row.project_id, Number(a.statusId), row.status_id],
      );
      if (Number(a.statusId) === row.status_id) return 'Transition skipped (already in that status)';
      if (!tr) throw new Error(`No transition from ${row.s_name} to the target status`);
      await applyTransition(q, bot, null, row, tr.id);
      return `Transitioned to ${tr.name}`;
    }
    case 'assign': {
      const target =
        a.to === 'unassigned' ? null : a.to === 'reporter' ? row.reporter_id : a.to === 'initiator' ? ev.actorId : Number(a.to);
      if (target != null) {
        const [u] = await q.query(`SELECT id, display_name FROM users WHERE id = $1 AND tenant_id = $2 AND active`, [target, bot.tenantId]);
        if (!u) throw new Error('Assignee is not an active user');
      }
      if ((row.assignee_id ?? null) === target) return 'Assignee unchanged';
      const names = await q.query(`SELECT id, display_name FROM users WHERE id = ANY($1::int[])`, [[row.assignee_id, target].filter((x) => x != null)]);
      const nm = (id: number | null) => names.find((n) => n.id === id)?.display_name ?? null;
      await q.query(`UPDATE issues SET assignee_id = $1, updated_at = now() WHERE id = $2`, [target, row.id]);
      await change('assignee', nm(row.assignee_id), nm(target));
      if (target) {
        await watch(q, row.id, target);
        await notify(q, { actorId: bot.id, issueId: row.id, kind: 'assigned', recipients: [target] });
      }
      return `Assigned to ${nm(target) ?? 'nobody'}`;
    }
    case 'add_label': {
      const label = String(a.label);
      if ((row.labels ?? []).includes(label)) return `Label ${label} already present`;
      const next = [...(row.labels ?? []), label];
      await q.query(`UPDATE issues SET labels = $1, updated_at = now() WHERE id = $2`, [next, row.id]);
      await change('labels', (row.labels ?? []).join(' ') || null, next.join(' '));
      return `Added label ${label}`;
    }
    case 'set_field': {
      const f = String(a.field);
      if (f === 'priority') {
        const [p] = await q.query(`SELECT id, name FROM priorities WHERE lower(name) = lower($1)`, [String(a.value)]);
        if (!p) throw new Error(`Unknown priority ${a.value}`);
        const [old] = await q.query(`SELECT name FROM priorities WHERE id = $1`, [row.priority_id]);
        if (row.priority_id === p.id) return `Priority already ${p.name}`;
        await q.query(`UPDATE issues SET priority_id = $1, updated_at = now() WHERE id = $2`, [p.id, row.id]);
        await change('priority', old?.name, p.name);
        return `Set priority to ${p.name}`;
      }
      if (f === 'duedate') {
        const rel = /^\+?(\d+)d$/.exec(String(a.value));
        const [{ d }] = await q.query(rel ? `SELECT (current_date + $1::int)::text AS d` : `SELECT $1::date::text AS d`, [rel ? Number(rel[1]) : String(a.value)]);
        await q.query(`UPDATE issues SET due_date = $1, updated_at = now() WHERE id = $2`, [d, row.id]);
        await change('duedate', row.due_date ? String(row.due_date instanceof Date ? row.due_date.toISOString().slice(0, 10) : row.due_date).slice(0, 10) : null, d);
        return `Set due date to ${d}`;
      }
      if (f === 'storypoints') {
        const n = Number(a.value);
        if (!Number.isFinite(n) || n < 0) throw new Error('Story points must be a non-negative number');
        await q.query(`UPDATE issues SET story_points = $1, updated_at = now() WHERE id = $2`, [n, row.id]);
        await change('storypoints', row.story_points, n);
        return `Set story points to ${n}`;
      }
      const m = /^customfield_(\d+)$/.exec(f);
      if (m) {
        const [cf] = await q.query<CfRow>(`SELECT * FROM custom_fields WHERE id = $1 AND project_id = $2`, [Number(m[1]), row.project_id]);
        if (!cf) throw new Error(`Unknown field ${f}`);
        await setValue(q, bot.id, bot.tenantId, row, cf, a.value);
        return `Set ${cf.name}`;
      }
      throw new Error(`Field ${f} cannot be set by automation`);
    }
    case 'comment': {
      const text = smart(String(a.text ?? ''), vars).trim();
      if (!text) throw new Error('Comment text is empty');
      const doc = await linkMentions(q, row.project_id, textToAdf(text));
      const [c] = await q.query(`INSERT INTO comments (issue_id, author_id, body) VALUES ($1,$2,$3) RETURNING id`, [row.id, bot.id, doc]);
      const data = { commentId: String(c.id), excerpt: excerpt(adfToText(doc)) };
      const mentioned = await notify(q, { actorId: bot.id, issueId: row.id, kind: 'mentioned', recipients: mentionedIds(doc), data });
      await notify(q, { actorId: bot.id, issueId: row.id, kind: 'commented', recipients: (await watchersOf(q, row.id)).filter((x) => !mentioned.includes(x)), data });
      return 'Added a comment';
    }
    default:
      throw new Error(`Unknown action ${a?.type}`);
  }
}

// ------------------------------------------------------------------ API

const Trigger = z.discriminatedUnion('type', [
  z.object({ type: z.literal('issue_created') }),
  z.object({ type: z.literal('issue_transitioned'), toStatusId: z.string().nullish(), fromStatusId: z.string().nullish() }),
  z.object({ type: z.literal('field_changed'), field: z.string().min(1) }),
  z.object({ type: z.literal('comment_added') }),
  // runs on a schedule for every work item matching the rule's JQL (condition required)
  z.object({ type: z.literal('scheduled'), every: z.enum(['hour', 'day', 'week']), hourUtc: z.number().int().min(0).max(23).optional() }),
]);
const Action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('transition'), statusId: z.string() }),
  z.object({ type: z.literal('assign'), to: z.string() }),
  z.object({ type: z.literal('set_field'), field: z.string(), value: z.any() }),
  z.object({ type: z.literal('add_label'), label: z.string().trim().regex(/^\S+$/, 'labels cannot contain spaces').max(255) }),
  z.object({ type: z.literal('comment'), text: z.string().trim().min(1).max(5000) }),
]);
const RuleInput = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().optional(),
  trigger: Trigger,
  condition: z.string().trim().max(2000).nullish(),
  actions: z.array(Action).min(1).max(10),
});

/** Next run for a scheduled trigger strictly after `from` (UTC): top of next hour / next day at hourUtc / next Monday. */
export function nextRun(t: { every: 'hour' | 'day' | 'week'; hourUtc?: number }, from: Date): Date {
  const d = new Date(from);
  d.setUTCMinutes(0, 0, 0);
  if (t.every === 'hour') { d.setUTCHours(d.getUTCHours() + 1); return d; }
  const hour = t.hourUtc ?? 8;
  d.setUTCHours(hour);
  if (d <= from) d.setUTCDate(d.getUTCDate() + 1);
  if (t.every === 'week') while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/** Run one scheduled rule now: every matching work item (max 100 per run), as the Automation user. */
export async function runScheduledRule(db: Db, rule: any, now: Date) {
  const [p] = await db.query(`SELECT tenant_id FROM projects WHERE id = $1`, [rule.project_id]);
  if (!p) return 0;
  const botId = await botFor(db, p.tenant_id);
  const bot: AuthUser = { id: botId, tenantId: p.tenant_id, email: BOT_EMAIL, displayName: 'Automation', avatarColor: '#626f86', isSiteAdmin: true };
  let ids: number[] = [];
  try {
    const params: unknown[] = [rule.project_id];
    const { where } = compile(parse(rule.condition_jql ?? ''), { ...(await jqlCtx(db, bot)), isSiteAdmin: true }, params);
    ids = (await db.query(`SELECT i.id ${FROM} WHERE i.project_id = $1 AND ${where} ORDER BY i.id LIMIT 100`, params)).map((r) => r.id);
  } catch (e: any) {
    await db.query(`INSERT INTO automation_runs (rule_id, status, message) VALUES ($1,'error',$2)`, [rule.id, `Condition: ${e?.message ?? e}`]);
  }
  if (!ids.length) await db.query(`INSERT INTO automation_runs (rule_id, status, message) VALUES ($1,'no_action','No work items matched')`, [rule.id]);
  // the JQL already selected the items, so each run skips the per-item condition re-check
  for (const id of ids) await runRule(db, { ...rule, condition_jql: null }, { type: 'scheduled', issueId: id, actorId: botId }, botId, p.tenant_id);
  await db.query(`UPDATE automation_rules SET next_run_at = $2 WHERE id = $1`, [rule.id, nextRun(rule.trigger, now).toISOString()]);
  return ids.length;
}

const ruleJson = (r: any) => ({
  id: String(r.id), name: r.name, enabled: r.enabled, trigger: r.trigger, condition: r.condition_jql, actions: r.actions, nextRun: r.next_run_at,
  owner: userRef(r.created_by, r.owner_name), updated: r.updated_at,
  stats: { runs: r.runs ?? 0, errors: r.errors ?? 0, lastRun: r.last_run ?? null },
});

export function automationRoutes(db: Db) {
  const r = Router();

  const validate = async (projectId: number, user: AuthUser, body: z.infer<typeof RuleInput>) => {
    const status = async (id: string | null | undefined) => {
      if (!id) return;
      const ok = await db.query(`SELECT 1 FROM statuses WHERE id = $1 AND project_id = $2`, [Number(id), projectId]);
      if (!ok.length) throw bad('Status not found in this space');
    };
    if (body.trigger.type === 'issue_transitioned') { await status(body.trigger.toStatusId); await status(body.trigger.fromStatusId); }
    if (body.trigger.type === 'scheduled' && !body.condition) throw bad('Scheduled rules need a JQL condition to choose the work items', { condition: 'required' });
    if (body.condition) compile(parse(body.condition), await jqlCtx(db, user), []);
    for (const a of body.actions) {
      if (a.type === 'transition') await status(a.statusId);
      if (a.type === 'assign' && !['reporter', 'initiator', 'unassigned'].includes(a.to)) {
        const ok = await db.query(`SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2`, [projectId, Number(a.to)]);
        if (!ok.length) throw bad('Assignee must be a member of this space');
      }
      if (a.type === 'set_field') {
        const m = /^customfield_(\d+)$/.exec(a.field);
        if (m) {
          const ok = await db.query(`SELECT 1 FROM custom_fields WHERE id = $1 AND project_id = $2`, [Number(m[1]), projectId]);
          if (!ok.length) throw bad(`Unknown field ${a.field}`);
        } else if (!['priority', 'duedate', 'storypoints'].includes(a.field)) throw bad(`Field ${a.field} cannot be set by automation`);
      }
    }
  };

  const LIST = `
    SELECT ar.*, u.display_name AS owner_name,
      (SELECT count(*)::int FROM automation_runs x WHERE x.rule_id = ar.id) AS runs,
      (SELECT count(*)::int FROM automation_runs x WHERE x.rule_id = ar.id AND x.status = 'error') AS errors,
      (SELECT max(created_at) FROM automation_runs x WHERE x.rule_id = ar.id) AS last_run
    FROM automation_rules ar JOIN users u ON u.id = ar.created_by`;

  const ruleFor = async (user: AuthUser, id: string) => {
    const [rule] = await db.query(
      `SELECT ar.* FROM automation_rules ar JOIN projects p ON p.id = ar.project_id WHERE ar.id = $1 AND p.tenant_id = $2`,
      [Number(id), user.tenantId],
    );
    if (!rule) throw notFound('Rule');
    await requirePerm(db, user, rule.project_id, 'ADMINISTER_PROJECTS');
    return rule;
  };

  r.get('/project/:key/automation', h(async (req) => {
    const user = req.user!;
    const p = await projectByKey(db, user, String(req.params.key));
    await requirePerm(db, user, p.id, 'ADMINISTER_PROJECTS');
    return (await db.query(`${LIST} WHERE ar.project_id = $1 ORDER BY ar.id`, [p.id])).map(ruleJson);
  }));

  r.post('/project/:key/automation', h(async (req, res) => {
    const user = req.user!;
    const p = await projectByKey(db, user, String(req.params.key));
    await requirePerm(db, user, p.id, 'ADMINISTER_PROJECTS');
    const body = RuleInput.parse(req.body);
    await validate(p.id, user, body);
    const [rule] = await db.query(
      `INSERT INTO automation_rules (project_id, name, enabled, trigger, condition_jql, actions, created_by, next_run_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8) RETURNING id`,
      [p.id, body.name, body.enabled ?? true, JSON.stringify(body.trigger), body.condition || null, JSON.stringify(body.actions), user.id,
        body.trigger.type === 'scheduled' ? nextRun(body.trigger, new Date()).toISOString() : null],
    );
    res.status(201);
    return ruleJson((await db.query(`${LIST} WHERE ar.id = $1`, [rule.id]))[0]);
  }));

  r.put('/automation/:id', h(async (req) => {
    const user = req.user!;
    const rule = await ruleFor(user, String(req.params.id));
    const body = RuleInput.partial().parse(req.body ?? {});
    const merged = {
      name: body.name ?? rule.name, enabled: body.enabled ?? rule.enabled, trigger: body.trigger ?? rule.trigger,
      condition: body.condition !== undefined ? body.condition : rule.condition_jql, actions: body.actions ?? rule.actions,
    };
    await validate(rule.project_id, user, RuleInput.parse(merged));
    await db.query(
      `UPDATE automation_rules SET name = $1, enabled = $2, trigger = $3::jsonb, condition_jql = $4, actions = $5::jsonb, updated_at = now(),
         next_run_at = CASE WHEN $7::text IS NULL THEN NULL WHEN trigger = $3::jsonb AND next_run_at IS NOT NULL THEN next_run_at ELSE $7::timestamptz END
       WHERE id = $6`,
      [merged.name, merged.enabled, JSON.stringify(merged.trigger), merged.condition || null, JSON.stringify(merged.actions), rule.id,
        merged.trigger.type === 'scheduled' ? nextRun(merged.trigger as any, new Date()).toISOString() : null],
    );
    return ruleJson((await db.query(`${LIST} WHERE ar.id = $1`, [rule.id]))[0]);
  }));

  r.delete('/automation/:id', h(async (req, res) => {
    const rule = await ruleFor(req.user!, String(req.params.id));
    await db.query(`DELETE FROM automation_rules WHERE id = $1`, [rule.id]);
    res.status(204).end();
    return undefined;
  }));

  const runJson = (x: any) => ({
    id: String(x.id), status: x.status, message: x.message, actions: x.actions, created: x.created_at,
    rule: { id: String(x.rule_id), name: x.rule_name }, issue: x.key ? { key: x.key, summary: x.summary } : null,
    initiator: userRef(x.initiator_id, x.initiator_name),
  });
  const RUNS = `
    SELECT x.*, ar.name AS rule_name, i.key, i.summary, u.display_name AS initiator_name
    FROM automation_runs x JOIN automation_rules ar ON ar.id = x.rule_id
    LEFT JOIN issues i ON i.id = x.issue_id LEFT JOIN users u ON u.id = x.initiator_id`;

  r.get('/automation/:id/runs', h(async (req) => {
    const rule = await ruleFor(req.user!, String(req.params.id));
    return (await db.query(`${RUNS} WHERE x.rule_id = $1 ORDER BY x.created_at DESC, x.id DESC LIMIT 50`, [rule.id])).map(runJson);
  }));

  /** Issue panel "Automation → Rule executions" (anyone who can browse the work item). */
  r.get('/issue/:key/automation', h(async (req) => {
    const user = req.user!;
    const [i] = await db.query(`SELECT id, project_id FROM issues WHERE tenant_id = $1 AND upper(key) = upper($2)`, [user.tenantId, String(req.params.key)]);
    if (!i) throw notFound('Issue');
    const role = await roleIn(db, user, i.project_id);
    if (!can(role, 'BROWSE_PROJECTS', user.isSiteAdmin)) throw notFound('Issue');
    return (await db.query(`${RUNS} WHERE x.issue_id = $1 ORDER BY x.created_at DESC, x.id DESC LIMIT 20`, [i.id])).map(runJson);
  }));

  return r;
}
