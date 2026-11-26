import { useEffect, useState } from 'react';
import { api, ApiError, type Issue, type Project, type SecurityLevel } from '../api';
import { useShell } from '../Layout';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));
const ROLES = [['admin', 'Administrators'], ['member', 'Members'], ['viewer', 'Viewers'], ['guest', 'Guests']] as const;

/** Work item sidebar: shows the level; space admins can change it. */
export function SecurityField({ issue, canSet, onSet }: { issue: Issue; canSet: boolean; onSet: (v: { id: string } | null) => void }) {
  const [levels, setLevels] = useState<SecurityLevel[] | null>(null);
  const cur = issue.fields.security ?? null;
  useEffect(() => { if (canSet) api.securityLevels(issue.fields.project.key).then(setLevels, () => setLevels([])); }, [canSet, issue.fields.project.key]);
  if (!canSet || !levels) return cur ? <span className="sec-badge">🔒 {cur.name}</span> : <span className="muted">None (everyone in the space)</span>;
  if (!levels.length && !cur) return <span className="muted small">None · add levels in Space settings → Security</span>;
  return (
    <select aria-label="Security level" value={cur?.id ?? ''} onChange={(e) => onSet(e.target.value ? { id: e.target.value } : null)}>
      <option value="">None (everyone in the space)</option>
      {levels.map((l) => <option key={l.id} value={l.id}>🔒 {l.name}</option>)}
    </select>
  );
}

/** Space settings → Security: who can see work set to each level. */
export function SecurityEditor({ project }: { project: Project }) {
  const { toast } = useShell();
  const [levels, setLevels] = useState<SecurityLevel[] | null>(null);
  const [name, setName] = useState('');
  const [roles, setRoles] = useState<string[]>(['admin']);
  const [people, setPeople] = useState<string[]>([]);
  const [rep, setRep] = useState(true);
  const [asg, setAsg] = useState(true);
  const load = () => api.securityLevels(project.key).then(setLevels, (e) => toast(errText(e)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [project.key]);
  const toggle = (list: string[], v: string, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.createSecurityLevel(project.key, { name, roles, users: people, includeReporter: rep, includeAssignee: asg });
      setName(''); setPeople([]);
      load();
    } catch (err) { toast(errText(err)); }
  };
  const who = (l: SecurityLevel) => [
    ...l.roles.map((r) => ROLES.find(([k]) => k === r)?.[1] ?? r),
    ...l.users.map((id) => project.members.find((m) => m.accountId === id)?.displayName ?? `#${id}`),
    ...(l.includeReporter ? ['the reporter'] : []), ...(l.includeAssignee ? ['the assignee'] : []),
  ].join(', ') || 'Nobody (site admins only)';
  return (
    <section className="panel">
      <h2 className="section-title" style={{ marginTop: 0 }}>Security levels</h2>
      <p className="muted small">Set a level on a work item to limit who can see it. People outside the level can’t open it or find it in search, boards, links or notifications. Work with no level is visible to everyone in the space. Site admins see everything.</p>
      {!levels ? <p className="muted">Loading…</p> : levels.length === 0 ? <p className="muted">No levels yet.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Level</th><th>Who can see it</th><th>Work items</th><th /></tr></thead>
            <tbody>
              {levels.map((l) => (
                <tr key={l.id}>
                  <td className="strong">🔒 {l.name}</td>
                  <td className="small">{who(l)}</td>
                  <td>{l.issueCount}</td>
                  <td><button className="link-btn danger-text" onClick={() => confirm(`Delete level "${l.name}"? Its ${l.issueCount} work item(s) become visible to everyone in the space.`) &&
                    api.deleteSecurityLevel(l.id).then(load, (e) => toast(errText(e)))}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form onSubmit={create} className="stack" style={{ marginTop: 12 }}>
        <label>New level<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder="e.g. Security team only" /></label>
        <fieldset className="radio-group"><legend>Roles who can see it</legend>
          <div className="chips-row">{ROLES.map(([k, label]) => (
            <label key={k} className="check small-check"><input type="checkbox" checked={roles.includes(k)} onChange={(e) => setRoles(toggle(roles, k, e.target.checked))} /> {label}</label>
          ))}</div>
        </fieldset>
        <fieldset className="radio-group"><legend>Also these people</legend>
          <div className="chips-row">{project.members.map((m) => (
            <label key={m.accountId} className="check small-check"><input type="checkbox" checked={people.includes(m.accountId)} onChange={(e) => setPeople(toggle(people, m.accountId, e.target.checked))} /> {m.displayName}</label>
          ))}</div>
        </fieldset>
        <div className="chips-row">
          <label className="check small-check"><input type="checkbox" checked={rep} onChange={(e) => setRep(e.target.checked)} /> The reporter</label>
          <label className="check small-check"><input type="checkbox" checked={asg} onChange={(e) => setAsg(e.target.checked)} /> The assignee</label>
        </div>
        <div><button className="btn primary">Add level</button></div>
      </form>
    </section>
  );
}
