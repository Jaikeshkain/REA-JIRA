import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, type ColumnDef, type Issue, type SavedFilter } from '../api';
import { BulkBar, loadColumns, saveColumns } from '../BulkBar';
import { PageHeader, useShell } from '../Layout';
import { DetailsDialog, shareLabel } from '../ShareDialog';
import { Avatar, Popover, PriorityIcon, StatusLozenge, TypeIcon, fmtDate, timeAgo, useAsync } from '../ui';

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
  const [catalog, setCatalog] = useState<{ defaults: string[]; columns: ColumnDef[] } | null>(null);
  const [columns, setColumns] = useState<string[]>(() => loadColumns(['key', 'summary', 'status', 'assignee', 'priority', 'project', 'updated']));
  const [picker, setPicker] = useState(false);
  const [selected, setSelected] = useState<Map<string, Issue>>(new Map());
  const res = useAsync(() => api.searchTable(jql, columns, page * 50, 50), [jql, page, version, columns.join()]);
  useEffect(() => { api.columns().then(setCatalog); }, []);
  useEffect(() => { setSelected(new Map()); }, [jql]);
  const setCols = (c: string[]) => { setColumns(c); saveColumns(c); };
  const pageIssues = res.data?.issues ?? [];
  const allOnPage = pageIssues.length > 0 && pageIssues.every((i) => selected.has(i.key));
  const toggle = (i: Issue) => setSelected((m) => { const n = new Map(m); n.has(i.key) ? n.delete(i.key) : n.set(i.key, i); return n; });
  const label = (id: string) => catalog?.columns.find((c) => c.id === id)?.label ?? id;

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
            <button className="btn subtle" onClick={() => api.exportCsv(jql, columns).then(
              (r) => toast(r.exported < r.total ? `Exported the first ${r.exported} of ${r.total}` : `Exported ${r.exported} work item${r.exported === 1 ? '' : 's'}`),
              (e) => toast(e instanceof ApiError ? e.message : String(e)),
            )}>Export CSV</button>
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
          <div className="results-bar">
            <span className="muted small">{res.data.total} result{res.data.total === 1 ? '' : 's'}</span>
            <span className="grow" />
            <span className="menu-anchor">
              <button className="btn subtle" onClick={() => setPicker((o) => !o)} aria-haspopup="dialog" aria-expanded={picker}>Columns ▾</button>
              <Popover open={picker} onClose={() => setPicker(false)} align="right">
                <div className="col-picker" role="dialog" aria-label="Choose columns">
                  {catalog?.columns.map((c) => (
                    <label key={c.id} className="check small-check">
                      <input type="checkbox" checked={columns.includes(c.id)} disabled={c.id === 'key'}
                        onChange={(e) => setCols(e.target.checked ? [...columns, c.id] : columns.filter((x) => x !== c.id))} />
                      {c.label}{c.space ? <span className="muted small"> · {c.space}</span> : null}
                    </label>
                  ))}
                  <button className="link-btn" onClick={() => setCols(catalog?.defaults ?? columns)}>Reset to default</button>
                </div>
              </Popover>
            </span>
          </div>
          {selected.size > 0 && <BulkBar selected={[...selected.values()]} onClear={() => setSelected(new Map())} onDone={bump} />}
          <div className="table-wrap">
            <table className="table">
              <thead><tr>
                <th className="sel"><input type="checkbox" aria-label="Select all on this page" checked={allOnPage}
                  onChange={() => setSelected((m) => { const n = new Map(m); pageIssues.forEach((i) => (allOnPage ? n.delete(i.key) : n.set(i.key, i))); return n; })} /></th>
                {columns.map((c) => <th key={c}>{label(c)}</th>)}
              </tr></thead>
              <tbody>
                {res.data.issues.map((i) => (
                  <tr key={i.key} className={selected.has(i.key) ? 'selected' : ''}>
                    <td className="sel"><input type="checkbox" aria-label={`Select ${i.key}`} checked={selected.has(i.key)} onChange={() => toggle(i)} /></td>
                    {columns.map((c) => <td key={c}><Cell issue={i} col={c} /></td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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

/** One table cell by column id (built-ins render rich; custom fields show their display text). */
function Cell({ issue: i, col }: { issue: Issue & { custom?: Record<string, string | null> }; col: string }) {
  const f = i.fields;
  switch (col) {
    case 'key': return <><TypeIcon type={f.issuetype} /> <Link to={`/browse/${i.key}`} className="key">{i.key}</Link></>;
    case 'summary': return <Link to={`/browse/${i.key}`}>{f.summary}</Link>;
    case 'issuetype': return <>{f.issuetype.name}</>;
    case 'status': return <StatusLozenge status={f.status} />;
    case 'priority': return <><PriorityIcon priority={f.priority} /> {f.priority?.name}</>;
    case 'assignee': return <span className="user-cell"><Avatar user={f.assignee} size={20} /> {f.assignee?.displayName ?? 'Unassigned'}</span>;
    case 'reporter': return <>{f.reporter?.displayName}</>;
    case 'labels': return <span className="labels">{f.labels.map((l) => <span key={l} className="label">{l}</span>)}</span>;
    case 'parent': return f.parent ? <Link to={`/browse/${f.parent.key}`} className="key">{f.parent.key}</Link> : null;
    case 'sprint': return <>{f.sprint?.name}</>;
    case 'storypoints': return <>{f.storypoints ?? ''}</>;
    case 'duedate': return <>{fmtDate(f.duedate)}</>;
    case 'startdate': return <>{fmtDate(f.startdate)}</>;
    case 'resolution': return <>{f.resolution?.name ?? 'Unresolved'}</>;
    case 'created': return <>{new Date(f.created).toLocaleDateString()}</>;
    case 'updated': return <>{timeAgo(f.updated)}</>;
    case 'project': return <>{f.project.key}</>;
    case 'description': return <span className="muted small">—</span>;
    default: return <>{i.custom?.[col] ?? ''}</>;
  }
}
