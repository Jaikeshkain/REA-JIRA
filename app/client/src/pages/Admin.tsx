import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api, ApiError, type ApiToken, type AuditEntry, type Webhook, type WebhookDelivery, type WebhookEventName } from '../api';
import { useAuth } from '../auth';
import { PageHeader, useShell } from '../Layout';
import { timeAgo } from '../ui';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

/** Tabs shared by the site-admin pages. */
export function AdminTabs() {
  return (
    <nav className="tabs" aria-label="Administration">
      <NavLink to="/admin/users">Users</NavLink>
      <NavLink to="/admin/groups">Groups</NavLink>
      <NavLink to="/admin/audit">Audit log</NavLink>
      <NavLink to="/admin/webhooks">Webhooks</NavLink>
      <NavLink to="/admin/outbox">Email outbox</NavLink>
      <NavLink to="/admin/settings">Settings</NavLink>
    </nav>
  );
}
const AdminOnly = ({ title }: { title: string }) => <div className="page"><h1>{title}</h1><p className="muted">Only site admins can see this page.</p></div>;

/** One-time secret display with a copy button. */
function Secret({ label, value, onDone }: { label: string; value: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="secret-box" role="status">
      <strong>{label}</strong>
      <p className="small">Copy it now. For your security it won’t be shown again.</p>
      <div className="secret-row">
        <code className="secret-value">{value}</code>
        <button className="btn" onClick={() => navigator.clipboard?.writeText(value).then(() => setCopied(true), () => setCopied(false))}>{copied ? 'Copied ✓' : 'Copy'}</button>
      </div>
      <button className="link-btn" onClick={onDone}>I’ve saved it</button>
    </div>
  );
}

// ------------------------------------------------------------------ API tokens (every user)

