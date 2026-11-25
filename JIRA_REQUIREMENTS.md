# Requirements: Building a Jira-like Issue Tracker from Scratch

**Source of evidence:** REA runtime capture over Chrome DevTools (see §8) plus live, read-only inspection of the Jira Cloud site `officestackiot.atlassian.net` on 2026-11-25
(projects `SAM1` "(Example) Billing System Dev" and `KAN` "QA Testing", both team-managed Software spaces).
Evidence was collected from the rendered pages, the network requests the app made, and Jira's own read-only REST
metadata endpoints called inside the signed-in session. The only change made to the site is test issue **KAN-4**
(created, assigned, transitioned, commented) used to capture write flows (§8.1).

**Legend**
- **[O] Observed** — seen directly on this instance (page, API response, or network call).
- **[I] Inferred** — standard Jira behaviour implied by what was observed, but not exercised here.
- **MVP / P2 / P3** — suggested build priority.

> Scope note: the sample site is small (10 work items, 2 boards, no sprints, versions, components, or saved filters),
> so features that exist but hold no data here are marked [I] where their *behaviour* was not seen.

---

## 1. Architecture observed

| Area | What Jira Cloud does | Evidence |
|---|---|---|
| Frontend | Single-page app; client-side routes under `/jira/...` and `/browse/{KEY}` | [O] URLs `/jira/for-you`, `/jira/software/projects/SAM1/boards/1`, `/browse/SAM1-7` |
| Public REST API | `/rest/api/3/*` (platform), `/rest/agile/1.0/*` (boards/sprints) | [O] `myself`, `project/search`, `field`, `issue/{key}`, `board`, `board/{id}/configuration` |
| Internal GraphQL | Persisted queries `/gateway/api/graphql/pq/{sha256}?operation=Name` | [O] `TopNavigationQuery`, `JiraHomePageQuery`, `PreviewPanelQuery` |
| Session | Heartbeat `POST /gateway/api/session/heartbeat` | [O] |
| User preferences | Per-user key/value properties `/rest/api/3/user/properties/{key}`, `/rest/api/3/mypreferences` | [O] (404 = not yet set) |
| Avatars | `/rest/api/2/universal_avatar/view/type/project/avatar/{id}` | [O] |
| Analytics / in-app messaging | `gasv3` metadata, `post-office` placements | [O] — **not needed** for a clone |
| Multi-tenancy | Every call scoped by `cloudId` (site) and `orgId` | [O] `cloudId=17f70c51-…` |

**Recommended clone architecture [design choice]:** SPA (React/Vue) + REST API (keep `/rest/api/3` shapes so tooling
is compatible) + relational DB (PostgreSQL) + search index (JQL → SQL first; Elasticsearch/OpenSearch later) +
object storage for attachments + WebSocket/SSE for live board updates + job queue for notifications/automation.

---

## 2. Core domain model

### 2.1 Entities [O unless noted]

| Entity | Key attributes |
|---|---|
| **Site / Tenant** | cloudId, name, org |
| **User** | accountId, displayName, email, avatar, timezone, active; per-user properties (key/JSON) |
| **Group** [I] | name, members (used by `membersOf()` in JQL) |
| **Project ("Space")** | id, key (e.g. `SAM1`), name, type (`software`), style (`next-gen` = team-managed / `classic` = company-managed), lead/owner, default assignee, category, avatar, description |
| **Issue type ("Work type")** | name, hierarchyLevel (**1 = Epic, 0 = Story/Task, -1 = Subtask**), subtask flag, scope (global or project) |
| **Issue ("Work item")** | key `PROJ-N` (per-project sequence), fields (below), parent, changelog, comments, worklogs, attachments, links, watchers, votes |
| **Status** | name, category (`new`/To Do, `indeterminate`/In Progress, `done`/Done), scope (global or project) |
| **Workflow** | statuses + transitions (name, from → to, optional screen, conditions/validators/post-functions [I]) |
| **Priority** | Highest, High, Medium, Low, Lowest |
| **Resolution** | Done (set when an issue moves into a done-category status) |
| **Issue link type** | Blocks / is blocked by; Clones / is cloned by; Duplicates / is duplicated by; Relates to |
| **Board** | id, name, type (`simple` for team-managed, `scrum`/`kanban` [I]), project, filter, columns→status mapping, ranking field, estimation field, WIP constraint |
| **Sprint** [I] | name, state (future/active/closed), goal, start/end dates, board |
| **Version / Release** [I] | name, released flag, release date (`fixVersions`, `versions` fields) |
| **Component** [I] | name, lead, default assignee |
| **Filter** [I] | name, owner, JQL, sharing, subscriptions |
| **Dashboard** | name, gadgets layout ([O] "Default dashboard" exists) |
| **Project role** | Administrator, Member, Viewer, guest (`jira-guest-member`), add-on access |
| **Permission** | 48 keys, GLOBAL or PROJECT scope (see §6) |
| **Custom field** | id `customfield_NNNNN`, name, type, context (projects/issue types), options |
| **Automation rule** | trigger, conditions, actions, execution log ([O] "Automation / Rule executions" panel on issue) |

