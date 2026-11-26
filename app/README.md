# Tracker — Phase 1 MVP

A Jira-style issue tracker built from [../JIRA_REQUIREMENTS.md](../JIRA_REQUIREMENTS.md). Plan: [../BUILD_PLAN.md](../BUILD_PLAN.md).

## Run

```powershell
cd app
npm install
npm run dev        # API on http://127.0.0.1:4000, UI on http://localhost:5173
```

The first start creates an embedded Postgres (PGlite) database in `server/data/` and seeds a demo site.

**Settings and secrets** live in `app/server/.env`, loaded automatically by `npm run dev`, `start` and `seed`.
It is ignored by git; `app/server/.env.example` (committed) lists every option with its default. Put database
passwords, the SMTP URL and the SSO client secret only in `.env`. Real environment variables override the file,
and `npm test` never reads it.
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
npm test           # API smoke test on an in-memory database (33 checks)
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

## Phase 3 (part 1): links + attachments

- **Linked work items** on the issue page, grouped by phrase as seen from that issue (*blocks* / *is blocked by*,
  *duplicates* / *is duplicated by*, *clones* / *is cloned by*, *relates to*); add with a type + issue search, remove
  inline. Each link writes a History entry on **both** issues. No self-links or duplicates (either direction for
  *relates to*). JQL: `issue in linkedIssues("DEMO-11")`, `issue in linkedIssues("DEMO-6", "is blocked by")`.
- **Attachments:** drag files onto the section or browse; image thumbnails and preview, other files download.
  Max 10 MB per file (`MAX_ATTACHMENT_MB`). Files are stored in `server/data/attachments/` (`ATTACHMENTS_DIR`) under random
  names with a SHA-256 in the DB, and deleted with their issue.
- **Download safety:** downloads require sign-in and project access; only PNG/JPEG/GIF/WebP are ever shown inline,
  everything else is forced to download, and every response is sent with `Content-Security-Policy: sandbox` and
  `nosniff`, so an uploaded HTML or SVG file cannot run scripts in the app.
- Permissions: `LINK_ISSUES`, `CREATE_ATTACHMENTS`, `DELETE_OWN_ATTACHMENTS` (members), `DELETE_ALL_ATTACHMENTS` (admins).
- API: `GET /api/issueLinkType`, `POST /api/issueLink`, `DELETE /api/issueLink/:id`,
  `POST /api/issue/:key/attachments` (raw body + `X-File-Name`), `GET /api/attachment/:id/content`, `DELETE /api/attachment/:id`;
  `fields.issuelinks` and `fields.attachment` on `GET /api/issue/:key`.

## Phase 3 (part 2): saved filters + dashboards

- **Saved filters:** run a JQL search → *Save filter* (name, description, who can see it: private / members of a
  space / everyone on the site). Open with `/issues?filter=ID`; owners get *Save changes* when the JQL is edited and a
  *Details* dialog; anyone can *Save as*. JQL is validated on save. **Filters** page: All / Starred / My filters,
  star toggle (creators star automatically), owner-only delete.
- **Dashboards:** two-column layouts, private / space / site sharing, owner-only editing (*Edit* → add, configure,
  move ↑ ↓ ← →, remove gadgets). New dashboards start with *Assigned to me*.
- **Gadgets** (Jira equivalents): *Filter results*, *Breakdown* (Jira's "Pie chart", drawn as ranked bars so values
  compare exactly; top 10 + Other), *Created vs. resolved* (7–90 days), *Assigned to me*.
- **Viewer-scoped data:** gadgets and shared filters are always computed with the viewer's own permissions, so
  sharing never exposes work someone couldn't already browse. A gadget whose filter is deleted or unshared shows
  "unavailable" instead of breaking the dashboard.
- API: `GET /api/filter/search?scope=all|mine|starred`, `POST /api/filter`, `GET|PUT|DELETE /api/filter/:id`,
  `POST|DELETE /api/filter/:id/favourite`; `GET|POST /api/dashboard`, `GET|PUT|DELETE /api/dashboard/:id`,
  `POST /api/dashboard/:id/gadgets`, `PUT|DELETE /api/dashboard/:id/gadgets/:gid`, `GET /api/dashboard/:id/gadgets/:gid/data`.

## Phase 3 (part 3): custom fields + workflows

