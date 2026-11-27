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
import { tick } from './scheduler.js';
import { startMockIdp } from './dev-idp.js';
import { parseDuration, formatDuration } from './timetracking.js';
import { signLicense, verifyLicense, evaluate } from './license.js';
import { generateKeyPairSync } from 'node:crypto';
import type { OidcConfig } from './oidc.js';

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
const app = buildApp(db, { attachmentsDir: attachDir });
const server = app.listen(0);
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

  await test('automation: triggers, conditions, actions, audit log, no loops, permissions', async () => {
    const rules = (await call(admin, 'GET', '/project/DEMO/automation')).body;
    assert.deepEqual(rules.map((r: any) => [r.name, r.enabled]), [['New bugs start as High priority', true], ['Thank whoever finishes work', false]]);
    assert.equal((await call(dev, 'GET', '/project/DEMO/automation')).status, 403, 'members cannot manage rules');
    // seeded rule: new bug → High priority + "triage" label, attributed to the Automation user
    const bug = (await call(dev, 'POST', '/issue', { fields: { project: { key: 'DEMO' }, issuetype: { name: 'Bug' }, summary: 'Crash on save' } })).body.key;
    let b = (await call(dev, 'GET', `/issue/${bug}?expand=changelog`)).body;
    assert.equal(b.fields.priority.name, 'High');
    assert.deepEqual(b.fields.labels, ['triage']);
    assert.ok(b.changelog.some((c: any) => c.author.displayName === 'Automation' && c.items[0].field === 'priority'));
    const runs = (await call(dev, 'GET', `/issue/${bug}/automation`)).body;
    assert.equal(runs[0].status, 'success');
    assert.deepEqual(runs[0].actions, ['Set priority to High', 'Added label triage']);
    // condition miss → logged as no_action, nothing changed
    const task = (await call(dev, 'POST', '/issue', { fields: { project: { key: 'DEMO' }, issuetype: { name: 'Task' }, summary: 'Plain task' } })).body.key;
    assert.equal((await call(dev, 'GET', `/issue/${task}`)).body.fields.priority.name, 'Medium');
    assert.equal((await call(dev, 'GET', `/issue/${task}/automation`)).body[0].status, 'no_action');
    // the Automation user cannot sign in
    assert.equal((await call(null, 'POST', '/auth/login', { email: 'automation@tracker.system', password: '!disabled' })).status, 401);

    // new rule: when moved to In Review → assign reporter + comment with smart values
    const wf = (await call(admin, 'GET', '/project/DEMO/workflow')).body;
    const sid = (n: string) => wf.statuses.find((s: any) => s.name === n).id;
    const bad = await call(admin, 'POST', '/project/DEMO/automation', { name: 'x', trigger: { type: 'issue_created' }, condition: 'nonsense = 1', actions: [{ type: 'add_label', label: 'a' }] });
    assert.equal(bad.status, 400, 'condition JQL validated');
    assert.equal((await call(admin, 'POST', '/project/DEMO/automation', { name: 'x', trigger: { type: 'issue_created' }, actions: [] })).status, 400);
    const r1 = await call(admin, 'POST', '/project/DEMO/automation', {
      name: 'Review hand-off', trigger: { type: 'issue_transitioned', toStatusId: sid('Review') },
      actions: [{ type: 'assign', to: 'reporter' }, { type: 'comment', text: '{{initiator}} sent {{issue.key}} for review' }],
    });
    assert.equal(r1.status, 201, JSON.stringify(r1.body));
    // a rule that would loop if rule changes triggered rules: on any transition, move to In Progress
    await call(admin, 'POST', '/project/DEMO/automation', {
      name: 'Bounce', trigger: { type: 'issue_transitioned', toStatusId: sid('To Do') }, actions: [{ type: 'transition', statusId: sid('In Progress') }],
    });
    const trs = (await call(dev, 'GET', `/issue/${task}/transitions`)).body.transitions;
    await call(dev, 'POST', `/issue/${task}/transitions`, { transition: { id: trs.find((t: any) => t.to.name === 'Review').id } });
    const t1 = (await call(dev, 'GET', `/issue/${task}`)).body;
    assert.equal(t1.fields.assignee.displayName, 'Dana Dev', 'assigned to reporter (Dana created it)');
    const cms = (await call(dev, 'GET', `/issue/${task}/comment`)).body.comments;
    assert.equal(cms[0].author.displayName, 'Automation');
    assert.equal(cms[0].body.content[0].content[0].text, `Dana Dev sent ${task} for review`);
    // moving back to To Do fires "Bounce" once; its own transition does not re-trigger anything
    const back = (await call(dev, 'GET', `/issue/${task}/transitions`)).body.transitions.find((t: any) => t.to.name === 'To Do');
    const moved = await call(dev, 'POST', `/issue/${task}/transitions`, { transition: { id: back.id } });
    assert.equal(moved.body.fields.status.name, 'In Progress', 'response reflects the rule result');
    const bounceRuns = (await call(dev, 'GET', `/issue/${task}/automation`)).body.filter((x: any) => x.rule.name === 'Bounce');
    assert.equal(bounceRuns.length, 1);
    // failing action rolls back the whole rule and logs an error (Done requires an assignee)
    const r2 = await call(admin, 'POST', '/project/DEMO/automation', {
      name: 'Close on comment', trigger: { type: 'comment_added' },
      actions: [{ type: 'add_label', label: 'closed-by-rule' }, { type: 'assign', to: 'unassigned' }, { type: 'transition', statusId: sid('Done') }],
    });
    await call(dev, 'POST', `/issue/${task}/comment`, { body: 'done here' });
    const after = (await call(dev, 'GET', `/issue/${task}`)).body;
    assert.ok(!after.fields.labels.includes('closed-by-rule'), 'rolled back');
    assert.equal(after.fields.assignee.displayName, 'Dana Dev');
    const errRun = (await call(admin, 'GET', `/automation/${r2.body.id}/runs`)).body[0];
    assert.equal(errRun.status, 'error');
    assert.match(errRun.message, /Fill in Assignee/);
    // disable + stats
    await call(admin, 'PUT', `/automation/${r2.body.id}`, { enabled: false });
    const list = (await call(admin, 'GET', '/project/DEMO/automation')).body;
    const st = list.find((x: any) => x.id === r2.body.id);
    assert.equal(st.enabled, false);
    assert.equal(st.stats.errors, 1);
    assert.equal((await call(admin, 'DELETE', `/automation/${r2.body.id}`)).status, 204);
  });

  await test('bulk change: per-item permissions + results, transition, edit, delete', async () => {
    const mk = async (summary: string) => (await call(dev, 'POST', '/issue', { fields: { project: { key: 'DEMO' }, issuetype: { name: 'Task' }, summary } })).body.key;
    const keys = [await mk('Bulk A'), await mk('Bulk B'), await mk('Bulk C')];
    // edit labels on all three (+ an unknown key → per-item error, others still succeed)
    let r = await call(dev, 'POST', '/bulk', { keys: [...keys, 'DEMO-9999'], action: { type: 'edit', field: 'labels', operation: 'ADD', value: ['bulk'] } });
    assert.equal(r.body.succeeded, 3);
    assert.equal(r.body.failed, 1);
    assert.match(r.body.results.find((x: any) => x.key === 'DEMO-9999').error, /not found/i);
    assert.ok((await call(dev, 'GET', `/issue/${keys[1]}`)).body.fields.labels.includes('bulk'));
    // assign + move to In Progress (Done would fail validators for unassigned ones → reported per item)
    await call(dev, 'POST', '/bulk', { keys: keys.slice(0, 2), action: { type: 'edit', field: 'assignee', value: { accountId: '2' } } });
    // the workflow test made Done also require Customer
    const cust = (await call(dev, 'GET', '/project/DEMO/fields')).body.find((f: any) => f.name === 'Customer').id;
    await call(dev, 'POST', '/bulk', { keys: keys.slice(0, 2), action: { type: 'edit', field: cust, value: 'Bulk Co' } });
    const wf = (await call(admin, 'GET', '/project/DEMO/workflow')).body;
    const done = wf.statuses.find((s: any) => s.name === 'Done').id;
    r = await call(dev, 'POST', '/bulk', { keys, action: { type: 'transition', statusId: done } });
    assert.equal(r.body.succeeded, 2, JSON.stringify(r.body));
    assert.match(r.body.results.find((x: any) => x.key === keys[2]).error, /Fill in Assignee/);
    // viewer: every item fails on permissions, nothing changes
    r = await call(viewer, 'POST', '/bulk', { keys, action: { type: 'edit', field: 'priority', value: 'Low' } });
    assert.equal(r.body.succeeded, 0);
    assert.ok(r.body.results.every((x: any) => /EDIT_ISSUES/.test(x.error)));
    // members cannot delete; admins can
    assert.equal((await call(dev, 'POST', '/bulk', { keys, action: { type: 'delete' } })).body.failed, 3);
    assert.equal((await call(admin, 'POST', '/bulk', { keys: [keys[2]], action: { type: 'delete' } })).body.succeeded, 1);
    assert.equal((await call(admin, 'GET', `/issue/${keys[2]}`)).status, 404);
    assert.equal((await call(dev, 'POST', '/bulk', { keys: Array.from({ length: 101 }, (_, i) => `DEMO-${i}`), action: { type: 'delete' } })).status, 400, 'max 100');
  });

  await test('CSV export (columns, custom fields, formula escaping) + table columns', async () => {
    const custId = (await call(dev, 'GET', '/project/DEMO/fields')).body.find((f: any) => f.name === 'Customer').id;
    await call(dev, 'PATCH', `/issue/DEMO-8/fields/${custId}`, { value: '=HYPERLINK("http://x")' });
    const res = await fetch(`${base}/search/csv?jql=${encodeURIComponent('key = DEMO-8')}&columns=key,summary,status,labels,${custId}`, { headers: { authorization: `Bearer ${dev}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /text\/csv/);
    const text = (await res.text()).replace(/^﻿/, '');
    const lines = text.trim().split('\r\n');
    assert.equal(lines[0], 'Key,Summary,Status,Labels,Customer');
    assert.ok(lines[1].startsWith('DEMO-8,Develop Transaction History Feature,'));
    assert.ok(lines[1].endsWith(`"'=HYPERLINK(""http://x"")"`), `formula neutralised: ${lines[1]}`);
    const outsider = (await call(null, 'POST', '/auth/login', { email: 'out2@tracker.test', password: 'longenough1' })).body.token;
    const none = await (await fetch(`${base}/search/csv?jql=${encodeURIComponent('project = DEMO')}`, { headers: { authorization: `Bearer ${outsider}` } })).text();
    assert.equal(none.trim().split('\r\n').length, 1, 'only the header for people without access');
    // column catalogue + table rows with custom values
    const cols = (await call(dev, 'GET', '/search/columns')).body;
    assert.ok(cols.columns.some((c: any) => c.id === custId && c.label === 'Customer'));
    const table = (await call(dev, 'POST', '/search/table', { jql: 'key = DEMO-8', columns: ['key', custId] })).body;
    assert.equal(table.issues[0].custom[custId], '=HYPERLINK("http://x")');
  });

  await test('CSV import: dry run validates, real run creates through normal rules', async () => {
    const csv = [
      'Summary,Work type,Priority,Assignee,Labels,Due date,Severity,Customer,Story points',
      'Imported task,Task,High,dev@tracker.test,"imported, csv",2026-12-31,,Initech,3',
      '"Bug with, comma",Bug,,Dana Dev,,,S1 - Critical,,',
      'Bad row,Task,Urgent,nobody@x.test,,31/12/2026,,,lots',
      ',Task,,,,,,,',
    ].join('\r\n');
    const imp = (dry: boolean, t = dev) =>
      fetch(`${base}/project/DEMO/import?dryRun=${dry}`, { method: 'POST', body: csv, headers: { authorization: `Bearer ${t}`, 'content-type': 'text/csv' } }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const dry = (await imp(true)).body;
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.rows.map((r: any) => r.ok), [true, true, false, false]);
    const bad = dry.rows[2].errors.join(' | ');
    assert.match(bad, /Assignee: "nobody@x.test" is not a member/);
    assert.match(bad, /Due date: use YYYY-MM-DD/);
    assert.match(bad, /Story points: not a number/);
    assert.match(dry.rows[3].errors[0], /Summary is empty/);
    const before = (await call(dev, 'POST', '/search/jql', { jql: 'summary ~ "Imported task"' })).body.total;
    assert.equal(before, 0, 'dry run wrote nothing');
    const real = (await imp(false)).body;
    assert.equal(real.ok, 2);
    const [k1, k2] = real.rows.filter((r: any) => r.ok).map((r: any) => r.key);
    const i1 = (await call(dev, 'GET', `/issue/${k1}`)).body;
    assert.equal(i1.fields.priority.name, 'High');
    assert.equal(i1.fields.assignee.displayName, 'Dana Dev');
    assert.deepEqual(i1.fields.labels, ['imported', 'csv']);
    assert.equal(i1.fields.duedate, '2026-12-31');
    assert.equal(i1.fields.storypoints, 3);
    assert.equal(i1.fields[(await call(dev, 'GET', '/project/DEMO/fields')).body.find((f: any) => f.name === 'Customer').id], 'Initech');
    const i2 = (await call(dev, 'GET', `/issue/${k2}`)).body;
    assert.equal(i2.fields.summary, 'Bug with, comma');
    // the "new bugs → High + triage" automation ran for the imported bug too
    assert.equal(i2.fields.priority.name, 'High');
    assert.ok(i2.fields.labels.includes('triage'));
    assert.equal((await imp(true, viewer)).status, 403);
    const noSummary = await fetch(`${base}/project/DEMO/import?dryRun=true`, { method: 'POST', body: 'Title\r\nx', headers: { authorization: `Bearer ${dev}`, 'content-type': 'text/csv' } });
    assert.equal(noSummary.status, 400);
  });

  await test('real-time: scoped change events after commit, notification pings, auth', async () => {
    /** Minimal SSE client over fetch (same approach as the browser client). */
    const stream = async (token: string | null) => {
      const ctl = new AbortController();
      const events: { event: string; data: any }[] = [];
      const res = await fetch(`${base}/events`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: ctl.signal });
      if (res.status !== 200) return { status: res.status, events, close: () => ctl.abort() };
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i); buf = buf.slice(i + 2);
              const ev = /^event: (.*)$/m.exec(block)?.[1];
              const data = /^data: (.*)$/m.exec(block)?.[1];
              if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : null });
            }
          }
        } catch { /* aborted */ }
      })();
      return { status: 200, events, close: () => ctl.abort() };
    };
    const until = async (cond: () => boolean, ms = 2000) => {
      const t0 = Date.now();
      while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
      return cond();
    };
    assert.equal((await stream(null)).status, 401);
    const vic = await stream(viewer);
    const dana = await stream(dev);
    const out = await stream((await call(null, 'POST', '/auth/login', { email: 'out2@tracker.test', password: 'longenough1' })).body.token);
    assert.ok(await until(() => vic.events.some((e) => e.event === 'hello') && out.events.some((e) => e.event === 'hello')));
    const changes = (s: typeof vic) => s.events.filter((e) => e.event === 'change');

    // a member's edit reaches the viewer (same space) but not the outsider
    await call(dev, 'PATCH', '/issue/DEMO-7/fields/summary', { value: 'Create Wallet Integration (live)' });
    assert.ok(await until(() => changes(vic).length > 0), 'viewer got a change event');
    assert.deepEqual(changes(vic)[0].data, { type: 'change', projectKey: 'DEMO', keys: ['DEMO-7'], actor: '2', scope: 'issue' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(changes(out).length, 0, 'outsider gets nothing');

    // a failed write publishes nothing
    const before = changes(dana).length;
    assert.equal((await call(viewer, 'PATCH', '/issue/DEMO-7/fields/summary', { value: 'nope' })).status, 403);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(changes(dana).length, before);

    // create announces the space; delete announces the deleted key
    const k = (await call(admin, 'POST', '/issue', { fields: { project: { key: 'DEMO' }, issuetype: { name: 'Task' }, summary: 'Live one', assignee: { accountId: '2' } } })).body.key;
    assert.ok(await until(() => changes(vic).some((e) => e.data.scope === 'space')));
    // the assignment notification pings Dana only
    assert.ok(await until(() => dana.events.some((e) => e.event === 'notification')), 'assignee pinged');
    assert.ok(!vic.events.some((e) => e.event === 'notification'));
    await call(admin, 'DELETE', `/issue/${k}`);
    assert.ok(await until(() => changes(vic).some((e) => e.data.keys.includes(k))), 'delete announced with its key');

    // bulk + sprint (id-based) routes resolve their space too
    const n0 = changes(vic).length;
    await call(dev, 'POST', '/bulk', { keys: ['DEMO-7', 'DEMO-8'], action: { type: 'edit', field: 'labels', operation: 'ADD', value: ['live'] } });
    assert.ok(await until(() => changes(vic).slice(n0).some((e) => e.data.keys.includes('DEMO-7') && e.data.keys.includes('DEMO-8'))));
    const sprint = (await call(dev, 'GET', '/project/DEMO/sprints?state=future')).body[0];
    if (sprint) {
      const n1 = changes(vic).length;
      await call(dev, 'PATCH', `/sprint/${sprint.id}`, { goal: 'live goal' });
      assert.ok(await until(() => changes(vic).length > n1));
    }
    vic.close(); dana.close(); out.close();
  });

  await test('email: preferences, batching, read/off/digest rules, escaping, outbox', async () => {
    assert.equal((await call(dev, 'GET', '/myself/preferences')).body.emailNotifications, 'immediate');
    assert.equal((await call(dev, 'PUT', '/myself/preferences', { emailNotifications: 'sometimes' })).status, 400);
    const emails = async (to: string) => db.query(`SELECT * FROM emails WHERE to_email = $1 ORDER BY id`, [to]);
    const later = (min: number) => new Date(Date.now() + min * 60_000);
    // flush whatever earlier tests queued, so counts below are about this test
    await tick(db, later(2));
    const danaBefore = (await emails('dev@tracker.test')).length;

    // assignment → one immediate email to Dana, after the 1-minute batch window; summary is HTML-escaped
    const k = (await call(admin, 'POST', '/issue', { fields: { project: { key: 'DEMO' }, issuetype: { name: 'Task' }, summary: 'Fix <script>alert(1)</script> in footer', assignee: { accountId: '2' } } })).body.key;
    await tick(db, new Date());
    assert.equal((await emails('dev@tracker.test')).length, danaBefore, 'not before the batch window');
    await tick(db, later(2));
    const mine = (await emails('dev@tracker.test')).slice(danaBefore);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].kind, 'notification');
    assert.equal(mine[0].status, 'outbox', 'no SMTP configured → kept in the outbox');
    assert.ok(mine[0].subject.includes(`assigned ${k} to you`), mine[0].subject);
    assert.ok(mine[0].html_body.includes('Fix &lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!mine[0].html_body.includes('<script>'));
    assert.ok(mine[0].text_body.includes(`/browse/${k}`));
    await tick(db, later(3));
    assert.equal((await emails('dev@tracker.test')).length, danaBefore + 1, 'never emailed twice');

    // read in the app first → no email; "off" → no email
    await call(admin, 'POST', `/issue/${k}/watchers`, { accountId: '3' });
    await call(dev, 'POST', `/issue/${k}/comment`, { body: 'on it' });
    await call(viewer, 'POST', '/notifications/read', { all: true });
    await call(admin, 'PUT', '/myself/preferences', { emailNotifications: 'off' });
    await call(dev, 'POST', `/issue/${k}/comment`, { body: 'still on it' });
    const vicBefore = (await emails('viewer@tracker.test')).length;
    const alexBefore = (await emails('admin@tracker.test')).length;
    await tick(db, later(4));
    assert.equal((await emails('viewer@tracker.test')).length, vicBefore + 1, 'only the unread second comment');
    assert.equal((await emails('admin@tracker.test')).length, alexBefore, 'email off');
    await call(admin, 'PUT', '/myself/preferences', { emailNotifications: 'immediate' });

    // digest: waits for the digest hour, then one email for everything, once a day
    await call(viewer, 'PUT', '/myself/preferences', { emailNotifications: 'digest' });
    await call(dev, 'POST', `/issue/${k}/comment`, { body: 'digest me 1' });
    await call(dev, 'POST', `/issue/${k}/comment`, { body: 'digest me 2' });
    const v0 = (await emails('viewer@tracker.test')).length;
    const notDigestHour = later(5);
    if (notDigestHour.getUTCHours() === 8) notDigestHour.setUTCHours(9);
    await tick(db, notDigestHour);
    assert.equal((await emails('viewer@tracker.test')).length, v0, 'digest waits for its hour');
    const digestTime = new Date(Date.now() + 86400_000);
    digestTime.setUTCHours(8, 5, 0, 0);
    await tick(db, digestTime);
    const vic = (await emails('viewer@tracker.test')).slice(v0);
    assert.equal(vic.length, 1);
    assert.equal(vic[0].kind, 'digest');
    assert.match(vic[0].subject, /Your Tracker digest: 2 updates/);
    await call(dev, 'POST', `/issue/${k}/comment`, { body: 'digest me 3' });
    await tick(db, new Date(digestTime.getTime() + 10 * 60_000));
    assert.equal((await emails('viewer@tracker.test')).length, v0 + 1, 'one digest a day');
    await call(viewer, 'PUT', '/myself/preferences', { emailNotifications: 'immediate' });
    await call(viewer, 'POST', '/notifications/read', { all: true });

    // admin outbox
    assert.equal((await call(dev, 'GET', '/admin/emails')).status, 403);
    assert.equal((await call(dev, 'POST', '/admin/scheduler/run')).status, 403);
    const box = (await call(admin, 'GET', '/admin/emails')).body;
    assert.equal(box.mode, 'outbox');
    assert.ok(box.emails.some((e: any) => e.kind === 'digest'));
    assert.equal((await call(admin, 'POST', '/admin/scheduler/run')).status, 200);
  });

  await test('filter subscriptions + scheduled automation rules', async () => {
    const count = async (to: string) =>
      (await db.query(`SELECT count(*)::int AS n FROM emails WHERE to_email = $1 AND kind = 'subscription'`, [to]))[0].n;
    const filters = (await call(dev, 'GET', '/filter/search')).body.values;
    const open = filters.find((f: any) => f.name === 'DEMO open work');
    assert.equal((await call(dev, 'POST', `/filter/${open.id}/subscriptions`, { frequency: 'monthly' })).status, 400);
    const sub = await call(dev, 'POST', `/filter/${open.id}/subscriptions`, { frequency: 'weekly', weekday: 3, hourUtc: 6 });
    assert.equal(sub.status, 201);
    const next = new Date(sub.body.nextRun);
    assert.equal(next.getUTCDay(), 3);
    assert.equal(next.getUTCHours(), 6);
    assert.equal((await call(dev, 'GET', `/filter/${open.id}/subscriptions`)).body.length, 1);
    const before = await count('dev@tracker.test');
    await tick(db, new Date(next.getTime() - 60_000));
    assert.equal(await count('dev@tracker.test'), before, 'not before it is due');
    await tick(db, new Date(next.getTime() + 1000));
    assert.equal(await count('dev@tracker.test'), before + 1);
    const [mail] = await db.query(`SELECT * FROM emails WHERE to_email = 'dev@tracker.test' AND kind = 'subscription' ORDER BY id DESC LIMIT 1`);
    assert.match(mail.subject, /^DEMO open work: \d+ work items?$/);
    assert.match(mail.text_body, /Open the filter: .*\/issues\?filter=/);
    const after = (await call(dev, 'GET', `/filter/${open.id}/subscriptions`)).body[0];
    assert.equal(new Date(after.nextRun).getTime() - next.getTime(), 7 * 86400_000, 'advanced one week');

    // someone with no DEMO access gets nothing unless "send when empty" (if they can see the filter at all)
    const out = (await call(null, 'POST', '/auth/login', { email: 'out2@tracker.test', password: 'longenough1' })).body.token;
    const os = await call(out, 'POST', `/filter/${open.id}/subscriptions`, { frequency: 'daily', hourUtc: 6 });
    if (os.status === 201) {
      await tick(db, new Date(new Date(os.body.nextRun).getTime() + 1000));
      assert.equal(await count('out2@tracker.test'), 0, 'permission-scoped: no rows → no email');
      assert.equal((await call(dev, 'DELETE', `/subscription/${os.body.id}`)).status, 404, 'only your own subscriptions');
    } else {
      assert.equal(os.status, 404);
    }
    assert.equal((await call(dev, 'DELETE', `/subscription/${sub.body.id}`)).status, 204);
    assert.equal((await call(dev, 'GET', `/filter/${open.id}/subscriptions`)).body.length, 0);

    // scheduled rule: needs a JQL; runs for matching work as Automation; next run advances
    assert.equal((await call(admin, 'POST', '/project/DEMO/automation', { name: 'x', trigger: { type: 'scheduled', every: 'day' }, actions: [{ type: 'add_label', label: 'a' }] })).status, 400);
    await call(dev, 'PATCH', '/issue/DEMO-11/fields/labels', { operation: 'ADD', value: ['stale-check'] });
    const rule = (await call(admin, 'POST', '/project/DEMO/automation', {
      name: 'Daily stale sweep', trigger: { type: 'scheduled', every: 'day', hourUtc: 7 }, condition: 'labels = stale-check',
      actions: [{ type: 'add_label', label: 'reviewed' }],
    })).body;
    assert.ok(rule.nextRun, JSON.stringify(rule));
    const due = new Date(rule.nextRun);
    assert.equal(due.getUTCHours(), 7);
    await tick(db, new Date(due.getTime() - 60_000));
    assert.ok(!(await call(dev, 'GET', '/issue/DEMO-11')).body.fields.labels.includes('reviewed'), 'not before it is due');
    await tick(db, new Date(due.getTime() + 1000));
    const i = (await call(dev, 'GET', '/issue/DEMO-11?expand=changelog')).body;
    assert.ok(i.fields.labels.includes('reviewed'));
    const runs = (await call(admin, 'GET', `/automation/${rule.id}/runs`)).body;
    assert.equal(runs[0].status, 'success', JSON.stringify(runs[0]));
    const again = (await call(admin, 'GET', '/project/DEMO/automation')).body.find((r: any) => r.id === rule.id);
    assert.equal(new Date(again.nextRun).getTime() - due.getTime(), 86400_000, 'next run tomorrow');
    await call(admin, 'DELETE', `/automation/${rule.id}`);
  });

  await test('timeline dependencies: blocks links inside the space, scoped to members', async () => {
    const deps = async (t: string | null) => call(t, 'GET', '/project/DEMO/dependencies');
    const base = (await deps(viewer)).body.dependencies;
    assert.ok(base.some((d: any) => d.blocker === 'DEMO-11' && d.blocked === 'DEMO-6'), 'seeded: login bug blocks notifications');
    assert.ok(base.every((d: any) => d.blocker && d.blocked));
    const l = (await call(dev, 'POST', '/issueLink', { type: { name: 'Blocks' }, outwardIssue: { key: 'DEMO-2' }, inwardIssue: { key: 'DEMO-3' } }));
    assert.equal(l.status, 201);
    await call(dev, 'POST', '/issueLink', { type: { name: 'Relates' }, outwardIssue: { key: 'DEMO-2' }, inwardIssue: { key: 'DEMO-4' } });
    const now = (await deps(dev)).body.dependencies;
    assert.ok(now.some((d: any) => d.blocker === 'DEMO-2' && d.blocked === 'DEMO-3'));
    assert.ok(!now.some((d: any) => d.blocked === 'DEMO-4'), 'only "blocks" links are dependencies');
    const out = (await call(null, 'POST', '/auth/login', { email: 'out2@tracker.test', password: 'longenough1' })).body.token;
    assert.equal((await deps(out)).status, 404, 'non-members cannot see the space');
    assert.equal((await deps(null)).status, 401);
    const id = now.find((d: any) => d.blocker === 'DEMO-2').id;
    assert.equal((await call(dev, 'DELETE', `/issueLink/${id}`)).status, 204);
    assert.ok(!(await deps(dev)).body.dependencies.some((d: any) => d.id === id));
  });

  await test('sso: OIDC sign-in, linking, provisioning, one-time codes, SSO-only mode', async () => {
    assert.deepEqual((await call(null, 'GET', '/auth/oidc/config')).body, { enabled: false, name: null, passwordLogin: 'all' });
    assert.equal((await call(null, 'GET', '/auth/oidc/start')).status, 404, 'not configured → no SSO');

    const idp = await startMockIdp();
    const cfg: OidcConfig = { issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, name: 'Acme SSO', redirectUri: '', allowedDomains: [], autoCreate: true, appUrl: 'http://app.test' };
    const app2 = buildApp(db, { attachmentsDir: attachDir, oidc: cfg });
    const srv2 = app2.listen(0);
    const base2 = `http://127.0.0.1:${(srv2.address() as AddressInfo).port}/api`;
    cfg.redirectUri = `${base2}/auth/oidc/callback`;
    const loc = async (url: string) => {
      const r = await fetch(url, { redirect: 'manual' });
      assert.equal(r.status, 302, `${url} → ${r.status}`);
      return r.headers.get('location')!;
    };
    /** Full browser-less round trip; returns the fragment params the app would receive. */
    const sso = async (email: string, next = '/issues') => {
      const auth = new URL(await loc(`${base2}/auth/oidc/start?next=${encodeURIComponent(next)}`));
      assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
      assert.ok(auth.searchParams.get('state') && auth.searchParams.get('nonce'));
      auth.searchParams.set('login_hint', email);
      const cb = await loc(auth.toString());
      const back = await loc(cb);
      assert.ok(back.startsWith('http://app.test/#'), back);
      const p = new URLSearchParams(back.split('#')[1]);
      return { code: p.get('sso'), error: p.get('sso_error'), cb };
    };
    const exchange = async (code: string | null) => {
      const r = await fetch(`${base2}/auth/oidc/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
      return { status: r.status, body: await r.json() };
    };
    try {
      assert.deepEqual(await (await fetch(`${base2}/auth/oidc/config`)).json(), { enabled: true, name: 'Acme SSO', passwordLogin: 'all' });

      // existing account (verified email) → linked, normal session
      const d = await sso('dev@tracker.test', '/issues?filter=1');
      assert.ok(d.code && !d.error, d.error ?? '');
      const ex = await exchange(d.code);
      assert.equal(ex.status, 200);
      assert.equal(ex.body.user.displayName, 'Dana Dev');
      assert.equal(ex.body.next, '/issues?filter=1');
      assert.equal((await call(ex.body.token, 'GET', '/myself')).body.displayName, 'Dana Dev');
      assert.equal((await exchange(d.code)).status, 401, 'hand-off code works once');
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM user_identities WHERE user_id = 2`))[0].n, 1);
      assert.equal((await exchange((await sso('dev@tracker.test')).code)).body.user.accountId, '2', 'same subject → same account');

      // replaying the provider's callback (state is one-time) fails
      assert.match((await loc(d.cb)), /sso_error=/);
      // open redirects are refused
      assert.equal((await exchange((await sso('dev@tracker.test', '//evil.example/x')).code)).body.next, '/');

      // new person → account created just in time, never a site admin, no password sign-in
      const n = await exchange((await sso('new.person@tracker.test')).code);
      assert.equal(n.status, 200);
      assert.equal(n.body.user.displayName, 'Nia Newcomer');
      assert.equal(n.body.user.isSiteAdmin, false);
      for (const pw of ['!sso', '', 'anything']) {
        assert.equal((await call(null, 'POST', '/auth/login', { email: 'new.person@tracker.test', password: pw || 'x' })).status, 401);
      }

      // unverified email: not provisioned, and never linked to an existing account (no takeover)
      assert.match((await sso('unverified@tracker.test')).error ?? '', /verified/);
      await call(null, 'POST', '/auth/register', { email: 'unverified@tracker.test', displayName: 'Real Owner', password: 'longenough1' });
      assert.match((await sso('unverified@tracker.test')).error ?? '', /verified/);
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM user_identities WHERE email = 'unverified@tracker.test'`))[0].n, 0);

      // forged or broken ID tokens are all rejected
      const attacks: [string, any][] = [
        ['alg none', () => ({ header: { alg: 'none' }, key: 'none' })],
        ['HS256', ({ header }: any) => ({ header: { ...header, alg: 'HS256' } })],
        ['signed with another key', () => ({ key: 'other' })],
        ['wrong audience', ({ claims }: any) => ({ claims: { ...claims, aud: 'someone-else' } })],
        ['extra audience without azp', ({ claims }: any) => ({ claims: { ...claims, aud: [claims.aud, 'other'] } })],
        ['wrong issuer', ({ claims }: any) => ({ claims: { ...claims, iss: 'https://evil.example' } })],
        ['expired', ({ claims }: any) => ({ claims: { ...claims, exp: Math.floor(Date.now() / 1000) - 3600 } })],
        ['wrong nonce', ({ claims }: any) => ({ claims: { ...claims, nonce: 'replayed' } })],
        ['tampered after signing', ({ claims }: any) => ({ claims: { ...claims, email: 'admin@tracker.test' }, key: 'other' })],
      ];
      for (const [name, f] of attacks) {
        idp.tamper = f;
        const r = await sso('dev@tracker.test');
        assert.ok(!r.code && r.error, `${name} must be rejected`);
      }
      idp.tamper = null;

      // deactivated account, domain allow-list, no auto-create
      await db.query(`UPDATE users SET active = false WHERE email = 'new.person@tracker.test'`);
      assert.match((await sso('new.person@tracker.test')).error ?? '', /deactivated/);
      cfg.allowedDomains = ['example.com'];
      assert.match((await sso('dev@tracker.test')).error ?? '', /can’t sign in here/);
      cfg.allowedDomains = [];
      await db.query(`DELETE FROM user_identities WHERE email = 'new.person@tracker.test'`);
      await db.query(`DELETE FROM users WHERE email = 'new.person@tracker.test'`);
      cfg.autoCreate = false;
      assert.match((await sso('new.person@tracker.test')).error ?? '', /no account/);
      cfg.autoCreate = true;

      // SSO-only: password sign-in only for site admins (break-glass), sign-up closed
      process.env.SSO_ONLY = '1';
      try {
        assert.equal((await call(null, 'POST', '/auth/login', { email: 'dev@tracker.test', password: DEMO_USERS[0].password })).status, 403);
        assert.equal((await call(null, 'POST', '/auth/login', { email: 'admin@tracker.test', password: DEMO_USERS[0].password })).status, 200);
        assert.equal((await call(null, 'POST', '/auth/register', { email: 'late@tracker.test', displayName: 'Late', password: 'longenough1' })).status, 403);
        assert.equal((await call(null, 'GET', '/auth/oidc/config')).body.passwordLogin, 'admins');
      } finally {
        delete process.env.SSO_ONLY;
      }
    } finally {
      (app2.locals.hub as { close(): void }).close();
      srv2.close();
      await idp.close();
    }
  });

  await test('multi-instance: events cross app instances once; scheduler lock released', async () => {
    const app3 = buildApp(db, { attachmentsDir: attachDir, oidc: null });
    const srv3 = app3.listen(0);
    const base3 = `http://127.0.0.1:${(srv3.address() as AddressInfo).port}/api`;
    await (app3.locals.hub as { ready: Promise<void> }).ready;
    await (app.locals.hub as { ready: Promise<void> }).ready;
    const open = async (b: string, token: string) => {
      const ctl = new AbortController();
      const events: string[] = [];
      const res = await fetch(`${b}/events`, { headers: { authorization: `Bearer ${token}` }, signal: ctl.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; for (const m of dec.decode(value).matchAll(/^event: (.*)$/gm)) events.push(m[1]); } } catch { /* closed */ } })();
      const t0 = Date.now();
      while (!events.includes('hello') && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 20));
      return { events, close: () => ctl.abort(), n: (e: string) => events.filter((x) => x === e).length };
    };
    const onOther = await open(base3, viewer);
    const onSame = await open(base, viewer);
    try {
      const w = await call(dev, 'PATCH', '/issue/DEMO-7/fields/summary', { value: `Wallet (multi-instance ${Date.now()})` });
      assert.ok(w.status < 300, `edit failed: ${w.status} ${JSON.stringify(w.body)}`);
      const t0 = Date.now();
      while (onOther.n('change') < 1 && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(onOther.n('change'), 1, `other instance: exactly once (via the bus) other=${onOther.events} same=${onSame.events}`);
      assert.equal(onSame.n('change'), 1, 'same instance: exactly once (own echo ignored)');
    } finally {
      onOther.close(); onSame.close();
      (app3.locals.hub as { close(): void }).close();
      srv3.close();
    }
    await tick(db);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`))[0].n, 0, 'scheduler lock released');
  });

  await test('API tokens: create once, Bearer + Basic auth, scoped like the user, revoke, expiry', async () => {
    const created = await call(dev, 'POST', '/myself/tokens', { name: 'CI script', expiresInDays: 30 });
    assert.equal(created.status, 201);
    const tok = created.body.token as string;
    assert.match(tok, /^trk_[A-Za-z0-9_-]{40,}$/);
    const list = (await call(dev, 'GET', '/myself/tokens')).body;
    assert.ok(list.some((t: any) => t.name === 'CI script' && !('token' in t)), 'token never listed again');
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM api_tokens WHERE token_hash = $1`, [tok]))[0].n, 0, 'only a hash is stored');

    assert.equal((await call(tok, 'GET', '/myself')).body.displayName, 'Dana Dev', 'Bearer token works');
    const basic = (email: string, t: string) => fetch(`${base}/myself`, { headers: { authorization: `Basic ${Buffer.from(`${email}:${t}`).toString('base64')}` } });
    assert.equal((await basic('dev@tracker.test', tok)).status, 200, 'Basic email:token works (Jira-style)');
    assert.equal((await basic('admin@tracker.test', tok)).status, 401, 'email must match the token owner');
    assert.equal((await call(tok, 'GET', '/admin/audit')).status, 403, 'a token has the owner’s permissions, no more');
    assert.equal((await call(tok, 'POST', '/myself/tokens', { name: 'chain' })).status, 403, 'tokens can’t mint tokens');
    assert.equal((await call('trk_' + 'x'.repeat(43), 'GET', '/myself')).status, 401);

    await db.query(`UPDATE api_tokens SET expires_at = now() - interval '1 minute' WHERE name = 'CI script'`);
    assert.equal((await call(tok, 'GET', '/myself')).status, 401, 'expired');
    await db.query(`UPDATE api_tokens SET expires_at = now() + interval '1 day' WHERE name = 'CI script'`);
    const id = list.find((t: any) => t.name === 'CI script').id;
    assert.equal((await call(viewer, 'DELETE', `/myself/tokens/${id}`)).status, 404, 'only your own');
    assert.equal((await call(dev, 'DELETE', `/myself/tokens/${id}`)).status, 204);
    assert.equal((await call(tok, 'GET', '/myself')).status, 401, 'revoked');
  });

  await test('audit log: config changes, tokens and sign-ins recorded; site admins only', async () => {
    await call(admin, 'POST', '/project/DEMO/fields', { name: 'Audit me', type: 'text' });
    await call(null, 'POST', '/auth/login', { email: 'dev@tracker.test', password: 'wrong-password' });
    const log = await call(admin, 'GET', '/admin/audit?maxResults=200');
    assert.equal(log.status, 200);
    const acts = log.body.values.map((a: any) => `${a.category}|${a.action}|${a.target ?? ''}`);
    assert.ok(acts.some((a: string) => a.startsWith('fields|Changed custom fields') && a.endsWith('|DEMO')), acts.slice(0, 8).join('\n'));
    assert.ok(acts.includes('security|Created an API token|CI script'));
    assert.ok(acts.includes('security|Revoked an API token|CI script'));
    assert.ok(acts.includes('sign-in|Failed password sign-in|dev@tracker.test'));
    assert.ok(acts.some((a: string) => a.startsWith('sign-in|Signed in with password')));
    const only = (await call(admin, 'GET', '/admin/audit?category=security')).body.values;
    assert.ok(only.length >= 2 && only.every((a: any) => a.category === 'security'));
    assert.equal((await call(dev, 'GET', '/admin/audit')).status, 403);
    // nothing sensitive is stored
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action ILIKE '%password%' AND action NOT IN ('Failed password sign-in','Signed in with password')`))[0].n, 0);
  });

  await test('webhooks: signed JSON on issue events, retries with backoff, test ping, private targets refused', async () => {
    const { createServer } = await import('node:http');
    const { createHmac } = await import('node:crypto');
    const got: { headers: Record<string, any>; body: string }[] = [];
    let reply = 200;
    const recv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => { got.push({ headers: req.headers, body }); res.writeHead(reply).end('ok'); });
    }).listen(0, '127.0.0.1');
    await new Promise((r) => recv.once('listening', r));
    const hookUrl = `http://127.0.0.1:${(recv.address() as AddressInfo).port}/hook`;
    const wait = async (n: number, ms = 3000) => { const t0 = Date.now(); while (got.length < n && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25)); };
    try {
      // private/loopback targets are refused unless explicitly allowed
      assert.equal((await call(admin, 'POST', '/webhooks', { name: 'x', url: hookUrl, events: ['issue_created'] })).status, 400);
      assert.equal((await call(admin, 'POST', '/webhooks', { name: 'x', url: 'ftp://example.com/', events: ['issue_created'] })).status, 400);
      assert.equal((await call(admin, 'POST', '/webhooks', { name: 'x', url: 'http://169.254.169.254/latest', events: ['issue_created'] })).status, 400);
      assert.equal((await call(dev, 'GET', '/webhooks')).status, 403, 'site admins only');
      process.env.WEBHOOK_ALLOW_PRIVATE = '1';
      const w = await call(admin, 'POST', '/webhooks', { name: 'CI', url: hookUrl, events: ['issue_created', 'issue_updated', 'comment_created', 'issue_deleted'], projectKey: 'DEMO' });
      assert.equal(w.status, 201);
      const secret = w.body.secret as string;
      assert.match(secret, /^whsec_/);
      assert.ok(!('secret' in (await call(admin, 'GET', '/webhooks')).body.webhooks[0]), 'secret not listed again');

      const k = (await call(dev, 'POST', '/issue', { fields: { project: { key: 'DEMO' }, issuetype: { name: 'Task' }, summary: 'Hooked' } })).body.key;
      await wait(1);
      assert.equal(got.length, 1);
      const first = got[0];
      const p = JSON.parse(first.body);
      assert.equal(p.webhookEvent, 'jira:issue_created');
      assert.equal(p.issue.key, k);
      assert.equal(p.issue.fields.summary, 'Hooked');
      assert.equal(p.user.displayName, 'Dana Dev');
      assert.equal(first.headers['x-tracker-event'], 'issue_created');
      const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(first.headers['x-tracker-signature'])!;
      assert.equal(v1, createHmac('sha256', secret).update(`${t}.${first.body}`).digest('hex'), 'valid HMAC signature');
      assert.ok(Math.abs(Date.now() / 1000 - Number(t)) < 60);

      await call(dev, 'PATCH', `/issue/${k}/fields/summary`, { value: 'Hooked (renamed)' });
      await call(dev, 'PATCH', `/issue/${k}/fields/summary`, { value: 'Hooked (renamed)' }); // no-op: no event
      await call(dev, 'POST', `/issue/${k}/comment`, { body: 'webhook comment' });
      await wait(3);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(got.length, 3, got.map((g) => JSON.parse(g.body).event).join());
      const upd = JSON.parse(got[1].body);
      assert.deepEqual(upd.changelog.items, [{ field: 'summary', fromString: 'Hooked', toString: 'Hooked (renamed)' }]);
      assert.equal(JSON.parse(got[2].body).comment.body, 'webhook comment');

      // receiver down → retried with backoff by the scheduler, then succeeds
      reply = 500;
      assert.equal((await call(admin, 'DELETE', `/issue/${k}`)).status, 204);
      await wait(4);
      let failed: any;
      for (let i = 0; i < 80; i++) { // the receiver can see the request before the result is stored
        [failed] = await db.query(`SELECT * FROM webhook_deliveries WHERE event = 'issue_deleted' ORDER BY id DESC LIMIT 1`);
        if (failed?.status !== 'sending') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(failed.status, 'queued');
      assert.equal(failed.attempts, 1);
      assert.equal(failed.error, 'HTTP 500');
      assert.equal(JSON.parse(got[3].body).issue.key, k, 'delete payload has the gone item');
      reply = 200;
      await tick(db, new Date(Date.now() + 30_000));
      assert.equal(got.length, 4, 'not before the backoff');
      await tick(db, new Date(Date.now() + 90_000));
      assert.equal(got.length, 5, 'retried');
      assert.equal(got[4].headers['x-tracker-delivery'], String(failed.id), 'same delivery id → receivers can de-duplicate');
      assert.equal((await db.query(`SELECT status FROM webhook_deliveries WHERE id = $1`, [failed.id]))[0].status, 'success');

      // other spaces don't trigger a space-scoped hook; test ping; deliveries list; disable
      const ping = await call(admin, 'POST', `/webhook/${w.body.id}/test`);
      assert.equal(ping.body.ok, true);
      assert.equal(JSON.parse(got.at(-1)!.body).event, 'ping');
      const dl = (await call(admin, 'GET', `/webhook/${w.body.id}/deliveries`)).body;
      assert.ok(dl.length === 5 && dl.every((d: any) => d.status === 'success'), JSON.stringify(dl.map((d: any) => [d.event, d.status, d.error])));
      await call(admin, 'PUT', `/webhook/${w.body.id}`, { enabled: false });
      const n = got.length;
      await call(dev, 'POST', '/issue', { fields: { project: { key: 'DEMO' }, issuetype: { name: 'Task' }, summary: 'Not hooked' } });
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(got.length, n, 'disabled hook sends nothing');
      // even an allowed hook can't reach private addresses once the switch is off (checked at connect time)
      await call(admin, 'PUT', `/webhook/${w.body.id}`, { enabled: true });
      delete process.env.WEBHOOK_ALLOW_PRIVATE;
      const blocked = await call(admin, 'POST', `/webhook/${w.body.id}/test`);
      assert.equal(blocked.body.ok, false);
      assert.match(blocked.body.error, /private address/);
      assert.equal(got.length, n);
      const acts = (await call(admin, 'GET', '/admin/audit?category=webhooks')).body.values.map((a: any) => a.action);
      assert.ok(acts.includes('Created a webhook') && acts.includes('Turned off a webhook'));
      assert.equal((await call(admin, 'DELETE', `/webhook/${w.body.id}`)).status, 204);
    } finally {
      delete process.env.WEBHOOK_ALLOW_PRIVATE;
      recv.close();
    }
  });

  await test('releases: versions CRUD, fix versions on work items, history, JQL, release with move, archive, delete', async () => {
    const versions = async () => (await call(dev, 'GET', '/project/DEMO/versions')).body as any[];
    const byName = async (n: string) => (await versions()).find((v) => v.name === n);
    const v11 = await byName('v1.1');
    assert.equal((await versions()).length, 3);
    assert.equal(v11.released, false);
    assert.ok(v11.issues.total > 0);
    const v11Total = v11.issues.total;
    assert.ok((await byName('v1.0')).released);

    // only space admins manage versions; names unique (case-insensitive); dates ordered
    assert.equal((await call(dev, 'POST', '/version', { project: 'DEMO', name: 'v1.2' })).status, 403);
    assert.equal((await call(admin, 'POST', '/version', { project: 'DEMO', name: 'V1.1' })).status, 400);
    assert.equal((await call(admin, 'POST', '/version', { project: 'DEMO', name: 'x', startDate: '2027-02-01', releaseDate: '2027-01-01' })).status, 400);
    const v12 = (await call(admin, 'POST', '/version', { project: 'DEMO', name: 'v1.2', releaseDate: '2027-03-01' })).body;
    assert.equal(v12.name, 'v1.2');

    // members set fix versions; History records it; JSON shows it
    const k = (await call(dev, 'POST', '/issue', { fields: { project: { key: 'DEMO' }, issuetype: { name: 'Task' }, summary: 'Versioned', fixVersions: [{ name: 'v1.1' }], components: ['Payments'] } })).body.key;
    let i = (await call(dev, 'GET', `/issue/${k}?expand=changelog`)).body;
    assert.deepEqual(i.fields.fixVersions.map((v: any) => v.name), ['v1.1']);
    assert.deepEqual(i.fields.components.map((c: any) => c.name), ['Payments']);
    assert.equal((await call(dev, 'PATCH', `/issue/${k}/fields/fixVersions`, { operation: 'ADD', value: [{ id: v12.id }] })).status < 300, true);
    assert.equal((await call(dev, 'PATCH', `/issue/${k}/fields/fixVersions`, { operation: 'REMOVE', value: ['v1.1'] })).status < 300, true);
    assert.equal((await call(dev, 'PATCH', `/issue/${k}/fields/fixVersions`, { value: ['nope'] })).status, 400, 'unknown version');
    assert.equal((await call(viewer, 'PATCH', `/issue/${k}/fields/fixVersions`, { value: ['v1.2'] })).status, 403);
    i = (await call(dev, 'GET', `/issue/${k}?expand=changelog`)).body;
    assert.deepEqual(i.fields.fixVersions.map((v: any) => v.name), ['v1.2']);
    const fv = i.changelog.filter((c: any) => c.items[0].field === 'Fix Version').map((c: any) => [c.items[0].fromString, c.items[0].toString]);
    assert.deepEqual(fv.slice(0, 2), [['v1.1, v1.2', 'v1.2'], ['v1.1', 'v1.1, v1.2']]);

    // JQL
    const jql = async (q: string) => (await call(dev, 'POST', '/search/jql', { jql: `project = DEMO AND ${q}`, maxResults: 100 })).body;
    assert.equal((await jql('fixVersion = v1.1')).total, v11Total);
    assert.ok((await jql('fixVersion in releasedVersions()')).issues.some((x: any) => x.key === 'DEMO-10'));
    assert.ok((await jql('fixVersion in unreleasedVersions()')).issues.some((x: any) => x.key === k));
    const empty = await jql('fixVersion is EMPTY');
    assert.ok(empty.issues.every((x: any) => x.fields.fixVersions.length === 0) && empty.total > 0);
    assert.equal((await jql('component = Payments')).total, (await call(dev, 'GET', '/project/DEMO/components')).body.find((c: any) => c.name === 'Payments').issueCount);
    const notPay = await jql('component != Payments');
    assert.ok(notPay.issues.every((x: any) => x.fields.components.length > 0 && !x.fields.components.some((c: any) => c.name === 'Payments')), 'Jira: != excludes empty');
    assert.equal((await call(dev, 'POST', '/search/jql', { jql: 'component in openSprints()' })).status, 400);

    // release v1.1: unfinished work moves to v1.2, finished work stays
    const before = (await jql('fixVersion = v1.1 AND statusCategory = Done')).total;
    const unfinished = (await jql('fixVersion = v1.1 AND statusCategory != Done')).issues.map((x: any) => x.key);
    assert.ok(unfinished.length > 0);
    assert.equal((await call(dev, 'POST', `/version/${v11.id}/release`, {})).status, 403);
    const rel = await call(admin, 'POST', `/version/${v11.id}/release`, { moveUnresolvedTo: v12.id });
    assert.equal(rel.status, 200);
    assert.equal(rel.body.released, true);
    assert.ok(rel.body.releaseDate);
    assert.equal(rel.body.moved, v11Total - before);
    assert.equal((await jql('fixVersion = v1.1')).total, before);
    assert.equal((await jql('fixVersion = v1.1 AND statusCategory != Done')).total, 0);
    assert.equal((await call(admin, 'POST', `/version/${v11.id}/release`, {})).status, 400, 'already released');
    const moved = (await call(dev, 'GET', `/issue/${unfinished[0]}?expand=changelog`)).body;
    assert.ok(moved.fields.fixVersions.some((v: any) => v.name === 'v1.2'));
    assert.equal(moved.changelog.find((c: any) => c.items[0].field === 'Fix Version').author.displayName, 'Alex Admin');

    // archived versions can't be newly set; delete moves work
    const v10 = await byName('v1.0');
    await call(admin, 'PUT', `/version/${v10.id}`, { archived: true });
    assert.equal((await call(dev, 'PATCH', `/issue/${k}/fields/fixVersions`, { operation: 'ADD', value: ['v1.0'] })).status, 400);
    const v20 = await byName('v2.0');
    const in20 = (await jql('fixVersion = v2.0')).total;
    assert.equal((await call(admin, 'DELETE', `/version/${v20.id}?moveFixIssuesTo=${v12.id}`)).status, 204);
    assert.equal((await versions()).length, 3);
    assert.equal((await jql('fixVersion = v1.2')).total, (await byName('v1.2')).issues.total);
    assert.ok(in20 > 0);

    // other spaces' versions can't be used; outsiders can't see versions
    const out = (await call(null, 'POST', '/auth/login', { email: 'out2@tracker.test', password: 'longenough1' })).body.token;
    assert.equal((await call(out, 'GET', '/project/DEMO/versions')).status, 404);
    assert.equal((await call(out, 'GET', `/version/${v12.id}`)).status, 404);
  });

  await test('components: CRUD, lead must be a member, delete moves work, columns + audit', async () => {
    const comps = async () => (await call(dev, 'GET', '/project/DEMO/components')).body as any[];
    const pay = (await comps()).find((c) => c.name === 'Payments');
    assert.equal(pay.lead.displayName, 'Dana Dev');
    assert.ok(pay.issueCount > 0);
    assert.equal((await call(dev, 'POST', '/component', { project: 'DEMO', name: 'API' })).status, 403, 'space admins only');
    assert.equal((await call(admin, 'POST', '/component', { project: 'DEMO', name: 'API', leadAccountId: 999 })).status, 400);
    const api = (await call(admin, 'POST', '/component', { project: 'DEMO', name: 'API', leadAccountId: '2' })).body;
    assert.equal(api.lead.displayName, 'Dana Dev');
    assert.equal((await call(admin, 'POST', '/component', { project: 'DEMO', name: 'api' })).status, 400, 'unique');
    const ck = (await call(dev, 'POST', '/issue', { fields: { project: { key: 'DEMO' }, issuetype: { name: 'Task' }, summary: 'Component move' } })).body.key;
    await call(dev, 'PATCH', `/issue/${ck}/fields/components`, { operation: 'ADD', value: ['Payments'] });
    const payCount = (await comps()).find((c) => c.name === 'Payments').issueCount;
    assert.equal((await call(admin, 'DELETE', `/component/${pay.id}?moveIssuesTo=${api.id}`)).status, 204);
    const after = await comps();
    assert.ok(!after.some((c) => c.name === 'Payments'));
    assert.equal(after.find((c) => c.name === 'API').issueCount, payCount);
    const i9 = (await call(dev, 'GET', `/issue/${ck}?expand=changelog`)).body;
    assert.deepEqual(i9.fields.components.map((c: any) => c.name), ['API']);

    const cols = (await call(dev, 'GET', '/search/columns')).body.columns.map((c: any) => c.id);
    assert.ok(cols.includes('fixVersions') && cols.includes('components'));
    const table = (await call(dev, 'POST', '/search/table', { jql: `key = ${ck}`, columns: ['key', 'fixVersions', 'components'] })).body;
    assert.deepEqual(table.issues[0].fields.components.map((c: any) => c.name), ['API']);
    const acts = (await call(admin, 'GET', '/admin/audit?category=releases')).body.values.map((a: any) => a.action);
    assert.ok(acts.includes('Released a version') && acts.some((a: string) => a.startsWith('Changed components')));
  });

  await test('time tracking: durations, estimates, work log with estimate adjustment, history, permissions', async () => {
    assert.equal(parseDuration('1w 2d 3h 30m'), (5 * 8 + 2 * 8 + 3) * 3600 + 30 * 60);
    assert.equal(parseDuration('1.5h'), 5400);
    assert.equal(parseDuration('90'), 5400, 'plain numbers are minutes');
    assert.equal(parseDuration('2h30m'), 9000);
    assert.throws(() => parseDuration('2 hours'), /valid time/);
    assert.throws(() => parseDuration('0m'), /more than zero/);
    assert.equal(formatDuration(9000), '2h 30m');
    assert.equal(formatDuration(8 * 3600 * 6), '1w 1d');

    const k = (await call(dev, 'POST', '/issue', { fields: { project: { key: 'DEMO' }, issuetype: { name: 'Task' }, summary: 'Timed', timetracking: { originalEstimate: '2d' } } })).body.key;
    let i = (await call(dev, 'GET', `/issue/${k}`)).body;
    assert.deepEqual(i.fields.timetracking, { originalEstimate: '2d', originalEstimateSeconds: 57600, remainingEstimate: '2d', remainingEstimateSeconds: 57600 });

    // log 3h → remaining auto-reduces to 1d 5h
    const log = async (t: string | null, body: object, q = '') => call(t, 'POST', `/issue/${k}/worklog${q}`, body);
    const w1 = await log(dev, { timeSpent: '3h', comment: 'spike', started: '2026-11-20T09:00:00.000+00:00' });
    assert.equal(w1.status, 201);
    assert.equal(w1.body.timeSpent, '3h');
    i = (await call(dev, 'GET', `/issue/${k}?expand=changelog`)).body;
    assert.equal(i.fields.timetracking.timeSpent, '3h');
    assert.equal(i.fields.timetracking.remainingEstimate, '1d 5h');
    const fields = i.changelog.slice(0, 2).map((c: any) => `${c.items[0].field}:${c.items[0].fromString ?? ''}->${c.items[0].toString}`);
    assert.deepEqual(fields.sort(), ['timeestimate:2d->1d 5h', 'timespent:->3h']);

    // leave / new / manual
    await log(dev, { timeSpent: '1h', adjustEstimate: 'leave' });
    assert.equal((await call(dev, 'GET', `/issue/${k}`)).body.fields.timetracking.remainingEstimate, '1d 5h');
    await log(dev, { timeSpent: '1h', adjustEstimate: 'new', newEstimate: '4h' });
    assert.equal((await call(dev, 'GET', `/issue/${k}`)).body.fields.timetracking.remainingEstimate, '4h');
    await log(dev, { timeSpent: '1h' }, '?adjustEstimate=manual&reduceBy=30m');
    assert.equal((await call(dev, 'GET', `/issue/${k}`)).body.fields.timetracking.remainingEstimate, '3h 30m');
    await log(dev, { timeSpent: '1d' }); // more than remaining → 0, never negative
    i = (await call(dev, 'GET', `/issue/${k}`)).body;
    assert.equal(i.fields.timetracking.remainingEstimate, '0m');
    assert.equal(i.fields.timetracking.timeSpent, '1d 6h');
    assert.equal(i.fields.timespent, (8 + 6) * 3600);
    assert.equal((await log(dev, { timeSpent: 'lots' })).status, 400);
    assert.equal((await log(dev, { timeSpent: '1h', adjustEstimate: 'new' })).status, 400, 'new needs a value');

    // list, edit own, delete adds time back (auto); viewers can't log; members can't touch others' logs
    const list = (await call(viewer, 'GET', `/issue/${k}/worklog`)).body;
    assert.equal(list.total, 5);
    assert.equal(list.worklogs[0].comment, 'spike');
    assert.equal(list.worklogs[0].author.displayName, 'Dana Dev');
    assert.equal((await log(viewer, { timeSpent: '1h' })).status, 403);
    const adminLog = (await log(admin, { timeSpent: '2h', adjustEstimate: 'leave' })).body;
    assert.equal((await call(dev, 'PUT', `/issue/${k}/worklog/${adminLog.id}`, { timeSpent: '1h' })).status, 403, 'not your log');
    assert.equal((await call(dev, 'DELETE', `/issue/${k}/worklog/${adminLog.id}`)).status, 403);
    assert.equal((await call(admin, 'DELETE', `/issue/${k}/worklog/${adminLog.id}?adjustEstimate=leave`)).status, 204, 'admins can delete any log');
    const edited = await call(dev, 'PUT', `/issue/${k}/worklog/${w1.body.id}`, { timeSpent: '4h', adjustEstimate: 'leave' });
    assert.equal(edited.body.timeSpent, '4h');
    assert.equal((await call(dev, 'DELETE', `/issue/${k}/worklog/${w1.body.id}`)).status, 204);
    i = (await call(dev, 'GET', `/issue/${k}`)).body;
    assert.equal(i.fields.timetracking.remainingEstimate, '4h', 'auto: deleting gives the time back');
    assert.equal(i.fields.timetracking.timeSpent, '1d 3h');

    // estimates by per-field edit; clearing; viewers can't
    assert.ok((await call(dev, 'PATCH', `/issue/${k}/fields/timeoriginalestimate`, { value: '3d' })).status < 300);
    assert.ok((await call(dev, 'PATCH', `/issue/${k}/fields/timeestimate`, { value: '1d' })).status < 300);
    assert.equal((await call(viewer, 'PATCH', `/issue/${k}/fields/timeestimate`, { value: '1d' })).status, 403);
    i = (await call(dev, 'GET', `/issue/${k}`)).body;
    assert.equal(i.fields.timetracking.originalEstimate, '3d');
    assert.equal(i.fields.timetracking.remainingEstimate, '1d');
    assert.ok((await call(dev, 'PATCH', `/issue/${k}/fields/timetracking`, { value: { remainingEstimate: null } })).status < 300);
    assert.equal((await call(dev, 'GET', `/issue/${k}`)).body.fields.timetracking.remainingEstimate, undefined);

    // JQL + columns
    const jql = async (q: string) => (await call(dev, 'POST', '/search/jql', { jql: q, maxResults: 100 })).body;
    assert.ok((await jql(`key = ${k} AND timeSpent > 1d AND originalEstimate = 3d AND remainingEstimate is EMPTY`)).total === 1);
    assert.equal((await jql(`key = ${k} AND timeSpent < 2h`)).total, 0);
    assert.ok((await jql('worklogAuthor = currentUser()')).issues.some((x: any) => x.key === k));
    assert.ok((await jql('worklogDate >= -1d')).issues.some((x: any) => x.key === k));
    assert.equal((await jql(`key = ${k} AND worklogDate = "2026-11-20"`)).total, 0, 'that log was deleted');
    assert.equal((await call(dev, 'POST', '/search/jql', { jql: 'timeSpent > lots' })).status, 400);
    const cols = (await call(dev, 'GET', '/search/columns')).body.columns.map((c: any) => c.id);
    assert.ok(['timeoriginalestimate', 'timeestimate', 'timespent'].every((c) => cols.includes(c)));
  });

  await test('WIP limits: set per status by space admins, returned on the board', async () => {
    const wf = (await call(admin, 'GET', '/project/DEMO/workflow')).body;
    const prog = wf.statuses.find((s: any) => s.statusCategory.key === 'in_progress');
    assert.equal(prog.wipLimit, null);
    assert.equal((await call(dev, 'PUT', `/status/${prog.id}`, { wipLimit: 1 })).status, 403);
    assert.equal((await call(admin, 'PUT', `/status/${prog.id}`, { wipLimit: 0 })).status, 400);
    const after = (await call(admin, 'PUT', `/status/${prog.id}`, { wipLimit: 1 })).body;
    assert.equal(after.statuses.find((s: any) => s.id === prog.id).wipLimit, 1);
    const board = (await call(dev, 'GET', '/project/DEMO/board')).body;
    assert.equal(board.columns.find((c: any) => c.status.id === prog.id).wipLimit, 1);
    await call(admin, 'PUT', `/status/${prog.id}`, { wipLimit: null });
    assert.equal((await call(dev, 'GET', '/project/DEMO/board')).body.columns.find((c: any) => c.status.id === prog.id).wipLimit, null);
  });

  await test('votes: vote once, not on own or resolved work, voters need permission, JQL', async () => {
    const k = (await call(admin, 'POST', '/issue', { fields: { project: { key: 'DEMO' }, issuetype: { name: 'Task' }, summary: 'Vote me' } })).body.key;
    assert.equal((await call(admin, 'POST', `/issue/${k}/votes`)).status, 400, 'reporter can’t vote');
    const v = (await call(dev, 'POST', `/issue/${k}/votes`)).body;
    assert.deepEqual([v.votes, v.hasVoted], [1, true]);
    assert.equal((await call(dev, 'POST', `/issue/${k}/votes`)).body.votes, 1, 'once');
    const seen = (await call(viewer, 'POST', `/issue/${k}/votes`)).body;
    assert.equal(seen.votes, 2);
    assert.deepEqual(seen.voters.map((u: any) => u.displayName).sort(), ['Dana Dev', 'Vic Viewer']);
    assert.equal((await call(dev, 'GET', `/issue/${k}`)).body.fields.votes.votes, 2);
    const jql = async (q: string) => (await call(dev, 'POST', '/search/jql', { jql: q, maxResults: 100 })).body;
    assert.equal((await jql(`key = ${k} AND votes >= 2 AND voter = currentUser()`)).total, 1);
    assert.equal((await jql(`project = DEMO AND votes > 0 ORDER BY votes DESC`)).issues[0].key, k);
    assert.equal((await call(dev, 'DELETE', `/issue/${k}/votes`)).body.votes, 1);
    assert.equal((await jql(`key = ${k} AND voter = currentUser()`)).total, 0);
  });

  await test('JQL history: WAS / WAS NOT / WAS IN, CHANGED FROM TO BY AFTER, user fields', async () => {
    const k = (await call(admin, 'POST', '/issue', { fields: { project: { key: 'DEMO' }, issuetype: { name: 'Task' }, summary: 'History JQL' } })).body.key;
    const tr = (await call(dev, 'GET', `/issue/${k}/transitions`)).body.transitions;
    const toProg = tr.find((t: any) => t.to.statusCategory.key === 'in_progress');
    await call(dev, 'POST', `/issue/${k}/transitions`, { transition: { id: toProg.id } });
    await call(dev, 'PATCH', `/issue/${k}/fields/assignee`, { value: { accountId: '2' } });
    await call(admin, 'PATCH', `/issue/${k}/fields/assignee`, { value: null });
    const has = async (q: string) => (await call(dev, 'POST', '/search/jql', { jql: `key = ${k} AND ${q}` })).body.total === 1;
    const prog = toProg.to.name;
    assert.ok(await has(`status WAS "To Do"`), 'was, via History');
    assert.ok(await has(`status WAS "${prog}"`), 'was, current value');
    assert.ok(!(await has('status WAS Done')));
    assert.ok(await has('status WAS NOT Done'));
    assert.ok(await has(`status WAS IN (Done, "To Do")`));
    assert.ok(await has(`status CHANGED FROM "To Do" TO "${prog}"`));
    assert.ok(await has(`status CHANGED BY dev@tracker.test AFTER -1d`));
    assert.ok(!(await has(`status CHANGED BY admin@tracker.test`)));
    assert.ok(!(await has(`status CHANGED BEFORE -1d`)));
    assert.ok(await has(`status CHANGED DURING ("2020-01-01", "2099-01-01")`));
    assert.ok(await has('assignee WAS currentUser()'), 'held by Dana, now unassigned');
    assert.ok(await has('assignee CHANGED FROM dev@tracker.test TO EMPTY BY admin@tracker.test'));
    assert.ok(await has('assignee is EMPTY AND assignee WAS dev@tracker.test'));
    assert.equal((await call(dev, 'POST', '/search/jql', { jql: 'summary WAS x' })).status, 400);
    assert.equal((await call(dev, 'POST', '/search/jql', { jql: 'status WAS Done FROM "To Do"' })).status, 400);
  });

  await test('archiving: hidden from board/search/backlog, read-only, archived = true, restore; admins only', async () => {
    const epic = (await call(admin, 'POST', '/issue', { fields: { project: { key: 'DEMO' }, issuetype: { name: 'Task' }, summary: 'Old idea' } })).body.key;
    const sub = (await call(admin, 'POST', '/issue', { fields: { project: { key: 'DEMO' }, issuetype: { name: 'Subtask' }, summary: 'Old sub', parent: { key: epic } } })).body.key;
    assert.equal((await call(dev, 'POST', `/issue/${epic}/archive`)).status, 403);
    assert.equal((await call(admin, 'POST', `/issue/${sub}/archive`)).status, 400, 'archive the parent instead');
    const a = await call(admin, 'POST', `/issue/${epic}/archive`);
    assert.equal(a.body.count, 2, 'subtasks go with it');
    const jql = async (q: string) => (await call(dev, 'POST', '/search/jql', { jql: q, maxResults: 200 })).body;
    assert.ok(!(await jql('project = DEMO')).issues.some((x: any) => [epic, sub].includes(x.key)), 'hidden from search');
    assert.deepEqual((await jql(`project = DEMO AND archived = true`)).issues.map((x: any) => x.key).sort(), [epic, sub].sort());
    const i = (await call(dev, 'GET', `/issue/${epic}`)).body;
    assert.equal(i.fields.archived, true, 'still readable by key');
    assert.equal((await call(admin, 'PATCH', `/issue/${epic}/fields/summary`, { value: 'x' })).status, 400, 'read-only');
    assert.match((await call(dev, 'POST', `/issue/${epic}/comment`, { body: 'hi' })).body.errorMessages[0], /archived/);
    assert.equal((await call(dev, 'POST', `/issue/${epic}/worklog`, { timeSpent: '1h' })).status, 400);
    const board = (await call(dev, 'GET', '/project/DEMO/board')).body;
    assert.ok(!board.columns.some((c: any) => c.issues.some((x: any) => x.key === epic)));
    assert.equal((await call(admin, 'POST', `/issue/${epic}/restore`)).body.count, 2);
    assert.ok((await jql('project = DEMO')).issues.some((x: any) => x.key === sub));
    assert.ok((await call(admin, 'PATCH', `/issue/${epic}/fields/summary`, { value: 'Revived idea' })).status < 300);
    const acts = (await call(admin, 'GET', '/admin/audit?category=spaces')).body.values.map((x: any) => x.action);
    assert.ok(acts.includes('Archived a work item') && acts.includes('Restored a work item'));
  });

  await test('security levels: hide work from people outside the level everywhere', async () => {
    assert.equal((await call(dev, 'POST', '/project/DEMO/security-levels', { name: 'x' })).status, 403);
    const lvl = (await call(admin, 'POST', '/project/DEMO/security-levels', { name: 'Admins only', roles: ['admin'], includeReporter: true, includeAssignee: true })).body;
    assert.equal(lvl.name, 'Admins only');
    const k = (await call(admin, 'POST', '/issue', { fields: { project: { key: 'DEMO' }, issuetype: { name: 'Task' }, summary: 'Secret plan', security: { id: lvl.id } } })).body.key;
    assert.equal((await call(admin, 'GET', `/issue/${k}`)).body.fields.security.name, 'Admins only');
    // Dana (member) and Vic (viewer) can't see it anywhere
    for (const t of [dev, viewer]) {
      assert.equal((await call(t, 'GET', `/issue/${k}`)).status, 404);
      assert.equal((await call(t, 'POST', '/search/jql', { jql: `key = ${k}` })).body.total, 0);
      assert.equal((await call(t, 'POST', '/search/jql', { jql: 'summary ~ "Secret plan"' })).body.total, 0);
    }
    const board = (await call(dev, 'GET', '/project/DEMO/board')).body;
    assert.ok(!board.columns.some((c: any) => c.issues.some((x: any) => x.key === k)));
    const act = (await call(dev, 'GET', '/project/DEMO/activity')).body;
    assert.ok(!act.some((x: any) => x.issue.key === k), 'not in the activity stream');
    assert.equal((await call(dev, 'PATCH', `/issue/${k}/fields/summary`, { value: 'x' })).status, 404);
    // a link to it doesn't reveal it
    await call(admin, 'POST', '/issueLink', { type: { name: 'Relates' }, outwardIssue: { key: k }, inwardIssue: { key: 'DEMO-1' } });
    assert.ok(!(await call(dev, 'GET', '/issue/DEMO-1')).body.fields.issuelinks.some((l: any) => (l.outwardIssue ?? l.inwardIssue).key === k));
    assert.ok((await call(admin, 'GET', '/issue/DEMO-1')).body.fields.issuelinks.some((l: any) => (l.outwardIssue ?? l.inwardIssue).key === k));
    // mention / assign Dana: no notification leaks the summary; assigning makes it visible to her (include assignee)
    const before = (await db.query(`SELECT count(*)::int AS n FROM notifications n JOIN issues i ON i.id = n.issue_id WHERE i.key = $1 AND n.user_id = 2`, [k]))[0].n;
    assert.equal(before, 0);
    await call(admin, 'PATCH', `/issue/${k}/fields/assignee`, { value: { accountId: '2' } });
    assert.equal((await call(dev, 'GET', `/issue/${k}`)).status, 200, 'assignee can see it');
    assert.equal((await call(viewer, 'GET', `/issue/${k}`)).status, 404);
    // only space admins set levels; you can't pick a level you're not in
    assert.equal((await call(dev, 'PATCH', `/issue/${k}/fields/security`, { value: null })).status, 403);
    // clearing the level makes it visible to the space again
    assert.ok((await call(admin, 'PATCH', `/issue/${k}/fields/security`, { value: null })).status < 300);
    assert.equal((await call(viewer, 'GET', `/issue/${k}`)).status, 200);
    const levels = (await call(admin, 'GET', '/project/DEMO/security-levels')).body;
    assert.equal(levels.length, 1);
    assert.equal((await call(admin, 'DELETE', `/security-level/${lvl.id}`)).status, 204);
  });

  /** The one-time link from the latest account email to this address. */
  const linkToken = async (to: string, kind: string) => {
    const [m] = await db.query(`SELECT text_body FROM emails WHERE to_email = $1 AND kind = $2 ORDER BY id DESC LIMIT 1`, [to, `account-${kind}`]);
    return m ? /#token=([A-Za-z0-9_-]+)/.exec(m.text_body)![1] : null;
  };

  await test('accounts: sign-up verification, forgot/reset password, change password, idle sessions', async () => {
    // sign-up → unverified, verification email; the link verifies once
    const reg = await call(null, 'POST', '/auth/register', { email: 'newbie@tracker.test', displayName: 'New Bee', password: 'longenough1' });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.user.emailVerified, false);
    const vt = (await linkToken('newbie@tracker.test', 'verify'))!;
    assert.ok(vt, 'verification email sent');
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM auth_tokens WHERE token_hash = $1`, [vt]))[0].n, 0, 'only hashes stored');
    assert.equal((await call(null, 'POST', '/auth/verify', { token: vt })).status, 200);
    assert.equal((await call(null, 'POST', '/auth/verify', { token: vt })).status, 400, 'one use');
    assert.equal((await call(reg.body.token, 'GET', '/myself')).body.emailVerified, true);

    // forgot: same answer for unknown emails; link resets once and signs out other sessions
    const unknown = await call(null, 'POST', '/auth/forgot', { email: 'nobody@tracker.test' });
    const known = await call(null, 'POST', '/auth/forgot', { email: 'newbie@tracker.test' });
    assert.deepEqual(unknown.body, known.body, 'no account discovery');
    assert.equal(await linkToken('nobody@tracker.test', 'reset'), null);
    const rt = (await linkToken('newbie@tracker.test', 'reset'))!;
    assert.equal((await call(null, 'POST', '/auth/reset', { token: rt, password: 'short' })).status, 400);
    const reset = await call(null, 'POST', '/auth/reset', { token: rt, password: 'brand-new-pass-1' });
    assert.equal(reset.status, 200);
    assert.ok(reset.body.token);
    assert.equal((await call(reg.body.token, 'GET', '/myself')).status, 401, 'old sessions signed out');
    assert.equal((await call(null, 'POST', '/auth/reset', { token: rt, password: 'another-pass-2' })).status, 400, 'link used');
    assert.equal((await call(null, 'POST', '/auth/login', { email: 'newbie@tracker.test', password: 'brand-new-pass-1' })).status, 200);
    // SSO-only accounts get no reset email
    await db.query(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES (1, 'ssoonly@tracker.test', 'S', '!sso')`);
    await call(null, 'POST', '/auth/forgot', { email: 'ssoonly@tracker.test' });
    assert.equal(await linkToken('ssoonly@tracker.test', 'reset'), null);

    // change password: needs the current one; other sessions end, this one stays
    const s1 = reset.body.token;
    const s2 = (await call(null, 'POST', '/auth/login', { email: 'newbie@tracker.test', password: 'brand-new-pass-1' })).body.token;
    assert.equal((await call(s1, 'POST', '/myself/password', { currentPassword: 'nope', newPassword: 'third-pass-33' })).status, 400);
    assert.equal((await call(s1, 'POST', '/myself/password', { currentPassword: 'brand-new-pass-1', newPassword: 'third-pass-33' })).status, 200);
    assert.equal((await call(s1, 'GET', '/myself')).status, 200);
    assert.equal((await call(s2, 'GET', '/myself')).status, 401);

    // idle timeout
    await db.query(`UPDATE sessions SET last_seen_at = now() - interval '13 hours' WHERE token = $1`, [s1]);
    assert.equal((await call(s1, 'GET', '/myself')).status, 401, 'idle session expired');
  });

  await test('login protection: rate limits per email (429 + Retry-After), forgot-password limit', async () => {
    await call(null, 'POST', '/auth/register', { email: 'target@tracker.test', displayName: 'T', password: 'longenough1' });
    for (let i = 0; i < 5; i++) assert.equal((await call(null, 'POST', '/auth/login', { email: 'target@tracker.test', password: `wrong${i}` })).status, 401);
    const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'target@tracker.test', password: 'longenough1' }) });
    assert.equal(res.status, 429, 'even the right password is refused while locked');
    assert.equal(res.headers.get('retry-after'), '900');
    assert.equal((await call(null, 'POST', '/auth/login', { email: 'dev@tracker.test', password: DEMO_USERS[0].password })).status, 200, 'other accounts unaffected');
    await db.query(`DELETE FROM auth_failures WHERE email = 'target@tracker.test'`);
    assert.equal((await call(null, 'POST', '/auth/login', { email: 'target@tracker.test', password: 'longenough1' })).status, 200);
    for (let i = 0; i < 3; i++) await call(null, 'POST', '/auth/forgot', { email: 'target@tracker.test' });
    assert.equal((await call(null, 'POST', '/auth/forgot', { email: 'target@tracker.test' })).status, 429);
    await db.query(`DELETE FROM auth_failures`);
  });

  await test('admin users: invite → accept, deactivate/reactivate, site admin rules', async () => {
    assert.equal((await call(dev, 'GET', '/admin/users')).status, 403);
    const list = (await call(admin, 'GET', '/admin/users')).body;
    assert.ok(list.some((u: any) => u.emailAddress === 'dev@tracker.test' && u.status === 'active'));
    assert.ok(!list.some((u: any) => u.emailAddress.endsWith('@tracker.system')), 'the Automation bot is hidden');
    const inv = await call(admin, 'POST', '/admin/users/invite', { email: 'invitee@tracker.test', displayName: 'Ivy Invitee' });
    assert.equal(inv.status, 201);
    assert.equal(inv.body.status, 'invited');
    assert.equal((await call(admin, 'POST', '/admin/users/invite', { email: 'invitee@tracker.test', displayName: 'x' })).status, 400);
    assert.equal((await call(null, 'POST', '/auth/login', { email: 'invitee@tracker.test', password: '!invited' })).status, 401, 'no usable password yet');
    const it = (await linkToken('invitee@tracker.test', 'invite'))!;
    assert.deepEqual((await call(null, 'GET', `/auth/invite?token=${it}`)).body, { email: 'invitee@tracker.test', displayName: 'Ivy Invitee' });
    const acc = await call(null, 'POST', '/auth/accept-invite', { token: it, password: 'ivy-password-1', displayName: 'Ivy I.' });
    assert.equal(acc.status, 200);
    assert.equal(acc.body.user.displayName, 'Ivy I.');
    assert.equal(acc.body.user.emailVerified, true);
    assert.equal((await call(null, 'POST', '/auth/accept-invite', { token: it, password: 'again-pass-1' })).status, 400);

    // deactivate: signed out everywhere, API tokens stop, can't sign in; can't deactivate yourself or the last admin
    const ivy = acc.body.token;
    const pat = (await call(ivy, 'POST', '/myself/tokens', { name: 'ivy script' })).body.token;
    const id = acc.body.user.accountId;
    assert.equal((await call(admin, 'POST', `/admin/users/${id}/deactivate`)).body.active, false);
    assert.equal((await call(ivy, 'GET', '/myself')).status, 401);
    assert.equal((await call(pat, 'GET', '/myself')).status, 401);
    assert.equal((await call(null, 'POST', '/auth/login', { email: 'invitee@tracker.test', password: 'ivy-password-1' })).status, 401);
    await call(admin, 'POST', `/admin/users/${id}/activate`);
    assert.equal((await call(null, 'POST', '/auth/login', { email: 'invitee@tracker.test', password: 'ivy-password-1' })).status, 200);
    assert.equal((await call(admin, 'POST', '/admin/users/1/deactivate')).status, 400, 'not yourself');
    assert.equal((await call(admin, 'PUT', '/admin/users/1', { siteAdmin: false })).status, 400, 'keep one site admin');
    assert.equal((await call(admin, 'PUT', `/admin/users/${id}`, { siteAdmin: true })).body.isSiteAdmin, true);
    assert.equal((await call(admin, 'PUT', `/admin/users/${id}`, { siteAdmin: false })).body.isSiteAdmin, false);
    const acts = (await call(admin, 'GET', '/admin/audit?maxResults=100')).body.values.map((a: any) => a.action);
    assert.ok(['Invited a user', 'Deactivated a user', 'Reactivated a user', 'Made someone a site admin', 'Accepted an invitation'].every((a) => acts.includes(a)));
  });

  await test('groups: space access through a group, highest role wins, removal revokes, direct access kept', async () => {
    const reg = await call(null, 'POST', '/auth/register', { email: 'grouped@tracker.test', displayName: 'Gus Grouped', password: 'longenough1' });
    const gus = reg.body.token, gusId = reg.body.user.accountId;
    assert.equal((await call(gus, 'GET', '/project/DEMO')).status, 404, 'no access yet');
    const qa = (await call(admin, 'POST', '/admin/groups', { name: 'QA' })).body;
    const leads = (await call(admin, 'POST', '/admin/groups', { name: 'Leads' })).body;
    assert.equal((await call(admin, 'POST', '/admin/groups', { name: 'qa' })).status, 400);
    await call(admin, 'POST', `/admin/groups/${qa.id}/members`, { accountIds: [gusId] });
    await call(admin, 'POST', `/admin/groups/${leads.id}/members`, { accountIds: [gusId] });
    assert.equal((await call(dev, 'POST', '/project/DEMO/groups', { groupId: qa.id, role: 'viewer' })).status, 403, 'space admins only');
    await call(admin, 'POST', '/project/DEMO/groups', { groupId: qa.id, role: 'viewer' });
    assert.equal((await call(gus, 'GET', '/project/DEMO')).body.myRole, 'viewer');
    assert.equal((await call(gus, 'PATCH', '/issue/DEMO-1/fields/summary', { value: 'x' })).status, 403);
    await call(admin, 'POST', '/project/DEMO/groups', { groupId: leads.id, role: 'member' });
    assert.equal((await call(gus, 'GET', '/project/DEMO')).body.myRole, 'member', 'highest role wins');
    await call(admin, 'DELETE', `/admin/groups/${leads.id}/members/${gusId}`);
    assert.equal((await call(gus, 'GET', '/project/DEMO')).body.myRole, 'viewer');
    await call(admin, 'DELETE', `/project/DEMO/groups/${qa.id}`);
    assert.equal((await call(gus, 'GET', '/project/DEMO')).status, 404, 'access removed with the group');
    // a direct member keeps their own role whatever groups say
    await call(admin, 'POST', '/project/DEMO/groups', { groupId: qa.id, role: 'admin' });
    await call(admin, 'POST', `/admin/groups/${qa.id}/members`, { accountIds: ['3'] }); // Vic is a direct viewer
    assert.equal((await call(viewer, 'GET', '/project/DEMO')).body.myRole, 'viewer');
    const groups = (await call(admin, 'GET', '/admin/groups')).body;
    assert.deepEqual(groups.find((g: any) => g.name === 'QA').spaces, [{ key: 'DEMO', role: 'admin' }]);
    assert.equal((await call(admin, 'DELETE', `/admin/groups/${qa.id}`)).status, 204);
    assert.equal((await call(viewer, 'GET', '/project/DEMO')).body.myRole, 'viewer');
    await call(admin, 'DELETE', `/admin/groups/${leads.id}`);
  });

  await test('site settings: close sign-up, sign-up domains, space creation for site admins only', async () => {
    assert.deepEqual((await call(null, 'GET', '/auth/site')).body, { setup: false, allowSignup: true, signupDomains: [] });
    assert.equal((await call(dev, 'GET', '/admin/settings')).status, 403);
    assert.equal((await call(dev, 'PUT', '/admin/settings', { allowSignup: false })).status, 403);
    // domain-limited sign-up
    assert.equal((await call(admin, 'PUT', '/admin/settings', { signupDomains: ['not a domain'] })).status, 400);
    await call(admin, 'PUT', '/admin/settings', { signupDomains: ['Example.com'] });
    assert.deepEqual((await call(null, 'GET', '/auth/site')).body.signupDomains, ['example.com']);
    assert.equal((await call(null, 'POST', '/auth/register', { email: 'stranger@elsewhere.test', displayName: 'S', password: 'longenough1' })).status, 403);
    assert.equal((await call(null, 'POST', '/auth/register', { email: 'colleague@example.com', displayName: 'C', password: 'longenough1' })).status, 201);
    // closed: nobody signs up; invitations still work
    await call(admin, 'PUT', '/admin/settings', { allowSignup: false, signupDomains: [] });
    const closed = await call(null, 'POST', '/auth/register', { email: 'late2@example.com', displayName: 'L', password: 'longenough1' });
    assert.equal(closed.status, 403);
    assert.match(closed.body.errorMessages[0], /closed/);
    assert.equal((await call(null, 'GET', '/auth/site')).body.allowSignup, false);
    assert.equal((await call(admin, 'POST', '/admin/users/invite', { email: 'invited2@example.com', displayName: 'I' })).status, 201, 'invites still work');
    // space creation
    assert.equal((await call(dev, 'GET', '/myself')).body.canCreateSpaces, true);
    await call(admin, 'PUT', '/admin/settings', { spaceCreation: 'admins' });
    assert.equal((await call(dev, 'GET', '/myself')).body.canCreateSpaces, false);
    assert.equal((await call(dev, 'POST', '/project', { key: 'NOPE', name: 'Nope' })).status, 403);
    assert.equal((await call(admin, 'GET', '/myself')).body.canCreateSpaces, true);
    assert.equal((await call(admin, 'POST', '/project', { key: 'OPSX', name: 'Ops X' })).status, 201, 'site admins still can');
    const acts = (await call(admin, 'GET', '/admin/audit?category=admin')).body.values.map((x: any) => x.target);
    assert.ok(acts.some((t: string) => t?.includes('closed sign-up')) && acts.some((t: string) => t?.includes('site admins only')));
    await call(admin, 'PUT', '/admin/settings', { allowSignup: true, spaceCreation: 'everyone' });
  });

  await test('licensing: signed keys, states, read-only mode, seats, installation binding, clock rollback', async () => {
    const kp = generateKeyPairSync('ed25519');
    const priv = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const pub = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const day = 86400_000;
    const key = (o: Partial<{ seats: number; install: string; from: number; to: number; lid: string }> = {}) => signLicense({
      v: 1, lid: o.lid ?? 'L-test', customer: 'Acme Ltd', seats: o.seats ?? 50, install: o.install ?? '*',
      issued: new Date(Date.now() + (o.from ?? 0) * day).toISOString(), expires: new Date(Date.now() + (o.to ?? 30) * day).toISOString(),
    }, priv);

    // keys: genuine, edited, signed by someone else
    const k = key();
    const good = verifyLicense(k, pub);
    assert.equal(good.ok, true);
    const [h0, body, sig] = k.split('.');
    const forged = Buffer.from(body, 'base64url').toString().replace('"seats":50', '"seats":5000');
    assert.equal(verifyLicense(`${h0}.${Buffer.from(forged).toString('base64url')}.${sig}`, pub).ok, false, 'edited key rejected');
    assert.equal(verifyLicense(signLicense((good as any).payload, other), pub).ok, false, 'key from another private key rejected');
    assert.equal(verifyLicense('hello', pub).ok, false);

    // state machine
    const now = new Date();
    const at = (d: number) => new Date(now.getTime() + d * day).toISOString();
    const payload = (exp: number) => ({ v: 1 as const, lid: 'x', customer: 'A', seats: 1, install: '*', issued: at(-30), expires: at(exp) });
    const ev = (p: any, installedDaysAgo = 1) => evaluate({ enforce: true, payload: p, installationId: 'i', installedAt: new Date(now.getTime() - installedDaysAgo * day), now }).state;
    assert.equal(evaluate({ enforce: false, payload: null, installationId: 'i', installedAt: now, now }).state, 'development');
    assert.equal(ev(null, 3), 'trial');
    assert.equal(ev(null, 20), 'read-only');
    assert.equal(ev(payload(20)), 'valid');
    assert.equal(ev(payload(5)), 'expiring');
    assert.equal(ev(payload(-5)), 'grace');
    assert.equal(ev(payload(-20)), 'read-only');
    const evUsed = (p: any, usedDays: number, installedDaysAgo = 1) => evaluate({ enforce: true, payload: p, installationId: 'i', installedAt: new Date(now.getTime() - installedDaysAgo * day), now, usedDays }).state;
    assert.equal(evUsed(payload(20), 10), 'valid', '50-day key, 10 days used');
    assert.equal(evUsed(payload(20), 45), 'expiring', '50-day key, 45 days used: 5 days of use left');
    assert.equal(evUsed(payload(20), 70), 'read-only', 'date says valid, but more running time than the key (50) + grace (14) allow');
    assert.equal(evUsed(null, 15, 2), 'read-only', 'trial used up even if the calendar says day 2');

    // a release-mode app on the same database
    const app3 = buildApp(db, { attachmentsDir: attachDir, oidc: null, license: { enforce: true, publicKey: pub } });
    const srv3 = app3.listen(0);
    const b3 = `http://127.0.0.1:${(srv3.address() as AddressInfo).port}/api`;
    const c3 = async (t: string | null, method: string, path: string, payloadBody?: unknown) => {
      const res = await fetch(b3 + path, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: payloadBody === undefined ? undefined : JSON.stringify(payloadBody) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const lic = app3.locals.licensing as { invalidate(): void };
    const status = async () => { lic.invalidate(); return (await c3(admin, 'GET', '/license/status')).body; };
    try {
      await db.query(`UPDATE installation SET license_key = NULL, max_seen_at = NULL, created_at = now() WHERE id = 1`);
      const s0 = await status();
      assert.equal(s0.state, 'trial');
      assert.ok(s0.installationId);
      assert.equal((await c3(dev, 'GET', '/license/status')).body.installationId, undefined, 'details for site admins only');

      // trial over: reads, search, sign-in and the licence page work; changes don't
      await db.query(`UPDATE installation SET created_at = now() - interval '20 days' WHERE id = 1`);
      assert.equal((await status()).readOnly, true);
      const blocked = await c3(dev, 'POST', '/issue', { fields: { project: { key: 'DEMO' }, issuetype: { name: 'Task' }, summary: 'nope' } });
      assert.equal(blocked.status, 403);
      assert.match(blocked.body.errorMessages[0], /read-only/);
      assert.equal((await c3(dev, 'GET', '/issue/DEMO-1')).status, 200);
      assert.equal((await c3(dev, 'POST', '/search/jql', { jql: 'project = DEMO' })).status, 200);
      assert.equal((await c3(null, 'POST', '/auth/login', { email: 'dev@tracker.test', password: DEMO_USERS[0].password })).status, 200, 'sign-in still works');

      // installing keys: other installation, long expired, not an admin, valid
      const inst = s0.installationId;
      assert.equal((await c3(admin, 'PUT', '/admin/license', { key: key({ install: 'some-other-install' }) })).status, 400);
      assert.equal((await c3(admin, 'PUT', '/admin/license', { key: key({ from: -60, to: -30 }) })).status, 400, 'expired keys are refused');
      assert.equal((await c3(dev, 'PUT', '/admin/license', { key: key({ install: inst }) })).status, 403, 'site admins only');
      const ok = await c3(admin, 'PUT', '/admin/license', { key: key({ install: inst, to: 30 }) });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.state, 'valid');
      assert.equal(ok.body.license.customer, 'Acme Ltd');
      assert.equal((await c3(dev, 'POST', '/issue', { fields: { project: { key: 'DEMO' }, issuetype: { name: 'Task' }, summary: 'Licensed' } })).status, 201);

      // seats: a licence for exactly the people already active blocks adding more
      const used = (await status()).usedSeats;
      await c3(admin, 'PUT', '/admin/license', { key: key({ install: inst, seats: used }) });
      const full = await c3(admin, 'POST', '/admin/users/invite', { email: 'seat@tracker.test', displayName: 'Seat' });
      assert.equal(full.status, 403);
      assert.match(full.body.errorMessages[0], new RegExp(`covers ${used} active user`));
      await c3(admin, 'PUT', '/admin/license', { key: key({ install: inst, seats: used + 1 }) });
      assert.equal((await c3(admin, 'POST', '/admin/users/invite', { email: 'seat@tracker.test', displayName: 'Seat' })).status, 201);

      // grace: expired 3 days ago still works; turning the clock back doesn't revive an expired licence
      await db.query(`UPDATE installation SET license_key = $1 WHERE id = 1`, [key({ install: inst, from: -33, to: -3 })]);
      const g = await status();
      assert.equal(g.state, 'grace');
      assert.equal(g.readOnly, false);
      await db.query(`UPDATE installation SET license_key = $1, max_seen_at = now() + interval '40 days' WHERE id = 1`, [key({ install: inst, to: 10 })]);
      assert.equal((await status()).state, 'read-only', 'latest time seen wins over a rolled-back clock');
      const acts = (await call(admin, 'GET', '/admin/audit?category=admin')).body.values.map((a: any) => a.action);
      assert.ok(acts.includes('Installed a licence key'));

      // usage counter: a frozen clock still runs out
      const usage = async () => Number((await db.query(`SELECT usage_seconds FROM installation WHERE id = 1`))[0].usage_seconds);
      await db.query(`UPDATE installation SET max_seen_at = NULL WHERE id = 1`);
      const frozen = key({ install: inst, to: 30, lid: 'L-frozen' });
      assert.equal((await c3(admin, 'PUT', '/admin/license', { key: frozen })).body.state, 'valid');
      await db.query(`UPDATE installation SET usage_seconds = usage_seconds + $1 WHERE id = 1`, [50 * 86400]);
      const spent = await status();
      assert.equal(spent.state, 'read-only', 'the calendar says valid, the running time says used up');
      assert.match(spent.message, /used up/);
      assert.ok(spent.usage.usedDays >= 50 && spent.usage.allowedDays === 44);
      // reinstalling the same key doesn't reset its allowance; a new key starts a new one
      assert.equal((await c3(admin, 'PUT', '/admin/license', { key: frozen })).body.state, 'read-only');
      assert.equal((await c3(admin, 'PUT', '/admin/license', { key: key({ install: inst, to: 30, lid: 'L-next' }) })).body.state, 'valid');

      // counting: at most 10 minutes per step (server was off), never backwards (clock moved back)
      await db.query(`UPDATE installation SET usage_tick_at = now() - interval '5 hours' WHERE id = 1`);
      const u0 = await usage(); await status(); const u1 = await usage();
      assert.ok(u1 - u0 <= 600 && u1 - u0 >= 590, `capped step, added ${u1 - u0}s`);
      await db.query(`UPDATE installation SET usage_tick_at = now() + interval '2 hours' WHERE id = 1`);
      const u2 = await usage(); await status();
      assert.equal(await usage(), u2, 'a clock moved backwards adds nothing');

      // newest recorded activity counts as "now": History written by a correct clock outlives a rolled-back app clock
      await db.query(`UPDATE installation SET max_seen_at = NULL WHERE id = 1`);
      await c3(admin, 'PUT', '/admin/license', { key: key({ install: inst, to: 10, lid: 'L-act' }) });
      await db.query(`INSERT INTO audit_log (tenant_id, actor_id, category, action, created_at) VALUES (1, 1, 'admin', 'probe', now() + interval '40 days')`);
      assert.equal((await status()).state, 'read-only', 'activity dated 40 days ahead means the 10-day key is long gone');
      await db.query(`DELETE FROM audit_log WHERE action = 'probe'`);
    } finally {
      await db.query(`UPDATE installation SET license_key = NULL, max_seen_at = NULL, created_at = now(), usage_seconds = 0, usage_tick_at = NULL WHERE id = 1`);
      await db.query(`DELETE FROM license_usage`);
      (app3.locals.hub as { close(): void }).close();
      srv3.close();
    }
  });

  await test('recently viewed list', async () => {
    await call(admin, 'GET', '/issue/DEMO-2');
    const r = (await call(admin, 'GET', '/recent')).body;
    assert.equal(r.issues[0].key, 'DEMO-2');
  });

  console.log(`\n${passed} passed`);
} finally {
  (app.locals.hub as { close(): void }).close();
  server.close();
  await db.close();
  await rm(attachDir, { recursive: true, force: true });
}