### 2.2 Issue fields observed on this site (51 total)

**System fields [O]:** `summary`, `description` (rich text, **Atlassian Document Format JSON**), `issuetype`, `project`,
`status`, `statusCategory`, `statuscategorychangedate`, `priority`, `resolution`, `resolutiondate`, `assignee`, `reporter`,
`creator`, `created`, `updated`, `lastViewed`, `duedate`, `labels[]`, `components[]`, `fixVersions[]`, `versions[]`,
`parent`, `subtasks[]`, `issuelinks[]`, `attachment[]`, `comment`, `worklog[]`, `watches`, `votes`, `environment`,
`security` (issue security level), `issuerestriction`, time tracking (`timeoriginalestimate`, `timeestimate`,
`timespent`, `aggregate*`, `progress`, `aggregateprogress`, `workratio`, `timetracking`).

**Custom fields present [O]:** Flagged (multi-checkbox), Rank (lexorank), Start date, Issue color, Development
(dev summary), Team, Agent Sessions. Story points / Sprint exist as JQL fields [I] but were empty in sample data.

**Rich text [O]:** description is ADF JSON (`doc → paragraph, bulletList, listItem, text` + marks like `strong`).
Clone requirement: store a structured document (ADF or ProseMirror JSON) and render it; support headings, lists,
code, tables, mentions, links, emoji, media [I for the extra node types].

**Ordering [O]:** `Rank` uses **LexoRank** strings so drag-and-drop reordering updates one row instead of renumbering.

---

## 3. Functional requirements

### 3.1 Projects / spaces — MVP
- [O] Create/list/browse projects; unique uppercase **key** used as issue-key prefix.
- [O] Settings pages: **Details** (name, key, category, owner, default assignee, icon), **Access**, **Automation**,
  **Policies**, **Fields**, **Features**, **Custom filters** (board quick filters), **Toolchain** (dev-tool links).
- [O] Two project styles: team-managed (`simplified: true`, project-scoped issue types/statuses) and
  company-managed (shared schemes) — **MVP: team-managed only**; P2: schemes.
- [O] Feature toggles per project: **Sprints** (requires backlog), **Estimation**, **Standups**.

### 3.2 Project views (tabs observed on SAM1) [O]
| View | Requirement | Priority |
|---|---|---|
| **Summary** | Project overview: status breakdown, recent activity, workload, priority/type charts [I for widgets] | P2 |
| **List** | Spreadsheet of issues; sortable columns (Work, Assignee, Reporter, Priority, Status, Resolution, Created, Updated, Due date); configurable columns; expand parent→children hierarchy; inline create; "Copy link"; row actions; count ("5 of 5"); refresh | MVP |
| **Board** | Columns mapped to statuses (To Do / In Progress / In Review / Done); per-column counts; collapse column; cards show summary, key, parent epic, due date; inline summary edit; card actions; drag-and-drop transitions + rank; filter by assignee; **Group** (none/assignee/epic/…); board insights; view settings; WIP limits (constraint `none` here) | MVP |
| **Backlog** | Rank-ordered backlog + sprint containers (appears when Sprints enabled) [I] | P2 |
| **Timeline** | Gantt of epics/children using start date + due date, dependencies [I] | P2 |
| **Forms** | Intake forms that create issues [I] | P3 |
| **Docs** | Linked documentation pages (Confluence integration) | P3 / skip |

