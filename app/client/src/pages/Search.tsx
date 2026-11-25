import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type SavedFilter } from '../api';
import { PageHeader, useShell } from '../Layout';
import { DetailsDialog, shareLabel } from '../ShareDialog';
import { Avatar, PriorityIcon, StatusLozenge, TypeIcon, timeAgo, useAsync } from '../ui';

const EXAMPLES = [
  'assignee = currentUser() AND statusCategory != Done',
  'priority >= High ORDER BY priority DESC',
  'labels in (backend, security)',
  'sprint in openSprints()',
  'created >= -7d ORDER BY created DESC',
  'text ~ "wallet"',
];

/** Search work: run JQL, or open a saved filter (?filter=ID), then save / save as / update it. */
export function Search() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const filterId = params.get('filter');
  const page = Number(params.get('page') ?? 0);
  const { version, bump, toast } = useShell();
  const [filter, setFilter] = useState<SavedFilter | null>(null);
  const jql = params.get('jql') ?? filter?.jql ?? 'ORDER BY updated DESC';
  const [draft, setDraft] = useState(jql);
  const [dialog, setDialog] = useState<'save' | 'details' | null>(null);
  const res = useAsync(() => api.search(jql, page * 50, 50), [jql, page, version]);

  useEffect(() => {
    if (!filterId) { setFilter(null); return; }
    api.filter(filterId).then(setFilter, (e) => { toast(e.message); setFilter(null); });
  }, [filterId, version, toast]);
  useEffect(() => setDraft(jql), [jql]);

  const run = (q: string) => setParams(filterId ? { filter: filterId, jql: q } : { jql: q });
  const changed = !!filter && jql !== filter.jql;

  return (
    <div className="page">
      <PageHeader
        crumbs={filter ? <><Link to="/filters">Filters</Link> /</> : undefined}
        title={
          filter ? (
            <span className="title-with-star">
              <button className="icon-btn star" aria-pressed={filter.favourite} aria-label={filter.favourite ? 'Unstar filter' : 'Star filter'}
                onClick={() => api.favouriteFilter(filter.id, !filter.favourite).then(bump)}>{filter.favourite ? '★' : '☆'}</button>
              {filter.name}{changed && <span className="muted small"> (edited)</span>}
            </span>
          ) : 'Search work'
        }
        actions={
          <div className="row-actions">
            {filter?.editable && changed && (
              <button className="btn primary" onClick={() => api.updateFilter(filter.id, { jql }).then(() => { toast('Filter updated'); bump(); }, (e) => toast(e.message))}>
                Save changes
              </button>
            )}
            {filter?.editable && <button className="btn subtle" onClick={() => setDialog('details')}>Details</button>}
            <button className={`btn ${filter && !changed ? 'subtle' : filter ? '' : 'primary'}`} onClick={() => setDialog('save')}>
              {filter ? 'Save as' : 'Save filter'}
            </button>
          </div>
        }
      />
      {filter && (
        <p className="muted small">
          {filter.description && <>{filter.description} · </>}Owner {filter.owner.displayName} · {shareLabel(filter.share)}
        </p>
      )}
      <form className="jql-bar" onSubmit={(e) => { e.preventDefault(); run(draft); }}>
        <input className="jql-input" aria-label="JQL query" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
        <button className="btn primary">Search</button>
      </form>
      {!filter && (
        <div className="chips">
          {EXAMPLES.map((x) => <button key={x} className="chip" onClick={() => { setDraft(x); run(x); }}>{x}</button>)}
        </div>
      )}
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
              <button className="btn subtle" disabled={page === 0} onClick={() => setParams({ ...Object.fromEntries(params), page: String(page - 1) })}>← Prev</button>
              <span className="muted small">Page {page + 1} of {Math.ceil(res.data.total / 50)}</span>
              <button className="btn subtle" disabled={(page + 1) * 50 >= res.data.total} onClick={() => setParams({ ...Object.fromEntries(params), page: String(page + 1) })}>Next →</button>
            </div>
          )}
        </>
      )}
      {dialog === 'save' && (
        <DetailsDialog title={filter ? 'Save as new filter' : 'Save filter'} submit="Save"
          initial={filter ? { name: `${filter.name} (copy)`, share: filter.share } : undefined}
          extra={<p className="muted small">JQL: <code>{jql}</code></p>}
          onClose={() => setDialog(null)}
          onSave={async (v) => {
            const f = await api.createFilter({ ...v, jql });
            setDialog(null);
            toast(`Saved filter "${f.name}"`);
            bump();
            nav(`/issues?filter=${f.id}`);
          }} />
      )}
      {dialog === 'details' && filter && (
        <DetailsDialog title="Filter details" submit="Save" initial={filter}
          onClose={() => setDialog(null)}
          onSave={async (v) => { await api.updateFilter(filter.id, v); setDialog(null); toast('Filter updated'); bump(); }} />
      )}
    </div>
  );
}
