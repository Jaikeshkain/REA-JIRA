// Typed client for the Tracker API (shapes follow app/server/src/issues.ts + projects.ts).

export interface User { accountId: string; displayName: string; emailAddress?: string; avatarColor?: string; isSiteAdmin?: boolean; role?: string }
export interface StatusCat { key: 'todo' | 'in_progress' | 'done'; name?: string }
export interface Status { id: string; name: string; statusCategory: StatusCat }
export interface IssueType { id: string; name: string; hierarchyLevel: number; color: string }
export interface Priority { id: string; name: string; color: string }
export interface Adf { type: string; text?: string; content?: Adf[]; attrs?: Record<string, any>; marks?: { type: string; attrs?: any }[] }
export interface Issue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description: Adf | null;
    project: { id: string; key: string; name: string };
    issuetype: IssueType;
    status: Status;
    priority: Priority | null;
    assignee: User | null;
    reporter: User | null;
    parent: { id: string; key: string; summary: string; issuetype: string } | null;
    labels: string[];
    duedate: string | null;
    startdate: string | null;
    storypoints: number | null;
    resolution: { name: string } | null;
    created: string;
    updated: string;
    watches: { watchCount: number; isWatching?: boolean };
    sprint: { id: string; name: string; state: SprintState } | null;
    fixVersions?: { id: string; name: string; released: boolean; archived?: boolean }[];
    components?: { id: string; name: string }[];
    timetracking?: { originalEstimate?: string; originalEstimateSeconds?: number; remainingEstimate?: string; remainingEstimateSeconds?: number; timeSpent?: string; timeSpentSeconds?: number };
    timespent?: number | null;
    issuelinks?: IssueLink[];
    attachment?: Attachment[];
  };
  children?: Issue[];
  transitions?: Transition[];
  customFields?: CustomField[];
  changelog?: ChangeEntry[];
  permissions?: Record<string, boolean>;
}
export interface Transition { id: string; name: string; to: { id: string; name: string; statusCategory: StatusCat }; requiredFields?: string[] }
export type CfType = 'text' | 'paragraph' | 'number' | 'date' | 'select' | 'multiselect' | 'user';
export interface CustomField {
  id: string; fieldId: string; name: string; description: string; type: CfType;
  options: { id: string; value: string }[]; required: boolean; issueTypeIds: string[] | null; position: number;
}
export interface Workflow {
  statuses: (Status & { position: number; issueCount: number; wipLimit?: number | null })[];
  transitions: { id: string; name: string; from: string | null; to: string; requiredFields: string[]; allowedRoles: string[] | null }[];
  requirableFields: { id: string; name: string }[];
}
export interface ChangeEntry { id: string; author: User; created: string; items: { field: string; fromString: string | null; toString: string | null }[] }
export interface Comment { id: string; author: User; body: Adf; created: string; updated: string }
export interface ProjectSummary { id: string; key: string; name: string; description: string; lead: User | null; myRole: string | null; issueCount: number }
export interface Project {
  id: string; key: string; name: string; description: string; lead: User | null;
  issueTypes: IssueType[]; statuses: (Status & { position: number })[]; members: User[]; myRole: string | null; myPermissions: string[];
  features: { sprints: boolean };
}
export interface Version {
  id: string; name: string; description: string; projectId: string; startDate: string | null; releaseDate: string | null;
  released: boolean; archived: boolean; overdue: boolean; issues?: { total: number; todo: number; inProgress: number; done: number } | null;
}
export interface Component { id: string; name: string; description: string; projectId: string; lead: { accountId: string; displayName: string } | null; issueCount: number }
export interface Worklog { id: string; issueId: string; author: User | null; comment: string; started: string; created: string; updated: string; timeSpent: string; timeSpentSeconds: number }
export interface Dependency { id: string; blocker: string; blocked: string }
export interface LinkType { id: string; name: string; inward: string; outward: string }
export interface LinkedIssue {
  id: string; key: string;
  fields: { summary: string; status: Pick<Status, 'name' | 'statusCategory'>; issuetype: { name: string; color: string }; priority: { name: string; color: string } | null };
}
export interface IssueLink { id: string; type: LinkType; relation: string; inwardIssue?: LinkedIssue; outwardIssue?: LinkedIssue }
export interface Attachment { id: string; filename: string; mimeType: string; size: number; created: string; author: User; content: string; isImage: boolean }
export type ShareType = 'private' | 'project' | 'site';
export interface Share { type: ShareType; project: { key: string; name: string } | null }
export interface SavedFilter {
  id: string; name: string; description: string; jql: string; owner: User; share: Share;
  favourite: boolean; favouriteCount: number; editable: boolean; updated: string;
}
export type GadgetType = 'filter-results' | 'breakdown' | 'created-vs-resolved' | 'assigned-to-me';
export interface Gadget { id: string; type: GadgetType; column: number; position: number; config: Record<string, any> }
export interface Dashboard { id: string; name: string; description: string; owner: User; share: Share; editable: boolean; updated: string; gadgets?: Gadget[] }
export type GadgetData =
  | { unavailable: string }
  | { source: { id: string; name: string; jql: string } | null; jql: string; total: number; issues: Issue[] }
  | { source: { id: string; name: string }; field: string; total: number; groups: { name: string; count: number }[] }
  | { source: { id: string; name: string }; days: number; totals: { created: number; resolved: number }; series: { date: string; created: number; resolved: number }[] };