### 3.3 Issue (work item) view — MVP [O]
- Breadcrumb: project → parent (`SAM1-2`) → issue key.
- Editable **summary** and **description** (rich text), attachments (upload, list, delete), **subtasks** (add/create
  child), **linked work items** (add link with type), "Add or create work related to this…".
- **Status button** with available transitions (sample: To Do, In Progress, In Review, Done — "all-to-all" workflow).
- **Details panel**: Assignee (+ "Assign to me"), Parent, Priority, Labels, Due date, Team, Start date, Reporter,
  Development; layout configurable per project (`EDIT_ISSUE_LAYOUT`).
- **Activity** tabs: All / Comments / History / Work log; newest-first toggle; comment box with quick replies;
  keyboard shortcut **M** to comment.
- Created / Updated timestamps; Share; More actions (clone, move, delete, watch, vote, print/export [I]).
- Open as full page (`/browse/KEY`) **and** as side panel over board/list (resize handle observed).
- AI helpers ("Summarize work item", "Improve Task") — **P3 / optional**.

### 3.4 Create issue — MVP [I, with field list O]
- Global **Create** button (top bar) → modal: project, issue type, summary, description, assignee, priority, labels,
  parent, due/start date, custom fields per field configuration; "create another" toggle.
- Validates required fields; returns key from a per-project counter (must be atomic).
- Inline create on board columns and list rows.

### 3.5 Workflow engine — MVP
- [O] Status categories drive colour, board "done" logic, and resolution.
- [O] Team-managed: per-project statuses; default transitions allow any→any.
- [I] Company-managed: explicit transitions with **conditions** (permission/user), **validators** (field required),
  **post-functions** (set resolution, assign, fire event), and **transition screens**. P2.
- [O] Every change writes a **changelog** entry (`field: from → to`), shown under History.

### 3.6 Search & JQL — MVP (subset), P2 (full)
Observed in `/rest/api/3/jql/autocompletedata`:
- **150 searchable fields**, **178 reserved words**.
- **Operators [O]:** `= != < <= > >= ~ !~ in, not in, is, is not, was, was in, was not, was not in, changed`.
- **Functions [O] (Software-relevant):** `currentUser()`, `membersOf()`, `now()`, `startOfDay/Week/Month/Year()`,
  `endOfDay/Week/Month/Year()`, `openSprints()`, `closedSprints()`, `futureSprints()`, `releasedVersions()`,
  `unreleasedVersions()`, `latestReleasedVersion()`, `earliestUnreleasedVersion()`, `linkedIssues()`,
  `watchedIssues()`, `votedIssues()`, `issueHistory()`, `updatedBy()`, `subTaskIssueTypes()`,
  `standardIssueTypes()`, `projectsLeadByUser()`, `projectsWhereUserHasPermission()`,
  `projectsWhereUserHasRole()`, `componentsLeadByUser()`, `inactiveUsers()`.
  (Service-management functions such as `breached()`, `approver()` exist but are out of scope.)
- Requirements: parser + autocomplete, `ORDER BY`, text search (`~`), history operators (`was`, `changed`) backed by
  the changelog, permission-filtered results, pagination (`/rest/api/3/search/jql` with `nextPageToken`) [O endpoint].
- Basic search UI (dropdown filters) that generates JQL, plus advanced JQL editor.
- Saved **filters** with sharing and email subscriptions — P2.

### 3.7 Agile (boards, backlog, sprints, estimation)
- [O] `GET /rest/agile/1.0/board`, `/board/{id}/configuration` (columns→status IDs, rank field, estimation, constraint).
- MVP: Kanban-style board with columns, drag/drop transition + rank, quick filters, swimlanes/grouping.
- P2: Scrum — backlog, create/start/complete sprint (move unfinished items), sprint goal, story-point estimation,
  WIP limits per column.
- P2: Reports — burndown/burnup, velocity, cumulative flow, sprint report, cycle-time ("Board insights" [O]).

### 3.8 Home / personal pages [O]
- **For you**: Recommended, Assigned to me (with count), Starred, Worked on; recent spaces; "View all spaces".
- Starred items and recently viewed (`lastViewed` field).
- Top navigation: app switcher, global search, Create, notifications, help, profile/settings.

