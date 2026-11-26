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
    await q.query(`UPDATE users SET email_verified_at = now() WHERE tenant_id = $1`, [tenant.id]); // demo accounts are verified
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
    // ---- Phase 5 demo: releases + components
    const relDay = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
    const [v10] = await q.query(`INSERT INTO versions (project_id, name, description, start_date, release_date, released, released_at, position) VALUES ($1,'v1.0','First public release',$2,$3,true,now(),1) RETURNING id`, [p.id, relDay(-60), relDay(-30)]);
    const [v11] = await q.query(`INSERT INTO versions (project_id, name, description, start_date, release_date, position) VALUES ($1,'v1.1','Wallet and notifications',$2,$3,2) RETURNING id`, [p.id, relDay(-14), relDay(14)]);
    const [v20] = await q.query(`INSERT INTO versions (project_id, name, description, position) VALUES ($1,'v2.0','Analytics',3) RETURNING id`, [p.id]);
    const [cPay] = await q.query(`INSERT INTO components (project_id, name, description, lead_id) VALUES ($1,'Payments','Wallet, billing and transactions',$2) RETURNING id`, [p.id, dev.id]);
    const [cWeb] = await q.query(`INSERT INTO components (project_id, name, description, lead_id) VALUES ($1,'Web app','Browser UI',$2) RETURNING id`, [p.id, admin.id]);
    for (const [n, v] of [[10, v10], [6, v11], [7, v11], [9, v11], [11, v11], [8, v20], [2, v20]] as const) {
      await q.query(`INSERT INTO issue_versions (issue_id, version_id) VALUES ($1,$2)`, [ids[n - 1], v.id]);
    }
    for (const [n, c] of [[7, cPay], [8, cPay], [11, cWeb], [3, cWeb]] as const) {
      await q.query(`INSERT INTO issue_components (issue_id, component_id) VALUES ($1,$2)`, [ids[n - 1], c.id]);
    }
    // ---- Phase 3 demo: shared filters + a team dashboard
    const filter = async (name: string, jql: string, description: string) => {
      const [f] = await q.query(
        `INSERT INTO filters (tenant_id, owner_id, name, description, jql, share) VALUES ($1,$2,$3,$4,$5,'site') RETURNING id`,
        [tenant.id, admin.id, name, description, jql],
      );
      await q.query(`INSERT INTO filter_favourites (filter_id, user_id) VALUES ($1,$2)`, [f.id, admin.id]);
      return String(f.id);
    };
    const fOpen = await filter('DEMO open work', 'project = DEMO AND statusCategory != Done ORDER BY priority DESC, updated DESC', 'Everything not done in the demo space');
    const fAll = await filter('DEMO all work', 'project = DEMO ORDER BY created DESC', 'All work items in the demo space');
    await filter('Open bugs', 'type = Bug AND resolution = Unresolved ORDER BY priority DESC', 'Unresolved bugs across spaces');
    const [dash] = await q.query(
      `INSERT INTO dashboards (tenant_id, owner_id, name, description, share) VALUES ($1,$2,'DEMO team dashboard','Status of the demo space','site') RETURNING id`,
      [tenant.id, admin.id],
    );
    const gadgets: [string, number, object][] = [
      ['filter-results', 0, { filterId: fOpen, max: 8 }],
      ['created-vs-resolved', 0, { filterId: fAll, days: 14 }],
      ['breakdown', 1, { filterId: fAll, field: 'status' }],
      ['breakdown', 1, { filterId: fOpen, field: 'assignee' }],
      ['assigned-to-me', 1, { max: 5 }],
    ];
    for (const [i, [type, col, config]] of gadgets.entries()) {
      await q.query(`INSERT INTO gadgets (dashboard_id, type, col, position, config) VALUES ($1,$2,$3,$4,$5)`, [dash.id, type, col, i, config]);
    }
    // ---- Phase 3 demo: custom fields + a workflow rule
    const bugType = types.Bug;
    const sev = [
      { id: 's1', value: 'S1 - Critical' }, { id: 's2', value: 'S2 - Major' }, { id: 's3', value: 'S3 - Minor' }, { id: 's4', value: 'S4 - Trivial' },
    ];
    const [fSev] = await q.query(
      `INSERT INTO custom_fields (project_id, name, description, type, options, required, issue_type_ids, position)
       VALUES ($1,'Severity','How bad is the impact?','select',$2::jsonb,false,$3,0) RETURNING id`,
      [p.id, JSON.stringify(sev), [bugType]],
    );
    const [fCust] = await q.query(
      `INSERT INTO custom_fields (project_id, name, description, type, position) VALUES ($1,'Customer','Who asked for this','text',1) RETURNING id`,
      [p.id],
    );
    await q.query(`INSERT INTO issue_custom_values (issue_id, field_id, value) VALUES ($1,$2,'"s1"'::jsonb)`, [ids[10], fSev.id]);
    await q.query(`INSERT INTO issue_custom_values (issue_id, field_id, value) VALUES ($1,$2,'"Acme Bank"'::jsonb)`, [ids[6], fCust.id]);
    // validator: work needs an assignee before it can be Done
    await q.query(`UPDATE transitions SET required_fields = '{assignee}' WHERE project_id = $1 AND to_status_id = $2`, [p.id, st.Done]);
    // ---- Phase 3 demo: epic start dates for the Timeline, a few notifications for Dana
    const epicStarts: Record<number, number> = { 1: -6, 2: -4, 3: 1, 4: 8, 5: -10 };
    for (const [n, off] of Object.entries(epicStarts)) {
      await q.query(`UPDATE issues SET start_date = current_date + $1::int WHERE id = $2`, [off, ids[Number(n) - 1]]);
    }
    for (const n of [6, 7, 8, 9, 10]) {
      await q.query(`UPDATE issues SET start_date = due_date - 4 WHERE id = $1 AND due_date IS NOT NULL`, [ids[n - 1]]);
    }
    await q.query(
      `INSERT INTO notifications (tenant_id, user_id, actor_id, issue_id, kind, data, created_at) VALUES
        ($1,$2,$3,$4,'assigned','{}', now() - interval '2 hours'),
        ($1,$2,$3,$5,'mentioned','{"excerpt":"@Dana Dev can you look at the empty-password case today?"}', now() - interval '40 minutes'),
        ($1,$2,$3,$4,'status','{"from":"To Do","to":"In Progress","category":"in_progress"}', now() - interval '10 minutes')`,
      [tenant.id, dev.id, admin.id, ids[6], ids[10]],
    );
    // ---- Phase 4 demo: automation rules
    await q.query(
      `INSERT INTO automation_rules (project_id, name, enabled, trigger, condition_jql, actions, created_by) VALUES
        ($1, 'New bugs start as High priority', true, '{"type":"issue_created"}', 'type = Bug',
         '[{"type":"set_field","field":"priority","value":"High"},{"type":"add_label","label":"triage"}]', $2),
        ($1, 'Thank whoever finishes work', false, $3::jsonb, NULL,
         '[{"type":"comment","text":"Nice work {{initiator}} — {{issue.key}} is done."}]', $2)`,
      [p.id, admin.id, JSON.stringify({ type: 'issue_transitioned', toStatusId: String(st.Done) })],
    );
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