export function ApiTokens() {
  const { toast } = useShell();
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [name, setName] = useState('');
  const [days, setDays] = useState<'30' | '90' | '365' | 'never'>('90');
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.tokens().then(setTokens, (e) => toast(errText(e)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const t = await api.createToken(name.trim(), days === 'never' ? null : (Number(days) as 30 | 90 | 365));
      setFresh(t.token);
      setName('');
      load();
    } catch (err) { setError(errText(err)); }
  };
  const revoke = (t: ApiToken) => confirm(`Revoke "${t.name}"? Anything using it stops working immediately.`) &&
    api.revokeToken(t.id).then(() => { toast('Token revoked'); load(); }, (e) => toast(errText(e)));
  const origin = window.location.origin;
  return (
    <div className="page narrow-page">
      <PageHeader title="API tokens" />
      <p className="muted small">Scripts and other tools can use the REST API as you with a token. It can do exactly what you can do, so keep it secret.</p>
      {fresh && <Secret label="Your new API token" value={fresh} onDone={() => setFresh(null)} />}
      <section className="panel">
        <h2 className="section-title" style={{ marginTop: 0 }}>Create a token</h2>
        <form className="row-form" onSubmit={create}>
          <label className="grow">Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Release script" required maxLength={80} /></label>
          <label>Expires
            <select value={days} onChange={(e) => setDays(e.target.value as typeof days)}>
              <option value="30">in 30 days</option><option value="90">in 90 days</option><option value="365">in 1 year</option><option value="never">never</option>
            </select>
          </label>
          <button className="btn primary">Create</button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
      </section>
      <section className="panel">
        <h2 className="section-title" style={{ marginTop: 0 }}>Your tokens</h2>
        {!tokens ? <p className="muted">Loading…</p> : tokens.length === 0 ? <p className="muted">No tokens yet.</p> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Name</th><th>Token</th><th>Last used</th><th>Expires</th><th /></tr></thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td><code>{t.hint}</code></td>
                  <td className="muted small">{t.lastUsed ? timeAgo(t.lastUsed) : 'Never'}</td>
                  <td className="muted small">{t.expires ? when(t.expires) : 'Never'}</td>
                  <td><button className="link-btn danger-text" onClick={() => revoke(t)}>Revoke</button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
      <section className="panel">
        <h2 className="section-title" style={{ marginTop: 0 }}>Using a token</h2>
        <pre className="mail-text">{`curl -H "Authorization: Bearer <token>" ${origin}/api/myself\n\n# Jira-style: email + token\ncurl -u you@example.com:<token> "${origin}/api/search/jql?jql=assignee=currentUser()"`}</pre>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ webhooks (site admins)

const EVENT_LABEL: Record<WebhookEventName, string> = {
  issue_created: 'Work item created', issue_updated: 'Work item updated', issue_deleted: 'Work item deleted', comment_created: 'Comment added',
};

export function Webhooks() {
  const { user } = useAuth();
  const { toast } = useShell();
  const [data, setData] = useState<{ events: WebhookEventName[]; webhooks: Webhook[] } | null>(null);
  const [editing, setEditing] = useState<Webhook | 'new' | null>(null);
  const [log, setLog] = useState<Webhook | null>(null);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const load = () => api.webhooks().then(setData, (e) => toast(errText(e)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (user?.isSiteAdmin) load(); }, [user?.isSiteAdmin]);
  if (!user?.isSiteAdmin) return <AdminOnly title="Webhooks" />;
  const test = (w: Webhook) => api.testWebhook(w.id).then(
    (r) => { toast(r.ok ? `Test sent: receiver answered ${r.responseStatus}` : `Test failed: ${r.error ?? r.status}`); load(); },
    (e) => toast(errText(e)),
  );
  return (
    <div className="page">
      <PageHeader title="Administration" actions={<button className="btn primary" onClick={() => setEditing('new')}>+ Create webhook</button>} />
      <AdminTabs />
      <p className="muted small">Tracker sends a signed JSON <code>POST</code> to your URL when something happens. Verify the <code>X-Tracker-Signature</code> header (<code>t=…,v1=</code> HMAC-SHA256 of <code>{'"<t>.<body>"'}</code> with the webhook’s secret). Failed deliveries are retried for about an hour.</p>
      {secret && <Secret label={`Signing secret for “${secret.name}”`} value={secret.value} onDone={() => setSecret(null)} />}
      {!data ? <p className="muted">Loading…</p> : data.webhooks.length === 0 ? <p className="muted">No webhooks yet.</p> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Name</th><th>URL</th><th>Events</th><th>Space</th><th>Deliveries</th><th>Status</th><th /></tr></thead>
          <tbody>
            {data.webhooks.map((w) => (
              <tr key={w.id}>
                <td>{w.name}</td>
                <td className="url-cell" title={w.url}><code>{w.url}</code></td>
                <td className="small">{w.events.map((e) => EVENT_LABEL[e]).join(', ')}</td>
                <td>{w.project?.key ?? 'All'}</td>
                <td className="small nowrap">
                  {w.stats?.success ?? 0} ok{w.stats?.failed ? <span className="danger-text"> · {w.stats.failed} failed</span> : null}{w.stats?.pending ? ` · ${w.stats.pending} pending` : ''}
                </td>
                <td><span className={`lozenge ${w.enabled ? 'lozenge-done' : 'lozenge-todo'}`}>{w.enabled ? 'On' : 'Off'}</span></td>
                <td className="nowrap">
                  <button className="link-btn" onClick={() => test(w)}>Send test</button>{' '}
                  <button className="link-btn" onClick={() => setLog(w)}>Deliveries</button>{' '}
                  <button className="link-btn" onClick={() => setEditing(w)}>Edit</button>{' '}
                  <button className="link-btn danger-text" onClick={() => confirm(`Delete webhook "${w.name}"?`) && api.deleteWebhook(w.id).then(load, (e) => toast(errText(e)))}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {editing && data && (
        <WebhookDialog hook={editing === 'new' ? null : editing} events={data.events} onClose={() => setEditing(null)}
          onSaved={(s) => { setEditing(null); if (s) setSecret(s); load(); }} />
      )}
      {log && <DeliveriesDialog hook={log} onClose={() => setLog(null)} />}
    </div>
  );
}

function WebhookDialog({ hook, events, onClose, onSaved }: { hook: Webhook | null; events: WebhookEventName[]; onClose: () => void; onSaved: (secret?: { name: string; value: string }) => void }) {
  const [name, setName] = useState(hook?.name ?? '');
  const [url, setUrl] = useState(hook?.url ?? '');
  const [chosen, setChosen] = useState<WebhookEventName[]>(hook?.events ?? ['issue_created', 'issue_updated']);
  const [space, setSpace] = useState(hook?.project?.key ?? '');
  const [enabled, setEnabled] = useState(hook?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = { name, url, events: chosen, projectKey: space.trim() || null, enabled };
    try {
      if (hook) { await api.updateWebhook(hook.id, body); onSaved(); }
      else { const w = await api.createWebhook(body); onSaved({ name: w.name, value: w.secret }); }
    } catch (err) { setError(errText(err)); }
  };
  const rotate = async () => {
    if (!hook || !confirm('Create a new signing secret? The old one stops working immediately.')) return;
    try { const r = await api.rotateWebhookSecret(hook.id); onSaved({ name: hook.name, value: r.secret }); } catch (err) { setError(errText(err)); }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" role="dialog" aria-modal="true" aria-label={hook ? 'Edit webhook' : 'Create webhook'} onSubmit={save}>
        <header className="modal-head"><h1>{hook ? 'Edit webhook' : 'Create webhook'}</h1><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button></header>
        <div className="modal-body">
          <label>Name*<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoFocus /></label>
          <label>URL*<input type="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://example.com/hooks/tracker" /></label>
          <fieldset className="radio-group">
            <legend>Events*</legend>
            {events.map((ev) => (
              <label key={ev} className="check small-check">
                <input type="checkbox" checked={chosen.includes(ev)} onChange={(e) => setChosen(e.target.checked ? [...chosen, ev] : chosen.filter((x) => x !== ev))} />
                {EVENT_LABEL[ev]} <code className="muted small">{ev}</code>
              </label>
            ))}
          </fieldset>
          <label>Only for space (key)<input value={space} onChange={(e) => setSpace(e.target.value.toUpperCase())} placeholder="All spaces" maxLength={20} /></label>
          <label className="check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> On</label>
          {hook && <p className="small">Signing secret <code>{hook.secretHint}</code> · <button type="button" className="link-btn" onClick={rotate}>Create a new secret</button></p>}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <footer className="modal-foot"><span className="grow" />
          <button type="button" className="btn subtle" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!chosen.length}>{hook ? 'Save' : 'Create'}</button>
        </footer>
      </form>
    </div>
  );
}

function DeliveriesDialog({ hook, onClose }: { hook: Webhook; onClose: () => void }) {
  const [rows, setRows] = useState<WebhookDelivery[] | null>(null);
  useEffect(() => { api.webhookDeliveries(hook.id).then(setRows, () => setRows([])); }, [hook.id]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-label="Webhook deliveries">
        <header className="modal-head"><h1>Deliveries · {hook.name}</h1><button className="icon-btn" aria-label="Close" onClick={onClose}>✕</button></header>
        <div className="modal-body">
          {!rows ? <p className="muted">Loading…</p> : rows.length === 0 ? <p className="muted">Nothing sent yet.</p> : (
            <table className="table compact">
              <thead><tr><th>When</th><th>Event</th><th>Work item</th><th>Result</th><th>Attempts</th></tr></thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td className="nowrap small">{timeAgo(d.created)}</td>
                    <td><code>{d.event}</code></td>
                    <td>{d.issueKey ?? '—'}</td>
                    <td className="small">
                      <span className={`lozenge ${d.status === 'success' ? 'lozenge-done' : d.status === 'failed' ? 'lozenge-failed' : 'lozenge-in_progress'}`}>{d.status}</span>
                      {d.responseStatus ? ` HTTP ${d.responseStatus}` : ''}{d.error && d.status !== 'success' ? ` · ${d.error}` : ''}
                      {d.nextTry ? <span className="muted"> · retry {timeAgo(d.nextTry).replace(' ago', '')}</span> : null}
                    </td>
                    <td>{d.attempts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <footer className="modal-foot"><span className="grow" /><button className="btn" onClick={onClose}>Close</button></footer>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ audit log (site admins)

const CATEGORIES = ['spaces', 'permissions', 'workflow', 'fields', 'automation', 'webhooks', 'security', 'sign-in', 'admin'];

export function AuditLog() {
  const { user } = useAuth();
  const { toast } = useShell();
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ total: number; values: AuditEntry[] } | null>(null);
  useEffect(() => {
    if (!user?.isSiteAdmin) return;
    api.audit({ category: category || undefined, startAt: page * 50 }).then(setData, (e) => toast(errText(e)));
  }, [user?.isSiteAdmin, category, page, toast]);
  if (!user?.isSiteAdmin) return <AdminOnly title="Audit log" />;
  return (
    <div className="page">
      <PageHeader title="Administration" />
      <AdminTabs />
      <div className="toolbar">
        <label className="inline-label">Category
          <select value={category} onChange={(e) => { setCategory(e.target.value); setPage(0); }}>
            <option value="">All</option>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <span className="grow" />
        <span className="muted small">Who changed configuration and security settings, and when. Work item changes are in each item’s History.</span>
      </div>
      {!data ? <p className="muted">Loading…</p> : data.values.length === 0 ? <p className="muted">Nothing recorded yet.</p> : (
        <>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>When</th><th>Who</th><th>Category</th><th>What</th><th>Target</th><th>IP</th></tr></thead>
            <tbody>
              {data.values.map((a) => (
                <tr key={a.id}>
                  <td className="nowrap small" title={new Date(a.created).toLocaleString()}>{timeAgo(a.created)}</td>
                  <td>{a.actor?.displayName ?? '—'}</td>
                  <td><span className="chip-sm">{a.category}</span></td>
                  <td>{a.action}</td>
                  <td className="small">{a.target ?? ''}</td>
                  <td className="muted small">{a.ip ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <div className="pager">
            <button className="btn subtle" disabled={page === 0} onClick={() => setPage(page - 1)}>← Newer</button>
            <span className="muted small">{page * 50 + 1}–{Math.min((page + 1) * 50, data.total)} of {data.total}</span>
            <button className="btn subtle" disabled={(page + 1) * 50 >= data.total} onClick={() => setPage(page + 1)}>Older →</button>
          </div>
        </>
      )}
    </div>
  );
}