### 3.9 Collaboration — MVP
- Comments (rich text, edit/delete own vs all — separate permissions), @mentions with notification [I].
- Watchers (manage watchers permission), votes, share link.
- Notifications: in-app + email on create/assign/comment/transition/mention [I]; per-user preferences.
- Attachments: upload, preview thumbnails, delete own/all.
- Work log: log time, edit/delete own/all; original/remaining estimate; progress bars.

### 3.10 Dashboards — P2
- [O] Default dashboard exists. Gadgets [I]: filter results, pie chart, created vs resolved, assigned to me,
  activity stream, sprint health.

### 3.11 Automation — P2
- [O] Project-level Automation settings and per-issue "Rule executions".
- Rule = trigger (issue created/transitioned/field changed/scheduled) + conditions (JQL / field compare) +
  actions (transition, assign, edit field, comment, send email, create issue, webhook) + audit log.

### 3.12 Administration
- [O] Project roles: Administrator, Member, Viewer, Guest.
- [O] Global admin vs site admin (`ADMINISTER`, `SYSTEM_ADMIN`).
- [I] User/group management, custom field management, issue type/workflow/screen/permission schemes (company-managed),
  issue security levels, audit log, webhooks, API tokens, import (CSV), export (CSV/Excel), archiving issues.

### 3.13 Integrations — P3
- [O] "Development" field + Toolchain settings: link branches, commits, PRs, builds, deployments (GitHub/GitLab/Bitbucket).
- [O] Connect/Forge app framework (`atlassian-connect/addons-baseurl`, "Add apps") — replace with a simple
  webhook + REST + OAuth/API-token model.

---

## 4. Permissions model [O] — implement in MVP

48 permission keys. Project-scoped ones (grant to role/group/user via a permission scheme):

`BROWSE_PROJECTS, CREATE_ISSUES, EDIT_ISSUES, DELETE_ISSUES, ASSIGN_ISSUES, ASSIGNABLE_USER, CLOSE_ISSUES,
RESOLVE_ISSUES, TRANSITION_ISSUES, MOVE_ISSUES, LINK_ISSUES, SCHEDULE_ISSUES, MODIFY_REPORTER, ARCHIVE_ISSUES,
UNARCHIVE_ISSUES, SET_ISSUE_SECURITY, ADD_COMMENTS, EDIT_ALL_COMMENTS, EDIT_OWN_COMMENTS, DELETE_ALL_COMMENTS,
DELETE_OWN_COMMENTS, CREATE_ATTACHMENTS, DELETE_ALL_ATTACHMENTS, DELETE_OWN_ATTACHMENTS, WORK_ON_ISSUES,
EDIT_ALL_WORKLOGS, EDIT_OWN_WORKLOGS, DELETE_ALL_WORKLOGS, DELETE_OWN_WORKLOGS, MANAGE_WATCHERS,
VIEW_VOTERS_AND_WATCHERS, MANAGE_SPRINTS_PERMISSION, MANAGE_VERSIONS, ADMINISTER_PROJECTS, EDIT_WORKFLOW,
VIEW_READONLY_WORKFLOW, EDIT_ISSUE_LAYOUT, VIEW_DEV_TOOLS, VIEW_AGGREGATED_DATA`

Global: `ADMINISTER, SYSTEM_ADMIN, CREATE_PROJECT, BULK_CHANGE, CREATE_SHARED_OBJECTS, USER_PICKER,
MANAGE_GROUP_FILTER_SUBSCRIPTIONS, MANAGE_CUSTOM_ONBOARDING`

MVP can collapse these into the 4 roles (Admin, Member, Viewer, Guest) with a fixed mapping, keeping the keys in code so
schemes can be added later. Issue-level security (`security`, `issuerestriction`) is P2.

---

## 5. API surface to implement (compatible subset)

