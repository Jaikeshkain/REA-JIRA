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

## Phase 4 — part 1 done: automation rules
When/If/Then rules (4 triggers, JQL condition, 5 action types, smart values), audit log per rule and per issue,
non-login Automation actor, no rule-triggers-rule loops, per-rule transactional rollback on failure.

## Phase 4 — part 2 done: working in bulk
Search column picker (incl. custom fields), bulk change (move/assign/priority/labels/sprint/delete) with per-item
results, CSV export (formula-safe), CSV import with dry-run preview. Create/edit/transition/delete refactored into
shared functions so REST, bulk and import enforce identical rules.

## Phase 4 — part 3 done: real-time updates
SSE hub with per-space/per-user scoping, publish-after-commit change tracking for all write routes, live board/
list/issue refresh, instant bell, Live indicator with reconnect. Single-instance hub (scale-out needs pub/sub).

## Phase 4 — part 4 done: email + scheduled work
Per-person email preference (immediate / daily digest / off), filter subscriptions run as the subscriber,
scheduled automation trigger (hourly/daily/weekly + required JQL), SMTP delivery with retries or a dev outbox for
site admins, one DB-driven background scheduler.

## Phase 4 — part 5 done: timeline dependencies + list fields
Blocks links drawn as Timeline arrows with conflict flags, drag-to-link and click-to-remove; custom-field columns
in the space List view.

## Phase 4 — part 6 done: single sign-on
OIDC (code + PKCE) with full ID-token checks, verified-email account linking, JIT accounts, domain allow-list,
SSO-only mode with admin break-glass, mock provider for development and tests.

## Phase 4 — part 7 done: multi-instance
Live updates over Postgres LISTEN/NOTIFY (once per browser, own echo ignored, chunked payloads, listener
reconnect + browser resync), scheduler passes under an advisory lock. Verified against a real Postgres 17.

## Phase 4 — complete
All planned Phase 4 items are built.

## Phase 5 — part 1 done: API tokens, webhooks, audit log
Personal API tokens (Bearer/Basic, hashed, expiry, revoke), signed webhooks with retries and SSRF protection,
admin audit log for configuration, security and sign-in events.

## Phase 5 — part 2 done: releases and components
Versions (release with move, archive, delete with move, progress), components with leads, Fix versions /
Components on work items with History, JQL `fixVersion` / `component` incl. released/unreleasedVersions().

## Phase 5 — part 3 done: time tracking + WIP limits
Estimates, work log with estimate adjustment (auto/leave/new/manual), History, JQL time fields + worklogAuthor /
worklogDate, per-status WIP limits on the board.

## Phase 5 — part 4 done: votes, JQL history, archiving, security levels
Votes (JQL votes/voter), WAS / WAS NOT / WAS IN / CHANGED with FROM TO BY AFTER BEFORE ON DURING, archive/restore
(hidden everywhere, read-only, `archived = true`), per-space security levels enforced in every listing.

## Phase 5 — complete
All items from the requirements' Phase 2–3 roadmap are built.

## Must-haves done: accounts, administration, deployment
Password reset, email verification, invitations, change password, rate limits, idle sessions; admin users
(invite/deactivate/site admin) and groups granting space roles; Dockerfile, compose with PostgreSQL, CI, production
serving with security headers.

## Still open (from JIRA_REQUIREMENTS.md)
Configurable permission/notification schemes, workflow post-functions, dev-tool integrations (GitHub/GitLab), Forms,
AI summaries, Jira-identical REST paths (/rest/api/3), JQL autocomplete, attachment thumbnails/virus scan/S3,
passkeys, Excel export, multiple organisations per install.
