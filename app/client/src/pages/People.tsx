import { useEffect, useState } from 'react';
import { api, ApiError, type AdminUser, type Group, type Project } from '../api';
import { useAuth } from '../auth';
import { PageHeader, useShell } from '../Layout';
import { Avatar, timeAgo } from '../ui';
import { AdminTabs } from './Admin';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));
const STATUS_CLASS: Record<AdminUser['status'], string> = { active: 'lozenge-done', invited: 'lozenge-in_progress', deactivated: 'lozenge-todo' };

/** Administration → Users. */
export function Users() {
  const { user } = useAuth();
  const { toast } = useShell();
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<AdminUser[] | null>(null);
  const [inviting, setInviting] = useState(false);
  const load = (q = query) => api.adminUsers(q).then(setRows, (e) => toast(errText(e)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (user?.isSiteAdmin) load(''); }, [user?.isSiteAdmin]);
  if (!user?.isSiteAdmin) return <div className="page"><h1>Users</h1><p className="muted">Only site admins can see this page.</p></div>;
  const act = (p: Promise<unknown>, msg: string) => p.then(() => { toast(msg); load(); }, (e) => toast(errText(e)));
  return (
    <div className="page">
      <PageHeader title="Administration" actions={<button className="btn primary" onClick={() => setInviting(true)}>+ Invite people</button>} />
      <AdminTabs />
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); load(); }}>
        <input aria-label="Search people" placeholder="Search by name or email" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn subtle">Search</button>
      </form>
      {!rows ? <p className="muted">Loading…</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Site admin</th><th>Groups</th><th>Last sign-in</th><th /></tr></thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.accountId} className={u.active ? '' : 'muted'}>
                  <td><span className="user-cell"><Avatar user={u} size={22} /> {u.displayName}</span></td>
                  <td className="small">{u.emailAddress}{!u.emailVerified && u.status === 'active' ? <span className="muted"> · unconfirmed</span> : ''}{u.sso ? <span className="muted"> · SSO</span> : ''}</td>
                  <td><span className={`lozenge ${STATUS_CLASS[u.status]}`}>{u.status}</span></td>
                  <td>
                    <input type="checkbox" aria-label={`${u.displayName} is a site admin`} checked={u.isSiteAdmin} disabled={!u.active}
                      onChange={(e) => act(api.setSiteAdmin(u.accountId, e.target.checked), e.target.checked ? `${u.displayName} is now a site admin` : `${u.displayName} is no longer a site admin`)} />
                  </td>
                  <td className="small">{u.groups.join(', ') || <span className="muted">—</span>}</td>
                  <td className="small muted nowrap">{u.lastLogin ? timeAgo(u.lastLogin) : 'Never'}</td>
                  <td className="nowrap">
                    {u.status === 'invited' && <><button className="link-btn" onClick={() => act(api.resendInvite(u.accountId), `Invitation sent again to ${u.emailAddress}`)}>Resend invite</button>{' '}</>}
                    {u.accountId !== user.accountId && (u.active
                      ? <button className="link-btn danger-text" onClick={() => confirm(`Deactivate ${u.displayName}? They’re signed out everywhere and can’t sign in. Their work and history stay.`) && act(api.deactivateUser(u.accountId), `${u.displayName} deactivated`)}>Deactivate</button>
                      : <button className="link-btn" onClick={() => act(api.activateUser(u.accountId), `${u.displayName} reactivated`)}>Reactivate</button>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {inviting && <InviteDialog onClose={() => setInviting(false)} onDone={(email) => { setInviting(false); toast(`Invitation sent to ${email}`); load(); }} />}
    </div>
  );
}

function InviteDialog({ onClose, onDone }: { onClose: () => void; onDone: (email: string) => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [admin, setAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    try { await api.inviteUser(email, name, admin); onDone(email); } catch (err) { setError(errText(err)); }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal narrow" role="dialog" aria-modal="true" aria-label="Invite people" onSubmit={go}>
        <header className="modal-head"><h1>Invite someone</h1><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button></header>
        <div className="modal-body">
          <label>Email*<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label>
          <label>Name*<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></label>
          <label className="check"><input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} /> Site admin</label>
          <p className="muted small">They’ll get an email with a link to set their password (valid 7 days). Add them to spaces or groups afterwards.</p>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <footer className="modal-foot"><span className="grow" /><button type="button" className="btn subtle" onClick={onClose}>Cancel</button><button className="btn primary">Send invitation</button></footer>
      </form>
    </div>
  );
}

