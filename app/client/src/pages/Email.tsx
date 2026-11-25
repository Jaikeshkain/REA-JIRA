import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type EmailPref, type FilterSubscription, type OutboxEmail, type SavedFilter } from '../api';
import { useAuth } from '../auth';
import { PageHeader, useShell } from '../Layout';
import { timeAgo } from '../ui';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hour = (h: number) => `${String(h).padStart(2, '0')}:00 UTC`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

/** Account → Notification settings: how in-app notifications are also emailed. */
export function NotificationSettings() {
  const { toast } = useShell();
  const [p, setP] = useState<{ emailNotifications: EmailPref; emailMode: 'smtp' | 'outbox'; digestHourUtc: number } | null>(null);
  useEffect(() => { api.preferences().then(setP, (e) => toast(e.message)); }, [toast]);
  if (!p) return <div className="page"><p className="muted">Loading…</p></div>;
  const set = (v: EmailPref) => api.setPreferences(v).then((r) => { setP(r); toast('Notification settings saved'); }, (e) => toast(e.message));
  const options: [EmailPref, string, string][] = [
    ['immediate', 'Immediately', 'One email for each batch of updates, about a minute after they happen.'],
    ['digest', 'Daily digest', `One email a day at ${hour(p.digestHourUtc)} with everything you haven’t read yet.`],
    ['off', 'Off', 'Only the bell in the app. No emails.'],
  ];
  return (
    <div className="page narrow-page">
      <PageHeader title="Notification settings" />
      <section className="panel">
        <h2 className="section-title" style={{ marginTop: 0 }}>Email notifications</h2>
        <p className="muted small">You get notified when work is assigned to you, when you’re mentioned, and about comments and status changes on work you watch. Anything you’ve already read in the app is never emailed.</p>
        <div role="radiogroup" aria-label="Email notifications" className="radio-list">
          {options.map(([v, label, help]) => (
            <label key={v} className={`radio-card ${p.emailNotifications === v ? 'on' : ''}`}>
              <input type="radio" name="email-pref" value={v} checked={p.emailNotifications === v} onChange={() => set(v)} />
              <span><strong>{label}</strong><span className="muted small">{help}</span></span>
            </label>
          ))}
        </div>
        {p.emailMode === 'outbox' && (
          <p className="muted small">This site has no mail server configured, so emails are kept in the admin outbox instead of being sent.</p>
        )}
      </section>
      <section className="panel">
        <h2 className="section-title" style={{ marginTop: 0 }}>Filter subscriptions</h2>
        <p className="muted small">To get a filter’s results by email every day or week, open the filter from <Link to="/filters">Filters</Link> and choose <strong>Subscribe</strong>.</p>
      </section>
    </div>
  );
}

/** Saved filter → Subscribe: daily/weekly email of its results, run with your permissions. */
export function SubscribeDialog({ filter, onClose }: { filter: SavedFilter; onClose: () => void }) {
  const { toast } = useShell();
  const [subs, setSubs] = useState<FilterSubscription[] | null>(null);
  const [frequency, setFrequency] = useState<'daily' | 'weekly'>('daily');
  const [hourUtc, setHourUtc] = useState(8);
  const [weekday, setWeekday] = useState(1);
  const [emailWhenEmpty, setEmpty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.subscriptions(filter.id).then((s) => {
    setSubs(s);
    if (s[0]) { setFrequency(s[0].frequency); setHourUtc(s[0].hourUtc); setWeekday(s[0].weekday ?? 1); setEmpty(s[0].emailWhenEmpty); }
  }, (e) => setError(e.message));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [filter.id]);
  const existing = subs?.[0];
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const s = await api.subscribe(filter.id, { frequency, hourUtc, weekday: frequency === 'weekly' ? weekday : null, emailWhenEmpty });
      toast(`Subscribed. First email ${when(s.nextRun)}`);
      onClose();
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
  };
  const remove = async () => {
    if (!existing) return;
    await api.unsubscribe(existing.id).then(() => { toast('Unsubscribed'); onClose(); }, (e) => setError(e.message));
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal narrow" role="dialog" aria-modal="true" aria-label="Subscribe to filter" onSubmit={save}>
        <header className="modal-head"><h1>Subscribe to “{filter.name}”</h1><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button></header>
        <div className="modal-body">
          <p className="muted small">We’ll email you this filter’s results (up to 50 work items). It runs with your permissions, so you only see work you can access.</p>
          {subs === null ? <p className="muted">Loading…</p> : (
            <>
              {existing && <p className="small">You’re subscribed. Next email <strong>{when(existing.nextRun)}</strong>{existing.lastRun ? <>, last sent {timeAgo(existing.lastRun)}</> : null}.</p>}
              <div className="row2">
                <label>How often
                  <select value={frequency} onChange={(e) => setFrequency(e.target.value as 'daily' | 'weekly')}>
                    <option value="daily">Every day</option>
                    <option value="weekly">Every week</option>
                  </select>
                </label>
                {frequency === 'weekly' && (
                  <label>On
                    <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                      {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                    </select>
                  </label>
                )}
                <label>At
                  <select value={hourUtc} onChange={(e) => setHourUtc(Number(e.target.value))}>
                    {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hour(h)}</option>)}
                  </select>
                </label>
              </div>
              <label className="check"><input type="checkbox" checked={emailWhenEmpty} onChange={(e) => setEmpty(e.target.checked)} /> Email me even when nothing matches</label>
            </>
          )}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <footer className="modal-foot">
          {existing && <button type="button" className="btn subtle danger-text" onClick={remove}>Unsubscribe</button>}
          <span className="grow" />
          <button type="button" className="btn subtle" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={subs === null}>{existing ? 'Update' : 'Subscribe'}</button>
        </footer>
      </form>
    </div>
  );
}