| Method & path | Purpose | Seen |
|---|---|---|
| `GET /rest/api/3/myself` | current user | O |
| `GET /rest/api/3/project/search` · `GET/POST/PUT /project/{key}` | projects | O |
| `GET /rest/api/3/project/{key}/statuses` | statuses per issue type | O |
| `GET /rest/api/3/field` | field catalogue | O |
| `GET /rest/api/3/issuetype`, `/priority/search`, `/resolution/search`, `/issueLinkType`, `/role`, `/permissions` | metadata | O |
| `GET /rest/api/3/issue/{key}?expand=changelog,transitions,editmeta,renderedFields,names` | issue read | O |
| `POST /rest/api/3/issue` · `PUT /issue/{key}` · `DELETE /issue/{key}` | create/edit/delete | I |
| `GET/POST /rest/api/3/issue/{key}/transitions` | workflow | O (GET via expand) |
| `GET/POST /rest/api/3/issue/{key}/comment`, `/worklog`, `/attachments`, `/watchers`, `/votes` | collaboration | I |
| `POST /rest/api/3/issueLink` | links | I |
| `GET /rest/api/3/search/jql` | JQL search (token paging) | O |
| `GET /rest/api/3/jql/autocompletedata` | JQL editor | O |
| `GET /rest/api/3/filter/search`, `/dashboard` | filters, dashboards | O |
| `GET /rest/api/3/project/{key}/components`, `/versions` | releases/components | O |
| `GET/PUT /rest/api/3/user/properties/{key}` | per-user prefs | O |
| `GET /rest/agile/1.0/board`, `/board/{id}/configuration`, `/board/{id}/sprint`, `/board/{id}/issue` | agile | O |
| `PUT /rest/agile/1.0/issue/rank` · sprint CRUD | rank & sprints | I |

---

## 6. Non-functional requirements [design choices, informed by observation]

- **Multi-tenancy:** tenant id on every row/query (Jira scopes by `cloudId`).
- **Issue-key generation:** atomic per-project counter; keys stay stable when issues move (keep old-key alias) [I].
- **Audit trail:** immutable changelog for every field change (drives History, `was`/`changed` JQL, reports).
- **Ordering:** LexoRank for board/backlog rank.
- **Search:** permission-aware; indexed; sub-second for 100k+ issues per tenant.
- **Realtime:** board/issue updates pushed to other viewers.
- **Rich text:** structured JSON document with server-side sanitising; mentions resolved to account IDs.
- **Attachments:** object storage, virus scan, thumbnails, size limits.
- **Auth:** SSO/OAuth (Google/Microsoft/Apple/Slack seen on login page [O]), email+password, passkeys, API tokens.
- **Session heartbeat** and idle timeout [O].
- **i18n/timezones:** dates shown in user locale (observed "Nov 25, 2026, 11:39 AM").
- **Accessibility:** keyboard shortcuts (e.g. `M` comment [O]), ARIA labels (observed throughout, e.g. "Card actions on Task SAM1-6").

---

## 7. Suggested build roadmap

| Phase | Deliverables |
|---|---|
| **1 — MVP core** | Auth, users, tenants; projects (team-managed); issue types Epic/Story/Task/Subtask with hierarchy; statuses + simple workflow; issue CRUD with system fields; rich-text description; comments; attachments; changelog/History; List view; Kanban board with drag-drop + LexoRank; basic search + JQL subset (`= != in ~ AND OR ORDER BY`, `currentUser()`); role-based permissions; notifications (in-app + email) |
| **2 — Agile & power users** | Backlog, sprints, estimation, WIP limits, reports; full JQL incl. history operators & functions; saved filters + subscriptions; dashboards & gadgets; custom fields & field layouts; versions/components; issue links UI; time tracking; watchers/votes; bulk edit; CSV import/export |
| **3 — Enterprise** | Company-managed schemes (workflow, permission, field, notification); workflow conditions/validators/post-functions; issue security; automation engine; Timeline; webhooks & REST API tokens; dev-tool integrations; audit log; archiving; Forms; AI summaries |

---

## 8. REA runtime capture (Chrome via CDP, 2026-11-25)

REA `capture_browser_scenario` drove a separate Chrome profile (debug port 9222) through Board, Issue, List, Summary,
Dashboards and Field settings with **navigation only** (no clicks that change data). Evidence bundle:
[evidence/jira-capture-bundle.json](evidence/jira-capture-bundle.json).

| Capture | Evidence ID | Screens | Transactions | Dropped |
|---|---|---|---|---|
| Run A | `ev_dac431fd…85fc` | Board → Issue | 423 | 0 |
| Run B | `ev_1f3b504f…72f2` | List → Summary → Dashboards → Fields | 712 | 0 |
| Static bundle scan | `ev_8d1c1368…acaf5` | For-you page JS (37 scripts) | — | routes/endpoints are built at runtime, so static scan found ~none |
| (Superseded) | `ev_ebf3aec6…00f5` | first attempt, 2595 events dropped by budget | 249 | yes |