export type NotificationKind = 'assigned' | 'mentioned' | 'commented' | 'status';
export interface AppNotification {
  id: string; kind: NotificationKind; read: boolean; created: string; actor: User;
  issue: { key: string; summary: string }; data: { excerpt?: string; from?: string; to?: string; where?: string };
}
export interface Inbox { unread: { unread: number; direct: number; watching: number }; items: AppNotification[] }
export type AutoTrigger =
  | { type: 'issue_created' }
  | { type: 'issue_transitioned'; toStatusId?: string | null; fromStatusId?: string | null }
  | { type: 'field_changed'; field: string }
  | { type: 'comment_added' }
  | { type: 'scheduled'; every: 'hour' | 'day' | 'week'; hourUtc?: number };
export type AutoAction =
  | { type: 'transition'; statusId: string }
  | { type: 'assign'; to: string }
  | { type: 'set_field'; field: string; value: any }
  | { type: 'add_label'; label: string }
  | { type: 'comment'; text: string };
export interface AutomationRule {
  id: string; name: string; enabled: boolean; trigger: AutoTrigger; condition: string | null; actions: AutoAction[];
  owner: User; updated: string; stats: { runs: number; errors: number; lastRun: string | null }; nextRun?: string | null;
}
export type EmailPref = 'immediate' | 'digest' | 'off';
export interface Preferences { emailNotifications: EmailPref; emailMode: 'smtp' | 'outbox'; digestHourUtc: number }
export interface FilterSubscription { id: string; filterId: string; frequency: 'daily' | 'weekly'; hourUtc: number; weekday: number | null; emailWhenEmpty: boolean; nextRun: string; lastRun: string | null }
export interface OutboxEmail { id: string; to: string; kind: string; subject: string; status: 'queued' | 'sent' | 'outbox' | 'failed'; attempts: number; error: string | null; created: string; sent: string | null; text: string; html: string }
export type TickResult = { skipped: true } | { notifications: number; subscriptions: number; rules: { rules: number; items: number }; delivery: { sent: number; failed: number }; webhooks?: { sent: number; failed: number } };
export interface ApiToken { id: string; name: string; hint: string; created: string; lastUsed: string | null; expires: string | null }
export type WebhookEventName = 'issue_created' | 'issue_updated' | 'issue_deleted' | 'comment_created';
export interface Webhook { id: string; name: string; url: string; events: WebhookEventName[]; enabled: boolean; project: { key: string } | null; created: string; secretHint: string; stats?: { success: number; failed: number; pending: number; last: string | null } }
export interface WebhookDelivery { id: string; event: string; status: 'queued' | 'sending' | 'success' | 'failed'; attempts: number; responseStatus: number | null; error: string | null; created: string; delivered: string | null; nextTry: string | null; issueKey: string | null }
export interface AuditEntry { id: string; created: string; category: string; action: string; target: string | null; ip: string | null; actor: { accountId: string; displayName: string } | null }
export interface AutomationRun {
  id: string; status: 'success' | 'no_action' | 'error'; message: string; actions: string[]; created: string;
  rule: { id: string; name: string }; issue: { key: string; summary: string } | null; initiator: User | null;
}
export interface ColumnDef { id: string; label: string; space?: string }
export type BulkAction =
  | { type: 'transition'; statusName: string }
  | { type: 'edit'; field: string; operation?: 'SET' | 'ADD' | 'REMOVE'; value: any }
  | { type: 'delete' };
