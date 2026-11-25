# Build Plan — Phase 1 MVP ("Tracker")

Source of truth for behaviour: [JIRA_REQUIREMENTS.md](JIRA_REQUIREMENTS.md) (§2 data model, §3 features, §4 permissions,
§5 API, §8 captured traffic).

## Stack
| Layer | Choice | Why |
|---|---|---|
| Client | React 18 + TypeScript + Vite + React Router | SPA like Jira; fast dev server |
| Server | Node 24 + TypeScript (tsx) + Express 5 + zod | small, typed, validated |
| DB | PostgreSQL. Dev default **PGlite** (embedded Postgres, file `server/data/`); set `DATABASE_URL` to use a real server | zero-setup dev, same SQL in prod |
| Auth | email + password (bcrypt), bearer session tokens | MVP; SSO later |

## Layout
```
app/
  package.json          workspaces + `npm run dev` (server :4000, client :5173 with /api proxy)
  server/src/
    db.ts               PGlite | pg adapter, migrations
    schema.sql          tables (§2)
    seed.ts             demo tenant, users, project DEMO with sample issues
    auth.ts             register/login/session middleware
    permissions.ts      role → permission keys (§4)
    lexorank.ts         rank strings for board/backlog ordering
    jql.ts              JQL subset → parameterised SQL
    issues.ts           create, get, per-field edit, transitions, comments, rank, delete, changelog
    projects.ts         projects, statuses, board, aggregate, activity, members
    index.ts            Express app
  client/src/           pages: Login, ForYou, Projects, Board, List, Summary, Issue, Search; CreateModal
```

## API (Jira-compatible shapes where captured)
- `POST /api/auth/register|login`, `GET /api/myself`
- `GET|POST /api/project`, `GET /api/project/:key`, `/statuses`, `/board`, `/aggregate`, `/activity`, `/members`
- `POST /api/issue` → `201 {id,key}` (whole field map, reporter+watcher auto-set, §8.1)
- `GET /api/issue/:key?expand=changelog,transitions&updateHistory=true`
- `PATCH /api/issue/:key/fields/:fieldId {operation:"SET"|"ADD"|"REMOVE", value}` (per-field edits, §8.1)
- `GET|POST /api/issue/:key/transitions {transition:{id}}`
- `GET|POST /api/issue/:key/comment` (ADF body), `DELETE /api/issue/:key/comment/:id`
- `POST /api/issue/:key/rank {before?|after?, statusId?}` (board drag: rank + transition)
- `DELETE /api/issue/:key`, `GET|POST|DELETE /api/issue/:key/watchers`
- `GET|POST /api/search/jql`, `GET /api/recent`

## MVP scope (this build)
Projects (team-managed, auto-created Epic/Story/Task/Subtask types, To Do/In Progress/In Review/Done statuses, any→any
transitions) · issue CRUD with keys `KEY-N` · ADF description/comments (simple editor) · changelog/History · watchers ·
board with drag-and-drop (transition + rank) and assignee filter · List view (sortable, JQL) · Summary (counts + activity)
· JQL subset (`= != in, not in, ~, !~, is EMPTY, > >= < <=`, AND/OR/NOT, parentheses, ORDER BY, `currentUser()`, `now()`)
· For you (assigned + recently viewed) · roles Admin/Member/Viewer/Guest.

## Phase 2 — done: sprints
Sprints feature toggle, backlog with drag planning, start/complete sprint (carry-over), board = active sprint,
sprint report with burndown, velocity, Sprint field, sprint JQL. Scope changes are logged in `sprint_scope`
(committed vs added vs removed) so reports stay correct after the sprint closes.

## Phase 3 — part 1 done: issue links + attachments
Jira link types and phrases, links UI with History on both ends, `linkedIssues()` JQL; attachments on disk with
thumbnails/preview, sandboxed downloads, size limit, cleanup on delete.

## Phase 3 — part 2 done: saved filters + dashboards
Filters with private/space/site sharing and stars; dashboards with 4 gadget types, owner-only layout editing,
viewer-scoped gadget data. (Filter email subscriptions need email delivery — deferred with notifications.)

## Phase 3 — part 3 done: custom fields + workflows
7 custom field types with required/applies-to, History, JQL by name/id; workflow editor for statuses (order, category,
delete-with-move) and transitions with validator (required fields) + condition (roles) rules and a transition dialog.

## Phase 3 — part 4 done: notifications + timeline
In-app bell (Direct / Watching), @mentions with suggestions, auto-watch on create/comment/assign; Timeline with
drag-to-schedule, zoom levels, roll-up epic bars, start ≤ due rule.

## Phase 3 complete. Candidates for Phase 4
Automation rules, real-time updates (SSE/WebSocket), email delivery (+ filter subscriptions), SSO, custom-field
columns in List/Search, dependency arrows on the Timeline, CSV import/export, bulk edit.
