import { useEffect, useState } from 'react';
import { api, ApiError, type Issue, type User, type Worklog } from './api';
import { Avatar, timeAgo } from './ui';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));
/** Local "YYYY-MM-DDTHH:mm" for <input type="datetime-local">. */
const localNow = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const toIso = (local: string) => new Date(local).toISOString();

/**
 * Sidebar block: one bar split into logged (filled) and remaining (light), the numbers in text, the original estimate
 * as an editable field, and "Log work". Over the estimate shows the overrun in text, not just colour.
 */
export function TimePanel({ issue, canEdit, canLog, onEdit, onLog }: {
  issue: Issue; canEdit: boolean; canLog: boolean;
  onEdit: (field: string, value: unknown) => void; onLog: () => void;
}) {
  const t = issue.fields.timetracking ?? {};
  const spent = t.timeSpentSeconds ?? 0, rem = t.remainingEstimateSeconds ?? 0, orig = t.originalEstimateSeconds ?? 0;
  const total = Math.max(spent + rem, orig, 1);
  const over = orig > 0 && spent + rem > orig;
  return (
    <div className="time-panel">
      <div className="time-bar" role="img" aria-label={`${t.timeSpent ?? 'No time'} logged, ${t.remainingEstimate ?? 'no estimate'} remaining`}>
        {spent > 0 && <span className="time-logged" style={{ flexGrow: spent }} />}
        {rem > 0 && <span className="time-left" style={{ flexGrow: rem }} />}
        {spent + rem < total && <span className="time-free" style={{ flexGrow: total - spent - rem }} />}
      </div>
      <div className="time-text small">
        <span><b>{t.timeSpent ?? '0m'}</b> logged</span>
        <span><b>{t.remainingEstimate ?? '—'}</b> remaining</span>
      </div>
      {over && <div className="small danger-text">⚠ {fmt(spent + rem - orig)} over the original estimate</div>}
      <div className="time-row">
        <label className="small">Original estimate
          <input key={t.originalEstimate ?? ''} defaultValue={t.originalEstimate ?? ''} placeholder="e.g. 2d 4h" disabled={!canEdit} aria-label="Original estimate"
            onBlur={(e) => { const v = e.target.value.trim(); if (v !== (t.originalEstimate ?? '')) onEdit('timeoriginalestimate', v || null); }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        </label>
        <label className="small">Remaining
          <input key={t.remainingEstimate ?? ''} defaultValue={t.remainingEstimate ?? ''} placeholder="e.g. 1d" disabled={!canEdit} aria-label="Remaining estimate"
            onBlur={(e) => { const v = e.target.value.trim(); if (v !== (t.remainingEstimate ?? '')) onEdit('timeestimate', v || null); }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        </label>
      </div>
      {canLog && <button className="btn subtle" onClick={onLog}>Log work</button>}
    </div>
  );
}

// same rules as the server: 1d = 8h, 1w = 5d
const fmt = (sec: number) => {
  let m = Math.round(sec / 60);
  const out: string[] = [];
  for (const [u, n] of [['w', 2400], ['d', 480], ['h', 60], ['m', 1]] as const) {
    const k = Math.floor(m / n);
    if (k) { out.push(`${k}${u}`); m -= k * n; }
  }
  return out.join(' ') || '0m';
};

export function LogWorkDialog({ issue, log, onClose, onSaved }: { issue: Issue; log?: Worklog; onClose: () => void; onSaved: () => void }) {
  const [spent, setSpent] = useState(log?.timeSpent ?? '');
  const [started, setStarted] = useState(() => {
    if (!log) return localNow();
    const d = new Date(log.started); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16);
  });
  const [mode, setMode] = useState<'auto' | 'leave' | 'new'>(log ? 'leave' : 'auto');
  const [newEstimate, setNewEstimate] = useState('');
  const [comment, setComment] = useState(log?.comment ?? '');
  const [error, setError] = useState<string | null>(null);
  const rem = issue.fields.timetracking?.remainingEstimate;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = { timeSpent: spent, started: toIso(started), comment, adjustEstimate: mode, ...(mode === 'new' ? { newEstimate } : {}) };
    try {
      if (log) await api.updateWorklog(issue.key, log.id, body); else await api.addWorklog(issue.key, body);
      onSaved();
    } catch (err) { setError(errText(err)); }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal narrow" role="dialog" aria-modal="true" aria-label={log ? 'Edit work log' : 'Log work'} onSubmit={save}>
        <header className="modal-head"><h1>{log ? 'Edit work log' : `Log work · ${issue.key}`}</h1><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button></header>
        <div className="modal-body">
          <div className="row2">
            <label>Time spent*<input value={spent} onChange={(e) => setSpent(e.target.value)} required placeholder="e.g. 2h 30m" autoFocus /></label>
            <label>Date started*<input type="datetime-local" value={started} onChange={(e) => setStarted(e.target.value)} required /></label>
          </div>
          <span className="muted small">Use w, d, h and m (1d = 8h, 1w = 5d).</span>
          <fieldset className="radio-group">
            <legend>Remaining estimate{rem ? ` (now ${rem})` : ''}</legend>
            <label className="check small-check"><input type="radio" name="adj" checked={mode === 'auto'} onChange={() => setMode('auto')} /> Reduce it by the time spent</label>
            <label className="check small-check"><input type="radio" name="adj" checked={mode === 'leave'} onChange={() => setMode('leave')} /> Leave it as it is</label>
            <label className="check small-check"><input type="radio" name="adj" checked={mode === 'new'} onChange={() => setMode('new')} /> Set it to
              <input className="inline-small" value={newEstimate} onChange={(e) => { setNewEstimate(e.target.value); setMode('new'); }} placeholder="e.g. 1d" aria-label="New remaining estimate" />
            </label>
          </fieldset>
          <label>What did you work on?<textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={5000} /></label>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <footer className="modal-foot"><span className="grow" /><button type="button" className="btn subtle" onClick={onClose}>Cancel</button><button className="btn primary">{log ? 'Save' : 'Log'}</button></footer>
      </form>
    </div>
  );
}

