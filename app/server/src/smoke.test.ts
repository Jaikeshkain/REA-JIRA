/**
 * End-to-end API smoke test on an in-memory PGlite database.
 * Run: npm test -w server
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from './db.js';
import { buildApp } from './app.js';
import { seed, DEMO_USERS } from './seed.js';
import { rankBetween, initialRanks } from './lexorank.js';
import { parse } from './jql.js';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanFilename } from './attachments.js';

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
};

console.log('unit');
await test('lexorank orders strictly between neighbours', () => {
  const r = initialRanks(5);
  for (let i = 1; i < r.length; i++) assert.ok(r[i - 1] < r[i]);
  for (const [a, b] of [[null, 'i'], ['a', 'b'], ['z', null], ['0i', '1'], ['a', 'a0i']] as const) {
    const m = rankBetween(a, b);
    if (a) assert.ok(a < m, `${a} < ${m}`);
    if (b) assert.ok(m < b, `${m} < ${b}`);
  }
  let lo: string | null = null, hi: string | null = 'i';
  for (let i = 0; i < 50; i++) { hi = rankBetween(lo, hi); } // repeated insert-at-top stays valid
  assert.ok(hi! < 'i');
});
await test('jql parses precedence and ORDER BY', () => {
  const q = parse('project = DEMO AND (status = "To Do" OR assignee = currentUser()) ORDER BY priority DESC, created');
  assert.equal(q.where?.t, 'and');
  assert.deepEqual(q.orderBy, [{ field: 'priority', dir: 'DESC' }, { field: 'created', dir: 'ASC' }]);
  assert.throws(() => parse('project = '), /expected a value/);
});

console.log('api');
const db = await openDb({ dataDir: 'memory://' });
await seed(db);
const attachDir = await mkdtemp(join(tmpdir(), 'tracker-attach-'));
const server = buildApp(db, { attachmentsDir: attachDir }).listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

const call = async (token: string | null, method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const login = async (email: string) => (await call(null, 'POST', '/auth/login', { email, password: DEMO_USERS[0].password })).body.token as string;

try {
  const admin = await login('admin@tracker.test');
  const dev = await login('dev@tracker.test');
  const viewer = await login('viewer@tracker.test');

  await test('auth: rejects bad password and missing token', async () => {
    assert.equal((await call(null, 'POST', '/auth/login', { email: 'admin@tracker.test', password: 'nope' })).status, 401);
    assert.equal((await call(null, 'GET', '/myself')).status, 401);
    assert.equal((await call(admin, 'GET', '/myself')).body.displayName, 'Alex Admin');
  });

  let key = '';
  await test('create issue returns 201 + key, sets reporter and watcher', async () => {
    const r = await call(dev, 'POST', '/issue', {
      fields: { project: { key: 'DEMO' }, issuetype: { name: 'Task' }, summary: 'Smoke test task', description: 'First line\n\n- a\n- b', labels: ['qa'] },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.key, /^DEMO-13$/);
    key = r.body.key;
    const i = (await call(dev, 'GET', `/issue/${key}?expand=transitions,changelog`)).body;
    assert.equal(i.fields.reporter.displayName, 'Dana Dev');
    assert.equal(i.fields.status.name, 'To Do');
    assert.equal(i.fields.watches.isWatching, true);
    assert.equal(i.fields.description.content[1].type, 'bulletList');
    assert.equal(i.transitions.length, 3); // excludes the current status
  });

  await test('subtask requires parent; hierarchy is enforced', async () => {
    const r1 = await call(dev, 'POST', '/issue', { fields: { project: { key: 'DEMO' }, issuetype: { name: 'Subtask' }, summary: 'x' } });
    assert.equal(r1.status, 400);
    const r2 = await call(dev, 'POST', '/issue', { fields: { project: { key: 'DEMO' }, issuetype: { name: 'Subtask' }, summary: 'child', parent: { key } } });
    assert.equal(r2.status, 201);
    const r3 = await call(dev, 'PATCH', `/issue/${key}/fields/parent`, { value: 'DEMO-7' }); // Task under Task → invalid
    assert.equal(r3.status, 400);
    const r4 = await call(dev, 'PATCH', `/issue/${key}/fields/parent`, { value: 'DEMO-1' }); // Task under Epic → ok
    assert.equal(r4.body.fields.parent.key, 'DEMO-1');
  });

  await test('per-field edits write the changelog', async () => {
    await call(dev, 'PATCH', `/issue/${key}/fields/summary`, { value: 'Renamed task' });
    await call(dev, 'PATCH', `/issue/${key}/fields/assignee`, { value: { accountId: '2' } });
    await call(dev, 'PATCH', `/issue/${key}/fields/labels`, { operation: 'ADD', value: ['smoke'] });
    await call(dev, 'PATCH', `/issue/${key}/fields/labels`, { operation: 'REMOVE', value: ['qa'] });
    const r = await call(dev, 'PATCH', `/issue/${key}/fields/priority`, { value: 'High' });
    assert.equal(r.body.fields.summary, 'Renamed task');
    assert.deepEqual(r.body.fields.labels, ['smoke']);
    assert.equal(r.body.fields.priority.name, 'High');
    const log = (await call(dev, 'GET', `/issue/${key}?expand=changelog`)).body.changelog.map((c: any) => c.items[0].field);
    for (const f of ['summary', 'assignee', 'labels', 'priority', 'parent', 'created']) assert.ok(log.includes(f), `changelog has ${f}`);
    assert.equal((await call(dev, 'PATCH', `/issue/${key}/fields/status`, { value: 'Done' })).status, 400);
  });

  await test('transition to Done sets resolution; back to To Do clears it', async () => {
    const tr = (await call(dev, 'GET', `/issue/${key}/transitions`)).body.transitions;
    const done = tr.find((t: any) => t.to.name === 'Done');
    const r = await call(dev, 'POST', `/issue/${key}/transitions`, { transition: { id: done.id } });
    assert.equal(r.body.fields.status.name, 'Done');
    assert.equal(r.body.fields.resolution.name, 'Done');
    const fromDone = (await call(dev, 'GET', `/issue/${key}/transitions`)).body.transitions;
    const todo = fromDone.find((t: any) => t.to.name === 'To Do');
    const r2 = await call(dev, 'POST', `/issue/${key}/transitions`, { transition: { id: todo.id } });
    assert.equal(r2.body.fields.resolution, null);
  });

  await test('board drag: move to In Progress at top of column', async () => {
    let board = (await call(dev, 'GET', '/project/DEMO/board')).body;
    assert.equal(board.sprint.name, 'DEMO Sprint 1');
    assert.ok(!board.columns.some((c: any) => c.issues.some((i: any) => i.key === key)), 'unplanned work is not on the sprint board');
    // plan it into the active sprint, then it shows up
    await call(dev, 'PATCH', `/issue/${key}/fields/sprint`, { value: board.sprint.id });
    board = (await call(dev, 'GET', '/project/DEMO/board')).body;
    const col = board.columns.find((c: any) => c.status.name === 'In Progress');
    const first = col.issues[0]?.key ?? null;
    const r = await call(dev, 'POST', `/issue/${key}/rank`, { statusId: col.status.id, prevKey: null, nextKey: first });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = (await call(dev, 'GET', '/project/DEMO/board')).body.columns.find((c: any) => c.status.name === 'In Progress');
    assert.equal(after.issues[0].key, key);
    assert.ok(!board.columns.some((c: any) => c.issues.some((i: any) => i.fields.issuetype.name === 'Epic')), 'epics not on board');
  });

  await test('comments: add, list, edit own; viewer cannot comment', async () => {
    const c = await call(dev, 'POST', `/issue/${key}/comment`, { body: 'Looks good' });
    assert.equal(c.status, 201);
    const list = (await call(dev, 'GET', `/issue/${key}/comment`)).body;
    assert.equal(list.total, 1);
    assert.equal(list.comments[0].body.type, 'doc');
    assert.equal((await call(dev, 'PUT', `/issue/${key}/comment/${c.body.id}`, { body: 'Edited' })).status, 200);
    assert.equal((await call(viewer, 'POST', `/issue/${key}/comment`, { body: 'hi' })).status, 403);
    assert.equal((await call(dev, 'POST', `/issue/${key}/comment`, { body: '   ' })).status, 400);
  });

  await test('permissions: viewer can browse but not edit/create; member cannot delete', async () => {
    assert.equal((await call(viewer, 'GET', `/issue/${key}`)).status, 200);
    assert.equal((await call(viewer, 'PATCH', `/issue/${key}/fields/summary`, { value: 'x' })).status, 403);
    assert.equal((await call(viewer, 'POST', '/issue', { fields: { project: { key: 'DEMO' }, issuetype: { name: 'Task' }, summary: 'x' } })).status, 403);
    assert.equal((await call(dev, 'DELETE', `/issue/DEMO-9`)).status, 403);
  });

  await test('JQL search: filters, text, ordering, errors, access control', async () => {
    const q = async (t: string, jql: string) => call(t, 'POST', '/search/jql', { jql, maxResults: 100 });
    const all = (await q(admin, 'project = DEMO')).body;
    assert.equal(all.total, 14);
    const mine = (await q(dev, 'assignee = currentUser() ORDER BY priority DESC')).body;
    assert.ok(mine.total >= 3);
    assert.equal(mine.issues[0].fields.priority.name, 'Highest');
    assert.equal((await q(admin, 'text ~ "wallet"')).body.total, 1);
    assert.equal((await q(admin, 'labels in (security) AND type = Bug')).body.issues[0].key, 'DEMO-11');
    assert.equal((await q(admin, 'statusCategory = Done AND resolution is not EMPTY')).body.total, 2);
    assert.equal((await q(admin, 'assignee is EMPTY AND project = DEMO')).body.issues.every((i: any) => !i.fields.assignee), true);
    assert.equal((await q(admin, 'created >= -1d')).body.total, 14);
    assert.equal((await q(admin, 'nonsense = 1')).status, 400);
    assert.equal((await q(admin, 'status = ')).status, 400);
    // a user outside the project sees nothing
    const reg = await call(null, 'POST', '/auth/register', { email: 'outsider@tracker.test', displayName: 'Out Sider', password: 'longenough1' });
    assert.equal(reg.status, 201);
    assert.equal((await q(reg.body.token, 'project = DEMO')).body.total, 0);
    assert.equal((await call(reg.body.token, 'GET', `/issue/${key}`)).status, 404);
  });

  await test('summary aggregates and activity stream', async () => {
    const agg = (await call(admin, 'GET', '/project/DEMO/aggregate?by=status')).body;
    assert.equal(agg.groups.reduce((n: number, g: any) => n + g.count, 0), 14);
    const act = (await call(admin, 'GET', '/project/DEMO/activity')).body;
    assert.ok(act.some((a: any) => a.kind === 'comment'));
    assert.ok(act.some((a: any) => a.field === 'status'));
  });

  await test('projects: create with defaults; duplicate key rejected; delete issue (admin)', async () => {
    const p = await call(dev, 'POST', '/project', { key: 'ops', name: 'Operations' });
    assert.equal(p.status, 201);
    assert.equal(p.body.key, 'OPS');
    const detail = (await call(dev, 'GET', '/project/OPS')).body;
    assert.equal(detail.statuses.length, 4);
    assert.equal(detail.myRole, 'admin');
    assert.equal((await call(dev, 'POST', '/project', { key: 'OPS', name: 'Dup' })).status, 400);
    const d = await call(admin, 'DELETE', `/issue/${key}`);
    assert.equal(d.status, 400); // has a subtask
    assert.equal((await call(admin, 'DELETE', `/issue/${key}?deleteSubtasks=true`)).status, 204);
    assert.equal((await call(admin, 'GET', `/issue/${key}`)).status, 404);
  });

  await test('sprints: backlog, plan, JQL, start rules, estimate change', async () => {
    const bl = (await call(dev, 'GET', '/project/DEMO/backlog')).body;
    assert.deepEqual(bl.sprints.map((s: any) => [s.sprint.name, s.sprint.state]), [['DEMO Sprint 1', 'active'], ['DEMO Sprint 2', 'future']]);
    assert.equal(bl.sprints[0].points.total, 3 + 8 + 3 + 5 + 1);
    assert.ok(bl.backlog.issues.some((i: any) => i.key === 'DEMO-9'));
    assert.ok(!bl.backlog.issues.some((i: any) => i.fields.issuetype.name === 'Epic'), 'epics not in backlog list');
    const s2 = bl.sprints[1].sprint.id;
    // drag DEMO-9 from backlog into Sprint 2, above DEMO-8
    const r = await call(dev, 'POST', '/issue/DEMO-9/rank', { sprintId: s2, prevKey: null, nextKey: 'DEMO-8' });
    assert.equal(r.body.fields.sprint.name, 'DEMO Sprint 2');
    const bl2 = (await call(dev, 'GET', '/project/DEMO/backlog')).body;
    assert.deepEqual(bl2.sprints[1].issues.map((i: any) => i.key), ['DEMO-9', 'DEMO-8']);
    // JQL
    const q = async (jql: string) => (await call(admin, 'POST', '/search/jql', { jql })).body;
    assert.equal((await q('sprint in openSprints()')).total, 5); // seeded 5 (the smoke task was deleted earlier)
    assert.equal((await q('sprint not in openSprints() AND sprint is not EMPTY')).total, 2);
    assert.equal((await q('sprint in futureSprints()')).total, 2);
    assert.equal((await q('sprint = "DEMO Sprint 2"')).total, 2);
    assert.ok((await q('sprint is EMPTY AND project = DEMO')).total > 0);
    // a second sprint cannot start while one is active
    assert.equal((await call(dev, 'POST', `/sprint/${s2}/start`, {})).status, 400);
    // viewer cannot manage sprints
    assert.equal((await call(viewer, 'POST', '/project/DEMO/sprints', {})).status, 403);
    // epics cannot be planned
    assert.equal((await call(dev, 'PATCH', '/issue/DEMO-1/fields/sprint', { value: s2 })).status, 400);
  });

  await test('sprints: complete moves open work to next sprint; report + burndown', async () => {
    const active = (await call(dev, 'GET', '/project/DEMO/sprints?state=active')).body[0];
    const future = (await call(dev, 'GET', '/project/DEMO/sprints?state=future')).body[0];
    // add scope mid-sprint and re-estimate
    await call(dev, 'PATCH', '/issue/DEMO-9/fields/sprint', { value: active.id });
    await call(dev, 'PATCH', '/issue/DEMO-9/fields/storypoints', { value: 4 });
    // finish DEMO-7
    const tr = (await call(dev, 'GET', '/issue/DEMO-7/transitions')).body.transitions.find((t: any) => t.to.name === 'Done');
    await call(dev, 'POST', '/issue/DEMO-7/transitions', { transition: { id: tr.id } });

    const before = (await call(dev, 'GET', `/sprint/${active.id}/report`)).body;
    assert.equal(before.summary.committedPoints, 20);
    assert.equal(before.summary.addedCount, 1);
    assert.ok(before.burndown.length >= 14);
    assert.equal(before.burndown[0].remainingPoints, 20);
    assert.ok(before.burndown.some((d: any) => d.remainingPoints === 19), 'DEMO-12 (1pt) done on day 2');

    const done = await call(dev, 'POST', `/sprint/${active.id}/complete`, { moveTo: future.id });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual(done.body.completed.sort(), ['DEMO-12', 'DEMO-7']);
    assert.ok(done.body.movedOpen.includes('DEMO-6'));
    assert.equal(done.body.movedTo.name, 'DEMO Sprint 2');

    const report = (await call(dev, 'GET', `/sprint/${active.id}/report`)).body;
    assert.equal(report.sprint.state, 'closed');
    assert.equal(report.summary.completedPoints, 9);
    assert.ok(report.notCompleted.some((i: any) => i.key === 'DEMO-6'));
    const board = (await call(dev, 'GET', '/project/DEMO/board')).body;
    assert.equal(board.sprint, null, 'no active sprint after completion');
    assert.equal(board.columns.reduce((n: number, c: any) => n + c.issues.length, 0), 0);
    // start Sprint 2 → carried-over work is committed scope
    const st = await call(dev, 'POST', `/sprint/${future.id}/start`, { endDate: new Date(Date.now() + 7 * 86400_000).toISOString() });
    assert.equal(st.body.state, 'active');
    const r2 = (await call(dev, 'GET', `/sprint/${future.id}/report`)).body;
    assert.ok(r2.summary.committedCount >= 4);
    assert.equal((await call(dev, 'GET', '/project/DEMO/velocity')).body[0].completed, 9);
    // closed sprint: done work cannot be moved out
    assert.equal((await call(dev, 'PATCH', '/issue/DEMO-7/fields/sprint', { value: null })).status, 400);
    assert.equal((await call(dev, 'DELETE', `/sprint/${future.id}`)).status, 400); // active sprint can't be deleted
  });

  await test('links: create both directions, phrases, duplicates, JQL, delete', async () => {
    const types = (await call(dev, 'GET', '/issueLinkType')).body.issueLinkTypes.map((t: any) => t.name);
    assert.deepEqual(types, ['Blocks', 'Cloners', 'Duplicate', 'Relates']);
    // seeded: DEMO-11 blocks DEMO-6
    const six = (await call(dev, 'GET', '/issue/DEMO-6')).body.fields.issuelinks;
    assert.equal(six[0].relation, 'is blocked by');
    assert.equal(six[0].outwardIssue.key, 'DEMO-11');
    const mk = (type: string, out: string, inn: string, t = dev) =>
      call(t, 'POST', '/issueLink', { type: { name: type }, outwardIssue: { key: out }, inwardIssue: { key: inn } });
    const r = await mk('Duplicate', 'DEMO-9', 'DEMO-8');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await mk('Duplicate', 'DEMO-9', 'DEMO-8')).status, 400, 'no duplicate link');
    assert.equal((await mk('Relates', 'DEMO-7', 'DEMO-8')).status, 400, 'symmetric type: reverse already exists');
    assert.equal((await mk('Blocks', 'DEMO-9', 'DEMO-9')).status, 400, 'no self link');
    assert.equal((await mk('Blocks', 'DEMO-9', 'DEMO-6', viewer)).status, 403);
    const eight = (await call(dev, 'GET', '/issue/DEMO-8?expand=changelog')).body;
    assert.ok(eight.fields.issuelinks.some((l: any) => l.relation === 'is duplicated by' && l.outwardIssue.key === 'DEMO-9'));
    assert.ok(eight.changelog.some((c: any) => c.items[0].field === 'Link' && c.items[0].toString === 'This issue is duplicated by DEMO-9'));
    const q = async (jql: string) => (await call(admin, 'POST', '/search/jql', { jql })).body;
    assert.deepEqual((await q('issue in linkedIssues("DEMO-11")')).issues.map((i: any) => i.key), ['DEMO-6']);
    assert.equal((await q('issue in linkedIssues("DEMO-6", "is blocked by")')).total, 1);
    assert.equal((await q('issue in linkedIssues("DEMO-6", "blocks")')).total, 0);
    assert.equal((await call(dev, 'DELETE', `/issueLink/${r.body.id}`)).status, 204);
    assert.ok(!(await call(dev, 'GET', '/issue/DEMO-8')).body.fields.issuelinks.some((l: any) => l.type.name === 'Duplicate'));
  });

  await test('attachments: upload, list, download headers, permissions, limits, cleanup', async () => {
    const up = (t: string, key: string, name: string, type: string, body: Buffer | string) =>
      fetch(`${base}/issue/${key}/attachments`, {
        method: 'POST', body: typeof body === 'string' ? body : new Uint8Array(body), headers: { authorization: `Bearer ${t}`, 'content-type': type, 'x-file-name': encodeURIComponent(name) },
      });
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    let res = await up(dev, 'DEMO-9', 'screen shot.png', 'image/png', png);
    assert.equal(res.status, 201);
    const [img] = await res.json();
    assert.equal(img.filename, 'screen shot.png');
    assert.equal(img.isImage, true);
    // a JSON file must be stored as bytes, not parsed by the JSON middleware
    res = await up(dev, 'DEMO-9', '../../etc/config.json', 'application/json', '{"a":1}');
    const [jsonFile] = await res.json();
    assert.equal(jsonFile.filename, 'config.json', 'path components stripped');
    assert.equal(jsonFile.size, 7);
    // HTML is never served inline, always sandboxed
    res = await up(dev, 'DEMO-9', 'x.html', 'text/html', '<script>alert(1)</script>');
    const [html] = await res.json();
    const dl = await fetch(`${base}/attachment/${html.id}/content`, { headers: { authorization: `Bearer ${dev}` } });
    assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
    assert.match(dl.headers.get('content-disposition')!, /^attachment;/);
    assert.match(dl.headers.get('content-security-policy')!, /sandbox/);
    assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
    const imgDl = await fetch(`${base}/attachment/${img.id}/content`, { headers: { authorization: `Bearer ${viewer}` } });
    assert.equal(imgDl.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await imgDl.arrayBuffer()), png);
    // permissions
    assert.equal((await up(viewer, 'DEMO-9', 'a.txt', 'text/plain', 'x')).status, 403);
    assert.equal((await up(dev, 'DEMO-9', 'empty.txt', 'text/plain', '')).status, 400);
    assert.equal((await up(dev, 'DEMO-9', 'big.bin', 'application/octet-stream', Buffer.alloc(11 * 1024 * 1024))).status, 413);
    assert.equal((await call(viewer, 'DELETE', `/attachment/${img.id}`)).status, 403);
    const listed = (await call(dev, 'GET', '/issue/DEMO-9')).body.fields.attachment;
    assert.equal(listed.length, 3);
    assert.equal((await call(dev, 'DELETE', `/attachment/${html.id}`)).status, 204);
    assert.equal((await readdir(attachDir)).length, 2);
    // a stranger cannot read the bytes
    const reg = await call(null, 'POST', '/auth/register', { email: 'peek@tracker.test', displayName: 'Peek', password: 'longenough1' });
    assert.equal((await fetch(`${base}/attachment/${img.id}/content`, { headers: { authorization: `Bearer ${reg.body.token}` } })).status, 404);
    // deleting the issue removes its files
    assert.equal((await call(admin, 'DELETE', '/issue/DEMO-9')).status, 204);
    assert.equal((await readdir(attachDir)).length, 0);
    assert.equal(cleanFilename('..\\..\\a\u0000b.txt'), 'ab.txt');
  });

  await test('filters: save, validate, share scopes, ownership, favourites', async () => {
    const seeded = (await call(dev, 'GET', '/filter/search')).body.values.map((f: any) => f.name);
    assert.deepEqual(seeded, ['DEMO all work', 'DEMO open work', 'Open bugs']);
    const mk = (body: object, t = dev) => call(t, 'POST', '/filter', body);
    const f = await mk({ name: 'My bugs', jql: 'type = Bug AND assignee = currentUser()' });
    assert.equal(f.status, 201, JSON.stringify(f.body));
    assert.equal(f.body.favourite, true, 'creator stars it');
    assert.equal(f.body.share.type, 'private');
    assert.equal((await mk({ name: 'my BUGS', jql: 'type = Bug' })).status, 400, 'duplicate name per owner');
    assert.equal((await mk({ name: 'Broken', jql: 'nonsense = 1' })).status, 400, 'JQL validated');
    assert.equal((await mk({ name: 'P', jql: 'type = Bug', share: 'project' })).status, 400, 'project share needs a space');
    // private → invisible to others
    assert.equal((await call(viewer, 'GET', `/filter/${f.body.id}`)).status, 404);
    // project share → DEMO members only
    await call(dev, 'PUT', `/filter/${f.body.id}`, { share: 'project', projectKey: 'DEMO' });
    assert.equal((await call(viewer, 'GET', `/filter/${f.body.id}`)).status, 200);
    const out = await call(null, 'POST', '/auth/register', { email: 'out2@tracker.test', displayName: 'Out Two', password: 'longenough1' });
    assert.equal((await call(out.body.token, 'GET', `/filter/${f.body.id}`)).status, 404);
    // only the owner edits/deletes
    assert.equal((await call(viewer, 'PUT', `/filter/${f.body.id}`, { name: 'hijack' })).status, 403);
    assert.equal((await call(viewer, 'DELETE', `/filter/${f.body.id}`)).status, 403);
    // favourites
    await call(viewer, 'POST', `/filter/${f.body.id}/favourite`);
    const starred = (await call(viewer, 'GET', '/filter/search?scope=starred')).body.values;
    assert.deepEqual(starred.map((x: any) => x.name), ['My bugs']);
    assert.equal(starred[0].favouriteCount, 2);
    await call(viewer, 'DELETE', `/filter/${f.body.id}/favourite`);
    assert.equal((await call(viewer, 'GET', '/filter/search?scope=starred')).body.values.length, 0);
    assert.deepEqual((await call(dev, 'GET', '/filter/search?scope=mine')).body.values.map((x: any) => x.name), ['My bugs']);
  });

  await test('dashboards: gadgets data per viewer, layout, ownership, broken filter', async () => {
    const list = (await call(dev, 'GET', '/dashboard')).body.dashboards;
    const team = list.find((d: any) => d.name === 'DEMO team dashboard');
    assert.ok(team && !team.editable, 'shared dashboard visible, not editable by non-owner');
    const full = (await call(dev, 'GET', `/dashboard/${team.id}`)).body;
    assert.equal(full.gadgets.length, 5);
    const data = async (t: string, dashId: string, gid: string) => (await call(t, 'GET', `/dashboard/${dashId}/gadgets/${gid}/data`)).body;
    const byType = (type: string) => full.gadgets.filter((g: any) => g.type === type);
    const results = await data(dev, team.id, byType('filter-results')[0].id);
    assert.ok(results.total > 0 && results.issues.length <= 8);
    assert.equal(results.issues[0].fields.priority.name, 'Highest', 'filter ORDER BY honoured');
    const status = await data(dev, team.id, byType('breakdown')[0].id);
    assert.equal(status.groups.reduce((n: number, g: any) => n + g.count, 0), status.total);
    const cvr = await data(dev, team.id, byType('created-vs-resolved')[0].id);
    assert.equal(cvr.series.length, 14);
    assert.ok(cvr.totals.created > 0);
    const mine = await data(dev, team.id, byType('assigned-to-me')[0].id);
    assert.ok(mine.issues.every((i: any) => i.fields.assignee.displayName === 'Dana Dev'));
    // an outsider can open the site dashboard but sees no DEMO issues in it
    const out = (await call(null, 'POST', '/auth/login', { email: 'out2@tracker.test', password: 'longenough1' })).body.token;
    assert.equal((await data(out, team.id, byType('breakdown')[0].id)).total, 0);
    // non-owners cannot change it
    assert.equal((await call(dev, 'POST', `/dashboard/${team.id}/gadgets`, { type: 'assigned-to-me', config: {} })).status, 403);
    assert.equal((await call(dev, 'DELETE', `/dashboard/${team.id}`)).status, 403);

    // own dashboard: starts with Assigned to me; add, configure, move, remove
    const d = await call(dev, 'POST', '/dashboard', { name: 'Dana board' });
    assert.equal(d.status, 201);
    let mineDash = (await call(dev, 'GET', `/dashboard/${d.body.id}`)).body;
    assert.deepEqual(mineDash.gadgets.map((g: any) => g.type), ['assigned-to-me']);
    const myFilter = (await call(dev, 'GET', '/filter/search?scope=mine')).body.values[0];
    assert.equal((await call(dev, 'POST', `/dashboard/${d.body.id}/gadgets`, { type: 'pie', config: {} })).status, 400);
    assert.equal((await call(dev, 'POST', `/dashboard/${d.body.id}/gadgets`, { type: 'breakdown', config: { filterId: myFilter.id, field: 'colour' } })).status, 400);
    const g = await call(dev, 'POST', `/dashboard/${d.body.id}/gadgets`, { type: 'breakdown', column: 1, config: { filterId: myFilter.id, field: 'priority' } });
    assert.equal(g.status, 201);
    await call(dev, 'PUT', `/dashboard/${d.body.id}/gadgets/${g.body.id}`, { column: 0, position: 0, config: { field: 'labels' } });
    mineDash = (await call(dev, 'GET', `/dashboard/${d.body.id}`)).body;
    assert.deepEqual(mineDash.gadgets.map((x: any) => [x.type, x.column, x.position]), [['breakdown', 0, 0], ['assigned-to-me', 0, 1]]);
    assert.equal(mineDash.gadgets[0].config.field, 'labels');
    // deleting the filter leaves the gadget in place but marks it unavailable
    await call(dev, 'DELETE', `/filter/${myFilter.id}`);
    assert.match((await data(dev, d.body.id, g.body.id)).unavailable, /deleted or is not shared/);
    // private dashboard invisible to others
    assert.equal((await call(viewer, 'GET', `/dashboard/${d.body.id}`)).status, 404);
    assert.equal((await call(dev, 'DELETE', `/dashboard/${d.body.id}`)).status, 204);
  });

  await test('custom fields: types, applicability, history, required, options, JQL', async () => {
    const fields = (await call(dev, 'GET', '/project/DEMO/fields')).body;
    assert.deepEqual(fields.map((f: any) => f.name), ['Severity', 'Customer']);
    const sev = fields[0].id, cust = fields[1].id;
    const bug = (await call(dev, 'GET', '/issue/DEMO-11')).body;
    assert.equal(bug.fields[sev].value, 'S1 - Critical');
    assert.ok(bug.customFields.some((f: any) => f.id === sev));
    const task = (await call(dev, 'GET', '/issue/DEMO-7')).body;
    assert.ok(!task.customFields.some((f: any) => f.id === sev), 'Severity applies to Bugs only');
    assert.equal(task.fields[cust], 'Acme Bank');
    assert.equal((await call(dev, 'PATCH', `/issue/DEMO-7/fields/${sev}`, { value: 's1' })).status, 400);
    // edit + history
    const ed = await call(dev, 'PATCH', `/issue/DEMO-11/fields/${sev}`, { value: 'S2 - Major' });
    assert.equal(ed.status, 200, JSON.stringify(ed.body));
    const hist = (await call(dev, 'GET', '/issue/DEMO-11?expand=changelog')).body.changelog[0].items[0];
    assert.deepEqual([hist.field, hist.fromString, hist.toString], ['Severity', 'S1 - Critical', 'S2 - Major']);
    assert.equal((await call(dev, 'PATCH', `/issue/DEMO-11/fields/${sev}`, { value: 'S9' })).status, 400);
    // admin-only field management; reserved names
    assert.equal((await call(dev, 'POST', '/project/DEMO/fields', { name: 'Effort hours', type: 'number' })).status, 403);
    assert.equal((await call(admin, 'POST', '/project/DEMO/fields', { name: 'Status', type: 'text' })).status, 400);
    assert.equal((await call(admin, 'POST', '/project/DEMO/fields', { name: 'Platforms', type: 'multiselect' })).status, 400, 'choice needs options');
    const effort = (await call(admin, 'POST', '/project/DEMO/fields', { name: 'Effort hours', type: 'number' })).body.id;
    const plat = (await call(admin, 'POST', '/project/DEMO/fields', { name: 'Platforms', type: 'multiselect', options: [{ value: 'iOS' }, { value: 'Android' }, { value: 'Web' }] })).body.id;
    const rev = (await call(admin, 'POST', '/project/DEMO/fields', { name: 'Reviewer', type: 'user' })).body.id;
    // create with custom values; required enforced
    const mk = (extra: object) => call(dev, 'POST', '/issue', { fields: { project: { key: 'DEMO' }, issuetype: { name: 'Task' }, summary: 'CF test', ...extra } });
    const created = await mk({ [cust]: 'Globex', [effort]: 5, [plat]: ['iOS', 'Web'], [rev]: { accountId: '1' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const ci = (await call(dev, 'GET', `/issue/${created.body.key}`)).body;
    assert.equal(ci.fields[effort], 5);
    assert.deepEqual(ci.fields[plat].map((o: any) => o.value), ['iOS', 'Web']);
    assert.equal(ci.fields[rev].displayName, 'Alex Admin');
    assert.equal((await mk({ [effort]: 'lots' })).status, 400);
    assert.equal((await mk({ customfield_99999: 'x' })).status, 400);
    await call(admin, 'PUT', `/field/${cust.split('_')[1]}`, { required: true });
    assert.equal((await mk({})).status, 400, 'Customer now required');
    await call(admin, 'PUT', `/field/${cust.split('_')[1]}`, { required: false });
    // JQL on custom fields
    const q = async (jql: string) => (await call(admin, 'POST', '/search/jql', { jql })).body;
    assert.deepEqual((await q('Severity = "S2 - Major"')).issues.map((i: any) => i.key), ['DEMO-11']);
    assert.deepEqual((await q('"Effort hours" > 3')).issues.map((i: any) => i.key), [created.body.key]);
    assert.equal((await q('Customer ~ glob')).total, 1);
    assert.equal((await q('Platforms in (Web)')).total, 1);
    assert.equal((await q('Reviewer = currentUser()')).total, 1);
    assert.equal((await q(`cf[${sev.split('_')[1]}] is not EMPTY`)).total, 1);
    assert.equal((await q('Severity = "S2 - Major" AND Customer is EMPTY')).total, 1);
    // removing an option clears values that used it
    const sevField = fields[0];
    await call(admin, 'PUT', `/field/${sevField.fieldId}`, { options: sevField.options.filter((o: any) => o.id !== 's2') });
    assert.equal((await call(dev, 'GET', '/issue/DEMO-11')).body.fields[sev], null);
  });

  await test('workflow: validators, role conditions, status editing', async () => {
    const wf = (await call(dev, 'GET', '/project/DEMO/workflow')).body;
    assert.deepEqual(wf.statuses.map((s: any) => s.name), ['To Do', 'In Progress', 'In Review', 'Done']);
    const done = wf.statuses.find((s: any) => s.name === 'Done');
    const toDone = wf.transitions.find((t: any) => t.to === done.id);
    assert.deepEqual(toDone.requiredFields, ['assignee']);
    // validator: DEMO-6 is unassigned
    const trs = (await call(dev, 'GET', '/issue/DEMO-6/transitions')).body.transitions;
    const tDone = trs.find((t: any) => t.to.name === 'Done');
    assert.deepEqual(tDone.requiredFields, ['assignee']);
    const fail = await call(dev, 'POST', '/issue/DEMO-6/transitions', { transition: { id: tDone.id } });
    assert.equal(fail.status, 400);
    assert.match(fail.body.errorMessages[0], /Fill in Assignee before moving to Done/);
    assert.deepEqual(fail.body.errors.missing, ['assignee']);
    // members cannot edit the workflow
    assert.equal((await call(dev, 'POST', '/project/DEMO/statuses', { name: 'QA', category: 'in_progress' })).status, 403);
    // add a status → reachable by default, shows as a board column
    let w = (await call(admin, 'POST', '/project/DEMO/statuses', { name: 'QA', category: 'in_progress' })).body;
    const qa = w.statuses.find((s: any) => s.name === 'QA');
    assert.ok(w.transitions.some((t: any) => t.to === qa.id && t.from === null));
    assert.ok((await call(dev, 'GET', '/project/DEMO/board')).body.columns.some((c: any) => c.status.name === 'QA'));
    // condition: only admins may move to QA
    const toQa = w.transitions.find((t: any) => t.to === qa.id);
    w = (await call(admin, 'PUT', `/transition/${toQa.id}`, { allowedRoles: ['admin'] })).body;
    assert.ok(!(await call(dev, 'GET', '/issue/DEMO-6/transitions')).body.transitions.some((t: any) => t.to.name === 'QA'));
    assert.equal((await call(dev, 'POST', '/issue/DEMO-6/transitions', { transition: { id: toQa.id } })).status, 403);
    assert.equal((await call(admin, 'POST', '/issue/DEMO-6/transitions', { transition: { id: toQa.id } })).body.fields.status.name, 'QA');
    // validators can require custom fields; unknown fields rejected
    assert.equal((await call(admin, 'PUT', `/transition/${toDone.id}`, { requiredFields: ['assignee', 'bogus'] })).status, 400);
    const custId = (await call(dev, 'GET', '/project/DEMO/fields')).body.find((f: any) => f.name === 'Customer').id;
    await call(admin, 'PUT', `/transition/${toDone.id}`, { requiredFields: ['assignee', custId] });
    await call(admin, 'PATCH', '/issue/DEMO-6/fields/assignee', { value: { accountId: '2' } });
    const miss = await call(admin, 'POST', '/issue/DEMO-6/transitions', { transition: { id: toDone.id } });
    assert.match(miss.body.errorMessages[0], /Fill in Customer before moving to Done/);
    await call(admin, 'PATCH', `/issue/DEMO-6/fields/${custId}`, { value: 'Initech' });
    assert.equal((await call(admin, 'POST', '/issue/DEMO-6/transitions', { transition: { id: toDone.id } })).body.fields.resolution.name, 'Done');
    // reorder + recategorise: In Review → done category resolves its work
    const review = w.statuses.find((s: any) => s.name === 'In Review');
    w = (await call(admin, 'PUT', `/status/${qa.id}`, { position: 2 })).body;
    assert.deepEqual(w.statuses.map((s: any) => s.name), ['To Do', 'In Progress', 'QA', 'In Review', 'Done']);
    await call(admin, 'PUT', `/status/${review.id}`, { name: 'Review', category: 'done' });
    const inReview = (await call(admin, 'POST', '/search/jql', { jql: 'status = Review' })).body.issues;
    assert.ok(inReview.length > 0 && inReview.every((i: any) => i.fields.resolution?.name === 'Done'));
    await call(admin, 'PUT', `/status/${review.id}`, { category: 'in_progress' });
    assert.ok((await call(admin, 'POST', '/search/jql', { jql: 'status = Review' })).body.issues.every((i: any) => !i.fields.resolution));
    // delete a status with work: must choose where it goes
    await call(admin, 'POST', '/issue/DEMO-6/transitions', { transition: { id: toQa.id } });
    assert.equal((await call(admin, 'DELETE', `/status/${qa.id}`)).status, 400);
    const todo = w.statuses.find((s: any) => s.name === 'To Do');
    w = (await call(admin, 'DELETE', `/status/${qa.id}?moveTo=${todo.id}`)).body;
    assert.ok(!w.statuses.some((s: any) => s.name === 'QA'));
    assert.equal((await call(admin, 'GET', '/issue/DEMO-6')).body.fields.status.name, 'To Do');
  });

  await test('notifications: assigned, mentions, watching, read state, no self/outsider', async () => {
    const inbox = async (t: string, tab = 'all') => (await call(t, 'GET', `/notifications?tab=${tab}`)).body;
    const before = { dev: (await inbox(dev)).items.length, admin: (await inbox(admin)).items.length, viewer: (await inbox(viewer)).items.length };
    // admin creates work assigned to Dana → Direct "assigned" for Dana only
    const c = await call(admin, 'POST', '/issue', { fields: { project: { key: 'DEMO' }, issuetype: { name: 'Task' }, summary: 'Notify me', assignee: { accountId: '2' } } });
    const key = c.body.key;
    let d = await inbox(dev, 'direct');
    assert.equal(d.items[0].kind, 'assigned');
    assert.equal(d.items[0].issue.key, key);
    assert.equal(d.items[0].actor.displayName, 'Alex Admin');
    assert.equal((await inbox(admin)).items.length, before.admin, 'actor is not notified');
    // Vic watches; Dana comments mentioning Alex → Alex "mentioned" (not also "commented"), Vic "commented", Dana nothing
    await call(admin, 'POST', `/issue/${key}/watchers`, { accountId: '3' });
    const cm = await call(dev, 'POST', `/issue/${key}/comment`, { body: '@Alex Admin please review the copy' });
    assert.equal(cm.body.body.content[0].content[0].type, 'mention', '@name became a mention node');
    const a = await inbox(admin);
    assert.deepEqual(a.items.filter((n: any) => n.issue.key === key).map((n: any) => n.kind), ['mentioned']);
    assert.match(a.items[0].data.excerpt, /please review/);
    const v = await inbox(viewer, 'watching');
    assert.equal(v.items[0].kind, 'commented');
    assert.equal((await inbox(dev)).items.filter((n: any) => n.issue.key === key).length, 1, 'only the earlier assignment');
    // status change → all watchers except the actor
    const tr = (await call(dev, 'GET', `/issue/${key}/transitions`)).body.transitions.find((t: any) => t.to.name === 'In Progress');
    await call(dev, 'POST', `/issue/${key}/transitions`, { transition: { id: tr.id } });
    assert.equal((await inbox(admin)).items[0].kind, 'status');
    assert.deepEqual((await inbox(admin)).items[0].data, { from: 'To Do', to: 'In Progress', category: 'in_progress' });
    assert.equal((await inbox(viewer)).items[0].kind, 'status');
    // people outside the space are never mentioned/notified
    await call(dev, 'POST', `/issue/${key}/comment`, { body: 'cc @Out Two' });
    const outTok = (await call(null, 'POST', '/auth/login', { email: 'out2@tracker.test', password: 'longenough1' })).body.token;
    assert.equal((await inbox(outTok)).items.length, 0);
    // read state + counts
    const unread = (await inbox(viewer)).unread;
    assert.ok(unread.unread >= 2 && unread.watching >= 2);
    const first = (await inbox(viewer)).items[0];
    await call(viewer, 'POST', '/notifications/read', { ids: [first.id] });
    assert.equal((await inbox(viewer)).unread.unread, unread.unread - 1);
    await call(viewer, 'POST', '/notifications/read', { all: true, tab: 'watching' });
    assert.equal((await inbox(viewer)).unread.watching, 0);
    assert.equal((await call(viewer, 'GET', '/notifications?unread=true')).body.items.length, (await inbox(viewer)).unread.unread);
    // people can only read their own
    await call(dev, 'POST', '/notifications/read', { ids: [a.items[0].id] });
    assert.equal((await inbox(admin)).items.find((n: any) => n.id === a.items[0].id).read, false);
    // Timeline rule: start must not be after due
    await call(dev, 'PATCH', `/issue/${key}/fields/duedate`, { value: '2026-12-10' });
    assert.equal((await call(dev, 'PATCH', `/issue/${key}/fields/startdate`, { value: '2026-12-20' })).status, 400);
    assert.equal((await call(dev, 'PATCH', `/issue/${key}/fields/startdate`, { value: '2026-12-01' })).status, 200);
    assert.equal((await call(dev, 'PATCH', `/issue/${key}/fields/duedate`, { value: '2026-11-30' })).status, 400);
    assert.ok(before.dev >= 0 && before.viewer >= 0);
  });

  await test('recently viewed list', async () => {
    await call(admin, 'GET', '/issue/DEMO-2');
    const r = (await call(admin, 'GET', '/recent')).body;
    assert.equal(r.issues[0].key, 'DEMO-2');
  });

  console.log(`\n${passed} passed`);
} finally {
  server.close();
  await db.close();
  await rm(attachDir, { recursive: true, force: true });
}
