import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api, type ProjectSummary } from './api';
import { useAuth } from './auth';
import { Avatar, Popover } from './ui';
import { CreateModal } from './CreateModal';
import { NotificationBell } from './Notifications';
import { startRealtime, type LiveState } from './realtime';

/** Lets pages refresh after a global create, and open the Create dialog with a preset project. */
interface ShellCtx { openCreate: (projectKey?: string) => void; version: number; bump: () => void; toast: (msg: string, link?: string) => void }
const Shell = createContext<ShellCtx>(null!);
export const useShell = () => useContext(Shell);

export function Layout() {
  const { user, signOut } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [create, setCreate] = useState<{ project?: string } | null>(null);
  const [version, setVersion] = useState(0);
  const [menu, setMenu] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; msg: string; link?: string }[]>([]);
  const [q, setQ] = useState('');

  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const toast = useCallback((msg: string, link?: string) => {
    const id = Date.now();
    setToasts((t) => [...t, { id, msg, link }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  const currentProject = /\/projects\/([A-Z0-9]+)/i.exec(loc.pathname)?.[1];
  const openCreate = useCallback((projectKey?: string) => setCreate({ project: projectKey ?? currentProject }), [currentProject]);

  useEffect(() => { api.projects().then(setProjects); }, [version]);

  // real-time: teammates' changes refresh the current page (debounced); own changes already bump
  const [live, setLive] = useState<LiveState>('connecting');
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = startRealtime({
      onChange: (e) => {
        window.dispatchEvent(new CustomEvent('tracker:change', { detail: e }));
        if (e.actor === user?.accountId) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(bump, 350);
      },
      onNotification: () => window.dispatchEvent(new Event('tracker:notify')),
      onResync: () => { bump(); window.dispatchEvent(new Event('tracker:notify')); },
      onState: setLive,
    });
    return () => { stop(); if (timer) clearTimeout(timer); };
  }, [user?.accountId, bump]);

  // "c" opens Create (Jira shortcut), unless typing in a field
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === 'c' && !e.metaKey && !e.ctrlKey && !/INPUT|TEXTAREA|SELECT/.test(t.tagName) && !t.isContentEditable) {
        e.preventDefault();
        openCreate();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openCreate]);

  const search = (e: React.FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (!term) return;
    const jql = /^[A-Z][A-Z0-9]+-\d+$/i.test(term) ? `key = ${term}` : `text ~ "${term.replace(/"/g, '\\"')}" ORDER BY updated DESC`;
    nav(`/issues?jql=${encodeURIComponent(jql)}`);
  };

  return (
    <Shell.Provider value={{ openCreate, version, bump, toast }}>
      <div className="shell">
        <header className="topbar">
          <Link to="/for-you" className="brand" aria-label="Go to your homepage"><span className="logo">◆</span> Tracker</Link>
          <form className="search" role="search" onSubmit={search}>
            <input aria-label="Search" placeholder="Search work or KEY-123" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
          <button className="btn primary" onClick={() => openCreate()} title="Create (c)">+ Create</button>
          <span className="grow" />
          <span className={`live live-${live}`} title={live === 'live' ? 'Live: changes by teammates appear automatically' : live === 'connecting' ? 'Connecting…' : 'Offline — reconnecting'}
            aria-label={live === 'live' ? 'Live updates on' : 'Live updates reconnecting'} role="status">
            <span className="live-dot" />{live === 'live' ? 'Live' : live === 'connecting' ? '…' : 'Offline'}
          </span>
          <NotificationBell version={version} />
          <div className="menu-anchor">
            <button className="icon-btn" onClick={() => setMenu((m) => !m)} aria-label={`Account: ${user?.displayName}`}>
              <Avatar user={user} size={28} />
            </button>
            <Popover open={menu} onClose={() => setMenu(false)} align="right">
              <div className="menu-head"><strong>{user?.displayName}</strong><span className="muted small">{user?.emailAddress}</span></div>
              <button className="menu-item" onClick={() => { setMenu(false); nav('/settings/notifications'); }}>Notification settings</button>
              <button className="menu-item" onClick={() => { setMenu(false); nav('/settings/tokens'); }}>API tokens</button>
              {user?.isSiteAdmin && <button className="menu-item" onClick={() => { setMenu(false); nav('/admin/audit'); }}>Administration</button>}
              <button className="menu-item" onClick={() => { setMenu(false); signOut(); }}>Log out</button>
            </Popover>
          </div>
        </header>
        <nav className="sidebar" aria-label="Sidebar">
          <NavLink to="/for-you" className="side-link">For you</NavLink>
          <NavLink to="/issues" end className="side-link">Search</NavLink>
          <NavLink to="/filters" className="side-link">Filters</NavLink>
          <NavLink to="/dashboards" className="side-link">Dashboards</NavLink>
          <NavLink to="/projects" end className="side-link">Spaces</NavLink>
          <div className="side-group">
            {projects.map((p) => (
              <NavLink key={p.key} to={`/projects/${p.key}/board`} className={({ isActive }) => `side-link sub ${isActive || currentProject === p.key ? 'active' : ''}`}>
                <span className="proj-badge">{p.key.slice(0, 2)}</span>{p.name}
              </NavLink>
            ))}
          </div>
        </nav>
        <main className="main"><Outlet /></main>
      </div>
      {create && (
        <CreateModal
          defaultProject={create.project}
          onClose={() => setCreate(null)}
          onCreated={(key) => { bump(); toast(`Created ${key}`, `/browse/${key}`); }}
        />
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">✓ {t.msg}{t.link && <> · <Link to={t.link}>View</Link></>}</div>
        ))}
      </div>
    </Shell.Provider>
  );
}

export function PageHeader({ crumbs, title, actions }: { crumbs?: ReactNode; title: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      {crumbs && <div className="crumbs">{crumbs}</div>}
      <div className="page-title-row"><h1>{title}</h1>{actions}</div>
    </div>
  );
}