- **Custom fields** (Space settings → Fields, admins): short text, paragraph, number, date, dropdown, checkboxes
  (multi-select), people. Optional description, *required when creating work*, and *applies to* specific work types.
  Ids follow Jira (`customfield_<id>`). Fields show on the Create dialog and the issue Details panel; every change is
  in History. Removing a dropdown option clears it from work that used it. A field's type can't change after creation,
  and names can't shadow system fields.
- **JQL on custom fields** by name or id: `"Severity" = "S1 - Critical"`, `"Effort hours" > 3`, `Customer ~ acme`,
  `Platforms in (Web)`, `Reviewer = currentUser()`, `cf[3] is EMPTY`.
- **Workflow editor** (Space settings → Workflow, admins): add / rename / re-order statuses (each is a board column; the
  first is where new work starts), change a status's category (moving into/out of *Done* resolves/unresolves the work
  in it), delete a status (its work moves to a status you pick, logged in History), add / remove transitions.
- **Transition rules:** *required fields* (validator: built-ins like Assignee/Story points or any custom field) and
  *who can use it* (condition: roles). Restricted transitions aren't offered to other roles; when a rule needs empty
  fields, the issue page opens a "Move to …" dialog to fill them, then moves the work.
- The transition list no longer offers the status the work is already in (Jira behaviour).
- API: `GET|POST /api/project/:key/fields`, `PUT|DELETE /api/field/:id`; `GET /api/project/:key/workflow`,
  `POST /api/project/:key/statuses`, `PUT|DELETE /api/status/:id[?moveTo=]`, `POST /api/project/:key/transitions`,
  `PUT|DELETE /api/transition/:id`; `customfield_<id>` keys on create and `PATCH /api/issue/:key/fields/customfield_<id>`.

## Phase 4 (part 7): running several server instances

Run as many API instances as you like behind a load balancer, all pointing at the same PostgreSQL (`DATABASE_URL`):

- **Live updates cross instances.** Every event also goes out on Postgres `NOTIFY` (channel `tracker_events`); each
  instance `LISTEN`s on its own connection. A change made through one instance reaches browsers connected to any
  other, exactly once (an instance delivers its own events directly and ignores their echo). Large events are split
  to stay under the 8 KB NOTIFY limit. No sticky sessions or extra services (Redis) are needed.
- **Self-healing.** If the listener connection drops (database restart or failover), it reconnects with backoff and
  tells connected browsers to refetch, since events may have been missed.
- **One scheduler at a time.** Each scheduler pass runs under a Postgres advisory lock: instances that find it taken
  skip that minute, so emails, subscriptions and scheduled rules never run twice.
- **Test it:** `DATABASE_URL=postgres://… npm --prefix server run test:multi` runs two independent instances against a
  real Postgres (cross-instance delivery, pings, large events, scheduler lock, killed listener connection).
  The embedded PGlite database is single-process; it uses the same code paths, covered by `npm test`.

## Phase 4 (part 6): single sign-on (OpenID Connect)