export interface BulkResult { succeeded: number; failed: number; results: { key: string; ok: boolean; error?: string }[] }
export interface ImportResult {
  dryRun: boolean; ok: number; failed: number; ignored: string[];
  mapping: { column: string; field: string | null }[];
  rows: { row: number; ok: boolean; key?: string; errors: string[]; summary: string }[];
}
export type SprintState = 'future' | 'active' | 'closed';
export interface Sprint { id: string; name: string; goal: string; state: SprintState; startDate: string | null; endDate: string | null; completeDate: string | null }
export interface BacklogData {
  sprintsEnabled: boolean;
  sprints: { sprint: Sprint; issues: Issue[]; points: { total: number; done: number; todo: number } }[];
  backlog: { issues: Issue[]; points: number };
}
export interface ReportRow { key: string; summary: string; points: number | null; status: string; category: StatusCat['key']; type: { name: string; color: string }; addedAfterStart: boolean; outcome: string }
export interface SprintReport {
  sprint: Sprint;
  summary: Record<'committedPoints' | 'committedCount' | 'addedPoints' | 'addedCount' | 'completedPoints' | 'completedCount' | 'notCompletedPoints' | 'notCompletedCount' | 'removedCount', number>;
  burndown: { date: string; remainingPoints: number | null; remainingCount: number | null; scopePoints: number | null; idealPoints: number }[];
  completed: ReportRow[]; notCompleted: ReportRow[]; removed: ReportRow[];
}
export interface SearchResult { jql: string; total: number; startAt: number; maxResults: number; issues: Issue[] }

