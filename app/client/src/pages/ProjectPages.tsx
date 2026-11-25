import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, type Issue, type Project, type Sprint, type Status } from '../api';
import { daysLeft } from './Backlog';
import { FieldsEditor, WorkflowEditor } from './SettingsEditors';
import { PageHeader, useShell } from '../Layout';
import { Avatar, PriorityIcon, StatusLozenge, TypeIcon, fmtDate, timeAgo, useAsync } from '../ui';

type Ctx = { project: Project };
export const useProject = () => useOutletContext<Ctx>().project;

export function ProjectLayout() {
  const { key = '' } = useParams();
  const { version } = useShell();
  const proj = useAsync(() => api.project(key), [key, version]);
  if (proj.error) return <div className="page"><p className="error">{proj.error.message}</p></div>;
  if (!proj.data) return <div className="page"><p className="muted">Loading…</p></div>;
  const p = proj.data;
  return (
    <div className="page">
      <PageHeader crumbs={<><Link to="/projects">Spaces</Link> /</>} title={p.name} />
      <nav className="tabs" aria-label="Space navigation">
        <NavLink to="summary">Summary</NavLink>
        {p.features.sprints && <NavLink to="backlog">Backlog</NavLink>}
        <NavLink to="board">Board</NavLink>
        <NavLink to="list">List</NavLink>
        {p.features.sprints && <NavLink to="reports">Reports</NavLink>}
        {p.myPermissions.includes('ADMINISTER_PROJECTS') && <NavLink to="settings">Settings</NavLink>}
      </nav>
      <Outlet context={{ project: p } satisfies Ctx} />
    </div>
  );
}

// ------------------------------------------------------------------ Board