- **Continue with SSO** on the login page works with any OpenID Connect provider (Okta, Microsoft Entra ID, Google,
  Keycloak, …). Configure the API with:

  | Variable | |
  |---|---|
  | `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | from your provider; register `<APP_URL>/api/auth/oidc/callback` as the redirect URI |
  | `OIDC_NAME` | button label, e.g. `Acme SSO` |
  | `OIDC_ALLOWED_DOMAINS` | optional, comma-separated email domains allowed to sign in with SSO |
  | `OIDC_AUTO_CREATE=false` | only people who already have an account may sign in (default: accounts are created on first sign-in) |
  | `SSO_ONLY=1` | password sign-in only for site admins (break-glass); sign-up is closed |

- **Security:** authorization code flow with PKCE, one-time `state` and `nonce`. The ID token's signature (RS256/ES256,
  provider JWKS with key rotation), issuer, audience/`azp`, expiry and nonce are all checked; `alg: none` and HMAC
  tokens are refused. People are matched by (issuer, subject). A first SSO sign-in links to an existing account only
  when the provider marks the email as **verified**, so an unverified address can't take over an account. New SSO
  accounts are never site admins and have no password. The session reaches the browser through a one-time,
  60-second code in the URL fragment (not a token in a URL), and deep links survive the round trip.
- **Try it locally:** `npm run dev:sso` starts a **mock identity provider** on http://127.0.0.1:4100 next to the app.
  It asks no password: you pick a test identity (including one with an unverified email). Development only.

## Phase 4 (part 5): timeline dependencies + list fields

- **Dependencies on the Timeline.** "Blocks" links between work in the space are drawn as arrows from the end of the
  blocking work to the start of the blocked work. When blocked work is scheduled to start before its blocker ends, the
  arrow turns red and dashed, the row gets a ⚠, and the toolbar counts the conflicts. Arrows follow bars while you drag.
- **Add or remove one on the Timeline:** drag the dot at the end of a bar onto another bar ("this blocks that"); click
  an arrow to remove it. They're ordinary work item links, so they also show on each work item. A **Dependencies**
  toggle hides the arrows. `GET /api/project/:key/dependencies` lists them (space members only).
- **Custom fields in the List view.** **Fields ▾** adds any of the space's custom fields as columns; the choice is
  remembered per space in this browser.

## Phase 4 (part 4): email + scheduled work

- **Email notifications.** Each person chooses in **Account → Notification settings**: *Immediately* (one email per
  batch of updates, about a minute after they happen), *Daily digest* (once a day at `DIGEST_HOUR_UTC`, default 08:00
  UTC) or *Off*. Anything already read in the app is never emailed, and nothing is emailed twice.
- **Filter subscriptions.** On a saved filter, **Subscribe** emails its results (up to 50 work items) every day or
  every week at a chosen hour (UTC). It runs **as the subscriber**, so people only get work they can see; by default
  no email is sent when nothing matches. Unsubscribe from the same dialog.
- **Scheduled automation.** A new **Scheduled** trigger (every hour, every day or every Monday at a chosen hour UTC)
  runs the rule's actions on each work item in the space that matches its JQL condition (required, max 100 per run),
  as the Automation user, with the same audit log and rollback.
- **Delivery.** Set `SMTP_URL` (e.g. `smtp://user:pass@smtp.example.com:587`, plus optional `MAIL_FROM` and `APP_URL`
  for links) to send real email; failed sends retry with backoff up to 5 times. Without it, emails stay in a built-in
  **outbox** that site admins can read (**Account → Email outbox**, HTML preview in a sandboxed frame) — so
  development never sends anything. All user text in emails is HTML-escaped.
- **Scheduler.** One background pass every minute (`DISABLE_SCHEDULER=1` turns it off); everything it needs to know
  (`next_run_at`, `emailed_at`) lives in the database, so restarts don't lose or repeat work. Admins can run it now
  from the outbox page.

## Phase 4 (part 3): real-time updates

- Changes by teammates appear without reloading: boards, backlog, lists, summary and dashboards refresh shortly
  after a change; an open work item reloads itself and shows **"Updated by a teammate just now"** (half-written
  comments and description edits are kept). The bell updates instantly on new notifications. A **Live** marker in the
  top bar shows the connection (it reconnects automatically with backoff).
- How it works: one **Server-Sent Events** stream per tab (`GET /api/events`), read with `fetch` streaming so the
  session token stays in the `Authorization` header (never in a URL or log).
- **Scoped:** change events reach only people who can browse that space; notification pings reach only their
  recipient. Events carry only the space key, work item keys and actor id — clients refetch through the normal,
  permission-checked API, so no content travels on the stream.
- **After commit only:** events are published when a write request finishes successfully, so a failed or rolled-back
  change never triggers refreshes. Every write route is covered generically (work items, comments, links,
  attachments, sprints, workflow, fields, automation, bulk, import); deletes are resolved before the rows go.
- Limits: max 8 streams per person, 25 s heartbeats. Several server instances are supported (see part 7).

## Phase 4 (part 2): working in bulk

- **Search columns:** *Columns ▾* picks any built-in field or custom field (remembered in this browser).
- **Bulk change:** tick rows (or *select all on this page*) → a bar offers **Move to** (by status name, so one move
  can span spaces), **Assign**, **Priority**, **Labels** (add/remove), **Sprint** (one space at a time) and **Delete**.
  Each item goes through exactly the same rules as editing it alone — permissions, workflow validators, History,
  notifications and automation — and the result lists what changed and *why* anything didn't. Max 100 per action.
- **Export CSV** (Search page): the current JQL with your chosen columns, up to 1,000 rows, only work you can see.
  Cells starting with `= + - @` are prefixed with `'` so spreadsheets don't run them as formulas.
- **Import CSV** (space *List* view): header row maps columns by name — Summary (required), Work type, Priority,
  Assignee/Reporter (email or name), Labels, Description, Due/Start date (YYYY-MM-DD), Story points, Parent, Sprint,
  any custom field by name; other columns are ignored and shown struck through. A **preview** (dry run, nothing
  saved) flags problem rows; importing creates the good rows through the normal create path (automation runs).
  Up to 500 rows / 2 MB. A template is downloadable from the dialog.
