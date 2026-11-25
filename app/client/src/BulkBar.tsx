import { useEffect, useState } from 'react';
import { api, ApiError, type BulkAction, type BulkResult, type Issue, type Priority, type Sprint, type User } from './api';
import { Popover } from './ui';

/**
 * Bulk change bar for selected work items. Every item is processed with the same rules as editing it alone;
 * the result dialog lists what succeeded and why anything failed.
 */
export function BulkBar({ selected, onClear, onDone }: { selected: Issue[]; onClear: () => void; onDone: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [priorities, setPriorities] = useState<Priority[]>([]);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ title: string; r: BulkResult } | null>(null);
  const projects = [...new Set(selected.map((i) => i.fields.project.key))];
  const oneProject = projects.length === 1 ? projects[0] : null;
  const keys = selected.map((i) => i.key);

  useEffect(() => {
    api.priorities().then(setPriorities);
    // statuses: names available in every selected space (bulk move is by name)
    Promise.all(projects.map((k) => api.project(k))).then((ps) => {
      const sets = ps.map((p) => new Set(p.statuses.map((s) => s.name)));
      setStatuses(ps[0]?.statuses.map((s) => s.name).filter((n) => sets.every((x) => x.has(n))) ?? []);
    });
    if (oneProject) {
      api.assignable(oneProject).then(setUsers).catch(() => setUsers([]));
      api.sprints(oneProject, 'active,future').then(setSprints).catch(() => setSprints([]));
    } else { setUsers([]); setSprints([]); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects.join()]);

  const run = async (title: string, action: BulkAction) => {
    setOpen(null);
    if (action.type === 'delete' && !confirm(`Delete ${keys.length} work item${keys.length === 1 ? '' : 's'} (and their subtasks)? This can't be undone.`)) return;
    setBusy(true);
    try {
      const r = await api.bulk(keys, action);
      setResult({ title, r });
      onDone();
    } catch (e) {
      setResult({ title, r: { succeeded: 0, failed: keys.length, results: keys.map((k) => ({ key: k, ok: false, error: e instanceof ApiError ? e.message : String(e) })) } });
    } finally {
      setBusy(false);
    }
  };

  const menu = (id: string, label: string, body: React.ReactNode, disabled = false) => (
    <span className="menu-anchor">
      <button className="btn subtle" disabled={busy || disabled} onClick={() => setOpen(open === id ? null : id)} aria-haspopup="menu" aria-expanded={open === id}>{label} ▾</button>
      <Popover open={open === id} onClose={() => setOpen(null)}>{body}</Popover>
    </span>
  );

  return (
    <>
      <div className="bulk-bar" role="toolbar" aria-label="Bulk change">
        <strong>{selected.length} selected</strong>
        <button className="link-btn" onClick={onClear}>Clear</button>
        <span className="bulk-sep" />
        {menu('move', 'Move to', statuses.map((s) => (
          <button key={s} className="menu-item" role="menuitem" onClick={() => run(`Move to ${s}`, { type: 'transition', statusName: s })}>{s}</button>
        )), !statuses.length)}
        {menu('assign', 'Assign', (
          <>
            <button className="menu-item" role="menuitem" onClick={() => run('Unassign', { type: 'edit', field: 'assignee', value: null })}>Unassigned</button>
            {users.map((u) => <button key={u.accountId} className="menu-item" role="menuitem" onClick={() => run(`Assign to ${u.displayName}`, { type: 'edit', field: 'assignee', value: { accountId: u.accountId } })}>{u.displayName}</button>)}
            {!oneProject && <p className="muted small menu-note">Select work from one space to assign people.</p>}
          </>
        ))}
        {menu('prio', 'Priority', priorities.map((p) => (
          <button key={p.id} className="menu-item" role="menuitem" onClick={() => run(`Set priority ${p.name}`, { type: 'edit', field: 'priority', value: p.name })}>{p.name}</button>
        )))}
        {menu('labels', 'Labels', (
          <form className="menu-form" onSubmit={(e) => { e.preventDefault(); const l = label.trim().replace(/\s+/g, '-'); if (l) run(`Add label ${l}`, { type: 'edit', field: 'labels', operation: 'ADD', value: [l] }); }}>
            <input autoFocus aria-label="Label" placeholder="label" value={label} onChange={(e) => setLabel(e.target.value)} />
            <div className="row-actions">
              <button className="btn primary" disabled={!label.trim()}>Add</button>
              <button type="button" className="btn subtle" disabled={!label.trim()}
                onClick={() => { const l = label.trim().replace(/\s+/g, '-'); run(`Remove label ${l}`, { type: 'edit', field: 'labels', operation: 'REMOVE', value: [l] }); }}>Remove</button>
            </div>
          </form>
        ))}
        {oneProject && sprints.length > 0 && menu('sprint', 'Sprint', (
          <>
            {sprints.map((s) => <button key={s.id} className="menu-item" role="menuitem" onClick={() => run(`Move to ${s.name}`, { type: 'edit', field: 'sprint', value: s.id })}>{s.name}{s.state === 'active' ? ' (active)' : ''}</button>)}
            <button className="menu-item" role="menuitem" onClick={() => run('Move to backlog', { type: 'edit', field: 'sprint', value: null })}>Backlog</button>
          </>
        ))}
        <button className="btn subtle danger-text" disabled={busy} onClick={() => run('Delete', { type: 'delete' })}>Delete</button>
        {busy && <span className="muted small">Working…</span>}
      </div>
      {result && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setResult(null)}>
          <div className="modal narrow" role="dialog" aria-modal="true" aria-label="Bulk change result">
            <header className="modal-head"><h1>{result.title}</h1><button className="icon-btn" aria-label="Close" onClick={() => setResult(null)}>✕</button></header>
            <div className="modal-body">
              <p><strong>{result.r.succeeded}</strong> updated{result.r.failed ? <>, <strong className="danger-text">{result.r.failed}</strong> not changed</> : null}.</p>
              {result.r.failed > 0 && (
                <ul className="plain small">
                  {result.r.results.filter((x) => !x.ok).map((x) => <li key={x.key}><span className="key">{x.key}</span> — {x.error}</li>)}
                </ul>
              )}
            </div>
            <footer className="modal-foot"><span className="grow" /><button className="btn primary" onClick={() => { setResult(null); if (!result.r.failed) onClear(); }}>Done</button></footer>
          </div>
        </div>
      )}
    </>
  );
}

const COLS_KEY = 'tracker.searchColumns';
export function loadColumns(defaults: string[]): string[] {
  try { const v = JSON.parse(localStorage.getItem(COLS_KEY) ?? 'null'); return Array.isArray(v) && v.length ? v : defaults; } catch { return defaults; }
}
export function saveColumns(cols: string[]) {
  try { localStorage.setItem(COLS_KEY, JSON.stringify(cols)); } catch { /* private mode */ }
}
