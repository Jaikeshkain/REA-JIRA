import { useEffect, useState } from 'react';
import { api, ApiError, type SiteSettingsData } from '../api';
import { useAuth } from '../auth';
import { PageHeader, useShell } from '../Layout';
import { AdminTabs } from './Admin';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

/** Administration → Settings: who can sign up and who can create spaces. */
export function SiteSettings() {
  const { user } = useAuth();
  const { toast } = useShell();
  const [s, setS] = useState<SiteSettingsData | null>(null);
  const [mode, setMode] = useState<'open' | 'domains' | 'closed'>('open');
  const [domains, setDomains] = useState('');
  useEffect(() => {
    if (!user?.isSiteAdmin) return;
    api.siteSettings().then((x) => {
      setS(x);
      setMode(!x.allowSignup ? 'closed' : x.signupDomains.length ? 'domains' : 'open');
      setDomains(x.signupDomains.join(', '));
    }, (e) => toast(errText(e)));
  }, [user?.isSiteAdmin, toast]);
  if (!user?.isSiteAdmin) return <div className="page"><h1>Settings</h1><p className="muted">Only site admins can see this page.</p></div>;
  const save = async (body: Partial<SiteSettingsData>, msg: string) => {
    try { setS(await api.updateSiteSettings(body)); toast(msg); } catch (e) { toast(errText(e)); }
  };
  const saveSignup = (e?: React.FormEvent) => {
    e?.preventDefault();
    const list = domains.split(/[\s,]+/).map((d) => d.replace(/^@/, '').trim()).filter(Boolean);
    if (mode === 'domains' && !list.length) { toast('Add at least one email domain'); return; }
    save(
      mode === 'closed' ? { allowSignup: false, signupDomains: [] } : { allowSignup: true, signupDomains: mode === 'domains' ? list : [] },
      mode === 'closed' ? 'Sign-up closed' : mode === 'domains' ? 'Sign-up limited to those domains' : 'Sign-up open to anyone',
    );
  };
  return (
    <div className="page">
      <PageHeader title="Administration" />
      <AdminTabs />
      {!s ? <p className="muted">Loading…</p> : (
        <div className="narrow-page">
          <section className="panel">
            <h2 className="section-title" style={{ marginTop: 0 }}>Who can sign up</h2>
            <form onSubmit={saveSignup} className="stack">
              <div role="radiogroup" aria-label="Who can sign up" className="radio-list">
                {([
                  ['open', 'Anyone', 'Anyone who can reach this site can create an account. They only see spaces they’re added to.'],
                  ['domains', 'Only people with these email domains', 'Others need an invitation.'],
                  ['closed', 'Nobody — invitation only', 'People join when a site admin invites them (Administration → Users), or through single sign-on if it’s set up.'],
                ] as const).map(([v, label, help]) => (
                  <label key={v} className={`radio-card ${mode === v ? 'on' : ''}`}>
                    <input type="radio" name="signup" checked={mode === v} onChange={() => setMode(v)} />
                    <span><strong>{label}</strong><span className="muted small">{help}</span></span>
                  </label>
                ))}
              </div>
              {mode === 'domains' && (
                <label>Email domains<input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="example.com, example.org" aria-label="Email domains" /></label>
              )}
              <div><button className="btn primary">Save</button></div>
            </form>
          </section>
          <section className="panel">
            <h2 className="section-title" style={{ marginTop: 0 }}>Who can create spaces</h2>
            <div role="radiogroup" aria-label="Who can create spaces" className="radio-list">
              {([['everyone', 'Everyone', 'Anyone signed in can create a space and becomes its administrator.'],
                ['admins', 'Site admins only', 'Others ask a site admin for a new space.']] as const).map(([v, label, help]) => (
                <label key={v} className={`radio-card ${s.spaceCreation === v ? 'on' : ''}`}>
                  <input type="radio" name="spaces" checked={s.spaceCreation === v}
                    onChange={() => save({ spaceCreation: v }, v === 'admins' ? 'Only site admins can create spaces now' : 'Everyone can create spaces now')} />
                  <span><strong>{label}</strong><span className="muted small">{help}</span></span>
                </label>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
