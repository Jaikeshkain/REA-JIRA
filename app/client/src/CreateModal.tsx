import { useEffect, useState } from 'react';
import { api, ApiError, type Priority, type Project, type ProjectSummary, type User } from './api';

/**
 * Global "Create" dialog. Fields follow the order observed in Jira's create-modal layout
 * (summary, description, assignee, parent, priority, labels, due date — JIRA_REQUIREMENTS §8.1).
 */
export function CreateModal({ defaultProject, onClose, onCreated }: {
  defaultProject?: string;
  onClose: () => void;
  onCreated: (key: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectKey, setProjectKey] = useState(defaultProject ?? '');
  const [project, setProject] = useState<Project | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [priorities, setPriorities] = useState<Priority[]>([]);
  const [form, setForm] = useState({ type: '', summary: '', description: '', assignee: '', parent: '', priority: 'Medium', labels: '', duedate: '' });
  const [another, setAnother] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [parents, setParents] = useState<{ key: string; summary: string }[]>([]);

  useEffect(() => {
    api.projects().then((ps) => {
      setProjects(ps);
      if (!projectKey && ps[0]) setProjectKey(ps[0].key);
    });
    api.priorities().then(setPriorities);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!projectKey) return;
    api.project(projectKey).then((p) => {
      setProject(p);
      setForm((f) => ({ ...f, type: p.issueTypes.find((t) => t.name === 'Task')?.id ?? p.issueTypes[0]?.id ?? '' }));
    });
    api.assignable(projectKey).then(setUsers).catch(() => setUsers([]));
  }, [projectKey]);

  const type = project?.issueTypes.find((t) => t.id === form.type);
  useEffect(() => {
    if (!type || type.hierarchyLevel >= 1) { setParents([]); return; }
    const parentType = type.hierarchyLevel === 0 ? 'Epic' : undefined;
    const jql = parentType
      ? `project = ${projectKey} AND type = Epic ORDER BY created DESC`
      : `project = ${projectKey} AND type != Epic AND type != Subtask ORDER BY created DESC`;
    api.search(jql, 0, 100).then((r) => setParents(r.issues.map((i) => ({ key: i.key, summary: i.fields.summary }))));
  }, [type?.id, projectKey]);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api.createIssue({
        project: { key: projectKey },
        issuetype: { id: form.type },
        summary: form.summary,
        description: form.description || undefined,
        assignee: form.assignee ? { accountId: form.assignee } : undefined,
        parent: form.parent ? { key: form.parent } : undefined,
        priority: { name: form.priority },
        labels: form.labels.split(/[\s,]+/).filter(Boolean),
        duedate: form.duedate || undefined,
      });
      onCreated(r.key);
      if (another) setForm((f) => ({ ...f, summary: '', description: '' }));
      else onClose();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}${err.errors ? ` ${Object.values(err.errors).flat().join(', ')}` : ''}` : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="create-title" onSubmit={submit}>
        <header className="modal-head">
          <h1 id="create-title">Create</h1>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="modal-body">
          <p className="muted small">Required fields are marked with an asterisk *</p>
          <div className="row2">
            <label>Project*
              <select value={projectKey} onChange={(e) => setProjectKey(e.target.value)} required>
                {projects.map((p) => <option key={p.key} value={p.key}>{p.name} ({p.key})</option>)}
              </select>
            </label>
            <label>Work type*
              <select value={form.type} onChange={set('type')} required>
                {project?.issueTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          </div>
          <label>Summary*
            <input value={form.summary} onChange={set('summary')} required maxLength={255} autoFocus />
          </label>
          <label>Description
            <textarea rows={5} value={form.description} onChange={set('description')}
              placeholder={'Blank line = new paragraph.\n- lines starting with "- " become a bullet list'} />
          </label>
          <div className="row2">
            <label>Assignee
              <select value={form.assignee} onChange={set('assignee')}>
                <option value="">Unassigned</option>
                {users.map((u) => <option key={u.accountId} value={u.accountId}>{u.displayName}</option>)}
              </select>
            </label>
            <label>Parent{type?.hierarchyLevel === -1 ? '*' : ''}
              <select value={form.parent} onChange={set('parent')} disabled={!type || type.hierarchyLevel >= 1} required={type?.hierarchyLevel === -1}>
                <option value="">{type?.hierarchyLevel === 1 ? 'Epics have no parent' : 'None'}</option>
                {parents.map((p) => <option key={p.key} value={p.key}>{p.key} {p.summary}</option>)}
              </select>
            </label>
          </div>
          <div className="row3">
            <label>Priority
              <select value={form.priority} onChange={set('priority')}>
                {priorities.map((p) => <option key={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label>Labels
              <input value={form.labels} onChange={set('labels')} placeholder="frontend, urgent" />
            </label>
            <label>Due date
              <input type="date" value={form.duedate} onChange={set('duedate')} />
            </label>
          </div>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <footer className="modal-foot">
          <label className="check"><input type="checkbox" checked={another} onChange={(e) => setAnother(e.target.checked)} /> Create another</label>
          <span className="grow" />
          <button type="button" className="btn subtle" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !form.summary.trim()}>{busy ? 'Creating…' : 'Create'}</button>
        </footer>
      </form>
    </div>
  );
}
