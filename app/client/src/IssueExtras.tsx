import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type Attachment, type Issue, type IssueLink, type LinkType } from './api';
import { useAuth } from './auth';
import { Avatar, PriorityIcon, StatusLozenge, TypeIcon, timeAgo } from './ui';

// ------------------------------------------------------------------ Linked work items

/** "Linked work items": grouped by the phrase as seen from this issue (blocks / is blocked by / …). */
export function LinkedItems({ issue, canLink, onChange, onError }: {
  issue: Issue; canLink: boolean; onChange: () => void; onError: (m: string) => void;
}) {
  const links = issue.fields.issuelinks ?? [];
  const [adding, setAdding] = useState(false);
  const groups = links.reduce<Record<string, IssueLink[]>>((g, l) => ((g[l.relation] ??= []).push(l), g), {});

  return (
    <>
      <div className="section-row">
        <h2 className="section-title">Linked work items</h2>
        {canLink && !adding && <button className="icon-btn" aria-label="Add linked work item" onClick={() => setAdding(true)}>＋</button>}
      </div>
      {adding && <AddLink issue={issue} onDone={(changed) => { setAdding(false); if (changed) onChange(); }} onError={onError} />}
      {links.length === 0 && !adding && <p className="muted small">No linked work items.</p>}
      {Object.entries(groups).map(([relation, list]) => (
        <div key={relation} className="link-group">
          <div className="link-rel">{relation}</div>
          <ul className="child-list">
            {list.map((l) => {
              const o = (l.inwardIssue ?? l.outwardIssue)!;
              return (
                <li key={l.id}>
                  <TypeIcon type={o.fields.issuetype} />
                  <Link to={`/browse/${o.key}`} className="key">{o.key}</Link>
                  <Link to={`/browse/${o.key}`} className={`grow ${o.fields.status.statusCategory.key === 'done' ? 'strike' : ''}`}>{o.fields.summary}</Link>
                  <PriorityIcon priority={o.fields.priority as any} />
                  <StatusLozenge status={o.fields.status} />
                  {canLink && (
                    <button className="icon-btn tiny" aria-label={`Remove link to ${o.key}`}
                      onClick={() => api.deleteLink(l.id).then(onChange, (e) => onError(e.message))}>✕</button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}

function AddLink({ issue, onDone, onError }: { issue: Issue; onDone: (changed: boolean) => void; onError: (m: string) => void }) {
  const [types, setTypes] = useState<LinkType[]>([]);
  const [rel, setRel] = useState('Blocks|out');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Issue[]>([]);
  const [picked, setPicked] = useState<Issue | null>(null);
  useEffect(() => { api.linkTypes().then((r) => setTypes(r.issueLinkTypes)); }, []);
  useEffect(() => {
    const term = q.trim();
    if (!term || picked) { setResults([]); return; }
    const t = setTimeout(() => {
      const jql = /^[A-Z][A-Z0-9]+-\d+$/i.test(term) ? `key = ${term}` : `text ~ "${term.replace(/"/g, '\\"')}" ORDER BY updated DESC`;
      api.search(jql, 0, 8).then((r) => setResults(r.issues.filter((i) => i.key !== issue.key)), () => setResults([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, picked, issue.key]);

  // each type offers both phrases; for symmetric types (relates to) only one
  const options = types.flatMap((t) =>
    t.inward === t.outward ? [{ v: `${t.name}|out`, label: t.outward }] : [{ v: `${t.name}|out`, label: t.outward }, { v: `${t.name}|in`, label: t.inward }],
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!picked) return;
    const [name, dir] = rel.split('|');
    try {
      // "this issue blocks X" → this = outward; "this issue is blocked by X" → this = inward
      if (dir === 'out') await api.createLink(name, issue.key, picked.key);
      else await api.createLink(name, picked.key, issue.key);
      onDone(true);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : String(err));
    }
  };

  return (
    <form className="add-link" onSubmit={submit}>
      <select value={rel} onChange={(e) => setRel(e.target.value)} aria-label="Link type">
        {options.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
      </select>
      <div className="picker">
        {picked ? (
          <span className="picked"><TypeIcon type={picked.fields.issuetype} /> {picked.key} {picked.fields.summary}
            <button type="button" className="icon-btn tiny" aria-label="Clear" onClick={() => { setPicked(null); setQ(''); }}>✕</button></span>
        ) : (
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by key or text" aria-label="Work item to link" />
        )}
        {results.length > 0 && (
          <ul className="picker-list" role="listbox">
            {results.map((r) => (
              <li key={r.key}><button type="button" role="option" aria-selected="false" className="menu-item" onClick={() => { setPicked(r); setResults([]); }}>
                <TypeIcon type={r.fields.issuetype} /> <span className="key">{r.key}</span> {r.fields.summary}
              </button></li>
            ))}
          </ul>
        )}
      </div>
      <button className="btn primary" disabled={!picked}>Link</button>
      <button type="button" className="btn subtle" onClick={() => onDone(false)}>Cancel</button>
    </form>
  );
}

// ------------------------------------------------------------------ Attachments

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const ext = (name: string) => (name.includes('.') ? name.split('.').pop()!.slice(0, 4).toUpperCase() : 'FILE');

export function Attachments({ issue, canAdd, canDeleteOwn, canDeleteAll, onChange, onError }: {
  issue: Issue; canAdd: boolean; canDeleteOwn: boolean; canDeleteAll: boolean; onChange: () => void; onError: (m: string) => void;
}) {
  const { user } = useAuth();
  const files = issue.fields.attachment ?? [];
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  const [over, setOver] = useState(false);
  const [preview, setPreview] = useState<{ a: Attachment; url: string } | null>(null);
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { URL.revokeObjectURL(preview.url); setPreview(null); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [preview]);

  const upload = async (list: FileList | File[]) => {
    const arr = [...list];
    if (!arr.length) return;
    setBusy(arr.length);
    for (const f of arr) {
      try { await api.uploadAttachment(issue.key, f); } catch (e) { onError(`${f.name}: ${e instanceof ApiError ? e.message : String(e)}`); }
      setBusy((b) => b - 1);
    }
    onChange();
  };

  const open = async (a: Attachment) => {
    try {
      const blob = await api.attachmentBlob(a, !a.isImage);
      const url = URL.createObjectURL(blob);
      if (a.isImage) setPreview({ a, url });
      else {
        const link = document.createElement('a');
        link.href = url;
        link.download = a.filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e) { onError(e instanceof ApiError ? e.message : String(e)); }
  };

  return (
    <section className={`attachments ${over ? 'drop' : ''}`}
      onDragOver={(e) => { if (canAdd && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={(e) => { if (!canAdd) return; e.preventDefault(); setOver(false); upload(e.dataTransfer.files); }}>
      <div className="section-row">
        <h2 className="section-title">Attachments {files.length > 0 && <span className="count">{files.length}</span>}</h2>
        {canAdd && <button className="icon-btn" aria-label="Add attachment" onClick={() => input.current?.click()}>＋</button>}
        <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files) upload(e.target.files); e.target.value = ''; }} />
      </div>
      {busy > 0 && <p className="muted small">Uploading {busy} file{busy === 1 ? '' : 's'}…</p>}
      {files.length === 0 ? (
        canAdd && <button className="drop-hint block" onClick={() => input.current?.click()}>Drop files here or click to browse (max 10 MB each)</button>
      ) : (
        <ul className="att-grid">
          {files.map((a) => (
            <li key={a.id} className="att">
              <button className="att-thumb" onClick={() => open(a)} aria-label={`${a.isImage ? 'Preview' : 'Download'} ${a.filename}`}>
                {a.isImage ? <Thumb a={a} /> : <span className="att-ext">{ext(a.filename)}</span>}
              </button>
              <div className="att-meta">
                <span className="att-name" title={a.filename}>{a.filename}</span>
                <span className="muted small">{fmtSize(a.size)} · {timeAgo(a.created)}</span>
              </div>
              {(canDeleteAll || (canDeleteOwn && a.author.accountId === user?.accountId)) && (
                <button className="icon-btn tiny att-del" aria-label={`Delete ${a.filename}`}
                  onClick={() => confirm(`Delete ${a.filename}? This can't be undone.`) && api.deleteAttachment(a.id).then(onChange, (e) => onError(e.message))}>🗑</button>
              )}
            </li>
          ))}
          {canAdd && <li className="att add"><button className="att-thumb" onClick={() => input.current?.click()} aria-label="Add attachment">＋</button></li>}
        </ul>
      )}
      {preview && (
        <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) { URL.revokeObjectURL(preview.url); setPreview(null); } }}>
          <figure className="lightbox" role="dialog" aria-label={preview.a.filename}>
            <img src={preview.url} alt={preview.a.filename} />
            <figcaption>
              <Avatar user={preview.a.author} size={20} /> {preview.a.filename} <span className="muted small">{fmtSize(preview.a.size)}</span>
              <span className="grow" />
              <button className="btn subtle" onClick={async () => {
                const blob = await api.attachmentBlob(preview.a, true);
                const u = URL.createObjectURL(blob);
                const link = document.createElement('a'); link.href = u; link.download = preview.a.filename; link.click();
                setTimeout(() => URL.revokeObjectURL(u), 1000);
              }}>Download</button>
              <button className="btn subtle" onClick={() => { URL.revokeObjectURL(preview.url); setPreview(null); }}>Close</button>
            </figcaption>
          </figure>
        </div>
      )}
    </section>
  );
}

function Thumb({ a }: { a: Attachment }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null;
    let live = true;
    api.attachmentBlob(a).then((b) => { if (live) { u = URL.createObjectURL(b); setUrl(u); } }, () => {});
    return () => { live = false; if (u) URL.revokeObjectURL(u); };
  }, [a.id]);
  return url ? <img src={url} alt="" /> : <span className="att-ext">IMG</span>;
}
