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
    issuelinks?: IssueLink[];
    attachment?: Attachment[];
  };
  children?: Issue[];
  transitions?: Transition[];
  changelog?: ChangeEntry[];
  permissions?: Record<string, boolean>;
}
export interface Transition { id: string; name: string; to: { id: string; name: string; statusCategory: StatusCat } }
export interface ChangeEntry { id: string; author: User; created: string; items: { field: string; fromString: string | null; toString: string | null }[] }
export interface Comment { id: string; author: User; body: Adf; created: string; updated: string }
export interface ProjectSummary { id: string; key: string; name: string; description: string; lead: User | null; myRole: string | null; issueCount: number }
export interface Project {
  id: string; key: string; name: string; description: string; lead: User | null;
  issueTypes: IssueType[]; statuses: (Status & { position: number })[]; members: User[]; myRole: string | null; myPermissions: string[];
  features: { sprints: boolean };
}
export interface LinkType { id: string; name: string; inward: string; outward: string }
export interface LinkedIssue {
  id: string; key: string;
  fields: { summary: string; status: Pick<Status, 'name' | 'statusCategory'>; issuetype: { name: string; color: string }; priority: { name: string; color: string } | null };
}
export interface IssueLink { id: string; type: LinkType; relation: string; inwardIssue?: LinkedIssue; outwardIssue?: LinkedIssue }
export interface Attachment { id: string; filename: string; mimeType: string; size: number; created: string; author: User; content: string; isImage: boolean }
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
  linkTypes: () => call<{ issueLinkTypes: LinkType[] }>('GET', '/issueLinkType'),
  createLink: (type: string, outwardKey: string, inwardKey: string) =>
    call<{ id: string }>('POST', '/issueLink', { type: { name: type }, outwardIssue: { key: outwardKey }, inwardIssue: { key: inwardKey } }),
  deleteLink: (id: string) => call('DELETE', `/issueLink/${id}`),
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
