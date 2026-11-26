import { useEffect, useState } from 'react';
import { api, ApiError, session } from '../api';
import { PageHeader, useShell } from '../Layout';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));
/** One-time links carry the token in the URL fragment (#token=…): read it, then drop it from the address bar. */
const takeToken = () => {
  const t = new URLSearchParams(window.location.hash.slice(1)).get('token');
  if (t) history.replaceState(null, '', window.location.pathname);
  return t;
};

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="brand big"><span className="logo">◆</span> Tracker</div>
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}

/** /reset#token=… — choose a new password (signs you in). */
export function ResetPassword() {
  const [token] = useState(takeToken);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(token ? null : 'This link is incomplete. Ask for a new one from the login page.');
  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw !== pw2) { setError('The passwords don’t match'); return; }
    try { const r = await api.resetPassword(token!, pw); session.set(r.token); window.location.replace('/'); }
    catch (err) { setError(errText(err)); }
  };
  return (
    <Card title="Choose a new password">
      <form className="stack" onSubmit={go}>
        <label>New password<input type="password" value={pw} onChange={(e) => setPw(e.target.value)} minLength={8} required autoComplete="new-password" autoFocus /></label>
        <label>Repeat it<input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} minLength={8} required autoComplete="new-password" /></label>
        <p className="muted small">At least 8 characters. You’ll be signed out on your other devices.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary block" disabled={!token}>Save and sign in</button>
        <a className="link-btn" href="/">Back to log in</a>
      </form>
    </Card>
  );
}

/** /invite#token=… — accept an invitation. */
export function AcceptInvite() {
  const [token] = useState(takeToken);
  const [info, setInfo] = useState<{ email: string; displayName: string } | null>(null);
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(token ? null : 'This invitation link is incomplete.');
  useEffect(() => {
    if (token) api.inviteInfo(token).then((i) => { setInfo(i); setName(i.displayName); }, (e) => setError(errText(e)));
  }, [token]);
  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    try { const r = await api.acceptInvite(token!, pw, name); session.set(r.token); window.location.replace('/'); }
    catch (err) { setError(errText(err)); }
  };
  return (
    <Card title="Join Tracker">
      {info ? (
        <form className="stack" onSubmit={go}>
          <p className="small">You were invited as <strong>{info.email}</strong>.</p>
          <label>Your name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></label>
          <label>Choose a password<input type="password" value={pw} onChange={(e) => setPw(e.target.value)} minLength={8} required autoComplete="new-password" autoFocus /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="btn primary block">Join</button>
        </form>
      ) : error ? <p className="error" role="alert">{error}</p> : <p className="muted">Checking your invitation…</p>}
    </Card>
  );
}

/** /verify#token=… — confirm an email address (works signed in or not). */
export function VerifyEmail() {
  const [token] = useState(takeToken);
  const [state, setState] = useState<'busy' | 'ok' | string>(token ? 'busy' : 'This link is incomplete.');
  useEffect(() => { if (token) api.verifyEmail(token).then(() => setState('ok'), (e) => setState(errText(e))); }, [token]);
  return (
    <Card title="Confirm your email">
      {state === 'busy' ? <p className="muted">Confirming…</p> : state === 'ok' ? <p>Thanks, your email is confirmed.</p> : <p className="error" role="alert">{state}</p>}
      <a className="btn primary block" href="/">Continue to Tracker</a>
    </Card>
  );
}

/** Account → Account & password. */
export function AccountSettings() {
  const { toast } = useShell();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const change = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try { await api.changePassword(cur, next); setCur(''); setNext(''); toast('Password changed · other devices signed out'); }
    catch (err) { setError(errText(err)); }
  };
  return (
    <div className="page narrow-page">
      <PageHeader title="Account & password" />
      <section className="panel">
        <h2 className="section-title" style={{ marginTop: 0 }}>Change password</h2>
        <form className="stack" onSubmit={change}>
          <label>Current password<input type="password" value={cur} onChange={(e) => setCur(e.target.value)} required autoComplete="current-password" /></label>
          <label>New password<input type="password" value={next} onChange={(e) => setNext(e.target.value)} minLength={8} required autoComplete="new-password" /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <div><button className="btn primary">Change password</button></div>
        </form>
        <p className="muted small">If you only sign in with single sign-on, your identity provider manages your password, not Tracker.</p>
      </section>
      <section className="panel">
        <h2 className="section-title" style={{ marginTop: 0 }}>Sessions</h2>
        <p className="muted small">Sessions end after 12 hours without activity, and always after 14 days.</p>
        <button className="btn" onClick={() => confirm('Sign out on every device, including this one?') &&
          api.signOutEverywhere().then(() => { session.set(null); window.location.replace('/'); }, (e) => toast(errText(e)))}>Sign out everywhere</button>
      </section>
    </div>
  );
}

/** Shown under the top bar until the email is confirmed. */
export function VerifyBanner() {
  const { toast } = useShell();
  const [sent, setSent] = useState(false);
  return (
    <div className="verify-banner" role="status">
      Confirm your email address to get notifications and be able to reset your password.{' '}
      <button className="link-btn" disabled={sent} onClick={() => api.resendVerification().then(() => { setSent(true); toast('Verification email sent'); }, (e) => toast(errText(e)))}>
        {sent ? 'Sent — check your inbox' : 'Resend the email'}
      </button>
    </div>
  );
}
