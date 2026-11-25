import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, type BacklogData, type Issue, type Sprint } from '../api';
import { useShell } from '../Layout';
import { Avatar, Popover, StatusLozenge, TypeIcon } from '../ui';
import { useProject } from './ProjectPages';

const BACKLOG = 'backlog';
const day = 86400_000;
const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
export const fmtShort = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');

export function daysLeft(s: Sprint) {
  if (!s.endDate) return null;
  return Math.ceil((new Date(s.endDate).getTime() - Date.now()) / day);
}

/** Jira backlog: open sprints (active first), then the backlog; drag work between them to plan. */
export function Backlog() {
  const project = useProject();
  const { version, bump, toast } = useShell();
  const nav = useNavigate();
  const [data, setData] = useState<BacklogData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ box: string; index: number } | null>(null);
  const [dialog, setDialog] = useState<{ kind: 'start' | 'complete' | 'edit'; sprint: Sprint; count: number; open: number } | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const canPlan = project.myPermissions.includes('SCHEDULE_ISSUES');
  const canManage = project.myPermissions.includes('MANAGE_SPRINTS');
  const isAdmin = project.myPermissions.includes('ADMINISTER_PROJECTS');

  const load = () => api.backlog(project.key).then(setData, (e) => setError(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [project.key, version]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast(ok);
      bump();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      load();
    }
  };

  if (!data) return <p className="muted">{error ?? 'Loading…'}</p>;

  if (!data.sprintsEnabled) {
    return (
      <div className="panel empty-state">
        <h2>Plan work in sprints</h2>
        <p className="muted">Sprints let your team commit to a set of work for a fixed time, then review what got done. The board will show only the active sprint.</p>
        {isAdmin
          ? <button className="btn primary" onClick={() => run(() => api.setFeatures(project.key, true), 'Sprints turned on')}>Turn on sprints</button>
          : <p className="muted small">Ask a space admin to turn on Sprints in Settings.</p>}
      </div>
    );
  }

  const boxes: { id: string; sprint: Sprint | null; issues: Issue[] }[] = [
    ...data.sprints.map((s) => ({ id: s.sprint.id, sprint: s.sprint, issues: s.issues })),
    { id: BACKLOG, sprint: null, issues: data.backlog.issues },
  ];
  const hasActive = data.sprints.some((s) => s.sprint.state === 'active');

  const onDrop = (boxId: string, index: number) => {
    if (!drag) return;
    const from = boxes.find((b) => b.issues.some((i) => i.key === drag))!;
    const to = boxes.find((b) => b.id === boxId)!;
    const origIdx = to.issues.findIndex((i) => i.key === drag);
    const at = origIdx >= 0 && origIdx < index ? index - 1 : index;
    if (from.id === to.id && origIdx === at) return;
    const without = to.issues.filter((i) => i.key !== drag);
    const prev = without[at - 1]?.key ?? null;
    const next = without[at]?.key ?? null;
    // optimistic
    const issue = from.issues.find((i) => i.key === drag)!;
    const move = (list: Issue[], id: string) => {
      const l = list.filter((i) => i.key !== drag);
      if (id === boxId) l.splice(at, 0, issue);
      return l;
    };
    setData({
      ...data,
      sprints: data.sprints.map((s) => ({ ...s, issues: move(s.issues, s.sprint.id) })),
      backlog: { ...data.backlog, issues: move(data.backlog.issues, BACKLOG) },
    });
    const body = { prevKey: prev, nextKey: next, ...(from.id !== to.id ? { sprintId: to.id === BACKLOG ? null : to.id } : {}) };
    run(() => api.rank(drag, body));
  };

  return (
    <div className="backlog">
      {error && <p className="error" role="alert" onClick={() => setError(null)}>{error} (dismiss)</p>}
      {boxes.map((box) => {
        const s = box.sprint;
        const meta = s ? data.sprints.find((x) => x.sprint.id === s.id)! : null;
        const open = box.issues.filter((i) => i.fields.status.statusCategory.key !== 'done').length;
        const isCollapsed = collapsed.has(box.id);
        const toggle = () => setCollapsed((c) => { const n = new Set(c); n.has(box.id) ? n.delete(box.id) : n.add(box.id); return n; });
        const left = s ? daysLeft(s) : null;
        return (
          <section key={box.id} className={`sprint-box ${s?.state === 'active' ? 'active' : ''} ${dropAt?.box === box.id ? 'drop' : ''}`}
            aria-label={s ? s.name : 'Backlog'}
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-row]')];
              const idx = rows.findIndex((r) => e.clientY < r.getBoundingClientRect().top + r.offsetHeight / 2);
              setDropAt({ box: box.id, index: idx === -1 ? rows.length : idx });
            }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropAt(null); }}
            onDrop={(e) => { e.preventDefault(); if (dropAt) onDrop(box.id, dropAt.index); setDropAt(null); setDrag(null); }}>
            <header className="sprint-head">
              <button className="icon-btn tiny" onClick={toggle} aria-expanded={!isCollapsed} aria-label={isCollapsed ? 'Expand' : 'Collapse'}>{isCollapsed ? '▸' : '▾'}</button>
              <strong>{s ? s.name : 'Backlog'}</strong>
              {s?.startDate && <span className="muted small">{fmtShort(s.startDate)} – {fmtShort(s.endDate)}</span>}
              {s?.state === 'active' && left != null && <span className={`chip-sm ${left < 0 ? 'late' : ''}`}>{left < 0 ? `${-left}d overdue` : `${left}d left`}</span>}
              <span className="muted small">({box.issues.length} work item{box.issues.length === 1 ? '' : 's'})</span>
              <span className="grow" />
              {meta && (
                <span className="pts" title="Story points: to do / in progress / done">
                  <span className="pt todo">{meta.points.todo}</span>
                  <span className="pt prog">{meta.points.total - meta.points.todo - meta.points.done}</span>
                  <span className="pt done">{meta.points.done}</span>
                </span>
              )}
              {!s && <span className="muted small">{data.backlog.points} pts</span>}
              {s && canManage && s.state === 'active' && (
                <>
                  <Link className="btn subtle" to={`../reports/${s.id}`}>Burndown</Link>
                  <button className="btn" onClick={() => setDialog({ kind: 'complete', sprint: s, count: box.issues.length, open })}>Complete sprint</button>
                </>
              )}
              {s && canManage && s.state === 'future' && (
                <button className="btn" disabled={hasActive || box.issues.length === 0}
                  title={hasActive ? 'Complete the active sprint first' : box.issues.length === 0 ? 'Add work to start this sprint' : ''}
                  onClick={() => setDialog({ kind: 'start', sprint: s, count: box.issues.length, open })}>Start sprint</button>
              )}
              {!s && canManage && <button className="btn" onClick={() => run(() => api.createSprint(project.key), 'Sprint created')}>Create sprint</button>}
              {s && canManage && (
                <span className="menu-anchor">
                  <button className="icon-btn" aria-label={`More actions for ${s.name}`} onClick={() => setMenu(menu === s.id ? null : s.id)}>⋯</button>
                  <Popover open={menu === s.id} onClose={() => setMenu(null)} align="right">
                    <button className="menu-item" onClick={() => { setMenu(null); setDialog({ kind: 'edit', sprint: s, count: 0, open: 0 }); }}>Edit sprint</button>
                    {s.state === 'future' && (
                      <button className="menu-item danger" onClick={() => {
                        setMenu(null);
                        if (confirm(`Delete ${s.name}? Its ${box.issues.length} work item(s) move to the backlog.`)) run(() => api.deleteSprint(s.id), 'Sprint deleted');
                      }}>Delete sprint</button>
                    )}
                  </Popover>
                </span>
              )}
            </header>
            {s?.goal && !isCollapsed && <p className="sprint-goal">{s.goal}</p>}
            {!isCollapsed && (
              <div className="rows">
                {box.issues.length === 0 && (
                  <div className="drop-hint">{s ? 'Plan a sprint by dragging work items into it.' : 'Your backlog is empty.'}</div>
                )}
                {box.issues.map((i, idx) => (
                  <div key={i.key}>
                    {dropAt?.box === box.id && dropAt.index === idx && <div className="drop-line" />}
                    <div data-row className={`bl-row ${drag === i.key ? 'dragging' : ''}`} draggable={canPlan}
                      onDragStart={(e) => { setDrag(i.key); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', i.key); }}
                      onDragEnd={() => { setDrag(null); setDropAt(null); }}
                      onClick={() => nav(`/browse/${i.key}`)} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/browse/${i.key}`)}>
                      <TypeIcon type={i.fields.issuetype} />
                      <span className="key">{i.key}</span>
                      <span className="grow bl-summary">{i.fields.summary}</span>
                      {i.fields.parent && <span className="epic-tag">{i.fields.parent.summary}</span>}
                      <StatusLozenge status={i.fields.status} />
                      <span className="pt-badge" title="Story points">{i.fields.storypoints ?? '–'}</span>
                      <Avatar user={i.fields.assignee} size={22} />
                    </div>
                  </div>
                ))}
                {dropAt?.box === box.id && dropAt.index === box.issues.length && <div className="drop-line" />}
              </div>
            )}
            {!isCollapsed && project.myPermissions.includes('CREATE_ISSUES') && (
              <QuickCreate projectKey={project.key} sprintId={s?.id} onCreated={(k) => { toast(`Created ${k}`); bump(); }} />
            )}
          </section>
        );
      })}
      {dialog?.kind === 'start' && (
        <StartDialog sprint={dialog.sprint} count={dialog.count} onClose={() => setDialog(null)}
          onStart={(body) => run(async () => { await api.startSprint(dialog.sprint.id, body); setDialog(null); nav(`/projects/${project.key}/board`); }, `${body.name ?? dialog.sprint.name} started`)} />
      )}
      {dialog?.kind === 'edit' && (
        <EditDialog sprint={dialog.sprint} onClose={() => setDialog(null)}
          onSave={(body) => run(async () => { await api.updateSprint(dialog.sprint.id, body); setDialog(null); }, 'Sprint updated')} />
      )}
      {dialog?.kind === 'complete' && (
        <CompleteDialog sprint={dialog.sprint} total={dialog.count} open={dialog.open}
          futures={data.sprints.filter((x) => x.sprint.state === 'future').map((x) => x.sprint)}
          onClose={() => setDialog(null)}
          onComplete={(moveTo) => run(async () => {
            const r = await api.completeSprint(dialog.sprint.id, moveTo);
            setDialog(null);
            toast(`${r.sprint.name} completed: ${r.completed.length} done, ${r.movedOpen.length} moved to ${r.movedTo?.name ?? 'backlog'}`);
            nav(`/projects/${project.key}/reports/${r.sprint.id}`);
          })} />
      )}
    </div>
  );
}

function QuickCreate({ projectKey, sprintId, onCreated }: { projectKey: string; sprintId?: string; onCreated: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (!open) return <button className="add-card" onClick={() => setOpen(true)}>+ Create</button>;
  return (
    <form className="quick-create" onSubmit={async (e) => {
      e.preventDefault();
      if (!summary.trim()) return;
      try {
        const r = await api.createIssue({ project: { key: projectKey }, issuetype: { name: 'Task' }, summary, ...(sprintId ? { sprint: { id: sprintId } } : {}) });
        setSummary('');
        onCreated(r.key);
      } catch (ex) { setErr(ex instanceof ApiError ? ex.message : String(ex)); }
    }}>
      <input autoFocus value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What needs to be done?" aria-label="New task summary"
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)} />
      <button className="btn primary">Create</button>
      <button type="button" className="btn subtle" onClick={() => setOpen(false)}>Cancel</button>
      {err && <span className="error">{err}</span>}
    </form>
  );
}

function Dialog({ title, children, onClose, onSubmit, submit, danger }: {
  title: string; children: React.ReactNode; onClose: () => void; onSubmit: () => void; submit: string; danger?: boolean;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal narrow" role="dialog" aria-modal="true" aria-label={title} onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
        <header className="modal-head"><h1>{title}</h1><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button></header>
        <div className="modal-body">{children}</div>
        <footer className="modal-foot"><span className="grow" />
          <button type="button" className="btn subtle" onClick={onClose}>Cancel</button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`}>{submit}</button>
        </footer>
      </form>
    </div>
  );
}

function StartDialog({ sprint, count, onClose, onStart }: {
  sprint: Sprint; count: number; onClose: () => void;
  onStart: (b: { name?: string; goal?: string; startDate: string; endDate: string }) => void;
}) {
  const [name, setName] = useState(sprint.name);
  const [goal, setGoal] = useState(sprint.goal);
  const [weeks, setWeeks] = useState('2');
  const [start, setStart] = useState(toLocalInput(sprint.startDate ? new Date(sprint.startDate) : new Date()));
  const [end, setEnd] = useState(toLocalInput(sprint.endDate ? new Date(sprint.endDate) : new Date(Date.now() + 14 * day)));
  useEffect(() => {
    if (weeks !== 'custom') setEnd(toLocalInput(new Date(new Date(start).getTime() + Number(weeks) * 7 * day)));
  }, [weeks, start]);
  return (
    <Dialog title="Start sprint" submit="Start" onClose={onClose}
      onSubmit={() => onStart({ name, goal, startDate: new Date(start).toISOString(), endDate: new Date(end).toISOString() })}>
      <p className="muted">{count} work item{count === 1 ? '' : 's'} will be included in this sprint.</p>
      <label>Sprint name*<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
      <label>Duration*
        <select value={weeks} onChange={(e) => setWeeks(e.target.value)}>
          {['1', '2', '3', '4'].map((w) => <option key={w} value={w}>{w} week{w === '1' ? '' : 's'}</option>)}
          <option value="custom">Custom</option>
        </select>
      </label>
      <div className="row2">
        <label>Start date*<input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} required /></label>
        <label>End date*<input type="datetime-local" value={end} onChange={(e) => { setWeeks('custom'); setEnd(e.target.value); }} required min={start} /></label>
      </div>
      <label>Sprint goal<textarea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} /></label>
    </Dialog>
  );
}

function EditDialog({ sprint, onClose, onSave }: { sprint: Sprint; onClose: () => void; onSave: (b: { name: string; goal: string; startDate?: string; endDate?: string }) => void }) {
  const [name, setName] = useState(sprint.name);
  const [goal, setGoal] = useState(sprint.goal);
  const [start, setStart] = useState(sprint.startDate ? toLocalInput(new Date(sprint.startDate)) : '');
  const [end, setEnd] = useState(sprint.endDate ? toLocalInput(new Date(sprint.endDate)) : '');
  return (
    <Dialog title="Edit sprint" submit="Update" onClose={onClose}
      onSubmit={() => onSave({ name, goal, ...(start ? { startDate: new Date(start).toISOString() } : {}), ...(end ? { endDate: new Date(end).toISOString() } : {}) })}>
      <label>Sprint name*<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
      <div className="row2">
        <label>Start date<input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label>End date<input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} min={start} /></label>
      </div>
      <label>Sprint goal<textarea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} /></label>
    </Dialog>
  );
}

function CompleteDialog({ sprint, total, open, futures, onClose, onComplete }: {
  sprint: Sprint; total: number; open: number; futures: Sprint[]; onClose: () => void; onComplete: (moveTo: string) => void;
}) {
  const [moveTo, setMoveTo] = useState(futures[0]?.id ?? 'backlog');
  return (
    <Dialog title={`Complete ${sprint.name}`} submit="Complete sprint" onClose={onClose} onSubmit={() => onComplete(moveTo)}>
      <p>This sprint contains <strong>{total - open} completed</strong> and <strong>{open} open</strong> work item{open === 1 ? '' : 's'}.</p>
      <ul className="muted small">
        <li>Completed work stays in this sprint's history.</li>
        <li>Open work moves to the place you choose below.</li>
      </ul>
      {open > 0 && (
        <label>Move open work items to
          <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
            {futures.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            <option value="new">New sprint</option>
            <option value="backlog">Backlog</option>
          </select>
        </label>
      )}
    </Dialog>
  );
}
