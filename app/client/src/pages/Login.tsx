import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';

type SsoConfig = { enabled: boolean; name: string | null; passwordLogin: 'all' | 'admins' };

export function Login() {
  const { signIn, signUp, ssoError } = useAuth();
  const [mode, setMode] = useState<'in' | 'up' | 'forgot'>('in');
  const [notice, setNotice] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(ssoError);
  const [busy, setBusy] = useState(false);
  const [sso, setSso] = useState<SsoConfig | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [site, setSite] = useState<{ allowSignup: boolean; signupDomains: string[] } | null>(null);
  useEffect(() => { api.siteInfo().then(setSite, () => setSite(null)); }, []);
  useEffect(() => { api.ssoConfig().then(setSso, () => setSso({ enabled: false, name: null, passwordLogin: 'all' })); }, []);
  useEffect(() => { if (ssoError) setError(ssoError); }, [ssoError]);

  const ssoOnly = !!sso?.enabled && sso.passwordLogin === 'admins';
  const passwordVisible = !sso?.enabled || !ssoOnly || showPassword;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'forgot') { const r = await api.forgotPassword(email); setNotice(r.message); return; }
      if (mode === 'in') await signIn(email, password);
      else await signUp(email, name, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };
  // come back to the page the person was trying to open
  const startSso = () => {
    setBusy(true);
    window.location.href = `/api/auth/oidc/start?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  };

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand big"><span className="logo">◆</span> Tracker</div>
        <h1>{mode === 'in' ? 'Log in to continue' : mode === 'forgot' ? 'Reset your password' : 'Create your account'}</h1>
        {mode === 'forgot' && (
          <>
            <p className="small muted">Enter your email and we’ll send you a link to choose a new password.</p>
            <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus autoComplete="email" /></label>
            {notice && <p className="small" role="status">{notice}</p>}
            {error && <p className="error" role="alert">{error}</p>}
            <button className="btn primary block" disabled={busy || !!notice}>Send reset link</button>
            <button type="button" className="link-btn" onClick={() => { setMode('in'); setNotice(null); setError(null); }}>Back to log in</button>
          </>
        )}
        {mode !== 'forgot' && sso?.enabled && mode === 'in' && (
          <>
            <button type="button" className="btn primary block" onClick={startSso} disabled={busy}>Continue with {sso.name}</button>
            {passwordVisible && <div className="auth-or" role="separator"><span>or</span></div>}
          </>
        )}
        {error && !passwordVisible && <p className="error" role="alert">{error}</p>}
        {mode !== 'forgot' && passwordVisible && (
          <>
            <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={!sso?.enabled} autoComplete="email" /></label>
            {mode === 'up' && <label>Full name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>}
            <label>Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === 'up' ? 8 : 1}
                autoComplete={mode === 'in' ? 'current-password' : 'new-password'} />
            </label>
            {error && <p className="error" role="alert">{error}</p>}
            <button className={`btn ${sso?.enabled && mode === 'in' ? '' : 'primary'} block`} disabled={busy}>{busy ? 'Please wait…' : mode === 'up' ? 'Sign up' : sso?.enabled ? 'Log in with password' : 'Continue'}</button>
          </>
        )}
        {mode === 'in' && passwordVisible && <button type="button" className="link-btn small" onClick={() => { setMode('forgot'); setError(null); }}>Forgot password?</button>}
        {mode !== 'forgot' && ssoOnly && !showPassword && (
          <button type="button" className="link-btn" onClick={() => setShowPassword(true)}>Site admin? Log in with a password</button>
        )}
        {mode === 'up' && site?.signupDomains.length ? <p className="muted small">Sign-up is open to {site.signupDomains.map((d) => `@${d}`).join(', ')} email addresses.</p> : null}
        {mode !== 'forgot' && !ssoOnly && (mode === 'up' || site?.allowSignup !== false) && (
          <button type="button" className="link-btn" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setError(null); }}>
            {mode === 'in' ? 'Create an account' : 'Already have an account? Log in'}
          </button>
        )}
        <p className="muted small">Local demo accounts are listed in app/README.md.</p>
      </form>
    </div>
  );
}
