import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';

type SsoConfig = { enabled: boolean; name: string | null; passwordLogin: 'all' | 'admins' };

export function Login() {
  const { signIn, signUp, ssoError } = useAuth();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(ssoError);
  const [busy, setBusy] = useState(false);
  const [sso, setSso] = useState<SsoConfig | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  useEffect(() => { api.ssoConfig().then(setSso, () => setSso({ enabled: false, name: null, passwordLogin: 'all' })); }, []);
  useEffect(() => { if (ssoError) setError(ssoError); }, [ssoError]);

  const ssoOnly = !!sso?.enabled && sso.passwordLogin === 'admins';
  const passwordVisible = !sso?.enabled || !ssoOnly || showPassword;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
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
        <h1>{mode === 'in' ? 'Log in to continue' : 'Create your account'}</h1>
        {sso?.enabled && mode === 'in' && (
          <>
            <button type="button" className="btn primary block" onClick={startSso} disabled={busy}>Continue with {sso.name}</button>
            {passwordVisible && <div className="auth-or" role="separator"><span>or</span></div>}
          </>
        )}
        {error && !passwordVisible && <p className="error" role="alert">{error}</p>}
        {passwordVisible && (
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
        {ssoOnly && !showPassword && (
          <button type="button" className="link-btn" onClick={() => setShowPassword(true)}>Site admin? Log in with a password</button>
        )}
        {!ssoOnly && (
          <button type="button" className="link-btn" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setError(null); }}>
            {mode === 'in' ? 'Create an account' : 'Already have an account? Log in'}
          </button>
        )}
        <p className="muted small">Local demo accounts are listed in app/README.md.</p>
      </form>
    </div>
  );
}
