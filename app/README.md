# Tracker — Phase 1 MVP

A Jira-style issue tracker built from [../JIRA_REQUIREMENTS.md](../JIRA_REQUIREMENTS.md). Plan: [../BUILD_PLAN.md](../BUILD_PLAN.md).

## Run

```powershell
cd app
npm install
npm run dev        # API on http://127.0.0.1:4000, UI on http://localhost:5173
```

The first start creates an embedded Postgres (PGlite) database in `server/data/` and seeds a demo site.
To use a real PostgreSQL server instead, set `DATABASE_URL` before starting, e.g.
`$env:DATABASE_URL = "postgres://user:pass@localhost:5432/tracker"`.

### Demo logins (local development only)

| Email | Password | Role in DEMO |
|---|---|---|
| admin@tracker.test | tracker-demo-1 | site admin / project admin |
| dev@tracker.test | tracker-demo-1 | member |
| viewer@tracker.test | tracker-demo-1 | viewer (read-only) |

Reset the demo data by stopping the server and deleting `server/data/`.

## Test

```powershell
npm test           # API smoke test on an in-memory database (16 checks)
npm run build      # type-check server + client, production-build client
```

## What's in the MVP

- Spaces (projects) with key prefixes, default work types (Epic › Story/Task/Bug › Subtask) and workflow
  (To Do → In Progress → In Review → Done, any-to-any)
- Work items with `KEY-N` keys, rich description and comments (stored as ADF JSON), labels, priority, due/start dates,
  story points, parent/child hierarchy, watchers, full change history
- Board with drag-and-drop (moves status via a transition and re-ranks with LexoRank), assignee filter, search
- List view with sortable columns and expandable hierarchy; Summary page with counts, breakdowns and activity
- JQL search: `= != ~ !~ < <= > >= IN, NOT IN, IS [NOT] EMPTY`, `AND/OR/NOT`, `ORDER BY`, `currentUser()`, `now()`,
  `startOfDay()…endOfMonth()`, relative dates (`-7d`)
- Roles Admin / Member / Viewer / Guest mapped to Jira permission keys; keyboard shortcuts `c` (create) and `m` (comment)

## Phase 2: sprints

- **Sprints feature** per space (Settings → Features). When on, the space gets **Backlog** and **Reports** tabs and the
  **board shows only the active sprint** (Jira scrum behaviour).
- **Backlog:** open sprints (active first) + backlog; drag work between them and re-order; quick create into a sprint;
  story-point totals per sprint (to do / in progress / done); create, edit, delete (future only) sprints.
- **Start sprint:** name, duration (1–4 weeks or custom), dates, goal; only one active sprint at a time; the work in it
  at start is the *committed* scope.
- **Complete sprint:** done work stays in the closed sprint; open work moves to a future sprint, a new sprint or the backlog.
- **Reports:** sprint report (committed / added after start / completed / not completed) with a **burndown** (remaining
  points per day, scope line, guideline; hover tooltip; table view) and **velocity** (committed vs completed per sprint).
- Issue page **Sprint** field; JQL `sprint = "Name" | id`, `sprint in openSprints() | futureSprints() | closedSprints()`,
  `sprint is EMPTY`, `ORDER BY sprint`.
- API: `GET|POST /api/project/:key/sprints`, `PATCH|DELETE /api/sprint/:id`, `POST /api/sprint/:id/start|complete`,
  `GET /api/project/:key/backlog`, `GET /api/sprint/:id/report`, `GET /api/project/:key/velocity`,
  `PATCH /api/project/:key/features`, plus `sprintId` on `POST /api/issue/:key/rank` and `fields.sprint` on create.

The demo space starts with **DEMO Sprint 1** active (day 5 of 14, one item done) and **DEMO Sprint 2** planned.
After upgrading from Phase 1, existing data keeps working (schema migrates in place); delete `server/data/` to get the
new demo sprints.

## API (Jira-shaped)

`POST /api/issue` (201 `{id,key}`) · `GET /api/issue/:key?expand=transitions,changelog` ·
`PATCH /api/issue/:key/fields/:fieldId {operation, value}` · `GET|POST /api/issue/:key/transitions` ·
`POST /api/issue/:key/rank` · `GET|POST|PUT|DELETE /api/issue/:key/comment` · `POST|DELETE /api/issue/:key/watchers` ·
`GET|POST /api/search/jql` · `GET|POST /api/project` · `/api/project/:key/{board,aggregate,activity,members}` ·
`/api/auth/{register,login,logout}` · `/api/myself` · `/api/recent`
