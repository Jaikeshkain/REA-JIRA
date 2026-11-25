import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { PageHeader, useShell } from '../Layout';
import { shareLabel } from '../ShareDialog';
import { Avatar, useAsync } from '../ui';

/** Filters directory: starred / mine / all visible, with star toggle and owner-only delete. */
export function Filters() {
  const { version, bump, toast } = useShell();
  const [scope, setScope] = useState<'starred' | 'mine' | 'all'>('all');
  const list = useAsync(() => api.filters(scope), [scope, version]);
  return (
    <div className="page">
      <PageHeader title="Filters" actions={<Link className="btn primary" to="/issues">Create filter</Link>} />
      <div className="tabs" role="tablist">
        {(['all', 'starred', 'mine'] as const).map((s) => (
          <button key={s} role="tab" aria-selected={scope === s} className={scope === s ? 'on' : ''} onClick={() => setScope(s)}>
            {{ all: 'All filters', starred: 'Starred', mine: 'My filters' }[s]}
          </button>
        ))}
      </div>
      {list.data?.values.length === 0 && <p className="muted empty">{scope === 'starred' ? 'Star a filter to keep it here.' : 'No filters yet — run a search and choose “Save filter”.'}</p>}
      {!!list.data?.values.length && (
        <table className="table">
          <thead><tr><th aria-label="Starred" /><th>Name</th><th>Owner</th><th>Viewers</th><th>Starred by</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {list.data.values.map((f) => (
              <tr key={f.id}>
                <td><button className="icon-btn star" aria-pressed={f.favourite} aria-label={f.favourite ? `Unstar ${f.name}` : `Star ${f.name}`}
                  onClick={() => api.favouriteFilter(f.id, !f.favourite).then(bump)}>{f.favourite ? '★' : '☆'}</button></td>
                <td><Link to={`/issues?filter=${f.id}`}>{f.name}</Link>{f.description && <div className="muted small">{f.description}</div>}</td>
                <td><span className="user-cell"><Avatar user={f.owner} size={20} /> {f.owner.displayName}</span></td>
                <td>{shareLabel(f.share)}</td>
                <td>{f.favouriteCount} {f.favouriteCount === 1 ? 'person' : 'people'}</td>
                <td>{f.editable && (
                  <button className="link-btn danger-text" onClick={async () => {
                    if (!confirm(`Delete filter "${f.name}"? Dashboard gadgets that use it will show as unavailable.`)) return;
                    await api.deleteFilter(f.id);
                    toast(`Deleted "${f.name}"`);
                    bump();
                  }}>Delete</button>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