- API: `POST /api/bulk {keys, action}`, `GET /api/search/columns`, `POST /api/search/table`,
  `GET /api/search/csv?jql=&columns=`, `POST /api/project/:key/import[?dryRun=true]` (body: CSV text).
- Internals: create / edit / transition / delete are now shared functions in `issues.ts` used by the REST routes,
  bulk change and import, so all paths enforce the same rules.

## Phase 4 (part 1): automation rules

- **Space settings → Automation** (admins): rules read as *When … If … Then …*, with an on/off switch, run/failure
  counts and an **audit log** per rule. The issue page has an **Automation** panel listing rule executions.
- **Triggers:** work item created · transitioned (optionally from/to a status) · a field changed (assignee, priority,
  labels, dates, story points, summary, description, sprint, any custom field) · comment added.
- **Condition:** optional JQL the work item must match (`type = Bug AND priority >= High`).
- **Actions** (in order, up to 10): transition · assign (reporter / whoever triggered it / unassigned / a member) ·
  edit a field (priority, due date incl. `+7d`, story points, custom fields) · add a label · add a comment with smart
  values `{{issue.key}}`, `{{issue.summary}}`, `{{issue.status}}`, `{{initiator}}`.
- **Safety:** rules run right after the change, as a non-login **Automation** user (shown in History, comments and
  notifications). Changes made by rules never trigger rules, so they can't loop. A rule's actions run in one
  transaction — if any fails (e.g. a workflow validator), its changes roll back and the run is logged as *Failed*.
- API: `GET|POST /api/project/:key/automation`, `PUT|DELETE /api/automation/:id`, `GET /api/automation/:id/runs`,
  `GET /api/issue/:key/automation`.

The demo space has two rules: **New bugs start as High priority** (on; also adds a `triage` label) and **Thank
whoever finishes work** (off; comments when work reaches Done).

## Phase 3 (part 4): notifications + timeline

- **Notifications bell** (top bar, unread badge, refreshes every 30 s): **Direct** — someone assigned work to you
  or @mentioned you; **Watching** — comments and status changes on work you watch. Excerpts for comments/mentions,
  "Only unread", mark one (by opening it) or all as read.
- **Rules:** the person who made the change is never notified; only people who can still browse the work are; one
  notification per person per event (a mention outranks "commented"). Creating, commenting on, or being assigned work
  makes you a watcher (Jira behaviour).
- **@mentions:** type `@` in a comment or description for suggestions; `@Display Name` becomes a mention (shown as a
  chip) for people in the space. Editing only notifies newly mentioned people.
- **Timeline** tab: epics with their child work, bars from start to due date; Weeks / Months / Quarters zoom, Today
  line, child progress (done/total). Drag a bar to move it, drag its ends to change start/due, click an empty lane to
  schedule a week. Epics without their own dates show a dashed bar rolled up from their children. Start must be on or
  before due (enforced by the API).
- API: `GET /api/notifications?tab=direct|watching|all&unread=true`, `POST /api/notifications/read {ids | all, tab}`.
  Email delivery is deferred; the notification rows are what an email worker would send.

The demo space has **Severity** (dropdown, Bugs only) and **Customer** (text) fields, and moving to **Done**
requires an **Assignee**.

The demo site also has three shared filters and a **DEMO team dashboard** with all four gadget types.

The demo space starts with **DEMO Sprint 1** active (day 5 of 14, one item done) and **DEMO Sprint 2** planned.
After upgrading from Phase 1, existing data keeps working (schema migrates in place); delete `server/data/` to get the
new demo sprints.

## API (Jira-shaped)

`POST /api/issue` (201 `{id,key}`) · `GET /api/issue/:key?expand=transitions,changelog` ·
`PATCH /api/issue/:key/fields/:fieldId {operation, value}` · `GET|POST /api/issue/:key/transitions` ·
`POST /api/issue/:key/rank` · `GET|POST|PUT|DELETE /api/issue/:key/comment` · `POST|DELETE /api/issue/:key/watchers` ·
`GET|POST /api/search/jql` · `GET|POST /api/project` · `/api/project/:key/{board,aggregate,activity,members}` ·
`/api/auth/{register,login,logout}` · `/api/myself` · `/api/recent`
