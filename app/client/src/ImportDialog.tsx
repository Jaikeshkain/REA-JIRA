import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type ImportResult } from './api';

const TEMPLATE = 'Summary,Work type,Priority,Assignee,Labels,Due date,Story points,Description\r\n'
  + 'Example task,Task,Medium,,"frontend, ux",2026-12-31,3,First line\\nSecond line\r\n';

/** CSV import into one space: pick a file → preview (dry run, nothing saved) → import. */
export function ImportDialog({ projectKey, onClose, onImported }: { projectKey: string; onClose: () => void; onImported: () => void }) {
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);

  const check = async (text: string) => {
    setBusy(true); setError(null); setPreview(null);
    try { setPreview(await api.importCsv(projectKey, text, true)); } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const run = async () => {
    if (!csv) return;
    setBusy(true); setError(null);
    try { setDone(await api.importCsv(projectKey, csv, false)); onImported(); } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const shown = done ?? preview;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-label="Import work items from CSV">
        <header className="modal-head"><h1>Import CSV into {projectKey}</h1><button className="icon-btn" aria-label="Close" onClick={onClose}>✕</button></header>
        <div className="modal-body">
          {!done && (
            <>
              <p className="muted small">
                First row = column names. <strong>Summary</strong> is required; also understood: Work type, Priority, Assignee (email or name),
                Reporter, Labels, Description, Due date / Start date (YYYY-MM-DD), Story points, Parent (key), Sprint, and any custom field by name.
                Up to 500 rows. Nothing is saved until you choose Import.{' '}
                <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`} download="tracker-import-template.csv">Download a template</a>
              </p>
              <label className="file-pick">
                <input type="file" accept=".csv,text/csv" onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  if (f.size > 2 * 1024 * 1024) { setError('Files up to 2 MB'); return; }
                  const text = await f.text();
                  setFileName(f.name); setCsv(text); check(text);
                }} />
                <span className="btn">{fileName ? `Change file (${fileName})` : 'Choose CSV file'}</span>
              </label>
            </>
          )}
          {busy && <p className="muted">{done ? 'Importing…' : 'Checking…'}</p>}
          {error && <p className="error" role="alert">{error}</p>}
          {shown && (
            <>
              {!done && (
                <p className="small">
                  Columns: {shown.mapping.map((m) => (
                    <span key={m.column} className={`map-chip ${m.field ? '' : 'ignored'}`} title={m.field ? `→ ${m.field}` : 'Ignored'}>{m.column}</span>
                  ))}
                </p>
              )}
              <p>
                {done ? <><strong>{done.ok}</strong> created</> : <><strong>{shown.ok}</strong> ready to import</>}
                {shown.failed > 0 && <>, <strong className="danger-text">{shown.failed}</strong> {done ? 'failed' : 'with problems (will be skipped)'}</>}.
              </p>
              <div className="table-wrap import-table">
                <table className="table compact">
                  <thead><tr><th>Row</th><th>Summary</th><th>Result</th></tr></thead>
                  <tbody>{shown.rows.map((r) => (
                    <tr key={r.row} className={r.ok ? '' : 'row-bad'}>
                      <td>{r.row}</td>
                      <td>{r.summary || <span className="muted">(empty)</span>}</td>
                      <td>{r.key ? <Link to={`/browse/${r.key}`} className="key" onClick={onClose}>{r.key}</Link> : r.ok ? <span className="muted">OK</span> : <span className="error small">{r.errors.join(' · ')}</span>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </>
          )}
        </div>
        <footer className="modal-foot"><span className="grow" />
          <button className="btn subtle" onClick={onClose}>{done ? 'Close' : 'Cancel'}</button>
          {!done && <button className="btn primary" disabled={!preview || preview.ok === 0 || busy} onClick={run}>Import {preview?.ok ?? 0} row{preview?.ok === 1 ? '' : 's'}</button>}
        </footer>
      </div>
    </div>
  );
}
