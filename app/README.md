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
npm test           # API smoke test on an in-memory database (49 checks)
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

## Accounts, administration and deployment (must-haves)

- **Password reset:** "Forgot password?" on the login page emails a one-time link (1 hour). The answer is the same
  whether or not the email has an account. Resetting signs out every other session.
- **Email verification:** new sign-ups get a confirmation link; until they confirm, a banner offers to resend it.
  Invited and SSO accounts are verified automatically; accounts that existed before this change count as verified.
- **Account & password** (account menu): change your password (other devices are signed out) or sign out everywhere.
- **Login protection:** 5 wrong passwords in 15 minutes for one email (or 20 from one IP) → `429` with `Retry-After`
  for 15 minutes; forgot-password is limited to 3 per hour per email. Sessions end after `SESSION_IDLE_HOURS` (default
  12) without activity and always after 14 days. One-time links store only a hash and travel in the URL fragment.
- **Users** (Administration → Users): search everyone, **invite** by email (they set their own password from a 7-day
  link), resend invites, **deactivate** (signed out everywhere, API tokens stop, work and history kept) and reactivate,
  grant or remove site admin. You can't deactivate yourself or remove the last site admin.
- **Site settings** (Administration → Settings): **who can sign up** — anyone, only people with chosen email domains, or
  nobody (invitation only; invites and SSO still work) — and **who can create spaces** — everyone, or site admins only.
  The login page hides “Create an account” when sign-up is closed. Changes are in the audit log.
- **Groups** (Administration → Groups, and Space settings → Access → Groups): give a group a role in a space and all its
  members get that access; people added later get it too, removed people lose it. Personal access is never
  overridden, and the highest role wins when several groups apply. All of this is in the audit log.

## Selling self-hosted licences (owner guide)

Customers run Tracker on their own servers with their own database. They get a **protected image** (one minified
server file plus the built web app: no source code) and a **monthly licence key** that only you can make.

**Your signing key** lives outside this repository at `~/.tracker-licensing/vendor-private.pem`. Back it up somewhere
safe and offline. Anyone holding it can make licence keys, and without it you can't renew customers. The app contains
only the matching public key (`server/src/license-key.ts`).

**Owner portal** (recommended): a private web app, only for you, to manage customers, their installations and licences,
issue and renew keys from a form, email them to the customer, and see what's due for renewal.

```powershell
npm --prefix app run portal          # then open http://127.0.0.1:4600 (first visit: create your owner account)
```

It keeps its data in `~/.tracker-licensing/portal-data`, next to your private key; back up the whole folder. It listens
on 127.0.0.1 only. To use it from elsewhere, put it behind a VPN, or behind HTTPS with `PORTAL_HOST=0.0.0.0` and
`PORTAL_SECURE_COOKIES=1`, never openly on the internet. To email keys, set `PORTAL_SMTP_URL` and `PORTAL_MAIL_FROM`.
It is never part of the customer image. **On your VPS:** follow `app/portal/DEPLOY.md` (Docker, HTTPS, access only from
your IP or VPN, key mounted read-only, backups).

**Or issue a key from the command line** (customer sends you their Installation ID from Administration → Licence):

```powershell
npm --prefix app run license -- issue --customer "Acme Ltd" --seats 25 --install <installation-id> --months 1
npm --prefix app run license -- inspect <key>     # check any key
```

`--install '*'` makes a key that works on any installation (use it for your own servers only).

**How a key is checked (offline, on their server):** the signature proves you made it and nothing was changed; the
installation ID must match; the expiry date must not have passed. "Now" is the latest of the app clock, the database
clock, the newest recorded activity and the latest time ever seen, so winding clocks back doesn't help. A usage
counter adds up running time and allows the days the key covers plus 14 days of grace, so a frozen clock still runs out.
After expiry: 14 days of grace, then read-only (no data is ever deleted). Wiping the licensing data creates a new
Installation ID that no key matches. Offline licensing deters copying; your licence agreement is the legal protection.