/** Administration → Groups. */
export function Groups() {
  const { user } = useAuth();
  const { toast } = useShell();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [people, setPeople] = useState<AdminUser[]>([]);
  const [name, setName] = useState('');
  const [adding, setAdding] = useState<Record<string, string>>({});
  const load = () => api.groups().then(setGroups, (e) => toast(errText(e)));
  useEffect(() => {
    if (!user?.isSiteAdmin) return;
    load();
    api.adminUsers('').then((u) => setPeople(u.filter((x) => x.active)), () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.isSiteAdmin]);
  if (!user?.isSiteAdmin) return <div className="page"><h1>Groups</h1><p className="muted">Only site admins can see this page.</p></div>;
  const act = (p: Promise<unknown>) => p.then(load, (e) => toast(errText(e)));
  return (
    <div className="page">
      <PageHeader title="Administration" />
      <AdminTabs />
      <p className="muted small">Give a group a role in a space (Space settings → Access) and everyone in it gets that access. People added to the group later get it too; removing them takes it away. If someone also has their own access to a space, theirs is kept.</p>
      <form className="row-form" onSubmit={(e) => { e.preventDefault(); act(api.createGroup(name).then(() => setName(''))); }}>
        <label className="grow">New group<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder="e.g. QA team" /></label>
        <button className="btn primary">Create</button>
      </form>
      {!groups ? <p className="muted">Loading…</p> : groups.length === 0 ? <p className="muted">No groups yet.</p> : groups.map((g) => (
        <section key={g.id} className="panel">
          <div className="section-row" style={{ marginTop: 0 }}>
            <h2 className="section-title" style={{ margin: 0 }}>{g.name}</h2>
            <span className="muted small">{g.members.length} member{g.members.length === 1 ? '' : 's'} · {g.spaces.length ? g.spaces.map((s) => `${s.key} (${s.role})`).join(', ') : 'not used in any space'}</span>
            <span className="grow" />
            <button className="link-btn danger-text" onClick={() => confirm(`Delete group ${g.name}? Its members lose the access it gave them.`) && act(api.deleteGroup(g.id))}>Delete</button>
          </div>
          <div className="labels">
            {g.members.map((m) => (
              <span key={m.accountId} className="label">{m.displayName}{!m.active && ' (deactivated)'}
                <button className="x" aria-label={`Remove ${m.displayName} from ${g.name}`} onClick={() => act(api.removeGroupMember(g.id, m.accountId))}>×</button>
              </span>
            ))}
            <select aria-label={`Add someone to ${g.name}`} value={adding[g.id] ?? ''} onChange={(e) => {
              const id = e.target.value;
              setAdding({ ...adding, [g.id]: '' });
              if (id) act(api.addGroupMembers(g.id, [id]));
            }}>
              <option value="">+ Add someone</option>
              {people.filter((p) => !g.members.some((m) => m.accountId === p.accountId)).map((p) => <option key={p.accountId} value={p.accountId}>{p.displayName}</option>)}
            </select>
          </div>
        </section>
      ))}
    </div>
  );
}

/** Space settings → Access: groups that have a role here. */
export function SpaceGroups({ project, onChange }: { project: Project; onChange: () => void }) {
  const { toast } = useShell();
  const [data, setData] = useState<{ groups: { id: string; name: string; role: string; memberCount: number }[]; available: { id: string; name: string }[] } | null>(null);
  const [pick, setPick] = useState('');
  const [role, setRole] = useState('member');
  const load = () => api.spaceGroups(project.key).then(setData, (e) => toast(errText(e)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [project.key]);
  if (!data) return null;
  const act = (p: Promise<unknown>) => p.then(() => { load(); onChange(); }, (e) => toast(errText(e)));
  return (
    <>
      <h3 className="section-title">Groups</h3>
      {data.groups.length === 0 ? <p className="muted small">No groups have access. Site admins manage groups in Administration → Groups.</p> : (
        <table className="table">
          <thead><tr><th>Group</th><th>Members</th><th>Role</th><th /></tr></thead>
          <tbody>{data.groups.map((g) => (
            <tr key={g.id}><td>{g.name}</td><td>{g.memberCount}</td><td>{g.role}</td>
              <td><button className="link-btn danger-text" onClick={() => act(api.removeSpaceGroup(project.key, g.id))}>Remove</button></td></tr>
          ))}</tbody>
        </table>
      )}
      {data.available.length > 0 && (
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (pick) act(api.addSpaceGroup(project.key, pick, role)); }}>
          <label>Add a group<select value={pick} onChange={(e) => setPick(e.target.value)} required>
            <option value="">Choose…</option>{data.available.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select></label>
          <label>Role<select value={role} onChange={(e) => setRole(e.target.value)}>{['admin', 'member', 'viewer', 'guest'].map((r) => <option key={r}>{r}</option>)}</select></label>
          <button className="btn">Add</button>
        </form>
      )}
    </>
  );
}
