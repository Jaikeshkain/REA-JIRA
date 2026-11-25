import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, type Issue } from '../api';
import { useAuth } from '../auth';
import { PageHeader, useShell } from '../Layout';
import { StatusLozenge, TypeIcon, PriorityIcon, timeAgo, useAsync } from '../ui';

function IssueRows({ issues, empty }: { issues: Issue[]; empty: string }) {
  if (!issues.length) return <p className="muted empty">{empty}</p>;
  return (
    <ul className="issue-rows">
      {issues.map((i) => (
        <li key={i.key}>
          <Link to={`/browse/${i.key}`} className="issue-row">
            <TypeIcon type={i.fields.issuetype} />
            <span className="key">{i.key}</span>
            <span className="summary">{i.fields.summary}</span>
            <span className="muted small">{i.fields.project.name}</span>
            <PriorityIcon priority={i.fields.priority} />
            <StatusLozenge status={i.fields.status} />
            <span className="muted small">{timeAgo(i.fields.updated)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function ForYou() {
  const { user } = useAuth();
  const { version } = useShell();
  const [tab, setTab] = useState<'assigned' | 'viewed'>('assigned');
  const assigned = useAsync(() => api.search('assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'), [version]);
  const recent = useAsync(() => api.recent(), [version]);
  const projects = useAsync(() => api.projects(), [version]);

  return (
    <div className="page">
      <PageHeader title="For you" />
      <p className="muted">Welcome, {user?.displayName}. {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}.</p>
      <section className="card-row">
        {projects.data?.slice(0, 4).map((p) => (
          <Link key={p.key} to={`/projects/${p.key}/board`} className="space-card">
            <span className="proj-badge lg">{p.key.slice(0, 2)}</span>
            <div><strong>{p.name}</strong><div className="muted small">{p.issueCount} work items</div></div>
          </Link>
        ))}
        <Link to="/projects" className="space-card ghost">View all spaces →</Link>
      </section>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'assigned'} className={tab === 'assigned' ? 'on' : ''} onClick={() => setTab('assigned')}>
          Assigned to me <span className="count">{assigned.data?.total ?? 0}</span>
        </button>
        <button role="tab" aria-selected={tab === 'viewed'} className={tab === 'viewed' ? 'on' : ''} onClick={() => setTab('viewed')}>Viewed</button>
      </div>
      {tab === 'assigned'
        ? <IssueRows issues={assigned.data?.issues ?? []} empty="Nothing assigned to you. Nice." />
        : <IssueRows issues={recent.data?.issues ?? []} empty="Items you open will appear here." />}
    </div>
  );
}

export function Projects() {
  const nav = useNavigate();
  const { bump, version } = useShell();
  const list = useAsync(() => api.projects(), [version]);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ name: '', key: '' });
  const [error, setError] = useState<string | null>(null);

  const suggestKey = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || '';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const p = await api.createProject(form.key, form.name);
      bump();
      nav(`/projects/${p.key}/board`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  return (
    <div className="page">
      <PageHeader title="Spaces" actions={<button className="btn primary" onClick={() => setShowNew(true)}>Create space</button>} />
      {showNew && (
        <form className="panel inline-form" onSubmit={submit}>
          <label>Name<input value={form.name} autoFocus required onChange={(e) => setForm({ name: e.target.value, key: form.key || suggestKey(e.target.value) })} /></label>
          <label>Key<input value={form.key} required pattern="[A-Za-z][A-Za-z0-9]{1,9}" title="2–10 letters/digits" onChange={(e) => setForm({ ...form, key: e.target.value.toUpperCase() })} /></label>
          <button className="btn primary">Create</button>
          <button type="button" className="btn subtle" onClick={() => setShowNew(false)}>Cancel</button>
          {error && <p className="error">{error}</p>}
        </form>
      )}
      <table className="table">
        <thead><tr><th>Name</th><th>Key</th><th>Lead</th><th>Your role</th><th>Work items</th></tr></thead>
        <tbody>
          {list.data?.map((p) => (
            <tr key={p.key}>
              <td><Link to={`/projects/${p.key}/board`}><span className="proj-badge">{p.key.slice(0, 2)}</span> {p.name}</Link></td>
              <td>{p.key}</td><td>{p.lead?.displayName}</td><td>{p.myRole ?? 'site admin'}</td><td>{p.issueCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
