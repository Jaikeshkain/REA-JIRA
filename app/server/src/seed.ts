import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';
import { openDb } from './db.js';
import { createUser, type AuthUser } from './auth.js';
import { createProject } from './projects.js';
import { textToAdf } from './adf.js';
import { initialRanks } from './lexorank.js';

/**
 * Demo data for local development only. Credentials are documented in app/README.md
 * and are not used anywhere else.
 */
export const DEMO_USERS = [
  { email: 'admin@tracker.test', name: 'Alex Admin', password: 'tracker-demo-1', siteAdmin: true, role: 'admin' },
  { email: 'dev@tracker.test', name: 'Dana Dev', password: 'tracker-demo-1', siteAdmin: false, role: 'member' },
  { email: 'viewer@tracker.test', name: 'Vic Viewer', password: 'tracker-demo-1', siteAdmin: false, role: 'viewer' },
] as const;

export async function seedIfEmpty(db: Db) {
  const [t] = await db.query(`SELECT id FROM tenants LIMIT 1`);
  if (t || process.env.SKIP_SEED) return;
  await seed(db);
  console.log('Seeded demo site (see app/README.md for demo logins)');
}

export async function seed(db: Db) {
  await db.tx(async (q) => {
    const [tenant] = await q.query(`INSERT INTO tenants (name) VALUES ('Demo site') RETURNING id`);
    const users: AuthUser[] = [];
    for (const u of DEMO_USERS) users.push(await createUser(q, tenant.id, u.email, u.name, u.password, u.siteAdmin));
    const [admin, dev] = users;
    const p = await createProject(q, admin, { key: 'DEMO', name: 'Demo Billing System', description: 'Sample project mirroring the Jira example space.' });
    for (const [i, u] of users.entries()) {
      if (i === 0) continue;
      await q.query(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,$3)`, [p.id, u.id, DEMO_USERS[i].role]);
    }
    const types = Object.fromEntries((await q.query(`SELECT id, name FROM issue_types WHERE project_id = $1`, [p.id])).map((t) => [t.name, t.id]));
    const st = Object.fromEntries((await q.query(`SELECT id, name FROM statuses WHERE project_id = $1`, [p.id])).map((s) => [s.name, s.id]));
    const pr = Object.fromEntries((await q.query(`SELECT id, name FROM priorities`)).map((x) => [x.name, x.id]));

    // Same shape as the Jira example space: 5 epics, tasks under them (JIRA_REQUIREMENTS §2, sample SAM1)
    const items: { type: string; summary: string; status: string; parent?: number; prio: string; assignee?: AuthUser; due?: number; labels?: string[]; desc?: string }[] = [
      { type: 'Epic', summary: 'Implement User Authentication', status: 'To Do', prio: 'High', due: 15 },
      { type: 'Epic', summary: 'Implement Market Analysis Tools', status: 'In Review', prio: 'Medium', due: 14 },
      { type: 'Epic', summary: 'Conduct User Testing for the Platform', status: 'In Progress', prio: 'Medium', due: 15 },
      { type: 'Epic', summary: 'Prepare for Project Launch', status: 'To Do', prio: 'Medium', due: 22 },
      { type: 'Epic', summary: 'Post-Launch Review and Feedback Collection', status: 'Done', prio: 'Low', due: 19 },
      { type: 'Task', summary: 'Set Up Notifications for Users', status: 'To Do', parent: 1, prio: 'Medium', due: 8, labels: ['backend'] },
      { type: 'Task', summary: 'Create Wallet Integration', status: 'In Progress', parent: 2, prio: 'High', assignee: dev, due: 13,
        desc: 'Integrating a wallet is essential for users to manage their assets. This task includes:\n\n- Researching wallet APIs\n- Implementing wallet connection features\n- Testing wallet transactions' },
      { type: 'Story', summary: 'Develop Transaction History Feature', status: 'To Do', parent: 2, prio: 'Medium', due: 11, labels: ['frontend'] },
      { type: 'Task', summary: 'Optimize Performance of the Application', status: 'To Do', parent: 2, prio: 'Low', due: 7 },
      { type: 'Task', summary: 'Finalize Documentation for the Project', status: 'In Review', parent: 5, prio: 'Medium', assignee: admin, due: 9 },
      { type: 'Bug', summary: 'Login form accepts empty password', status: 'To Do', parent: 1, prio: 'Highest', assignee: dev, labels: ['security', 'backend'] },
      { type: 'Task', summary: 'Write launch announcement', status: 'Done', parent: 4, prio: 'Low', assignee: admin },
    ];
    const ranks = initialRanks(items.length);
    const ids: number[] = [];
    for (const [n, it] of items.entries()) {
      const key = `DEMO-${n + 1}`;
      const done = it.status === 'Done';
      const [row] = await q.query(
        `INSERT INTO issues (tenant_id, project_id, number, key, type_id, status_id, priority_id, summary, description,
            assignee_id, reporter_id, creator_id, parent_id, labels, due_date, rank, resolution, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13, CASE WHEN $14::int IS NULL THEN NULL ELSE current_date + $14::int END, $15, $16, $17)
         RETURNING id`,
        [
          tenant.id, p.id, n + 1, key, types[it.type], st[it.status], pr[it.prio], it.summary,
          it.desc ? textToAdf(it.desc) : null, it.assignee?.id ?? null, admin.id,
          it.parent ? ids[it.parent - 1] : null, it.labels ?? [], it.due ?? null, ranks[n],
          done ? 'Done' : null, done ? new Date() : null,
        ],
      );
      ids.push(row.id);
      await q.query(`INSERT INTO watchers (issue_id, user_id) VALUES ($1,$2)`, [row.id, admin.id]);
      await q.query(`INSERT INTO changelog (issue_id, actor_id, field, to_value, to_string) VALUES ($1,$2,'created',$3,$4)`, [
        row.id, admin.id, row.id, key,
      ]);
    }
    await q.query(`UPDATE projects SET issue_counter = $1 WHERE id = $2`, [items.length, p.id]);

    // ---- Phase 2 demo: estimates + one active sprint (day 5 of 14) and one future sprint
    const points: Record<number, number> = { 6: 3, 7: 8, 8: 5, 9: 2, 10: 3, 11: 5, 12: 1 };
    for (const [n, pt] of Object.entries(points)) await q.query(`UPDATE issues SET story_points = $1 WHERE id = $2`, [pt, ids[Number(n) - 1]]);
    const day = 86400_000;
    const start = new Date(Date.now() - 5 * day);
    await q.query(`UPDATE projects SET sprints_enabled = true, sprint_counter = 2 WHERE id = $1`, [p.id]);
    const [s1] = await q.query(
      `INSERT INTO sprints (project_id, name, goal, state, start_date, end_date) VALUES ($1,'DEMO Sprint 1','Ship wallet integration and fix login',
         'active',$2,$3) RETURNING id`,
      [p.id, start.toISOString(), new Date(start.getTime() + 14 * day).toISOString()],
    );
    await q.query(`INSERT INTO sprints (project_id, name, goal) VALUES ($1,'DEMO Sprint 2','Transaction history')`, [p.id]);
    const [s2] = await q.query(`SELECT id FROM sprints WHERE project_id = $1 AND name = 'DEMO Sprint 2'`, [p.id]);
    for (const n of [6, 7, 10, 11, 12]) {
      await q.query(`UPDATE issues SET sprint_id = $1 WHERE id = $2`, [s1.id, ids[n - 1]]);
      await q.query(`INSERT INTO sprint_scope (sprint_id, issue_id, added_at, points) SELECT $1, id, $2, story_points FROM issues WHERE id = $3`, [
        s1.id, start.toISOString(), ids[n - 1],
      ]);
    }
    await q.query(`UPDATE issues SET sprint_id = $1 WHERE id = $2`, [s2.id, ids[7]]);
    // ---- Phase 3 demo links: the login bug blocks notifications; history relates to wallet work
    const lt = Object.fromEntries((await q.query(`SELECT id, name FROM link_types`)).map((x) => [x.name, x.id]));
    await q.query(`INSERT INTO issue_links (type_id, outward_issue_id, inward_issue_id, created_by) VALUES ($1,$2,$3,$4),($5,$6,$7,$4)`, [
      lt.Blocks, ids[10], ids[5], admin.id, lt.Relates, ids[7], ids[6],
    ]);
    // DEMO-12 finished on day 2 so the burndown has a step
    await q.query(`UPDATE issues SET resolved_at = $1 WHERE id = $2`, [new Date(start.getTime() + 2 * day).toISOString(), ids[11]]);
    await q.query(`INSERT INTO comments (issue_id, author_id, body) VALUES ($1,$2,$3)`, [
      ids[6], dev.id, textToAdf('Started on the wallet API spike — will share findings tomorrow.'),
    ]);
  });
}

// `npm run seed` → wipe nothing, seed only when empty
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = await openDb();
  await seedIfEmpty(db);
  await db.close();
}
