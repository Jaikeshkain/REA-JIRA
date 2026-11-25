/**
 * Sprints, backlog and sprint reports (Phase 2, JIRA_REQUIREMENTS §3.7).
 * Jira behaviour mirrored: future → active → closed; one active sprint per board/project; completing a sprint
 * keeps done work in the closed sprint and moves open work to the backlog or another sprint; the board shows
 * only the active sprint when Sprints is enabled.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from './db.js';
import type { AuthUser } from './auth.js';
import { h, bad, notFound } from './http.js';
import { projectByKey, requirePerm } from './access.js';
import { issueJson, SELECT_FROM } from './issues.js';

export const sprintJson = (s: any) =>
  !s ? null : {
    id: String(s.id),
    name: s.name,
    goal: s.goal,
    state: s.state,
    startDate: s.start_date,
    endDate: s.end_date,
    completeDate: s.completed_at,
    projectId: String(s.project_id),
  };

async function loadSprint(db: Db, user: AuthUser, id: string | number) {
  const [s] = await db.query(
    `SELECT sp.*, p.key AS p_key FROM sprints sp JOIN projects p ON p.id = sp.project_id
     WHERE sp.id = $1 AND p.tenant_id = $2`,
    [Number(id), user.tenantId],
  );
  if (!s) throw notFound('Sprint');
  return s;
}

/**
 * Move one issue (and its subtasks) into a sprint or the backlog (null), keeping the scope log in sync:
 * leaving an active sprint closes its scope row as 'removed'; joining an active sprint opens a new row.
 */
export async function setIssueSprint(q: Db, actorId: number, issue: { id: number; project_id: number; sprint_id: number | null }, sprintId: number | null) {
  if ((issue.sprint_id ?? null) === sprintId) return;
  let target: any = null;
  if (sprintId != null) {
    [target] = await q.query(`SELECT * FROM sprints WHERE id = $1`, [sprintId]);
    if (!target || target.project_id !== issue.project_id) throw bad('Sprint not found in this project');
    if (target.state === 'closed') throw bad('Cannot add work to a closed sprint');
  }
  const [old] = issue.sprint_id ? await q.query(`SELECT * FROM sprints WHERE id = $1`, [issue.sprint_id]) : [null];
  if (old?.state === 'closed') {
    // moving done work out of history would rewrite reports; Jira only allows it for open work
    const [st] = await q.query(`SELECT s.category FROM issues i JOIN statuses s ON s.id = i.status_id WHERE i.id = $1`, [issue.id]);
    if (st?.category === 'done') throw bad('Completed work in a closed sprint cannot be moved');
  }
  const ids = [issue.id, ...(await q.query(`SELECT id FROM issues WHERE parent_id = $1`, [issue.id])).map((r) => r.id)];
  await q.query(`UPDATE issues SET sprint_id = $1, updated_at = now() WHERE id = ANY($2::int[])`, [sprintId, ids]);
  if (old?.state === 'active') {
    await q.query(`UPDATE sprint_scope SET removed_at = now(), outcome = 'removed' WHERE sprint_id = $1 AND issue_id = $2 AND removed_at IS NULL`, [
      old.id, issue.id,
    ]);
  }
  if (target?.state === 'active') {
    await q.query(
      `INSERT INTO sprint_scope (sprint_id, issue_id, points) SELECT $1, id, story_points FROM issues WHERE id = $2`,
      [target.id, issue.id],
    );
  }
  await q.query(
    `INSERT INTO changelog (issue_id, actor_id, field, from_value, from_string, to_value, to_string) VALUES ($1,$2,'Sprint',$3,$4,$5,$6)`,
    [issue.id, actorId, old?.id ?? null, old?.name ?? null, target?.id ?? null, target?.name ?? null],
  );
}

const SprintInput = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  goal: z.string().max(1000).optional(),
  startDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).nullish(),
  endDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).nullish(),
});

/** Board-level issues only: Stories/Tasks/Bugs (level 0). Epics and subtasks are not planned directly. */
const LEVEL0 = `t.hierarchy_level = 0`;