export function Board() {
  const project = useProject();
  const { version, openCreate } = useShell();
  const nav = useNavigate();
  const [filter, setFilter] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [columns, setColumns] = useState<{ status: Status; issues: Issue[] }[] | null>(null);
  const [sprint, setSprint] = useState<{ enabled: boolean; current: Sprint | null }>({ enabled: false, current: null });
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ col: string; index: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canMove = project.myPermissions.includes('TRANSITION_ISSUES');

  const load = () =>
    api.board(project.key, filter, q).then((b) => {
      setColumns(b.columns);
      setSprint({ enabled: b.sprintsEnabled, current: b.sprint });
    }, (e) => setError(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [project.key, filter.join(), q, version]);

  const onDrop = async (statusId: string, index: number) => {
    if (!columns || !dragKey) return;
    const from = columns.find((c) => c.issues.some((i) => i.key === dragKey))!;
    const issue = from.issues.find((i) => i.key === dragKey)!;
    const target = columns.find((c) => c.status.id === statusId)!;
    const without = target.issues.filter((i) => i.key !== dragKey);
    // index was computed against the list that still contained the dragged card
    const origIdx = target.issues.findIndex((i) => i.key === dragKey);
    const at = origIdx >= 0 && origIdx < index ? index - 1 : index;
    const prev = without[at - 1]?.key ?? null;
    const next = without[at]?.key ?? null;
    if (from.status.id === statusId && origIdx === at) return;
    // optimistic move
    const moved = { ...issue, fields: { ...issue.fields, status: target.status } };
    setColumns(columns.map((c) => {
      const list = c.issues.filter((i) => i.key !== dragKey);
      if (c.status.id === statusId) list.splice(at, 0, moved);
      return { ...c, issues: list };
    }));
    try {
      await api.rank(dragKey, { statusId, prevKey: prev, nextKey: next });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      load();
    }
  };

  const toggle = (id: string) => setFilter((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]));

  if (sprint.enabled && !sprint.current && columns) {
    return (
      <div className="panel empty-state">
        <h2>No active sprint</h2>
        <p className="muted">The board shows the work in the active sprint. Plan and start a sprint from the backlog.</p>
        <Link className="btn primary" to="../backlog">Go to backlog</Link>
      </div>
    );
  }
  const left = sprint.current ? daysLeft(sprint.current) : null;

  return (
    <>
      {sprint.current && (
        <div className="sprint-banner">
          <strong>{sprint.current.name}</strong>
          {sprint.current.goal && <span className="muted">· {sprint.current.goal}</span>}
          <span className="grow" />
          {left != null && <span className={`chip-sm ${left < 0 ? 'late' : ''}`}>{left < 0 ? `${-left}d overdue` : `${left} days left`}</span>}
          <Link className="btn subtle" to={`../reports/${sprint.current.id}`}>Burndown</Link>
          {project.myPermissions.includes('MANAGE_SPRINTS') && <Link className="btn" to="../backlog">Complete sprint…</Link>}
        </div>
      )}
      <div className="toolbar">
        <input className="search-sm" placeholder="Search board" aria-label="Search board" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="avatar-filter" role="group" aria-label="Filter by assignee">
          {project.members.map((m) => (
            <button key={m.accountId} className={`av-toggle ${filter.includes(m.accountId) ? 'on' : ''}`} onClick={() => toggle(m.accountId)}
              aria-pressed={filter.includes(m.accountId)} title={`Filter: ${m.displayName}`}>
              <Avatar user={m} size={28} />
            </button>
          ))}
          <button className={`av-toggle ${filter.includes('unassigned') ? 'on' : ''}`} onClick={() => toggle('unassigned')} aria-pressed={filter.includes('unassigned')} title="Filter: Unassigned">
            <Avatar user={null} size={28} />
          </button>
        </div>
        {filter.length > 0 && <button className="btn subtle" onClick={() => setFilter([])}>Clear filters</button>}
      </div>
      {error && <p className="error" role="alert" onClick={() => setError(null)}>{error}</p>}
      <div className="board">
        {columns?.map((col) => (
          <section key={col.status.id} className={`column ${dropAt?.col === col.status.id ? 'drop' : ''}`} aria-label={`${col.status.name} column`}
            onDragOver={(e) => {
              if (!dragKey) return;
              e.preventDefault();
              const cards = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-card]')];
              const idx = cards.findIndex((c) => e.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2);
              setDropAt({ col: col.status.id, index: idx === -1 ? cards.length : idx });
            }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropAt(null); }}
            onDrop={(e) => { e.preventDefault(); if (dropAt) onDrop(col.status.id, dropAt.index); setDropAt(null); setDragKey(null); }}>
            <header className="column-head">
              <span>{col.status.name}</span><span className="count">{col.issues.length}</span>
              {col.status.statusCategory.key === 'done' && <span title="Done column">✓</span>}
            </header>
            <div className="cards">
              {col.issues.map((i, idx) => (
                <div key={i.key}>
                  {dropAt?.col === col.status.id && dropAt.index === idx && <div className="drop-line" />}
                  <article data-card className={`card ${dragKey === i.key ? 'dragging' : ''}`} draggable={canMove}
                    onDragStart={(e) => { setDragKey(i.key); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', i.key); }}
                    onDragEnd={() => { setDragKey(null); setDropAt(null); }}
                    onClick={() => nav(`/browse/${i.key}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/browse/${i.key}`)}
                    aria-label={`${i.key} ${i.fields.summary}`}>
                    <div className="card-summary">{i.fields.summary}</div>
                    {i.fields.parent && <span className="epic-tag">{i.fields.parent.summary}</span>}
                    {i.fields.labels.length > 0 && <div className="labels">{i.fields.labels.map((l) => <span key={l} className="label">{l}</span>)}</div>}
                    <div className="card-foot">
                      <TypeIcon type={i.fields.issuetype} />
                      <span className="key">{i.key}</span>
                      {i.fields.duedate && <span className="muted small">📅 {fmtDate(i.fields.duedate)}</span>}
                      <span className="grow" />
                      <PriorityIcon priority={i.fields.priority} />
                      <Avatar user={i.fields.assignee} />
                    </div>
                  </article>
                </div>
              ))}
              {dropAt?.col === col.status.id && dropAt.index === col.issues.length && <div className="drop-line" />}
            </div>
            {project.myPermissions.includes('CREATE_ISSUES') && col.status.statusCategory.key === 'todo' && !sprint.enabled && (
              <button className="add-card" onClick={() => openCreate(project.key)}>+ Create</button>
            )}
          </section>
        ))}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ List

const COLUMNS: { key: string; label: string; order: string }[] = [
  { key: 'work', label: 'Work', order: 'key' },
  { key: 'assignee', label: 'Assignee', order: 'assignee' },
  { key: 'reporter', label: 'Reporter', order: 'reporter' },
  { key: 'priority', label: 'Priority', order: 'priority' },
  { key: 'status', label: 'Status', order: 'status' },
  { key: 'resolution', label: 'Resolution', order: 'resolution' },
  { key: 'created', label: 'Created', order: 'created' },
  { key: 'updated', label: 'Updated', order: 'updated' },
  { key: 'duedate', label: 'Due date', order: 'duedate' },
];

export function List() {
  const project = useProject();
  const { version } = useShell();
  const [params, setParams] = useSearchParams();
  const sort = params.get('sort') ?? 'rank';
  const dir = params.get('dir') === 'DESC' ? 'DESC' : 'ASC';
  const jql = `project = ${project.key} ORDER BY ${sort} ${dir}`;
  const res = useAsync(() => api.search(jql, 0, 200), [jql, version]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // List shows the hierarchy: top-level items with their children beneath (Jira "Expand hierarchy")
  const { roots, kids } = useMemo(() => {
    const issues = res.data?.issues ?? [];
    const keys = new Set(issues.map((i) => i.key));
    const kids = new Map<string, Issue[]>();
    for (const i of issues) if (i.fields.parent && keys.has(i.fields.parent.key)) kids.set(i.fields.parent.key, [...(kids.get(i.fields.parent.key) ?? []), i]);
    return { roots: issues.filter((i) => !i.fields.parent || !keys.has(i.fields.parent.key)), kids };
  }, [res.data]);

  const sortBy = (col: string) => setParams({ sort: col, dir: sort === col && dir === 'ASC' ? 'DESC' : 'ASC' });

  const row = (i: Issue, depth: number): React.ReactNode => {
    const children = kids.get(i.key) ?? [];
    const open = expanded.has(i.key);
    return [
      <tr key={i.key}>
        <td style={{ paddingLeft: 8 + depth * 22 }}>
          {children.length > 0
            ? <button className="icon-btn tiny" aria-label={open ? 'Collapse' : 'Expand hierarchy'} aria-expanded={open}
                onClick={() => setExpanded((s) => { const n = new Set(s); n.has(i.key) ? n.delete(i.key) : n.add(i.key); return n; })}>{open ? '▾' : '▸'}</button>
            : <span className="tiny-spacer" />}
          <TypeIcon type={i.fields.issuetype} /> <Link to={`/browse/${i.key}`} className="key">{i.key}</Link> <Link to={`/browse/${i.key}`}>{i.fields.summary}</Link>
        </td>
        <td><span className="user-cell"><Avatar user={i.fields.assignee} size={20} /> {i.fields.assignee?.displayName ?? 'Unassigned'}</span></td>
        <td>{i.fields.reporter?.displayName}</td>
        <td><PriorityIcon priority={i.fields.priority} /> {i.fields.priority?.name}</td>
        <td><StatusLozenge status={i.fields.status} /></td>
        <td>{i.fields.resolution?.name ?? 'Unresolved'}</td>
        <td>{new Date(i.fields.created).toLocaleDateString()}</td>
        <td>{timeAgo(i.fields.updated)}</td>
        <td>{fmtDate(i.fields.duedate)}</td>
      </tr>,
      ...(open ? children.map((c) => row(c, depth + 1)) : []),
    ];
  };

  return (
    <>
      <div className="toolbar"><span className="muted small">JQL: <code>{jql}</code></span><span className="grow" />
        <Link className="btn subtle" to={`/issues?jql=${encodeURIComponent(jql)}`}>Open in search</Link></div>
      {res.error && <p className="error">{res.error.message}</p>}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>{COLUMNS.map((c) => (
              <th key={c.key} aria-sort={sort === c.order ? (dir === 'ASC' ? 'ascending' : 'descending') : 'none'}>
                <button className="th-btn" onClick={() => sortBy(c.order)}>{c.label}{sort === c.order ? (dir === 'ASC' ? ' ↑' : ' ↓') : ''}</button>
              </th>
            ))}</tr>
          </thead>
          <tbody>{roots.map((i) => row(i, 0))}</tbody>
        </table>
      </div>
      <p className="muted small">{res.data ? `${res.data.issues.length} of ${res.data.total}` : 'Loading…'}</p>
    </>
  );
}

// ------------------------------------------------------------------ Summary

export function Summary() {
  const project = useProject();
  const { version } = useShell();
  const byStatus = useAsync(() => api.aggregate(project.key, 'status'), [project.key, version]);
  const byType = useAsync(() => api.aggregate(project.key, 'type'), [project.key, version]);
  const byPrio = useAsync(() => api.aggregate(project.key, 'priority'), [project.key, version]);
  const activity = useAsync(() => api.activity(project.key), [project.key, version]);
  const t = byStatus.data?.totals ?? {};
  const total = t.total || 1;

  const bars = (groups: { name: string; count: number; color?: string; category?: string }[] | undefined) => (
    <ul className="bars">
      {groups?.map((g) => (
        <li key={g.name}>
          <span className="bar-label">{g.name}</span>
          <span className="bar-track"><span className={`bar-fill ${g.category ? `cat-${g.category}` : ''}`} style={{ width: `${(g.count / total) * 100}%`, background: g.color }} /></span>
          <span className="bar-count">{g.count}</span>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="summary-grid">
      <div className="stat"><strong>{t.done7 ?? 0}</strong><span>completed in the last 7 days</span></div>
      <div className="stat"><strong>{t.updated7 ?? 0}</strong><span>updated in the last 7 days</span></div>
      <div className="stat"><strong>{t.created7 ?? 0}</strong><span>created in the last 7 days</span></div>
      <div className="stat"><strong>{t.due7 ?? 0}</strong><span>due in the next 7 days</span></div>
      <section className="panel"><h2>Status overview</h2>{bars(byStatus.data?.groups)}</section>
      <section className="panel"><h2>Types of work</h2>{bars(byType.data?.groups)}</section>
      <section className="panel"><h2>Priority breakdown</h2>{bars(byPrio.data?.groups)}</section>
      <section className="panel span2">
        <h2>Recent activity</h2>
        <ul className="activity">
          {activity.data?.map((a, n) => (
            <li key={n}>
              <Avatar user={a.actor} size={22} />
              <span>
                <strong>{a.actor.displayName}</strong>{' '}
                {a.kind === 'comment' ? 'commented on'
                  : a.field === 'created' ? 'created'
                  : <>changed <em>{a.field}</em>{a.to ? <> to <strong>{a.to}</strong></> : ''} on</>}{' '}
                <Link to={`/browse/${a.issue.key}`}>{a.issue.key} {a.issue.summary}</Link>
              </span>
              <span className="muted small">{timeAgo(a.created)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ Settings (members)

export function Settings() {
  const project = useProject();
  const { bump } = useShell();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [msg, setMsg] = useState<string | null>(null);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.addMember(project.key, email, role);
      setMsg(`Added ${email} as ${role}`);
      setEmail('');
      bump();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : String(err));
    }
  };
  const [tab, setTab] = useState<'access' | 'fields' | 'workflow'>('access');
  const tabs = (
    <div className="tabs small" role="tablist" aria-label="Space settings">
      {(['access', 'fields', 'workflow'] as const).map((t) => (
        <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
          {{ access: 'Access & features', fields: 'Fields', workflow: 'Workflow' }[t]}
        </button>
      ))}
    </div>
  );
  if (tab === 'fields') return <>{tabs}<FieldsEditor project={project} /></>;
  if (tab === 'workflow') return <>{tabs}<div className="stack">{<WorkflowEditor project={project} />}</div></>;
  return (
    <>{tabs}
    <div className="settings">
      <section className="panel">
        <h2>Access</h2>
        <table className="table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead>
          <tbody>{project.members.map((m) => <tr key={m.accountId}><td><span className="user-cell"><Avatar user={m} size={20} /> {m.displayName}</span></td><td>{m.emailAddress}</td><td>{m.role}</td></tr>)}</tbody>
        </table>
        <form className="inline-form" onSubmit={add}>
          <label>Add people (email)<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <label>Role<select value={role} onChange={(e) => setRole(e.target.value)}>{['admin', 'member', 'viewer', 'guest'].map((r) => <option key={r}>{r}</option>)}</select></label>
          <button className="btn primary">Add</button>
        </form>
        {msg && <p className="muted">{msg}</p>}
      </section>
      <section className="panel">
        <h2>Features</h2>
        <label className="check">
          <input type="checkbox" checked={project.features.sprints} onChange={async (e) => {
            try {
              await api.setFeatures(project.key, e.target.checked);
              setMsg(`Sprints turned ${e.target.checked ? 'on' : 'off'}`);
              bump();
            } catch (err) { setMsg(err instanceof ApiError ? err.message : String(err)); }
          }} />
          Sprints — plan work in fixed time boxes; adds Backlog and Reports, and the board shows the active sprint
        </label>
        <h2 style={{ marginTop: 16 }}>Workflow</h2>
        <div className="workflow">{project.statuses.map((s) => <StatusLozenge key={s.id} status={s} />)}</div>
        <button className="link-btn" onClick={() => setTab('workflow')}>Edit workflow →</button>
        <h2 style={{ marginTop: 16 }}>Work types</h2>
        <ul className="plain">{project.issueTypes.map((t) => <li key={t.id}><TypeIcon type={t} /> {t.name} <span className="muted small">level {t.hierarchyLevel}</span></li>)}</ul>
      </section>
    </div>
    </>
  );
}
