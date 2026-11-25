import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { PageHeader, useShell } from '../Layout';
import { Avatar, PriorityIcon, StatusLozenge, TypeIcon, timeAgo, useAsync } from '../ui';

const EXAMPLES = [
  'assignee = currentUser() AND statusCategory != Done',
  'priority >= High ORDER BY priority DESC',
  'labels in (backend, security)',
  'created >= -7d ORDER BY created DESC',
  'text ~ "wallet"',
  'due <= endOfWeek() AND resolution = Unresolved',
];

export function Search() {
  const [params, setParams] = useSearchParams();
  const jql = params.get('jql') ?? 'ORDER BY updated DESC';
  const page = Number(params.get('page') ?? 0);
  const [draft, setDraft] = useState(jql);
  const { version } = useShell();
  const res = useAsync(() => api.search(jql, page * 50, 50), [jql, page, version]);

  return (
    <div className="page">
      <PageHeader title="Search work" />
      <form className="jql-bar" onSubmit={(e) => { e.preventDefault(); setParams({ jql: draft }); }}>
        <input className="jql-input" aria-label="JQL query" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
        <button className="btn primary">Search</button>
      </form>
      <div className="chips">
        {EXAMPLES.map((x) => <button key={x} className="chip" onClick={() => { setDraft(x); setParams({ jql: x }); }}>{x}</button>)}
      </div>
      {res.error && <p className="error" role="alert">{res.error.message}</p>}
      {res.data && (
        <>
          <p className="muted small">{res.data.total} result{res.data.total === 1 ? '' : 's'}</p>
          <table className="table">
            <thead><tr><th>Key</th><th>Summary</th><th>Status</th><th>Assignee</th><th>Priority</th><th>Space</th><th>Updated</th></tr></thead>
            <tbody>
              {res.data.issues.map((i) => (
                <tr key={i.key}>
                  <td><TypeIcon type={i.fields.issuetype} /> <Link to={`/browse/${i.key}`} className="key">{i.key}</Link></td>
                  <td><Link to={`/browse/${i.key}`}>{i.fields.summary}</Link></td>
                  <td><StatusLozenge status={i.fields.status} /></td>
                  <td><span className="user-cell"><Avatar user={i.fields.assignee} size={20} /> {i.fields.assignee?.displayName ?? 'Unassigned'}</span></td>
                  <td><PriorityIcon priority={i.fields.priority} /> {i.fields.priority?.name}</td>
                  <td>{i.fields.project.key}</td>
                  <td>{timeAgo(i.fields.updated)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {res.data.total > 50 && (
            <div className="pager">
              <button className="btn subtle" disabled={page === 0} onClick={() => setParams({ jql, page: String(page - 1) })}>← Prev</button>
              <span className="muted small">Page {page + 1} of {Math.ceil(res.data.total / 50)}</span>
              <button className="btn subtle" disabled={(page + 1) * 50 >= res.data.total} onClick={() => setParams({ jql, page: String(page + 1) })}>Next →</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