**Build and deliver the image.** Simplest: a versioned image file you share by private download link; the customer runs
`docker load`. Later, a private registry with per-customer read-only access (e.g. Harbor, AWS ECR, Cloudsmith).

```powershell
docker build -t tracker:1.0.0 ./app
docker save tracker:1.0.0 -o tracker-1.0.0.tar      # customer: docker load -i tracker-1.0.0.tar, TRACKER_IMAGE=tracker:1.0.0
```

**Give each customer:** the `app/customer-kit/` folder (`docker-compose.yml`, `.env.example`, `INSTALL.md`), the image
(file or registry access), and then a key each month. `npm run release` builds the protected bundle locally too.

## Deploying

One container serves the API and the web app on port 4000; PostgreSQL holds the data. The image is the protected
release build, so it needs a licence key: issue yourself one with `--install '*'` and install it in Administration → Licence.

```powershell
# app/.env (git-ignored): POSTGRES_PASSWORD=…, APP_URL=https://tracker.example.com, SMTP_URL=…, OIDC_* …
docker compose -f app/docker-compose.yml up -d --build
```

- Put it behind HTTPS (a reverse proxy or load balancer) and set `APP_URL` to the public address and `TRUST_PROXY=1`
  so rate limits and the audit log see real client IPs. Several app containers can share one database.