/** Site admin → Outbox: every email the site queued, with a safe preview. */
export function Outbox() {
  const { user } = useAuth();
  const { toast } = useShell();
  const [data, setData] = useState<{ mode: 'smtp' | 'outbox'; emails: OutboxEmail[] } | null>(null);
  const [open, setOpen] = useState<OutboxEmail | null>(null);
  const [view, setView] = useState<'html' | 'text'>('html');
  const [busy, setBusy] = useState(false);
  const load = () => api.outbox().then(setData, (e) => toast(e.message));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (user?.isSiteAdmin) load(); }, [user?.isSiteAdmin]);
  if (!user?.isSiteAdmin) return <div className="page"><h1>Outbox</h1><p className="muted">Only site admins can see the email outbox.</p></div>;
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.runScheduler();
      toast('skipped' in r ? 'The scheduler is already running' : `Scheduler ran: ${r.notifications} notification email(s), ${r.subscriptions} subscription(s), ${r.rules.items} rule item(s), ${r.delivery.sent} delivered`);
      await load();
    } catch (e) { toast(e instanceof ApiError ? e.message : String(e)); }
    setBusy(false);
  };
  return (
    <div className="page">
      <PageHeader title="Email outbox" actions={<button className="btn" onClick={run} disabled={busy}>{busy ? 'Running…' : 'Run scheduler now'}</button>} />
      {data && (
        <p className="muted small">
          {data.mode === 'outbox'
            ? <>No mail server is configured (<code>SMTP_URL</code>), so emails are stored here and never sent.</>
            : <>Emails are delivered by SMTP. Failed sends retry with backoff, up to 5 attempts.</>}
          {' '}The scheduler runs every minute. Showing the latest 100.
        </p>
      )}
      {!data ? <p className="muted">Loading…</p> : data.emails.length === 0 ? <p className="muted">No emails yet.</p> : (
        <table className="table">
          <thead><tr><th>To</th><th>Subject</th><th>Kind</th><th>Status</th><th>Queued</th></tr></thead>
          <tbody>
            {data.emails.map((m) => (
              <tr key={m.id}>
                <td className="nowrap">{m.to}</td>
                <td><button className="link-btn" onClick={() => { setOpen(m); setView('html'); }}>{m.subject}</button></td>
                <td>{m.kind}</td>
                <td><span className={`lozenge ${m.status === 'failed' ? 'lozenge-failed' : m.status === 'queued' ? 'lozenge-in_progress' : 'lozenge-done'}`} title={m.error ?? undefined}>{m.status}</span>{m.attempts > 1 ? <span className="muted small"> ×{m.attempts}</span> : null}</td>
                <td className="nowrap muted small">{timeAgo(m.created)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(null)}>
          <div className="modal wide" role="dialog" aria-modal="true" aria-label="Email preview">
            <header className="modal-head"><h1>{open.subject}</h1><button className="icon-btn" aria-label="Close" onClick={() => setOpen(null)}>✕</button></header>
            <div className="modal-body">
              <p className="muted small">To {open.to} · {open.kind} · {open.status}{open.error ? ` · ${open.error}` : ''}</p>
              <div className="tabs" role="tablist">
                <button role="tab" aria-selected={view === 'html'} className={`tab ${view === 'html' ? 'on' : ''}`} onClick={() => setView('html')}>HTML</button>
                <button role="tab" aria-selected={view === 'text'} className={`tab ${view === 'text' ? 'on' : ''}`} onClick={() => setView('text')}>Plain text</button>
              </div>
              {/* sandbox="" : no scripts, no same-origin, no forms — the preview can't touch the app */}
              {view === 'html'
                ? <iframe title="Email HTML preview" className="mail-preview" sandbox="" srcDoc={open.html} />
                : <pre className="mail-text">{open.text}</pre>}
            </div>
            <footer className="modal-foot"><span className="grow" /><button className="btn" onClick={() => setOpen(null)}>Close</button></footer>
          </div>
        </div>
      )}
    </div>
  );
}