const TOKEN_KEY = 'tracker.token';
export const session = {
  get token() {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  set(token: string | null) {
    try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
  },
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public errors?: Record<string, unknown>) { super(message); }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(session.token ? { authorization: `Bearer ${session.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    session.set(null);
    window.dispatchEvent(new Event('tracker:logout'));
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.errorMessages?.[0] ?? `Request failed (${res.status})`, data?.errors);
  return data as T;
}

export const api = {
  login: (email: string, password: string) => call<{ token: string; user: User }>('POST', '/auth/login', { email, password }),
  register: (email: string, displayName: string, password: string) =>
    call<{ token: string; user: User }>('POST', '/auth/register', { email, displayName, password }),
  logout: () => call('POST', '/auth/logout'),
  ssoConfig: () => call<{ enabled: boolean; name: string | null; passwordLogin: 'all' | 'admins' }>('GET', '/auth/oidc/config'),
  ssoExchange: (code: string) => call<{ token: string; next: string; user: User }>('POST', '/auth/oidc/exchange', { code }),
  myself: () => call<User>('GET', '/myself'),
  projects: () => call<ProjectSummary[]>('GET', '/project'),
  createProject: (key: string, name: string, description?: string) => call<{ key: string }>('POST', '/project', { key, name, description }),
  project: (key: string) => call<Project>('GET', `/project/${key}`),
  board: (key: string, assignees: string[] = [], q = '') =>
    call<{ sprintsEnabled: boolean; sprint: Sprint | null; columns: { status: Status; issues: Issue[] }[] }>(
      'GET', `/project/${key}/board?assignee=${encodeURIComponent(assignees.join(','))}&q=${encodeURIComponent(q)}`,
    ),
  aggregate: (key: string, by: string) =>
    call<{ totals: Record<string, number>; groups: { name: string; category?: string; color?: string; count: number }[] }>('GET', `/project/${key}/aggregate?by=${by}`),
  activity: (key: string) =>
    call<{ kind: string; created: string; field: string; from: string | null; to: string | null; issue: { key: string; summary: string }; actor: User }[]>(
      'GET', `/project/${key}/activity`,
    ),
  assignable: (key: string) => call<User[]>('GET', `/user/assignable?project=${key}`),
  addMember: (key: string, email: string, role: string) => call<User[]>('POST', `/project/${key}/members`, { email, role }),
  priorities: () => call<Priority[]>('GET', '/priority'),
  issue: (key: string) => call<Issue>('GET', `/issue/${key}?expand=transitions,changelog`),
  createIssue: (fields: Record<string, unknown>) => call<{ id: string; key: string }>('POST', '/issue', { fields }),
  editField: (key: string, field: string, value: unknown, operation: 'SET' | 'ADD' | 'REMOVE' = 'SET') =>
    call<Issue>('PATCH', `/issue/${key}/fields/${field}`, { operation, value }),
  transition: (key: string, id: string) => call<Issue>('POST', `/issue/${key}/transitions`, { transition: { id } }),
  rank: (key: string, body: { statusId?: string; sprintId?: string | null; prevKey?: string | null; nextKey?: string | null }) =>
    call<Issue>('POST', `/issue/${key}/rank`, body),
  backlog: (key: string) => call<BacklogData>('GET', `/project/${key}/backlog`),
  sprints: (key: string, state = 'active,future,closed') => call<Sprint[]>('GET', `/project/${key}/sprints?state=${state}`),
  createSprint: (key: string, body: { name?: string; goal?: string } = {}) => call<Sprint>('POST', `/project/${key}/sprints`, body),
  updateSprint: (id: string, body: Partial<{ name: string; goal: string; startDate: string | null; endDate: string | null }>) =>
    call<Sprint>('PATCH', `/sprint/${id}`, body),
  deleteSprint: (id: string) => call('DELETE', `/sprint/${id}`),
  startSprint: (id: string, body: { name?: string; goal?: string; startDate: string; endDate: string }) => call<Sprint>('POST', `/sprint/${id}/start`, body),
  completeSprint: (id: string, moveTo: string) =>
    call<{ sprint: Sprint; completed: string[]; movedOpen: string[]; movedTo: Sprint | null }>('POST', `/sprint/${id}/complete`, { moveTo }),
  sprintReport: (id: string) => call<SprintReport>('GET', `/sprint/${id}/report`),
  velocity: (key: string) => call<{ sprint: { id: string; name: string }; committed: number; completed: number }[]>('GET', `/project/${key}/velocity`),
  setFeatures: (key: string, sprints: boolean) => call<{ sprints: boolean }>('PATCH', `/project/${key}/features`, { sprints }),
  deleteIssue: (key: string) => call('DELETE', `/issue/${key}?deleteSubtasks=true`),
  comments: (key: string) => call<{ comments: Comment[] }>('GET', `/issue/${key}/comment`),
  addComment: (key: string, body: Adf | string) => call<Comment>('POST', `/issue/${key}/comment`, { body }),
  editComment: (key: string, id: string, body: Adf | string) => call<Comment>('PUT', `/issue/${key}/comment/${id}`, { body }),
  deleteComment: (key: string, id: string) => call('DELETE', `/issue/${key}/comment/${id}`),
  watch: (key: string, on: boolean) => call(on ? 'POST' : 'DELETE', `/issue/${key}/watchers`, on ? {} : undefined),
  filters: (scope: 'all' | 'mine' | 'starred' = 'all') => call<{ values: SavedFilter[] }>('GET', `/filter/search?scope=${scope}`),
  filter: (id: string) => call<SavedFilter>('GET', `/filter/${id}`),
  createFilter: (body: { name: string; description?: string; jql: string; share: ShareType; projectKey?: string | null }) =>
    call<SavedFilter>('POST', '/filter', body),
  updateFilter: (id: string, body: Partial<{ name: string; description: string; jql: string; share: ShareType; projectKey: string | null }>) =>
    call<SavedFilter>('PUT', `/filter/${id}`, body),
  deleteFilter: (id: string) => call('DELETE', `/filter/${id}`),
  favouriteFilter: (id: string, on: boolean) => call(on ? 'POST' : 'DELETE', `/filter/${id}/favourite`),
  dashboards: () => call<{ dashboards: Dashboard[] }>('GET', '/dashboard'),
  dashboard: (id: string) => call<Dashboard>('GET', `/dashboard/${id}`),
  createDashboard: (body: { name: string; description?: string; share: ShareType; projectKey?: string | null }) => call<Dashboard>('POST', '/dashboard', body),
  updateDashboard: (id: string, body: Partial<{ name: string; description: string; share: ShareType; projectKey: string | null }>) =>
    call<Dashboard>('PUT', `/dashboard/${id}`, body),
  deleteDashboard: (id: string) => call('DELETE', `/dashboard/${id}`),
  addGadget: (id: string, body: { type: GadgetType; column: number; config: Record<string, any> }) => call<Gadget>('POST', `/dashboard/${id}/gadgets`, body),
  updateGadget: (id: string, gid: string, body: { config?: Record<string, any>; column?: number; position?: number }) =>
    call<Gadget>('PUT', `/dashboard/${id}/gadgets/${gid}`, body),
  removeGadget: (id: string, gid: string) => call('DELETE', `/dashboard/${id}/gadgets/${gid}`),
  gadgetData: (id: string, gid: string) => call<GadgetData>('GET', `/dashboard/${id}/gadgets/${gid}/data`),
  fields: (key: string) => call<CustomField[]>('GET', `/project/${key}/fields`),
  createField: (key: string, body: Partial<Omit<CustomField, 'options'>> & { options?: { id?: string; value: string }[] }) =>
    call<CustomField>('POST', `/project/${key}/fields`, body),
  updateField: (fieldId: string, body: Partial<Omit<CustomField, 'options'>> & { options?: { id?: string; value: string }[] }) =>
    call<CustomField>('PUT', `/field/${fieldId}`, body),
  deleteField: (fieldId: string) => call('DELETE', `/field/${fieldId}`),
  workflow: (key: string) => call<Workflow>('GET', `/project/${key}/workflow`),
  addStatus: (key: string, name: string, category: string) => call<Workflow>('POST', `/project/${key}/statuses`, { name, category }),
  updateStatus: (id: string, body: { name?: string; category?: string; position?: number; wipLimit?: number | null }) => call<Workflow>('PUT', `/status/${id}`, body),
  deleteStatus: (id: string, moveTo?: string) => call<Workflow>('DELETE', `/status/${id}${moveTo ? `?moveTo=${moveTo}` : ''}`),
  addTransition: (key: string, body: { name?: string; from: string | null; to: string; requiredFields?: string[]; allowedRoles?: string[] | null }) =>
    call<Workflow>('POST', `/project/${key}/transitions`, body),
  updateTransition: (id: string, body: { name?: string; requiredFields?: string[]; allowedRoles?: string[] | null }) =>
    call<Workflow>('PUT', `/transition/${id}`, body),
  deleteTransition: (id: string) => call<Workflow>('DELETE', `/transition/${id}`),
  notifications: (tab: 'direct' | 'watching' | 'all' = 'all', limit = 30) => call<Inbox>('GET', `/notifications?tab=${tab}&limit=${limit}`),
  markRead: (body: { ids?: string[]; all?: boolean; tab?: 'direct' | 'watching' | 'all' }) => call('POST', '/notifications/read', body),
  preferences: () => call<Preferences>('GET', '/myself/preferences'),
  setPreferences: (emailNotifications: EmailPref) => call<Preferences>('PUT', '/myself/preferences', { emailNotifications }),
  subscriptions: (filterId: string) => call<FilterSubscription[]>('GET', `/filter/${filterId}/subscriptions`),
  subscribe: (filterId: string, body: { frequency: 'daily' | 'weekly'; hourUtc: number; weekday: number | null; emailWhenEmpty: boolean }) =>
    call<FilterSubscription>('POST', `/filter/${filterId}/subscriptions`, body),
  unsubscribe: (id: string) => call('DELETE', `/subscription/${id}`),
  outbox: () => call<{ mode: 'smtp' | 'outbox'; emails: OutboxEmail[] }>('GET', '/admin/emails'),
  runScheduler: () => call<TickResult>('POST', '/admin/scheduler/run'),
  tokens: () => call<ApiToken[]>('GET', '/myself/tokens'),
  createToken: (name: string, expiresInDays: 30 | 90 | 365 | null) => call<ApiToken & { token: string }>('POST', '/myself/tokens', { name, expiresInDays }),
  revokeToken: (id: string) => call('DELETE', `/myself/tokens/${id}`),
  webhooks: () => call<{ events: WebhookEventName[]; webhooks: Webhook[] }>('GET', '/webhooks'),
  createWebhook: (body: { name: string; url: string; events: WebhookEventName[]; projectKey: string | null; enabled: boolean }) => call<Webhook & { secret: string }>('POST', '/webhooks', body),
  updateWebhook: (id: string, body: Partial<{ name: string; url: string; events: WebhookEventName[]; projectKey: string | null; enabled: boolean }>) => call<Webhook>('PUT', `/webhook/${id}`, body),
  deleteWebhook: (id: string) => call('DELETE', `/webhook/${id}`),
  rotateWebhookSecret: (id: string) => call<{ secret: string }>('POST', `/webhook/${id}/secret`),
  testWebhook: (id: string) => call<{ ok: boolean; status: string; responseStatus: number | null; error: string | null }>('POST', `/webhook/${id}/test`),
  webhookDeliveries: (id: string) => call<WebhookDelivery[]>('GET', `/webhook/${id}/deliveries`),
  audit: (q: { category?: string; startAt?: number }) => call<{ total: number; startAt: number; values: AuditEntry[] }>('GET', `/admin/audit?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`),
  rules: (key: string) => call<AutomationRule[]>('GET', `/project/${key}/automation`),
  createRule: (key: string, body: { name: string; enabled?: boolean; trigger: AutoTrigger; condition?: string | null; actions: AutoAction[] }) =>
    call<AutomationRule>('POST', `/project/${key}/automation`, body),
  updateRule: (id: string, body: Partial<{ name: string; enabled: boolean; trigger: AutoTrigger; condition: string | null; actions: AutoAction[] }>) =>
    call<AutomationRule>('PUT', `/automation/${id}`, body),
  deleteRule: (id: string) => call('DELETE', `/automation/${id}`),
  ruleRuns: (id: string) => call<AutomationRun[]>('GET', `/automation/${id}/runs`),
  issueRuns: (key: string) => call<AutomationRun[]>('GET', `/issue/${key}/automation`),
  columns: () => call<{ defaults: string[]; columns: ColumnDef[] }>('GET', '/search/columns'),
  searchTable: (jql: string, columns: string[], startAt = 0, maxResults = 50) =>
    call<SearchResult & { issues: (Issue & { custom: Record<string, string | null> })[] }>('POST', '/search/table', { jql, columns, startAt, maxResults }),
  bulk: (keys: string[], action: BulkAction) => call<BulkResult>('POST', '/bulk', { keys, action }),
  /** CSV download needs the auth header, so fetch it as a blob and save it. */
  exportCsv: async (jql: string, columns: string[]) => {
    const res = await fetch(`/api/search/csv?jql=${encodeURIComponent(jql)}&columns=${encodeURIComponent(columns.join(','))}`, {
      headers: session.token ? { authorization: `Bearer ${session.token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => null))?.errorMessages?.[0] ?? 'Export failed');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'export.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return { total: Number(res.headers.get('x-total-count') ?? 0), exported: Number(res.headers.get('x-exported-count') ?? 0) };
  },
  importCsv: async (key: string, csv: string, dryRun: boolean) => {
    const res = await fetch(`/api/project/${key}/import?dryRun=${dryRun}`, {
      method: 'POST', body: csv,
      headers: { 'content-type': 'text/csv', ...(session.token ? { authorization: `Bearer ${session.token}` } : {}) },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, data?.errorMessages?.[0] ?? 'Import failed');
    return data as ImportResult;
  },
  linkTypes: () => call<{ issueLinkTypes: LinkType[] }>('GET', '/issueLinkType'),
  createLink: (type: string, outwardKey: string, inwardKey: string) =>
    call<{ id: string }>('POST', '/issueLink', { type: { name: type }, outwardIssue: { key: outwardKey }, inwardIssue: { key: inwardKey } }),
  deleteLink: (id: string) => call('DELETE', `/issueLink/${id}`),
  versions: (key: string) => call<Version[]>('GET', `/project/${key}/versions`),
  version: (id: string) => call<Version>('GET', `/version/${id}`),
  createVersion: (project: string, body: { name: string; description?: string; startDate?: string | null; releaseDate?: string | null }) => call<Version>('POST', '/version', { project, ...body }),
  updateVersion: (id: string, body: Partial<{ name: string; description: string; startDate: string | null; releaseDate: string | null; released: boolean; archived: boolean }>) => call<Version>('PUT', `/version/${id}`, body),
  releaseVersion: (id: string, body: { releaseDate?: string | null; moveUnresolvedTo?: string | null }) => call<Version & { moved: number }>('POST', `/version/${id}/release`, body),
  deleteVersion: (id: string, moveTo: string | null) => call('DELETE', `/version/${id}${moveTo ? `?moveFixIssuesTo=${moveTo}` : ''}`),
  components: (key: string) => call<Component[]>('GET', `/project/${key}/components`),
  createComponent: (project: string, body: { name: string; description?: string; leadAccountId?: string | null }) => call<Component>('POST', '/component', { project, ...body }),
  updateComponent: (id: string, body: Partial<{ name: string; description: string; leadAccountId: string | null }>) => call<Component>('PUT', `/component/${id}`, body),
  deleteComponent: (id: string, moveTo: string | null) => call('DELETE', `/component/${id}${moveTo ? `?moveIssuesTo=${moveTo}` : ''}`),
  worklogs: (key: string) => call<{ total: number; worklogs: Worklog[] }>('GET', `/issue/${key}/worklog`),
  addWorklog: (key: string, body: { timeSpent: string; started?: string; comment?: string; adjustEstimate?: string; newEstimate?: string }) => call<Worklog>('POST', `/issue/${key}/worklog`, body),
  updateWorklog: (key: string, id: string, body: { timeSpent?: string; started?: string; comment?: string; adjustEstimate?: string; newEstimate?: string }) => call<Worklog>('PUT', `/issue/${key}/worklog/${id}`, body),
  deleteWorklog: (key: string, id: string) => call('DELETE', `/issue/${key}/worklog/${id}`),
  dependencies: (key: string) => call<{ dependencies: Dependency[] }>('GET', `/project/${key}/dependencies`),
  deleteAttachment: (id: string) => call('DELETE', `/attachment/${id}`),
  /** Raw-body upload; the server stores bytes as-is (max size enforced server-side). */
  uploadAttachment: async (key: string, file: File) => {
    const res = await fetch(`/api/issue/${key}/attachments`, {
      method: 'POST',
      body: file,
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-file-name': encodeURIComponent(file.name),
        ...(session.token ? { authorization: `Bearer ${session.token}` } : {}),
      },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, data?.errorMessages?.[0] ?? `Upload failed (${res.status})`);
    return data as Attachment[];
  },
  /** Attachment bytes need the auth header, so fetch them as a blob for thumbnails/downloads. */
  attachmentBlob: async (a: Attachment, download = false) => {
    const res = await fetch(`${a.content}${download ? '?download=true' : ''}`, {
      headers: session.token ? { authorization: `Bearer ${session.token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, 'Could not load attachment');
    return res.blob();
  },
  search: (jql: string, startAt = 0, maxResults = 50) => call<SearchResult>('POST', '/search/jql', { jql, startAt, maxResults }),
  recent: () => call<{ issues: Issue[] }>('GET', '/recent'),
};