- Without Docker: `npm ci`, `npm run build -w client`, then `SERVE_CLIENT=1 HOST=0.0.0.0 DATABASE_URL=… npm start`.
- **Right after the first start:** sign up (the first account becomes the site admin), then go to Administration →
  Settings and set sign-up to *invitation only* (or your company's email domain) and, if you like, space creation to
  *site admins only*.
- **Migrations** run automatically at start-up. The demo site is only created on an empty database unless
  `SKIP_SEED=1` (compose sets it): the first person to sign up becomes the site admin.
- **Backups:** `docker compose exec db pg_dump -U tracker -Fc tracker > tracker.dump` (restore with `pg_restore`), plus
  the `attachments` volume. Test a restore before you rely on it.
- **CI** (`.github/workflows/ci.yml`): type-check, client build, smoke tests, the multi-instance test against a real
  PostgreSQL service, and a Docker image build — on every push and pull request.

## Phase 5 (part 4): votes, JQL history, archiving, security levels

- **Votes:** △ Vote on the work item page. One vote per person; not on work you reported or on resolved work.
  Voter names need the Viewer role or higher. JQL `votes >= 3`, `voter = currentUser()`, `ORDER BY votes DESC`.
- **JQL history** (from each work item's History): `status WAS "In Progress"`, `WAS NOT`, `WAS IN (…)`,
  `assignee WAS currentUser()`, and `CHANGED` with `FROM`, `TO`, `BY`, `AFTER`, `BEFORE`, `ON`, `DURING (a, b)`, e.g.
  `status CHANGED FROM "To Do" TO "In Progress" BY dev@tracker.test AFTER -7d`. Works for status, assignee, reporter
  and priority.
- **Archiving** (space admins, work item ⋯ → Archive): archived work and its subtasks disappear from boards, backlogs,
  lists, search, dashboards and counts; it stays readable by key, can't be edited, commented on or logged against, and
  `archived = true` finds it (List view → **Archived**). Restore brings it back. Both are in the audit log.
- **Security levels** (Space settings → Security): each level says which roles and people can see work set to it, plus
  optionally the reporter and assignee. Space admins set a work item's level (only to a level they're in). Everyone
  else gets "not found": the work item, search, filters, dashboards, CSV, board, backlog, summary counts, activity,
  links, recent items and notifications all leave it out. Site admins see everything.

## Phase 5 (part 3): time tracking and WIP limits

- **Estimates:** each work item has an *original estimate* and a *remaining estimate*, written like `1w 2d 3h 30m`
  (1d = 8h, 1w = 5d, as in Jira). Setting an original estimate with no remaining estimate sets both.
- **Log work** (work item page → Time tracking → Log work): time spent, when, and a note. The remaining estimate is
  reduced by the time spent (never below 0), left alone, or set to a new value. A bar shows logged vs remaining, and
  going over the original estimate is called out in text. **Work log** tab in Activity lists every entry; you can edit or
  delete your own (space admins: anyone's), and deleting gives the time back to the remaining estimate.
- Every estimate and time-spent change is in History. Members can log work; viewers can't.
- **JQL:** `timeSpent > 1d`, `originalEstimate = 3d`, `remainingEstimate is EMPTY`, `worklogAuthor = currentUser()`,
  `worklogDate >= -7d`, and `ORDER BY timeSpent`. Original / remaining / time spent are Search and CSV columns.
- **API (Jira-shaped):** `GET|POST /issue/{key}/worklog`, `PUT|DELETE /issue/{key}/worklog/{id}` with
  `adjustEstimate=auto|leave|new|manual`; `fields.timetracking` on create and edit.
- **WIP limits:** space admins set a work-in-progress limit per status (Space settings → Workflow). The board column
  shows `count / limit` and turns red with "Over limit" when exceeded (moving work in isn't blocked, as in Jira).

## Phase 5 (part 2): releases and components

- **Releases tab** in each space: versions with status (unreleased / released / archived), start and release dates
  (overdue ones flagged), and a progress bar of their work (done / in progress / to do, with the numbers beside it).
  Click a version for its work items.
- **Release** a version: unfinished work can move to another unreleased version in the same step. Unrelease, archive
  (archived versions can't be newly set on work), edit, and delete (its work can move to another version) too.
  Managing versions needs the space admin role (`MANAGE_VERSIONS`).
- **Components** (Space settings → Components): name, description and an optional lead (must be a space member);
  deleting one can move its work to another component.
- **On work items:** *Fix versions* and *Components* fields (add/remove on the work item page, or `fields.fixVersions` /
  `fields.components` in the API); every change is in History. Both are columns in Search and CSV export.
- **JQL:** `fixVersion = v1.1`, `fixVersion in unreleasedVersions()` / `releasedVersions()`, `fixVersion is EMPTY`,
  `component in (Payments, "Web app")`, `component != Payments` (Jira semantics: excludes work with no component).
- Version and component changes are in the audit log under *releases*.

## Phase 5 (part 1): API tokens, webhooks, audit log

- **API tokens** (Account → API tokens): let scripts and other tools use the REST API as you, with
  `Authorization: Bearer trk_…` or Jira-style Basic auth (`email:token`). A token has exactly your permissions, is
  shown once (only a hash is stored), can expire (30/90/365 days or never) and can be revoked. Tokens can't create
  more tokens. Up to 20 per person.
- **Webhooks** (Administration → Webhooks, site admins): Tracker POSTs Jira-shaped JSON (`webhookEvent`, `issue`,
  `changelog`, `comment`, `user`) when work items are created, updated or deleted, or comments are added — for all
  spaces or one. Each request is signed: `X-Tracker-Signature: t=<unix>,v1=<HMAC-SHA256(secret, "<t>.<body>")>`;
  `X-Tracker-Delivery` is stable across retries so receivers can de-duplicate. Failed deliveries are retried with
  backoff (1, 2, 4 … 32 minutes; 7 attempts), visible per webhook with a **Send test** button.
  Webhooks can't target private or local addresses (checked on the resolved IP at connect time); set
  `WEBHOOK_ALLOW_PRIVATE=1` in `.env` to allow them, e.g. for an internal receiver.
- **Audit log** (Administration → Audit log, site admins): who changed spaces, members and roles, workflows, fields,
  automation, webhooks and API tokens, plus password and SSO sign-ins (successful and failed), with time and IP.
  Request bodies are never stored.

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
