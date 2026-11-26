import { Router } from 'express';
import { z } from 'zod';
import type { Db } from './db.js';
import type { AuthUser } from './auth.js';
import { h, bad } from './http.js';
import { projectByKey, requirePerm, roleIn, userRef } from './access.js';
import { can, ROLE_PERMISSIONS } from './permissions.js';
import { issueJson } from './issues.js';
import { FROM } from './jql.js';
import { sprintJson } from './sprints.js';

/** Team-managed defaults observed on the sample site (JIRA_REQUIREMENTS §2, §3.5). */
const DEFAULT_TYPES = [
  { name: 'Epic', level: 1, color: '#6e5dc6' },
  { name: 'Story', level: 0, color: '#22a06b' },
  { name: 'Task', level: 0, color: '#1d7afc' },
  { name: 'Bug', level: 0, color: '#e2483d' },
  { name: 'Subtask', level: -1, color: '#579dff' },
];
const DEFAULT_STATUSES = [
  { name: 'To Do', category: 'todo' },
  { name: 'In Progress', category: 'in_progress' },
  { name: 'In Review', category: 'in_progress' },
  { name: 'Done', category: 'done' },
];

export async function createProject(
  q: Db, user: AuthUser, input: { key: string; name: string; description?: string },
) {
  const [p] = await q.query(
    `INSERT INTO projects (tenant_id, key, name, description, lead_id) VALUES ($1, upper($2), $3, $4, $5) RETURNING *`,
    [user.tenantId, input.key, input.name, input.description ?? '', user.id],
  );
  for (const t of DEFAULT_TYPES) {
    await q.query(`INSERT INTO issue_types (project_id, name, hierarchy_level, color) VALUES ($1,$2,$3,$4)`, [p.id, t.name, t.level, t.color]);
  }
  for (const [i, s] of DEFAULT_STATUSES.entries()) {
    const [st] = await q.query(`INSERT INTO statuses (project_id, name, category, position) VALUES ($1,$2,$3,$4) RETURNING id`, [
      p.id, s.name, s.category, i,
    ]);
    // team-managed default: "any status → this status" transition, named after the target (observed)
    await q.query(`INSERT INTO transitions (project_id, name, from_status_id, to_status_id) VALUES ($1,$2,NULL,$3)`, [p.id, s.name, st.id]);
  }
  await q.query(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,'admin')`, [p.id, user.id]);
  return p;
}

const CreateProject = z.object({
  key: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9]{1,9}$/, 'Key: 2–10 letters/digits, starting with a letter'),
  name: z.string().trim().min(2).max(80),
  description: z.string().max(2000).optional(),
});

export function projectRoutes(db: Db) {
  const r = Router();

  r.get(
    '/project',
    h(async (req) => {
      const user = req.user!;
      const rows = await db.query(
        `SELECT p.*, pm.role, u.display_name AS lead_name,
                (SELECT count(*)::int FROM issues i WHERE i.project_id = p.id) AS issue_count
         FROM projects p
         LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $2
         LEFT JOIN users u ON u.id = p.lead_id
         WHERE p.tenant_id = $1 AND ($3 OR pm.role IS NOT NULL)
         ORDER BY p.name`,
        [user.tenantId, user.id, user.isSiteAdmin],
      );
      return rows.map((p) => ({
        id: String(p.id), key: p.key, name: p.name, description: p.description,
        lead: userRef(p.lead_id, p.lead_name), myRole: p.role, issueCount: p.issue_count,
      }));
    }),
  );

  r.post(
    '/project',
    h(async (req, res) => {
      const user = req.user!;
      const body = CreateProject.parse(req.body);
      const exists = await db.query(`SELECT 1 FROM projects WHERE tenant_id = $1 AND upper(key) = upper($2)`, [user.tenantId, body.key]);
      if (exists.length) throw bad(`Project key ${body.key.toUpperCase()} is already used`, { key: 'taken' });
      const p = await db.tx((q) => createProject(q, user, body));
      res.status(201);
      return { id: String(p.id), key: p.key, name: p.name };
    }),
  );

  r.get(
    '/project/:key',
    h(async (req) => {
      const user = req.user!;
      const p = await projectByKey(db, user, String(req.params.key));
      const role = await requirePerm(db, user, p.id, 'BROWSE_PROJECTS');
      const [types, statuses, transitions, members] = await Promise.all([
        db.query(`SELECT * FROM issue_types WHERE project_id = $1 ORDER BY hierarchy_level DESC, id`, [p.id]),
        db.query(`SELECT * FROM statuses WHERE project_id = $1 ORDER BY position`, [p.id]),
        db.query(`SELECT * FROM transitions WHERE project_id = $1 ORDER BY id`, [p.id]),
        membersOf(db, p.id),
      ]);
      const perms = user.isSiteAdmin ? [...ROLE_PERMISSIONS.admin] : role ? [...ROLE_PERMISSIONS[role]] : [];
      await db.query(
        `INSERT INTO recent_views (user_id, entity_type, entity_id) VALUES ($1,'project',$2)
         ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE SET viewed_at = now()`,
        [user.id, p.id],
      );
      return {
        id: String(p.id), key: p.key, name: p.name, description: p.description,
        lead: members.find((m) => m.accountId === String(p.lead_id)) ?? null,
        issueTypes: types.map((t) => ({ id: String(t.id), name: t.name, hierarchyLevel: t.hierarchy_level, color: t.color })),
        statuses: statuses.map((s) => ({ id: String(s.id), name: s.name, statusCategory: { key: s.category }, position: s.position })),
        transitions: transitions.map((t) => ({ id: String(t.id), name: t.name, from: t.from_status_id && String(t.from_status_id), to: String(t.to_status_id) })),
        members,
        myRole: role,
        myPermissions: perms,
        features: { sprints: p.sprints_enabled },
      };
    }),
  );

  /** Board: one column per status (team-managed board = project statuses), cards ordered by rank. */
  r.get(
    '/project/:key/board',
    h(async (req) => {
      const user = req.user!;
      const p = await projectByKey(db, user, String(req.params.key));
      await requirePerm(db, user, p.id, 'BROWSE_PROJECTS');
      const params: unknown[] = [p.id];
      let filter = '';
      const assignees = String(req.query.assignee ?? '').split(',').filter(Boolean);
      if (assignees.length) {
        const parts: string[] = [];
        if (assignees.includes('unassigned')) parts.push('i.assignee_id IS NULL');
        const ids = assignees.filter((a) => a !== 'unassigned').map(Number).filter(Number.isFinite);
        if (ids.length) { params.push(ids); parts.push(`i.assignee_id = ANY($${params.length}::int[])`); }
        filter += ` AND (${parts.join(' OR ')})`;
      }
      if (req.query.q) { params.push(`%${String(req.query.q)}%`); filter += ` AND (i.summary ILIKE $${params.length} OR i.key ILIKE $${params.length})`; }
      // Sprints on: the board is the active sprint's board (Jira scrum behaviour)
      let sprint: any = null;
      if (p.sprints_enabled) {
        [sprint] = await db.query(`SELECT * FROM sprints WHERE project_id = $1 AND state = 'active'`, [p.id]);
        params.push(sprint?.id ?? -1);
        filter += ` AND i.sprint_id = $${params.length}`;
      }
      // Epics live on the timeline/list, not as board cards (Jira team-managed behaviour)
      const rows = await db.query(
        `SELECT i.*, p.key AS p_key, p.name AS p_name, s.name AS s_name, s.category AS s_category,
                t.name AS t_name, t.hierarchy_level AS t_level, t.color AS t_color,
                pr.name AS pr_name, pr.color AS pr_color,
                a.display_name AS a_name, a.email AS a_email, a.avatar_color AS a_color,
                r.display_name AS r_name, par.key AS parent_key, par.summary AS parent_summary,
                sp.name AS sp_name, sp.state AS sp_state
         ${FROM} LEFT JOIN issues par ON par.id = i.parent_id
         WHERE i.project_id = $1 AND t.hierarchy_level >= 0 AND t.hierarchy_level < 1 ${filter}
         ORDER BY i.rank, i.id`,
        params,
      );
      const statuses = await db.query(`SELECT * FROM statuses WHERE project_id = $1 ORDER BY position`, [p.id]);
      return {
        sprintsEnabled: p.sprints_enabled,
        sprint: sprintJson(sprint),
        columns: statuses.map((s) => ({
          status: { id: String(s.id), name: s.name, statusCategory: { key: s.category } },
          wipLimit: s.wip_limit ?? null,
          issues: rows.filter((i) => i.status_id === s.id).map(issueJson),
        })),
      };
    }),
  );

  /** Group-by counts for the Summary page (observed /rest/internal/data/aggregate/project/{id}, §8). */
  r.get(
    '/project/:key/aggregate',
    h(async (req) => {
      const user = req.user!;
      const p = await projectByKey(db, user, String(req.params.key));
      await requirePerm(db, user, p.id, 'BROWSE_PROJECTS');
      const by = String(req.query.by ?? 'status');
      const groups: Record<string, string> = {
        status: `s.name, s.category, s.position`,
        type: `t.name, t.color`,
        priority: `pr.name, pr.color, pr.position`,
        assignee: `a.display_name`,
      };
      const g = groups[by];
      if (!g) throw bad(`Cannot group by ${by}`);
      const order = by === 'status' ? 's.position' : by === 'priority' ? 'pr.position' : 'count DESC';
      const rows = await db.query(`SELECT ${g}, count(*)::int AS count ${FROM} WHERE i.project_id = $1 GROUP BY ${g} ORDER BY ${order}`, [p.id]);
      const [totals] = await db.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE s.category = 'done' AND i.resolved_at > now() - interval '7 days')::int AS done7,
                count(*) FILTER (WHERE i.created_at > now() - interval '7 days')::int AS created7,
                count(*) FILTER (WHERE i.updated_at > now() - interval '7 days')::int AS updated7,
                count(*) FILTER (WHERE i.due_date BETWEEN current_date AND current_date + 7 AND s.category <> 'done')::int AS due7
         ${FROM} WHERE i.project_id = $1`,
        [p.id],
      );
      return {
        by,
        totals,
        groups: rows.map((x) => ({
          name: x.name ?? x.display_name ?? 'Unassigned',
          category: x.category, color: x.color, count: x.count,
        })),
      };
    }),
  );

  /** Activity stream built from the changelog + comments (observed activity-stream endpoint, §8). */
  r.get(
    '/project/:key/activity',
    h(async (req) => {
      const user = req.user!;
      const p = await projectByKey(db, user, String(req.params.key));
      await requirePerm(db, user, p.id, 'BROWSE_PROJECTS');
      const rows = await db.query(
        `SELECT * FROM (
           SELECT 'change' AS kind, c.created_at, c.field, c.from_string, c.to_string, i.key, i.summary,
                  u.id AS uid, u.display_name, u.avatar_color
           FROM changelog c JOIN issues i ON i.id = c.issue_id JOIN users u ON u.id = c.actor_id WHERE i.project_id = $1
           UNION ALL
           SELECT 'comment', cm.created_at, 'comment', NULL, NULL, i.key, i.summary, u.id, u.display_name, u.avatar_color
           FROM comments cm JOIN issues i ON i.id = cm.issue_id JOIN users u ON u.id = cm.author_id WHERE i.project_id = $1
         ) x ORDER BY created_at DESC LIMIT 50`,
        [p.id],
      );
      return rows.map((x) => ({
        kind: x.kind, created: x.created_at, field: x.field, from: x.from_string, to: x.to_string,
        issue: { key: x.key, summary: x.summary }, actor: userRef(x.uid, x.display_name, null, x.avatar_color),
      }));
    }),
  );

  r.get(
    '/project/:key/members',
    h(async (req) => {
      const user = req.user!;
      const p = await projectByKey(db, user, String(req.params.key));
      await requirePerm(db, user, p.id, 'BROWSE_PROJECTS');
      return membersOf(db, p.id);
    }),
  );

  r.post(
    '/project/:key/members',
    h(async (req) => {
      const user = req.user!;
      const p = await projectByKey(db, user, String(req.params.key));
      await requirePerm(db, user, p.id, 'ADMINISTER_PROJECTS');
      const body = z.object({ email: z.string().email(), role: z.enum(['admin', 'member', 'viewer', 'guest']) }).parse(req.body);
      const [u] = await db.query(`SELECT id FROM users WHERE tenant_id = $1 AND email = lower($2)`, [user.tenantId, body.email]);
      if (!u) throw bad('No user with that email on this site — they need to sign up first');
      await db.query(
        `INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,$3)
         ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [p.id, u.id, body.role],
      );
      return membersOf(db, p.id);
    }),
  );

  /** Users that can be assigned in a project (ASSIGNABLE_USER). */
  r.get(
    '/user/assignable',
    h(async (req) => {
      const user = req.user!;
      const p = await projectByKey(db, user, String(req.query.project ?? ''));
      await requirePerm(db, user, p.id, 'BROWSE_PROJECTS');
      return (await membersOf(db, p.id)).filter((m) => can(m.role, 'ASSIGNABLE_USER'));
    }),
  );

  r.get(
    '/myself',
    h(async (req) => {
      const u = req.user!;
      return { accountId: String(u.id), displayName: u.displayName, emailAddress: u.email, avatarColor: u.avatarColor, isSiteAdmin: u.isSiteAdmin };
    }),
  );

  r.get('/priority', h(async () => (await db.query(`SELECT * FROM priorities ORDER BY position`)).map((p) => ({ id: String(p.id), name: p.name, color: p.color }))));

  return r;
}

async function membersOf(db: Db, projectId: number) {
  const rows = await db.query(
    `SELECT u.id, u.display_name, u.email, u.avatar_color, pm.role FROM project_members pm JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = $1 ORDER BY u.display_name`,
    [projectId],
  );
  return rows.map((m) => ({ ...userRef(m.id, m.display_name, m.email, m.avatar_color)!, role: m.role }));
}

export { roleIn };