/** Activity → Work log tab. */
export function WorkLogList({ issue, me, perms, onChanged, onError }: {
  issue: Issue; me: User | null; perms: Record<string, boolean>; onChanged: () => void; onError: (m: string) => void;
}) {
  const [logs, setLogs] = useState<Worklog[] | null>(null);
  const [editing, setEditing] = useState<Worklog | null>(null);
  const load = () => api.worklogs(issue.key).then((r) => setLogs(r.worklogs.slice().reverse()), (e) => onError(errText(e)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [issue.key, issue.fields.timespent]);
  if (!logs) return <p className="muted">Loading…</p>;
  if (!logs.length) return <p className="muted">No work logged yet.</p>;
  const mine = (w: Worklog) => w.author?.accountId === me?.accountId;
  return (
    <>
      <ul className="history">
        {logs.map((w) => (
          <li key={w.id}>
            <Avatar user={w.author} size={22} />
            <div className="grow">
              <strong>{w.author?.displayName}</strong> logged <strong>{w.timeSpent}</strong>
              <span className="muted small"> · {new Date(w.started).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · logged {timeAgo(w.created)}</span>
              {w.comment && <div className="small">{w.comment}</div>}
            </div>
            <span className="nowrap">
              {(mine(w) ? perms.EDIT_OWN_WORKLOGS : perms.EDIT_ALL_WORKLOGS) && <button className="link-btn small" onClick={() => setEditing(w)}>Edit</button>}{' '}
              {(mine(w) ? perms.DELETE_OWN_WORKLOGS : perms.DELETE_ALL_WORKLOGS) && (
                <button className="link-btn small danger-text" onClick={() => confirm(`Delete this ${w.timeSpent} log? Its time goes back to the remaining estimate.`) &&
                  api.deleteWorklog(issue.key, w.id).then(() => { load(); onChanged(); }, (e) => onError(errText(e)))}>Delete</button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {editing && <LogWorkDialog issue={issue} log={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); onChanged(); }} />}
    </>
  );
}

/** History shows Jira's internal field names; give the time ones readable labels. */
export const FIELD_LABEL: Record<string, string> = {
  timeoriginalestimate: 'Original estimate', timeestimate: 'Remaining estimate', timespent: 'Time spent',
};
