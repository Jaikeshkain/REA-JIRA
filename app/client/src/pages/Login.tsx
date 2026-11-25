import { useState } from 'react';
import { ApiError } from '../api';
import { useAuth } from '../auth';

export function Login() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand big"><span className="logo">◆</span> Tracker</div>
        <h1>{mode === 'in' ? 'Log in to continue' : 'Create your account'}</h1>
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus autoComplete="email" /></label>
        {mode === 'up' && <label>Full name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>}
        <label>Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === 'up' ? 8 : 1}
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'} />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary block" disabled={busy}>{busy ? 'Please wait…' : mode === 'in' ? 'Continue' : 'Sign up'}</button>
        <button type="button" className="link-btn" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setError(null); }}>
          {mode === 'in' ? 'Create an account' : 'Already have an account? Log in'}
        </button>
        <p className="muted small">Local demo accounts are listed in app/README.md.</p>
      </form>
    </div>
  );
}
