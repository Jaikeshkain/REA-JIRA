import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, session, type User } from './api';

interface AuthCtx {
  user: User | null;
  ready: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, name: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Message from a failed single sign-on round trip, shown on the login page. */
  ssoError: string | null;
}
const Ctx = createContext<AuthCtx>(null!);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [ssoError, setSsoError] = useState<string | null>(null);

  useEffect(() => {
    // back from single sign-on: the API put a one-time code (or an error) in the URL fragment
    const frag = new URLSearchParams(window.location.hash.slice(1));
    const code = frag.get('sso'), err = frag.get('sso_error');
    if (code || err) {
      history.replaceState(null, '', window.location.pathname + window.location.search); // drop it from the address bar / history
      if (err) setSsoError(err);
      if (code) {
        api.ssoExchange(code).then(
          (r) => { session.set(r.token); window.location.replace(r.next || '/'); },
          (e) => { setSsoError(e instanceof ApiError ? e.message : 'Single sign-on failed'); setReady(true); },
        );
        return;
      }
    }
    if (!session.token) { setReady(true); return; }
    // only a real 401 ends the session; a network error (API restarting) keeps the token
    api.myself().then(setUser, (e) => { if (e instanceof ApiError && e.status === 401) session.set(null); }).finally(() => setReady(true));
    const onLogout = () => setUser(null);
    window.addEventListener('tracker:logout', onLogout);
    return () => window.removeEventListener('tracker:logout', onLogout);
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const r = await api.login(email, password);
    session.set(r.token);
    setUser(await api.myself());
  }, []);
  const signUp = useCallback(async (email: string, name: string, password: string) => {
    const r = await api.register(email, name, password);
    session.set(r.token);
    setUser(await api.myself());
  }, []);
  const signOut = useCallback(async () => {
    await api.logout().catch(() => {});
    session.set(null);
    setUser(null);
  }, []);

  return <Ctx.Provider value={{ user, ready, signIn, signUp, signOut, ssoError }}>{children}</Ctx.Provider>;
}
