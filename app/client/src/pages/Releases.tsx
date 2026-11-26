import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, type Component, type Issue, type Project, type Version } from '../api';
import { useShell } from '../Layout';
import { Avatar, Popover, StatusLozenge, TypeIcon, fmtDate, useAsync } from '../ui';
import { useProject } from './ProjectPages';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));
const statusOf = (v: Version) => (v.archived ? 'Archived' : v.released ? 'Released' : 'Unreleased');

/** Done / In progress / To do as one thin segmented bar, with the numbers in text beside it. */
export function Progress({ v }: { v: Version }) {
  const c = v.issues ?? { total: 0, todo: 0, inProgress: 0, done: 0 };
  if (!c.total) return <span className="muted small">No work items</span>;
  const seg = (n: number, cls: string, label: string) =>
    n > 0 ? <span className={`prog-seg ${cls}`} style={{ flexGrow: n }} title={`${n} ${label}`} /> : null;
  return (
    <span className="prog" aria-label={`${c.done} of ${c.total} done, ${c.inProgress} in progress, ${c.todo} to do`}>
      <span className="prog-bar" aria-hidden>{seg(c.done, 'done', 'done')}{seg(c.inProgress, 'prog', 'in progress')}{seg(c.todo, 'todo', 'to do')}</span>
      <span className="small muted nowrap">{c.done}/{c.total} done</span>
    </span>
  );
}

// ------------------------------------------------------------------ Releases tab

