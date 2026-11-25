import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type Gadget, type GadgetData, type GadgetType, type SavedFilter } from '../api';
import { PageHeader, useShell } from '../Layout';
import { DetailsDialog, shareLabel } from '../ShareDialog';
import { Avatar, PriorityIcon, StatusLozenge, TypeIcon, useAsync } from '../ui';
import { BreakdownBars, CreatedResolvedChart } from '../charts';

const GADGETS: { type: GadgetType; title: string; blurb: string }[] = [
  { type: 'filter-results', title: 'Filter results', blurb: 'Work items from a saved filter, in its order.' },
  { type: 'breakdown', title: 'Breakdown', blurb: 'Counts of a filter’s work by status, assignee, priority, type, label…' },
  { type: 'created-vs-resolved', title: 'Created vs. resolved', blurb: 'Work created and resolved per day for a filter.' },
  { type: 'assigned-to-me', title: 'Assigned to me', blurb: 'Your unresolved work, highest priority first.' },
];
const FIELDS = [
  ['status', 'Status'], ['statusCategory', 'Status category'], ['assignee', 'Assignee'], ['priority', 'Priority'],
  ['type', 'Work type'], ['labels', 'Labels'], ['project', 'Space'], ['reporter', 'Reporter'],
] as const;
const fieldName = (f: string) => FIELDS.find(([k]) => k === f)?.[1] ?? f;