**Screen → backend calls observed [O]** (analytics, in-app messaging and upsell calls filtered out):

| Screen | Calls that load its data |
|---|---|
| **Board** | Server-side-rendered document (`x-jira-ssr-service-name` header) + `POST /gateway/api/graphql` (project by id/key → `projectStyle: TEAM_MANAGED_PROJECT`, ARI id `ari:cloud:jira:{cloudId}:project/10000`) + `useSetMostRecentlyViewedBoardMutation` |
| **Issue view** | `issueViewRemoteDataQuery` (remote issue links, Confluence linked/mentioned pages, web links) · `transitionsRelayQueryForStatusFieldQuery` (status dropdown) · `issueViewDevPanelSummaryDataQuery` (branches/PRs) · `rootUiModificationsQuery` (UI customisation) · `POST /rest/internal/2/issue/{key}/history` (records "recently viewed") · `GET /rest/api/3/issue/{key}/properties/recurrence-config` (issue properties) |
| **List** | `EntryPointContentQuery` · `batchIsEditableInIssueViewFactoryQuery` (per-row inline-edit permission) · URL rewritten to `?jql=project = SAM1 ORDER BY cf[10019] ASC` (list is a JQL view ordered by Rank) |
| **Summary** | `SummaryPageData` · `POST /rest/api/3/search/approximate-count` (stat tiles, e.g. `{"count":10}`) · `POST /rest/internal/data/aggregate/project/{id}` (group-by counts: by status with category, by epic) · `GET /rest/internal/data/activity-stream/project/{id}` |
| **Dashboards** | `DashboardsContentViewQuery`, `MergedDashboardsContent_dashboardsQuery`, `Nav4DashboardsContentQuery` · `GET /rest/api/3/project/search` · `GET /rest/api/3/groups/picker` (share-with picker) |
| **All pages** | `Nav4ProjectsContentQuery` (sidebar), `AsyncIssueCreateModalWithPreferencesQuery` (preloads Create modal), `GET /rest/api/3/user`, `frontendconfig/properties`, session heartbeat |

**New requirements derived from this capture:**
- **"Recently viewed" tracking** for issues, boards and projects (separate write on each visit) → powers *For you* and sidebar. MVP.
- **Aggregation API** (count by status/category, epic, assignee, priority, type) for the Summary page and dashboard gadgets. MVP-lite.
- **Approximate count** endpoint for JQL so stat tiles don't run full searches. P2.
- **Activity stream** per project (create/update/transition/comment events), built from the changelog. MVP.
- **Per-row edit permissions** returned in batch for list/board inline editing. MVP.
- **Remote links** on issues (web links, linked docs) separate from issue-to-issue links. P2.
- **Global resource IDs** (ARI-style `scheme:cloud:product:{tenant}:type/{id}`) alongside numeric ids and keys. Design choice.
- **Server-side render** of first paint for board/issue pages, then hydrate. Optional (performance).

### 8.1 Write flows captured on a test issue (KAN-4)

With your approval, REA drove the real UI to create **KAN-4 "REA capture test - safe to delete"** in *QA Testing*,
assign it, move it To Do → In Progress, and add a comment. Request + response bodies were recorded.
Evidence bundle: [evidence/jira-write-flows-bundle.json](evidence/jira-write-flows-bundle.json).

