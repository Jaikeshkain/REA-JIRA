import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type LicenseStatus } from '../api';
import { useAuth } from '../auth';
import { PageHeader, useShell } from '../Layout';
import { AdminTabs } from './Admin';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));
const LABEL: Record<LicenseStatus['state'], string> = {
  development: 'Development build', trial: 'Trial', valid: 'Licensed', expiring: 'Expiring soon', grace: 'Expired — grace period', 'read-only': 'Read-only',
};
const fmt = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '—');

/** Top-of-page notice for trial / expiring / grace / read-only. */
export function LicenseBanner() {
  const { user } = useAuth();
  const { version } = useShell();
  const [s, setS] = useState<LicenseStatus | null>(null);
  useEffect(() => { api.licenseStatus().then(setS, () => setS(null)); }, [version]);
  if (!s || s.state === 'valid' || s.state === 'development') return null;
  const tone = s.state === 'read-only' || s.state === 'grace' ? 'bad' : 'warn';
  return (
    <div className={`license-banner ${tone}`} role="status">
      {s.readOnly && <strong>Read-only. </strong>}{s.message.replace(/^Read-only: /, '')}
      {user?.isSiteAdmin ? <> <Link to="/admin/license">Manage licence</Link></> : s.readOnly ? ' Ask your site admin.' : ''}
    </div>
  );
}

/** Administration → Licence. */
export function LicensePage() {
  const { user } = useAuth();
  const { toast, bump } = useShell();
  const [s, setS] = useState<LicenseStatus | null>(null);
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (user?.isSiteAdmin) api.licenseStatus().then(setS, (e) => setError(errText(e))); }, [user?.isSiteAdmin]);
  if (!user?.isSiteAdmin) return <div className="page"><h1>Licence</h1><p className="muted">Only site admins can see this page.</p></div>;
  const install = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try { setS(await api.installLicense(key)); setKey(''); toast('Licence installed'); bump(); }
    catch (err) { setError(errText(err)); }
  };
  return (
    <div className="page">
      <PageHeader title="Administration" />
      <AdminTabs />
      {!s ? <p className="muted">Loading…</p> : (
        <div className="narrow-page">
          <section className="panel">
            <div className="section-row" style={{ marginTop: 0 }}>
              <h2 className="section-title" style={{ margin: 0 }}>Licence</h2>
              <span className={`lozenge ${s.readOnly ? 'lozenge-failed' : s.state === 'valid' ? 'lozenge-done' : 'lozenge-in_progress'}`}>{LABEL[s.state]}</span>
            </div>
            <p>{s.message}</p>
            <dl className="facts-list">
              <dt>Licensed to</dt><dd>{s.license?.customer ?? '—'}</dd>
              <dt>Users</dt><dd>{s.usedSeats} active{s.seats != null ? ` of ${s.seats}` : ''}</dd>
              <dt>Valid until</dt><dd>{fmt(s.license?.expires)}{s.daysLeft != null && s.state !== 'read-only' ? ` · ${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'} left` : ''}</dd>
              {s.usage && <><dt>Time used</dt><dd>{s.usage.usedDays} of {s.usage.allowedDays} days{s.license ? ' (including the grace period)' : ' of the trial'}</dd></>}
              <dt>Licence ID</dt><dd>{s.license?.id ?? '—'}</dd>
              <dt>Installation ID</dt>
              <dd><code>{s.installationId}</code> <button className="link-btn small" onClick={() => navigator.clipboard?.writeText(s.installationId ?? '').then(() => toast('Installation ID copied'))}>Copy</button></dd>
            </dl>
            {s.problem && <p className="error">The installed key can’t be used: {s.problem}.</p>}
          </section>
          <section className="panel">
            <h2 className="section-title" style={{ marginTop: 0 }}>Install a licence key</h2>
            <p className="muted small">Send your installation ID to your Tracker supplier to get a key, then paste it here. A renewed key replaces the current one straight away. When a licence runs out, Tracker keeps working for {14} days, then becomes read-only: nothing is deleted, and everyone can still sign in, view, search and export.</p>
            <form className="stack" onSubmit={install}>
              <textarea rows={4} value={key} onChange={(e) => setKey(e.target.value)} placeholder="TRK1.…" aria-label="Licence key" spellCheck={false} className="mono" required />
              {error && <p className="error" role="alert">{error}</p>}
              <div><button className="btn primary">Install key</button></div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