export function DashboardList() {
  const nav = useNavigate();
  const { version, bump } = useShell();
  const list = useAsync(() => api.dashboards(), [version]);
  const [creating, setCreating] = useState(false);
  return (
    <div className="page">
      <PageHeader title="Dashboards" actions={<button className="btn primary" onClick={() => setCreating(true)}>Create dashboard</button>} />
      {list.data?.dashboards.length === 0 && <p className="muted empty">No dashboards yet.</p>}
      {!!list.data?.dashboards.length && (
        <table className="table">
          <thead><tr><th>Name</th><th>Owner</th><th>Viewers</th></tr></thead>
          <tbody>{list.data.dashboards.map((d) => (
            <tr key={d.id}>
              <td><Link to={`/dashboards/${d.id}`}>{d.name}</Link>{d.description && <div className="muted small">{d.description}</div>}</td>
              <td><span className="user-cell"><Avatar user={d.owner} size={20} /> {d.owner.displayName}</span></td>
              <td>{shareLabel(d.share)}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {creating && (
        <DetailsDialog title="Create dashboard" submit="Create" onClose={() => setCreating(false)}
          onSave={async (v) => { const d = await api.createDashboard(v); bump(); nav(`/dashboards/${d.id}?edit=1`); }} />
      )}
    </div>
  );
}

export function DashboardView() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { version, bump, toast } = useShell();
  const dash = useAsync(() => api.dashboard(id), [id, version]);
  const [edit, setEdit] = useState(() => new URLSearchParams(location.search).has('edit'));
  const [dialog, setDialog] = useState<{ gadget?: Gadget; column: number } | 'details' | null>(null);

  if (dash.error) return <div className="page"><p className="error">{dash.error.message}</p><Link to="/dashboards">All dashboards</Link></div>;
  const d = dash.data;
  if (!d) return <div className="page"><p className="muted">Loading…</p></div>;
  const cols = [0, 1].map((c) => (d.gadgets ?? []).filter((g) => g.column === c).sort((a, b) => a.position - b.position));

  const act = (fn: () => Promise<unknown>) => fn().then(bump, (e) => toast(e instanceof ApiError ? e.message : String(e)));
  const move = (g: Gadget, column: number, position: number) => act(() => api.updateGadget(d.id, g.id, { column, position }));

  return (
    <div className="page">
      <PageHeader
        crumbs={<><Link to="/dashboards">Dashboards</Link> /</>}
        title={d.name}
        actions={d.editable && (
          <div className="row-actions">
            {edit && <button className="btn" onClick={() => setDialog({ column: 0 })}>+ Add gadget</button>}
            {edit && <button className="btn subtle" onClick={() => setDialog('details')}>Details</button>}
            {edit && (
              <button className="btn subtle danger-text" onClick={async () => {
                if (!confirm(`Delete dashboard "${d.name}"? This can't be undone.`)) return;
                await api.deleteDashboard(d.id); bump(); nav('/dashboards');
              }}>Delete</button>
            )}
            <button className={`btn ${edit ? 'primary' : ''}`} onClick={() => setEdit((e) => !e)}>{edit ? 'Done' : 'Edit'}</button>
          </div>
        )}
      />
      <p className="muted small">{d.description && <>{d.description} · </>}Owner {d.owner.displayName} · {shareLabel(d.share)}</p>
      <div className="dash-grid">
        {cols.map((list, c) => (
          <div key={c} className="dash-col">
            {list.map((g, i) => (
              <GadgetFrame key={g.id} dashId={d.id} gadget={g} version={version} edit={edit}
                controls={edit && (
                  <span className="gadget-ctl">
                    <button className="icon-btn tiny" aria-label="Move up" disabled={i === 0} onClick={() => move(g, c, i - 1)}>↑</button>
                    <button className="icon-btn tiny" aria-label="Move down" disabled={i === list.length - 1} onClick={() => move(g, c, i + 1)}>↓</button>
                    <button className="icon-btn tiny" aria-label={c === 0 ? 'Move to right column' : 'Move to left column'} onClick={() => move(g, 1 - c, 0)}>{c === 0 ? '→' : '←'}</button>
                    <button className="icon-btn tiny" aria-label="Configure" onClick={() => setDialog({ gadget: g, column: c })}>⚙</button>
                    <button className="icon-btn tiny" aria-label="Remove gadget" onClick={() => act(() => api.removeGadget(d.id, g.id))}>✕</button>
                  </span>
                )} />
            ))}
            {edit && <button className="drop-hint block" onClick={() => setDialog({ column: c })}>+ Add gadget here</button>}
            {!edit && list.length === 0 && c === 0 && (d.gadgets ?? []).length === 0 && <p className="muted">This dashboard is empty.</p>}
          </div>
        ))}
      </div>
      {dialog === 'details' && (
        <DetailsDialog title="Dashboard details" submit="Save" initial={d} onClose={() => setDialog(null)}
          onSave={async (v) => { await api.updateDashboard(d.id, v); setDialog(null); bump(); }} />
      )}
      {dialog && dialog !== 'details' && (
        <GadgetDialog gadget={dialog.gadget} onClose={() => setDialog(null)}
          onSave={async (type, config) => {
            if (dialog.gadget) await api.updateGadget(d.id, dialog.gadget.id, { config });
            else await api.addGadget(d.id, { type, column: dialog.column, config });
            setDialog(null);
            bump();
          }} />
      )}
    </div>
  );
}

function GadgetFrame({ dashId, gadget, version, edit, controls }: {
  dashId: string; gadget: Gadget; version: number; edit: boolean; controls: React.ReactNode;
}) {
  const [data, setData] = useState<GadgetData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setError(null);
    api.gadgetData(dashId, gadget.id).then((x) => live && setData(x), (e) => live && setError(e.message));
    return () => { live = false; };
  }, [dashId, gadget.id, gadget.config, version]);
  const meta = GADGETS.find((x) => x.type === gadget.type);
  const src = data && 'source' in data ? data.source : null;
  const title =
    gadget.type === 'breakdown' ? `${src?.name ?? 'Filter'} by ${fieldName(gadget.config.field)}`
    : gadget.type === 'created-vs-resolved' ? `Created vs. resolved: ${src?.name ?? ''} (last ${gadget.config.days ?? 30} days)`
    : gadget.type === 'filter-results' ? `Filter results: ${src?.name ?? ''}`
    : meta?.title ?? gadget.type;
  return (
    <section className={`gadget ${edit ? 'editing' : ''}`} aria-label={title}>
      <header className="gadget-head">
        <h2>{title}</h2>
        {controls}
      </header>
      <div className="gadget-body">
        {error && <p className="error small">{error}</p>}
        {!data && !error && <p className="muted small">Loading…</p>}
        {data && 'unavailable' in data && <p className="muted small">⚠ {data.unavailable}</p>}
        {data && 'issues' in data && (
          <>
            {data.issues.length === 0 ? <p className="muted small">No matching work items.</p> : (
              <table className="table compact">
                <tbody>{data.issues.map((i) => (
                  <tr key={i.key}>
                    <td><TypeIcon type={i.fields.issuetype} /> <Link to={`/browse/${i.key}`} className="key">{i.key}</Link></td>
                    <td><Link to={`/browse/${i.key}`}>{i.fields.summary}</Link></td>
                    <td><PriorityIcon priority={i.fields.priority} /></td>
                    <td><StatusLozenge status={i.fields.status} /></td>
                    <td><Avatar user={i.fields.assignee} size={20} /></td>
                  </tr>
                ))}</tbody>
              </table>
            )}
            <p className="muted small gadget-foot">
              Showing {data.issues.length} of {data.total} ·{' '}
              <Link to={src ? `/issues?filter=${src.id}` : `/issues?jql=${encodeURIComponent(data.jql)}`}>View all</Link>
            </p>
          </>
        )}
        {data && 'groups' in data && <BreakdownBars groups={data.groups} total={data.total} />}
        {data && 'series' in data && (
          <>
            <p className="muted small">{data.totals.created} created · {data.totals.resolved} resolved</p>
            <CreatedResolvedChart series={data.series} />
          </>
        )}
      </div>
    </section>
  );
}

function GadgetDialog({ gadget, onClose, onSave }: {
  gadget?: Gadget; onClose: () => void; onSave: (type: GadgetType, config: Record<string, any>) => Promise<void>;
}) {
  const [type, setType] = useState<GadgetType>(gadget?.type ?? 'filter-results');
  const [filters, setFilters] = useState<SavedFilter[]>([]);
  const [cfg, setCfg] = useState<Record<string, any>>(gadget?.config ?? {});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.filters('all').then((r) => {
      setFilters(r.values);
      setCfg((c) => ({ ...c, filterId: c.filterId ?? r.values.find((f) => f.favourite)?.id ?? r.values[0]?.id }));
    });
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);
  const needsFilter = type !== 'assigned-to-me';
  const config = {
    ...(needsFilter ? { filterId: cfg.filterId } : {}),
    ...(type === 'breakdown' ? { field: cfg.field ?? 'status' } : {}),
    ...(type === 'created-vs-resolved' ? { days: Number(cfg.days ?? 30) } : {}),
    ...(type === 'filter-results' || type === 'assigned-to-me' ? { max: Number(cfg.max ?? 10) } : {}),
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" role="dialog" aria-modal="true" aria-label={gadget ? 'Configure gadget' : 'Add gadget'} onSubmit={async (e) => {
        e.preventDefault();
        try { await onSave(type, config); } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
      }}>
        <header className="modal-head"><h1>{gadget ? 'Configure gadget' : 'Add gadget'}</h1><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button></header>
        <div className="modal-body">
          {!gadget && (
            <div className="gadget-picker" role="radiogroup" aria-label="Gadget type">
              {GADGETS.map((g) => (
                <button type="button" key={g.type} role="radio" aria-checked={type === g.type} className={`gadget-option ${type === g.type ? 'on' : ''}`} onClick={() => setType(g.type)}>
                  <strong>{g.title}</strong><span className="muted small">{g.blurb}</span>
                </button>
              ))}
            </div>
          )}
          {needsFilter && (
            filters.length === 0
              ? <p className="muted">You need a saved filter first. <Link to="/issues">Run a search and save it</Link>.</p>
              : (
                <label>Saved filter*
                  <select value={cfg.filterId ?? ''} onChange={(e) => setCfg({ ...cfg, filterId: e.target.value })} required>
                    {filters.map((f) => <option key={f.id} value={f.id}>{f.favourite ? '★ ' : ''}{f.name}</option>)}
                  </select>
                </label>
              )
          )}
          {type === 'breakdown' && (
            <label>Break down by
              <select value={cfg.field ?? 'status'} onChange={(e) => setCfg({ ...cfg, field: e.target.value })}>
                {FIELDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            </label>
          )}
          {type === 'created-vs-resolved' && (
            <label>Period
              <select value={String(cfg.days ?? 30)} onChange={(e) => setCfg({ ...cfg, days: Number(e.target.value) })}>
                {[7, 14, 30, 60, 90].map((n) => <option key={n} value={n}>Last {n} days</option>)}
              </select>
            </label>
          )}
          {(type === 'filter-results' || type === 'assigned-to-me') && (
            <label>Number of results
              <select value={String(cfg.max ?? 10)} onChange={(e) => setCfg({ ...cfg, max: Number(e.target.value) })}>
                {[5, 10, 20, 50].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          )}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <footer className="modal-foot"><span className="grow" />
          <button type="button" className="btn subtle" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={needsFilter && !cfg.filterId}>{gadget ? 'Save' : 'Add gadget'}</button>
        </footer>
      </form>
    </div>
  );
}