| Flow | Evidence ID | UI action | Request observed [O] | Response [O] |
|---|---|---|---|---|
| Open Create | `ev_ce542f6d…410f8d` | top-bar **Create** | `POST /rest/gira/1/?operation=JiraGlobalIssueCreateModalLoad` → ordered field layout (summary, description, assignee, parent, priority, labels, duedate…); `JiraProjects` (recent + all projects in `CREATE_ISSUE` context); `myPermissions(ADMINISTER_PROJECTS)` | layout JSON |
| **Create issue** | same | modal **Create** | `POST /rest/api/3/issue?updateHistory=true&applyDefaultValues=false&skipAutoWatch=true` body `{"fields":{"project":{"id":"10001"},"issuetype":{"id":"10008"},"summary":"…","priority":{"id":"3"},"labels":[],"reporter":{"id":"<accountId>"},"issuerestriction":{"projectrole":[]},"customfield_10021":[]},"update":{},"watchers":["<accountId>"],"externalToken":"0.2079…"}` | **201** `{"id":"10013","key":"KAN-4","self":…,"watchers":{"status":200}}` |
| Post-create | same | — | `POST /rest/api/3/search/jql` `{"jql":"issuekey=KAN-4","fields":[…],"reconcileIssues":[10013]}` (refresh board card); AI `fieldPrediction` for priority/assignee; parent-candidate suggestions | success flag "Created Task KAN-4" |
| **Assign to me** | `ev_28d6cd9e…11e6` | **Assign to me** | GraphQL `AssignToMeInlineEditInner_new_Mutation` `{"input":{"id":"ari:cloud:jira:{cloudId}:issuefieldvalue/10013/assignee","operation":{"operation":"SET","id":"ari:cloud:identity::user/<accountId>"}}}` | `updateSingleSelectUserPickerField.success=true` + updated user |
| **Transition** | same | Status → *In Progress* | GraphQL `IssueViewStatusFieldMutation` `{"input":{"id":"…:issuefieldvalue/10013/status","statusTransitionId":21}}` | `updateStatusByQuickTransition.success=true`; then `mainIssueAggQuery` reloads the issue |
| **Comment** | `ev_cee02964…d9bd2` | **M** shortcut → type → **Save** | GraphQL `useSaveCommentRelayAddCommentMutation` `{"input":{"issueId":"ari:…:issue/10013","content":{"version":1,"jsonValue":{"type":"doc","version":1,"content":[{"type":"paragraph","attrs":{"localId":"b951…"},"content":[{"type":"text","text":"REA capture test comment"}]}]}},"permissionLevel":null},"isRootComment":true}` | `addComment.success=true`, `commentId:"10000"`, created/updated timestamps, ADF echo; then `POST /gateway/api/reactions/reactions/view` for the comment |

**Requirements derived from the write flows:**
- **Create = REST, edits = per-field mutations.** Create posts the whole field map once; later edits update **one
  field at a time**, addressed as `issuefieldvalue/{issueId}/{fieldId}`, with a typed operation (`SET`, add/remove for
  multi-values [I]). Build an inline-edit API shaped `PATCH /issues/{id}/fields/{fieldId}` with typed ops. MVP.
- **Create options:** `updateHistory` (add to recent), `applyDefaultValues`, `skipAutoWatch`; reporter auto-set to
  the creator; creator auto-added as **watcher**; client `externalToken` for idempotency / matching the optimistic card. MVP.
- **Create-screen layout is data-driven** (ordered field list per project + issue type), not hard-coded. MVP.
- **Transitions are addressed by transition id** (e.g. `21`), not target status; "quick transition" from the status
  button; reload issue after success. MVP.
- **Comments are ADF documents** with per-node `localId`s; flags for root vs reply (threaded replies), visibility
  restriction (`permissionLevel`), and server-assigned `commentId` + timestamps. Comment **reactions** are a separate
  service keyed by comment ARI. MVP (reactions P2).
- **Optimistic UI + reconcile:** after a write, the client re-fetches only the changed issue (`reconcileIssues`) to
  update the board card. MVP.
- **AI suggestions** (priority/assignee/parent prediction from summary) are optional. P3.

## 9. Gaps / unknowns in this capture

- Create, assign, transition and comment were captured on test issue KAN-4. **Not** captured: description edit,
  attachments upload, issue linking, subtasks, drag-and-drop rank/column move, sprint operations, delete.
- Some response bodies over the retained size (activity stream, SummaryPageData, `mainIssueAggQuery`) were not kept.
- GraphQL queries are persisted (sent as hashes), so query text and full response schemas are not visible.
- Apart from test issue KAN-4 (§8.1), only read operations were performed on the site.
- Sample data had no sprints, versions, components, saved filters, comments or worklogs, so those behaviours are [I].
- Backlog, Timeline, Summary and Forms tab contents were not opened in detail (Timeline URL guessed wrongly → 404).
- Company-managed project configuration (schemes, workflow designer) was not inspected — both projects are team-managed.
- GraphQL operation payloads were not decoded; only operation names were recorded.