export function Releases() {
  const project = useProject();
  const { version: tick, bump, toast } = useShell();
  const canManage = project.myPermissions.includes('MANAGE_VERSIONS');
  const [filter, setFilter] = useState<'unreleased' | 'released' | 'archived' | 'all'>('unreleased');
  const res = useAsync(() => api.versions(project.key), [project.key, tick]);
  const [dialog, setDialog] = useState<{ kind: 'edit' | 'release' | 'delete'; v: Version | null } | null>(null);
  const all = res.data ?? [];
  const shown = all.filter((v) =>
    filter === 'all' ? true : filter === 'archived' ? v.archived : filter === 'released' ? v.released && !v.archived : !v.released && !v.archived);
  const update = (v: Version, body: Partial<Version>, msg: string) => api.updateVersion(v.id, body).then(() => { toast(msg); bump(); }, (e) => toast(errText(e)));

  return (
    <>
      <div className="toolbar">
        <div className="seg" role="radiogroup" aria-label="Show versions">
          {(['unreleased', 'released', 'archived', 'all'] as const).map((f) => (
            <button key={f} role="radio" aria-checked={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f[0].toUpperCase() + f.slice(1)} <span className="muted small">{all.filter((v) => f === 'all' || (f === 'archived' ? v.archived : f === 'released' ? v.released && !v.archived : !v.released && !v.archived)).length}</span>
            </button>
          ))}
        </div>
        <span className="grow" />
        {canManage && <button className="btn primary" onClick={() => setDialog({ kind: 'edit', v: null })}>+ Create version</button>}
      </div>
      {res.error && <p className="error">{res.error.message}</p>}
      {!res.data ? <p className="muted">Loading…</p> : shown.length === 0 ? (
        <div className="panel empty-state"><h2>No {filter === 'all' ? '' : filter} versions</h2><p className="muted">Versions group the work you plan to ship together. Set a work item’s <strong>Fix versions</strong> to add it.</p></div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Version</th><th>Status</th><th>Progress</th><th>Start date</th><th>Release date</th><th>Description</th>{canManage && <th />}</tr></thead>
            <tbody>
              {shown.map((v) => (
                <tr key={v.id}>
                  <td><Link to={`/projects/${project.key}/releases/${v.id}`} className="strong">{v.name}</Link></td>
                  <td><span className={`lozenge ${v.released ? 'lozenge-done' : v.archived ? 'lozenge-todo' : 'lozenge-in_progress'}`}>{statusOf(v)}</span></td>
                  <td className="prog-cell"><Progress v={v} /></td>
                  <td className="nowrap">{fmtDate(v.startDate)}</td>
                  <td className="nowrap">{fmtDate(v.releaseDate)}{v.overdue && <span className="danger-text small"> ⚠ Overdue</span>}</td>
                  <td className="small muted desc-cell">{v.description}</td>
                  {canManage && (
                    <td className="nowrap">
                      {!v.released && !v.archived && <><button className="link-btn" onClick={() => setDialog({ kind: 'release', v })}>Release</button>{' '}</>}
                      {v.released && !v.archived && <><button className="link-btn" onClick={() => update(v, { released: false }, `${v.name} unreleased`)}>Unrelease</button>{' '}</>}
                      <button className="link-btn" onClick={() => setDialog({ kind: 'edit', v })}>Edit</button>{' '}
                      <button className="link-btn" onClick={() => update(v, { archived: !v.archived }, v.archived ? `${v.name} restored` : `${v.name} archived`)}>{v.archived ? 'Restore' : 'Archive'}</button>{' '}
                      <button className="link-btn danger-text" onClick={() => setDialog({ kind: 'delete', v })}>Delete</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dialog?.kind === 'edit' && <VersionDialog project={project} v={dialog.v} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); bump(); }} />}
      {dialog?.kind === 'release' && dialog.v && <ReleaseDialog v={dialog.v} others={all.filter((o) => o.id !== dialog.v!.id && !o.released && !o.archived)} onClose={() => setDialog(null)} onDone={(msg) => { setDialog(null); toast(msg); bump(); }} />}
      {dialog?.kind === 'delete' && dialog.v && <DeleteDialog v={dialog.v} others={all.filter((o) => o.id !== dialog.v!.id && !o.archived)} onClose={() => setDialog(null)} onDone={(msg) => { setDialog(null); toast(msg); bump(); }} />}
    </>
  );
}

function VersionDialog({ project, v, onClose, onSaved }: { project: Project; v: Version | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(v?.name ?? '');
  const [description, setDescription] = useState(v?.description ?? '');
  const [startDate, setStart] = useState(v?.startDate ?? '');
  const [releaseDate, setRelease] = useState(v?.releaseDate ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = { name, description, startDate: startDate || null, releaseDate: releaseDate || null };
    try { if (v) await api.updateVersion(v.id, body); else await api.createVersion(project.key, body); onSaved(); }
    catch (err) { setError(errText(err)); }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal narrow" role="dialog" aria-modal="true" aria-label={v ? 'Edit version' : 'Create version'} onSubmit={save}>
        <header className="modal-head"><h1>{v ? `Edit ${v.name}` : 'Create version'}</h1><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button></header>
        <div className="modal-body">
          <label>Name*<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoFocus placeholder="e.g. v1.3" /></label>
          <div className="row2">
            <label>Start date<input type="date" value={startDate} onChange={(e) => setStart(e.target.value)} /></label>
            <label>Release date<input type="date" value={releaseDate} onChange={(e) => setRelease(e.target.value)} /></label>
          </div>
          <label>Description<textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} /></label>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <footer className="modal-foot"><span className="grow" /><button type="button" className="btn subtle" onClick={onClose}>Cancel</button><button className="btn primary">{v ? 'Save' : 'Create'}</button></footer>
      </form>
    </div>
  );
}

function ReleaseDialog({ v, others, onClose, onDone }: { v: Version; others: Version[]; onClose: () => void; onDone: (msg: string) => void }) {
  const unfinished = (v.issues?.total ?? 0) - (v.issues?.done ?? 0);
  const [date, setDate] = useState(v.releaseDate && !v.overdue ? v.releaseDate : new Date().toISOString().slice(0, 10));
  const [move, setMove] = useState(others[0]?.id ?? '');
  const [mode, setMode] = useState<'move' | 'ignore'>(others.length ? 'move' : 'ignore');
  const [error, setError] = useState<string | null>(null);
  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api.releaseVersion(v.id, { releaseDate: date, moveUnresolvedTo: unfinished && mode === 'move' ? move : null });
      onDone(r.moved ? `${v.name} released · ${r.moved} unfinished moved to ${others.find((o) => o.id === move)?.name}` : `${v.name} released`);
    } catch (err) { setError(errText(err)); }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal narrow" role="dialog" aria-modal="true" aria-label="Release version" onSubmit={go}>
        <header className="modal-head"><h1>Release {v.name}</h1><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button></header>
        <div className="modal-body">
          <label>Release date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></label>
          {unfinished > 0 ? (
            <fieldset className="radio-group">
              <legend>{unfinished} work item{unfinished === 1 ? ' isn’t' : 's aren’t'} done yet</legend>
              {others.length > 0 && (
                <label className="check small-check"><input type="radio" name="unfinished" checked={mode === 'move'} onChange={() => setMode('move')} /> Move {unfinished === 1 ? 'it' : 'them'} to
                  <select value={move} onChange={(e) => { setMove(e.target.value); setMode('move'); }} aria-label="Move unfinished work to">
                    {others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                </label>
              )}
              <label className="check small-check"><input type="radio" name="unfinished" checked={mode === 'ignore'} onChange={() => setMode('ignore')} /> Leave {unfinished === 1 ? 'it' : 'them'} in {v.name}</label>
            </fieldset>
          ) : <p className="small">All {v.issues?.total ?? 0} work items are done.</p>}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <footer className="modal-foot"><span className="grow" /><button type="button" className="btn subtle" onClick={onClose}>Cancel</button><button className="btn primary">Release</button></footer>
      </form>
    </div>
  );
}

function DeleteDialog({ v, others, onClose, onDone }: { v: Version; others: Version[]; onClose: () => void; onDone: (msg: string) => void }) {
  const [move, setMove] = useState('');
  const [error, setError] = useState<string | null>(null);
  const n = v.issues?.total ?? 0;
  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    try { await api.deleteVersion(v.id, move || null); onDone(`${v.name} deleted`); } catch (err) { setError(errText(err)); }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal narrow" role="dialog" aria-modal="true" aria-label="Delete version" onSubmit={go}>
        <header className="modal-head"><h1>Delete {v.name}?</h1><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button></header>
        <div className="modal-body">
          {n > 0 ? (
            <label>{n} work item{n === 1 ? ' has' : 's have'} this fix version. Afterwards:
              <select value={move} onChange={(e) => setMove(e.target.value)}>
                <option value="">Remove the fix version</option>
                {others.map((o) => <option key={o.id} value={o.id}>Move to {o.name}</option>)}
              </select>
            </label>
          ) : <p className="small">No work items use this version.</p>}
          <p className="small muted">This can’t be undone. Work items themselves aren’t deleted.</p>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <footer className="modal-foot"><span className="grow" /><button type="button" className="btn subtle" onClick={onClose}>Cancel</button><button className="btn danger">Delete</button></footer>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ version detail

export function VersionDetail() {
  const project = useProject();
  const { id = '' } = useParams();
  const { version: tick } = useShell();
  const v = useAsync(() => api.version(id), [id, tick]);
  const jql = `project = ${project.key} AND fixVersion = ${id} ORDER BY status, rank`;
  const issues = useAsync(() => api.search(jql, 0, 200), [jql, tick]);
  if (v.error) return <p className="error">{v.error.message}</p>;
  if (!v.data) return <p className="muted">Loading…</p>;
  const ver = v.data;
  return (
    <div className="stack">
      <div className="crumbs small"><Link to={`/projects/${project.key}/releases`}>Releases</Link> /</div>
      <div className="section-row" style={{ marginTop: 0 }}>
        <h2 style={{ margin: 0 }}>{ver.name}</h2>
        <span className={`lozenge ${ver.released ? 'lozenge-done' : ver.archived ? 'lozenge-todo' : 'lozenge-in_progress'}`}>{statusOf(ver)}</span>
        <span className="grow" />
        <Link className="btn subtle" to={`/issues?jql=${encodeURIComponent(jql)}`}>Open in search</Link>
      </div>
      <div className="facts">
        <span><b>Start</b> {fmtDate(ver.startDate) || 'Not set'}</span>
        <span><b>Release</b> {fmtDate(ver.releaseDate) || 'Not set'}{ver.overdue && <span className="danger-text"> ⚠ Overdue</span>}</span>
        <span className="prog-wide"><Progress v={ver} /></span>
      </div>
      {ver.description && <p>{ver.description}</p>}
      {!issues.data ? <p className="muted">Loading…</p> : issues.data.issues.length === 0 ? <p className="muted">No work items have this fix version yet.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Work</th><th>Status</th><th>Assignee</th><th>Priority</th></tr></thead>
            <tbody>
              {issues.data.issues.map((i: Issue) => (
                <tr key={i.key}>
                  <td><TypeIcon type={i.fields.issuetype} /> <Link to={`/browse/${i.key}`} className="key">{i.key}</Link> <Link to={`/browse/${i.key}`}>{i.fields.summary}</Link></td>
                  <td><StatusLozenge status={i.fields.status} /></td>
                  <td><span className="user-cell"><Avatar user={i.fields.assignee} size={20} /> {i.fields.assignee?.displayName ?? 'Unassigned'}</span></td>
                  <td>{i.fields.priority?.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ components (space settings)

export function ComponentsEditor({ project }: { project: Project }) {
  const { toast } = useShell();
  const [list, setList] = useState<Component[] | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [lead, setLead] = useState('');
  const [editing, setEditing] = useState<Component | null>(null);
  const load = () => api.components(project.key).then(setList, (e) => toast(errText(e)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [project.key]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const body = { name, description, leadAccountId: lead || null };
      if (editing) await api.updateComponent(editing.id, body); else await api.createComponent(project.key, body);
      setName(''); setDescription(''); setLead(''); setEditing(null);
      load();
    } catch (err) { toast(errText(err)); }
  };
  const remove = async (c: Component) => {
    const others = (list ?? []).filter((o) => o.id !== c.id);
    let move: string | null = null;
    if (c.issueCount > 0 && others.length) {
      const pick = prompt(`${c.issueCount} work item(s) use ${c.name}. Type another component’s name to move them there, or leave empty to just remove it:\n${others.map((o) => o.name).join(', ')}`, '');
      if (pick === null) return;
      move = others.find((o) => o.name.toLowerCase() === pick.trim().toLowerCase())?.id ?? null;
      if (pick.trim() && !move) { toast(`No component named ${pick}`); return; }
    } else if (!confirm(`Delete component ${c.name}?`)) return;
    api.deleteComponent(c.id, move).then(() => { toast(`${c.name} deleted`); load(); }, (e) => toast(errText(e)));
  };
  return (
    <section className="panel">
      <h2 className="section-title" style={{ marginTop: 0 }}>Components</h2>
      <p className="muted small">Group work by part of the product (e.g. “Payments”, “Web app”). Set them on work items and search with <code>component = Payments</code>.</p>
      {!list ? <p className="muted">Loading…</p> : list.length === 0 ? <p className="muted">No components yet.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>Description</th><th>Lead</th><th>Work items</th><th /></tr></thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id}>
                  <td className="strong">{c.name}</td>
                  <td className="small muted">{c.description}</td>
                  <td>{c.lead?.displayName ?? <span className="muted">—</span>}</td>
                  <td><Link to={`/issues?jql=${encodeURIComponent(`project = ${project.key} AND component = ${c.id}`)}`}>{c.issueCount}</Link></td>
                  <td className="nowrap">
                    <button className="link-btn" onClick={() => { setEditing(c); setName(c.name); setDescription(c.description); setLead(c.lead?.accountId ?? ''); }}>Edit</button>{' '}
                    <button className="link-btn danger-text" onClick={() => remove(c)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form className="row-form" onSubmit={save} style={{ marginTop: 12 }}>
        <label className="grow">{editing ? `Edit ${editing.name}` : 'New component'}<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} placeholder="Name" /></label>
        <label className="grow">Description<input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} /></label>
        <label>Lead
          <select value={lead} onChange={(e) => setLead(e.target.value)}>
            <option value="">No lead</option>
            {project.members.map((m) => <option key={m.accountId} value={m.accountId}>{m.displayName}</option>)}
          </select>
        </label>
        <button className="btn primary">{editing ? 'Save' : 'Add'}</button>
        {editing && <button type="button" className="btn subtle" onClick={() => { setEditing(null); setName(''); setDescription(''); setLead(''); }}>Cancel</button>}
      </form>
    </section>
  );
}

// ------------------------------------------------------------------ work item fields

/** "Fix versions" / "Components" on the work item page: chips + add menu. */
export function MultiRefField({ kind, issue, canEdit, onEdit }: {
  kind: 'fixVersions' | 'components'; issue: Issue; canEdit: boolean;
  onEdit: (field: string, value: unknown, op: 'ADD' | 'REMOVE') => void;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<{ id: string; name: string; note?: string }[] | null>(null);
  const current = (kind === 'fixVersions' ? issue.fields.fixVersions : issue.fields.components) ?? [];
  useEffect(() => {
    if (!open) return;
    const key = issue.fields.project.key;
    (kind === 'fixVersions'
      ? api.versions(key).then((vs) => vs.filter((v) => !v.archived).sort((a, b) => Number(a.released) - Number(b.released)).map((v) => ({ id: v.id, name: v.name, note: v.released ? 'released' : v.releaseDate ? fmtDate(v.releaseDate) : undefined })))
      : api.components(key).then((cs) => cs.map((c) => ({ id: c.id, name: c.name })))
    ).then(setOptions, () => setOptions([]));
  }, [open, kind, issue.fields.project.key]);
  const free = useMemo(() => (options ?? []).filter((o) => !current.some((c) => c.id === o.id)), [options, current]);
  const noun = kind === 'fixVersions' ? 'version' : 'component';
  return (
    <div className="labels">
      {current.length === 0 && !canEdit && <span className="muted">None</span>}
      {current.map((c) => (
        <span key={c.id} className="label">{c.name}{'released' in c && c.released ? ' ✓' : ''}
          {canEdit && <button className="x" aria-label={`Remove ${noun} ${c.name}`} onClick={() => onEdit(kind, [{ id: c.id }], 'REMOVE')}>×</button>}
        </span>
      ))}
      {canEdit && (
        <span className="menu-anchor">
          <button className="link-btn small" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>+ {noun}</button>
          <Popover open={open} onClose={() => setOpen(false)}>
            {options === null ? <div className="menu-item muted">Loading…</div>
              : free.length === 0 ? <div className="menu-item muted">{options.length ? `All ${noun}s are set` : `No ${noun}s in this space yet`}</div>
              : free.map((o) => (
                <button key={o.id} className="menu-item" onClick={() => { setOpen(false); onEdit(kind, [{ id: o.id }], 'ADD'); }}>
                  {o.name}{o.note && <span className="muted small"> · {o.note}</span>}
                </button>
              ))}
          </Popover>
        </span>
      )}
    </div>
  );
}
