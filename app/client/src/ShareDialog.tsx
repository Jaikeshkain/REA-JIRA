import { useEffect, useState } from 'react';
import { api, ApiError, type ProjectSummary, type Share, type ShareType } from './api';

export const shareLabel = (s: Share) =>
  s.type === 'site' ? 'Everyone on this site' : s.type === 'project' ? `Space: ${s.project?.name ?? ''}` : 'Private';

/** Name / description / share form shared by "Save filter" and "Create dashboard". */
export function DetailsDialog({ title, submit, initial, extra, onClose, onSave }: {
  title: string;
  submit: string;
  initial?: { name?: string; description?: string; share?: Share };
  extra?: React.ReactNode;
  onClose: () => void;
  onSave: (v: { name: string; description: string; share: ShareType; projectKey: string | null }) => Promise<unknown>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [share, setShare] = useState<ShareType>(initial?.share?.type ?? 'private');
  const [projectKey, setProjectKey] = useState(initial?.share?.project?.key ?? '');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.projects().then((p) => { setProjects(p); if (!projectKey && p[0]) setProjectKey(p[0].key); }); /* eslint-disable-next-line */ }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal narrow" role="dialog" aria-modal="true" aria-label={title} onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onSave({ name: name.trim(), description, share, projectKey: share === 'project' ? projectKey : null });
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}>
        <header className="modal-head"><h1>{title}</h1><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button></header>
        <div className="modal-body">
          <label>Name*<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoFocus /></label>
          <label>Description<textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
          <fieldset className="radio-group">
            <legend>Who can see it</legend>
            <label className="check"><input type="radio" name="share" checked={share === 'private'} onChange={() => setShare('private')} /> Private (only you)</label>
            <label className="check"><input type="radio" name="share" checked={share === 'project'} onChange={() => setShare('project')} /> Members of a space</label>
            {share === 'project' && (
              <select value={projectKey} onChange={(e) => setProjectKey(e.target.value)} aria-label="Space">
                {projects.map((p) => <option key={p.key} value={p.key}>{p.name} ({p.key})</option>)}
              </select>
            )}
            <label className="check"><input type="radio" name="share" checked={share === 'site'} onChange={() => setShare('site')} /> Everyone on this site</label>
          </fieldset>
          <p className="muted small">People only ever see work items they already have access to.</p>
          {extra}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <footer className="modal-foot"><span className="grow" />
          <button type="button" className="btn subtle" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !name.trim()}>{busy ? 'Saving…' : submit}</button>
        </footer>
      </form>
    </div>
  );
}