export function sprintRoutes(db: Db) {
  const r = Router();

  const project = async (user: AuthUser, key: string, perm: 'BROWSE_PROJECTS' | 'MANAGE_SPRINTS' = 'BROWSE_PROJECTS') => {
    const p = await projectByKey(db, user, key);
    await requirePerm(db, user, p.id, perm);
    return p;
  };

  /** Toggle Sprints feature (Space settings → Features). */
  r.patch(
    '/project/:key/features',
    h(async (req) => {
      const user = req.user!;
      const p = await projectByKey(db, user, String(req.params.key));
      await requirePerm(db, user, p.id, 'ADMINISTER_PROJECTS');
      const body = z.object({ sprints: z.boolean() }).parse(req.body);
      if (!body.sprints) {
        const [a] = await db.query(`SELECT 1 FROM sprints WHERE project_id = $1 AND state = 'active'`, [p.id]);
        if (a) throw bad('Complete the active sprint before turning Sprints off');
      }
      await db.query(`UPDATE projects SET sprints_enabled = $1 WHERE id = $2`, [body.sprints, p.id]);
      return { sprints: body.sprints };
    }),
  );

  r.get(
    '/project/:key/sprints',
    h(async (req) => {
      const p = await project(req.user!, String(req.params.key));
      const states = String(req.query.state ?? 'active,future,closed').split(',');
      const rows = await db.query(
        `SELECT * FROM sprints WHERE project_id = $1 AND state = ANY($2::text[])
         ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'future' THEN 1 ELSE 2 END, coalesce(completed_at, created_at) DESC, id`,
        [p.id, states],
      );
      return rows.map(sprintJson);
    }),
  );

  r.post(
    '/project/:key/sprints',
    h(async (req, res) => {
      const user = req.user!;
      const p = await project(user, String(req.params.key), 'MANAGE_SPRINTS');
      const body = SprintInput.parse(req.body ?? {});
      const s = await db.tx(async (q) => {
        const [{ sprint_counter: n }] = await q.query(
          `UPDATE projects SET sprint_counter = sprint_counter + 1, sprints_enabled = true WHERE id = $1 RETURNING sprint_counter`,
          [p.id],
        );
        const [row] = await q.query(
          `INSERT INTO sprints (project_id, name, goal, start_date, end_date) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [p.id, body.name ?? `${p.key} Sprint ${n}`, body.goal ?? '', body.startDate ?? null, body.endDate ?? null],
        );
        return row;
      });
      res.status(201);
      return sprintJson(s);
    }),
  );

  r.patch(
    '/sprint/:id',
    h(async (req) => {
      const user = req.user!;
      const s = await loadSprint(db, user, String(req.params.id));
      await requirePerm(db, user, s.project_id, 'MANAGE_SPRINTS');
      const body = SprintInput.parse(req.body ?? {});
      if (s.state === 'closed' && (body.startDate !== undefined || body.endDate !== undefined)) throw bad('Closed sprint dates cannot change');
      const [u] = await db.query(
        `UPDATE sprints SET name = coalesce($1, name), goal = coalesce($2, goal),
           start_date = CASE WHEN $3::boolean THEN $4::timestamptz ELSE start_date END,
           end_date = CASE WHEN $5::boolean THEN $6::timestamptz ELSE end_date END
         WHERE id = $7 RETURNING *`,
        [body.name ?? null, body.goal ?? null, body.startDate !== undefined, body.startDate ?? null, body.endDate !== undefined, body.endDate ?? null, s.id],
      );
      if (u.start_date && u.end_date && new Date(u.end_date) <= new Date(u.start_date)) throw bad('End date must be after start date');
      return sprintJson(u);
    }),
  );

  r.delete(
    '/sprint/:id',
    h(async (req, res) => {
      const user = req.user!;
      const s = await loadSprint(db, user, String(req.params.id));
      await requirePerm(db, user, s.project_id, 'MANAGE_SPRINTS');
      if (s.state !== 'future') throw bad('Only future sprints can be deleted');
      await db.tx(async (q) => {
        // its work goes back to the backlog
        await q.query(`UPDATE issues SET sprint_id = NULL WHERE sprint_id = $1`, [s.id]);
        await q.query(`DELETE FROM sprints WHERE id = $1`, [s.id]);
      });
      res.status(204).end();
      return undefined;
    }),
  );

  r.post(
    '/sprint/:id/start',
    h(async (req) => {
      const user = req.user!;
      const s = await loadSprint(db, user, String(req.params.id));
      await requirePerm(db, user, s.project_id, 'MANAGE_SPRINTS');
      if (s.state !== 'future') throw bad(`Sprint is already ${s.state}`);
      const body = SprintInput.parse(req.body ?? {});
      const start = new Date(body.startDate ?? s.start_date ?? Date.now());
      const end = new Date(body.endDate ?? s.end_date ?? start.getTime() + 14 * 86400_000);
      if (end <= start) throw bad('End date must be after start date');
      const out = await db.tx(async (q) => {
        const [active] = await q.query(`SELECT name FROM sprints WHERE project_id = $1 AND state = 'active'`, [s.project_id]);
        if (active) throw bad(`${active.name} is still active — complete it first`);
        const [u] = await q.query(
          `UPDATE sprints SET state = 'active', name = coalesce($1, name), goal = coalesce($2, goal), start_date = $3, end_date = $4
           WHERE id = $5 RETURNING *`,
          [body.name ?? null, body.goal ?? null, start.toISOString(), end.toISOString(), s.id],
        );
        // committed scope = board-level work in the sprint at start
        await q.query(
          `INSERT INTO sprint_scope (sprint_id, issue_id, added_at, points)
           SELECT $1, i.id, $2, i.story_points FROM issues i JOIN issue_types t ON t.id = i.type_id
           WHERE i.sprint_id = $1 AND ${LEVEL0}`,
          [s.id, start.toISOString()],
        );
        return u;
      });
      return sprintJson(out);
    }),
  );

  /** Complete: done work stays; open work moves to backlog, an existing future sprint, or a new sprint. */
  r.post(
    '/sprint/:id/complete',
    h(async (req) => {
      const user = req.user!;
      const s = await loadSprint(db, user, String(req.params.id));
      await requirePerm(db, user, s.project_id, 'MANAGE_SPRINTS');
      if (s.state !== 'active') throw bad('Only the active sprint can be completed');
      const body = z.object({ moveTo: z.union([z.literal('backlog'), z.literal('new'), z.string().regex(/^\d+$/), z.number()]).default('backlog') }).parse(req.body ?? {});
      const result = await db.tx(async (q) => {
        let targetId: number | null = null;
        let target: any = null;
        if (body.moveTo === 'new') {
          const [{ sprint_counter: n }] = await q.query(`UPDATE projects SET sprint_counter = sprint_counter + 1 WHERE id = $1 RETURNING sprint_counter`, [s.project_id]);
          [target] = await q.query(`INSERT INTO sprints (project_id, name) VALUES ($1,$2) RETURNING *`, [s.project_id, `${s.p_key} Sprint ${n}`]);
          targetId = target.id;
        } else if (body.moveTo !== 'backlog') {
          [target] = await q.query(`SELECT * FROM sprints WHERE id = $1 AND project_id = $2 AND state = 'future'`, [Number(body.moveTo), s.project_id]);
          if (!target) throw bad('Target must be a future sprint in this project');
          targetId = target.id;
        }
        const items = await q.query(
          `SELECT i.id, i.key, s.category FROM issues i JOIN statuses s ON s.id = i.status_id JOIN issue_types t ON t.id = i.type_id
           WHERE i.sprint_id = $1 AND ${LEVEL0}`,
          [s.id],
        );
        const open = items.filter((i) => i.category !== 'done');
        const done = items.filter((i) => i.category === 'done');
        const now = new Date().toISOString();
        await q.query(
          `UPDATE sprint_scope SET outcome = 'completed' WHERE sprint_id = $1 AND removed_at IS NULL AND issue_id = ANY($2::int[])`,
          [s.id, done.map((i) => i.id)],
        );
        await q.query(
          `UPDATE sprint_scope SET outcome = 'not_completed', removed_at = $3 WHERE sprint_id = $1 AND removed_at IS NULL AND issue_id = ANY($2::int[])`,
          [s.id, open.map((i) => i.id), now],
        );
        for (const i of open) {
          await q.query(`UPDATE issues SET sprint_id = $1, updated_at = now() WHERE id = $2 OR parent_id = $2`, [targetId, i.id]);
          await q.query(
            `INSERT INTO changelog (issue_id, actor_id, field, from_value, from_string, to_value, to_string) VALUES ($1,$2,'Sprint',$3,$4,$5,$6)`,
            [i.id, user.id, s.id, s.name, targetId, target?.name ?? null],
          );
        }
        const [closed] = await q.query(`UPDATE sprints SET state = 'closed', completed_at = $2 WHERE id = $1 RETURNING *`, [s.id, now]);
        return { sprint: sprintJson(closed), completed: done.map((i) => i.key), movedOpen: open.map((i) => i.key), movedTo: target ? sprintJson(target) : null };
      });
      return result;
    }),
  );

  /** Backlog view: open sprints (active first) with their work, then the backlog. */
  r.get(
    '/project/:key/backlog',
    h(async (req) => {
      const p = await project(req.user!, String(req.params.key));
      const sprints = await db.query(
        `SELECT * FROM sprints WHERE project_id = $1 AND state <> 'closed' ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, id`,
        [p.id],
      );
      const rows = await db.query(
        `${SELECT_FROM}
         WHERE i.project_id = $1 AND ${LEVEL0}
           AND (i.sprint_id = ANY($2::int[]) OR (i.sprint_id IS NULL AND s.category <> 'done'))
         ORDER BY i.rank, i.id`,
        [p.id, sprints.map((s) => s.id)],
      );
      const pts = (list: any[]) => list.reduce((n, i) => n + Number(i.story_points ?? 0), 0);
      return {
        sprintsEnabled: p.sprints_enabled,
        sprints: sprints.map((s) => {
          const issues = rows.filter((i) => i.sprint_id === s.id);
          return {
            sprint: sprintJson(s),
            issues: issues.map(issueJson),
            points: { total: pts(issues), done: pts(issues.filter((i) => i.s_category === 'done')), todo: pts(issues.filter((i) => i.s_category === 'todo')) },
          };
        }),
        backlog: { issues: rows.filter((i) => i.sprint_id == null).map(issueJson), points: pts(rows.filter((i) => i.sprint_id == null)) },
      };
    }),
  );

  /**
   * Sprint report + burndown. Remaining work per day = scope at end of day − work resolved by then,
   * measured in story points (unestimated work counts 0) and in issue count.
   */
  r.get(
    '/sprint/:id/report',
    h(async (req) => {
      const user = req.user!;
      const s = await loadSprint(db, user, String(req.params.id));
      await requirePerm(db, user, s.project_id, 'BROWSE_PROJECTS');
      if (s.state === 'future') throw bad('Sprint has not started');
      const scope = await db.query(
        `SELECT sc.*, i.key, i.summary, i.resolved_at, i.story_points AS cur_points, st.name AS status, st.category,
                t.name AS type, t.color AS type_color
         FROM sprint_scope sc JOIN issues i ON i.id = sc.issue_id JOIN statuses st ON st.id = i.status_id
         JOIN issue_types t ON t.id = i.type_id
         WHERE sc.sprint_id = $1 ORDER BY sc.added_at, sc.id`,
        [s.id],
      );
      const start = new Date(s.start_date);
      const until = new Date(s.completed_at ?? Math.min(Date.now(), new Date(s.end_date).getTime()));
      const end = new Date(s.end_date);
      const graceMs = 60_000; // work added in the first minute counts as committed
      const pts = (r: any) => Number(r.points ?? r.cur_points ?? 0);
      const inScope = (r: any, t: Date) => new Date(r.added_at) <= t && (!r.removed_at || new Date(r.removed_at) > t);
      const resolvedBy = (r: any, t: Date) => r.resolved_at && new Date(r.resolved_at) <= t && (!r.removed_at || new Date(r.resolved_at) <= new Date(r.removed_at));

      const days: { date: string; remainingPoints: number; remainingCount: number; scopePoints: number; idealPoints: number }[] = [];
      const committedRows = scope.filter((r) => new Date(r.added_at).getTime() <= start.getTime() + graceMs);
      const committedPts = committedRows.reduce((n, r) => n + pts(r), 0);
      const spanDays = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400_000));
      for (let d = 0; d <= spanDays; d++) {
        const t = new Date(Math.min(start.getTime() + d * 86400_000, end.getTime()));
        if (t > until && d > 0) {
          days.push({ date: t.toISOString(), remainingPoints: NaN, remainingCount: NaN, scopePoints: NaN, idealPoints: committedPts * (1 - d / spanDays) });
          continue;
        }
        const live = scope.filter((r) => inScope(r, t));
        const open = live.filter((r) => !resolvedBy(r, t));
        days.push({
          date: t.toISOString(),
          remainingPoints: open.reduce((n, r) => n + pts(r), 0),
          remainingCount: open.length,
          scopePoints: live.reduce((n, r) => n + pts(r), 0),
          idealPoints: Math.max(0, committedPts * (1 - d / spanDays)),
        });
      }
      const row = (r: any) => ({
        key: r.key, summary: r.summary, points: r.points == null ? null : Number(r.points), status: r.status, category: r.category,
        type: { name: r.type, color: r.type_color }, addedAfterStart: new Date(r.added_at).getTime() > start.getTime() + graceMs,
        outcome: r.outcome ?? (r.removed_at ? 'removed' : r.category === 'done' ? 'completed' : 'open'),
      });
      const rows = scope.map(row);
      const sum = (list: ReturnType<typeof row>[]) => list.reduce((n, r) => n + (r.points ?? 0), 0);
      const completed = rows.filter((r) => r.outcome === 'completed');
      const notCompleted = rows.filter((r) => r.outcome === 'not_completed' || r.outcome === 'open');
      const removed = rows.filter((r) => r.outcome === 'removed');
      return {
        sprint: sprintJson(s),
        summary: {
          committedPoints: committedPts, committedCount: committedRows.length,
          addedPoints: sum(rows.filter((r) => r.addedAfterStart)), addedCount: rows.filter((r) => r.addedAfterStart).length,
          completedPoints: sum(completed), completedCount: completed.length,
          notCompletedPoints: sum(notCompleted), notCompletedCount: notCompleted.length,
          removedCount: removed.length,
        },
        burndown: days,
        completed, notCompleted, removed,
      };
    }),
  );

  /** Velocity: completed vs committed points for the last closed sprints. */
  r.get(
    '/project/:key/velocity',
    h(async (req) => {
      const p = await project(req.user!, String(req.params.key));
      const rows = await db.query(
        `SELECT sp.id, sp.name, sp.start_date, sp.completed_at,
           coalesce(sum(coalesce(sc.points, 0)) FILTER (WHERE sc.added_at <= sp.start_date + interval '1 minute'), 0) AS committed,
           coalesce(sum(coalesce(sc.points, 0)) FILTER (WHERE sc.outcome = 'completed'), 0) AS completed
         FROM sprints sp LEFT JOIN sprint_scope sc ON sc.sprint_id = sp.id
         WHERE sp.project_id = $1 AND sp.state = 'closed'
         GROUP BY sp.id ORDER BY sp.completed_at DESC LIMIT 7`,
        [p.id],
      );
      return rows.reverse().map((r) => ({ sprint: { id: String(r.id), name: r.name }, committed: Number(r.committed), completed: Number(r.completed) }));
    }),
  );

  return r;
}
