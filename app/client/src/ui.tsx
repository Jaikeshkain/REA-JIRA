import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Adf, IssueType, Priority, Status, User } from './api';

export function Avatar({ user, size = 24 }: { user: User | null | undefined; size?: number }) {
  if (!user) return <span className="avatar avatar-empty" style={{ width: size, height: size }} title="Unassigned" aria-label="Unassigned" />;
  const initials = user.displayName.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <span className="avatar" title={user.displayName} aria-label={user.displayName}
      style={{ width: size, height: size, background: user.avatarColor ?? '#0c66e4', fontSize: size * 0.42 }}>
      {initials}
    </span>
  );
}

export function StatusLozenge({ status }: { status: Pick<Status, 'name' | 'statusCategory'> }) {
  return <span className={`lozenge lozenge-${status.statusCategory.key}`}>{status.name}</span>;
}

export function TypeIcon({ type, size = 16 }: { type: Pick<IssueType, 'name' | 'color'> | { name: string; color?: string }; size?: number }) {
  const glyph = { Epic: '⚡', Story: '▮', Task: '✓', Bug: '●', Subtask: '↳' }[type.name] ?? '■';
  return (
    <span className="type-icon" title={type.name} aria-label={type.name}
      style={{ width: size, height: size, background: (type as IssueType).color ?? '#1d7afc', fontSize: size * 0.62 }}>
      {glyph}
    </span>
  );
}

export function PriorityIcon({ priority }: { priority: Priority | null }) {
  if (!priority) return null;
  const arrow = { Highest: '⇈', High: '↑', Medium: '=', Low: '↓', Lowest: '⇊' }[priority.name] ?? '=';
  return <span className="prio" style={{ color: priority.color }} title={`Priority: ${priority.name}`} aria-label={`Priority: ${priority.name}`}>{arrow}</span>;
}

/** Render the stored ADF document (subset produced by the server sanitiser). */
export function AdfView({ doc, empty = null }: { doc: Adf | null | undefined; empty?: ReactNode }) {
  if (!doc?.content?.length) return <>{empty}</>;
  const render = (n: Adf, i: number): ReactNode => {
    const kids = n.content?.map(render);
    switch (n.type) {
      case 'paragraph': return <p key={i}>{kids}</p>;
      case 'heading': { const H = `h${Math.min(6, (n.attrs?.level ?? 1) + 2)}` as 'h3'; return <H key={i}>{kids}</H>; }
      case 'bulletList': return <ul key={i}>{kids}</ul>;
      case 'orderedList': return <ol key={i}>{kids}</ol>;
      case 'listItem': return <li key={i}>{kids}</li>;
      case 'codeBlock': return <pre key={i}><code>{kids}</code></pre>;
      case 'blockquote': return <blockquote key={i}>{kids}</blockquote>;
      case 'hardBreak': return <br key={i} />;
      case 'rule': return <hr key={i} />;
      case 'mention': {
        const t = String(n.attrs?.text ?? '');
        return <span key={i} className="mention">{t.startsWith('@') ? t : `@${t}`}</span>;
      }
      case 'text': {
        let el: ReactNode = n.text;
        for (const m of n.marks ?? []) {
          if (m.type === 'strong') el = <strong>{el}</strong>;
          else if (m.type === 'em') el = <em>{el}</em>;
          else if (m.type === 'code') el = <code>{el}</code>;
          else if (m.type === 'strike') el = <s>{el}</s>;
          else if (m.type === 'link') el = <a href={m.attrs?.href} target="_blank" rel="noreferrer">{el}</a>;
        }
        return <span key={i}>{el}</span>;
      }
      default: return <span key={i}>{kids}</span>;
    }
  };
  return <div className="adf">{doc.content.map(render)}</div>;
}

/** ADF → editable plain text (inverse of the server's textToAdf for paragraphs and bullet lists). */
export function adfToEditable(doc: Adf | null | undefined): string {
  if (!doc?.content) return '';
  const text = (n: Adf): string =>
    n.type === 'text' ? n.text ?? ''
    : n.type === 'mention' ? String(n.attrs?.text ?? '') // round-trips as "@Name"; the server re-links it
    : (n.content ?? []).map(text).join(n.type === 'hardBreak' ? '\n' : '');
  return doc.content
    .map((b) =>
      b.type === 'bulletList' ? (b.content ?? []).map((li) => `- ${text(li)}`).join('\n')
      : b.type === 'orderedList' ? (b.content ?? []).map((li, i) => `${i + 1}. ${text(li)}`).join('\n')
      : text(b),
    )
    .join('\n\n');
}

export function timeAgo(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}

export const fmtDate = (d: string | null) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';

/** Click-outside-to-close popover used for pickers and menus. */
export function Popover({ open, onClose, children, align = 'left' }: { open: boolean; onClose: () => void; children: ReactNode; align?: 'left' | 'right' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, onClose]);
  if (!open) return null;
  return <div ref={ref} className={`popover popover-${align}`} role="menu">{children}</div>;
}

/** Inline-editable single-line text (summary). Enter saves, Escape cancels. */
export function InlineText({ value, onSave, className, label, disabled }: { value: string; onSave: (v: string) => Promise<unknown>; className?: string; label: string; disabled?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  if (!editing || disabled) {
    return (
      <button type="button" className={`inline-text ${className ?? ''}`} onClick={() => !disabled && setEditing(true)} aria-label={`${label}, edit`} disabled={disabled}>
        {value}
      </button>
    );
  }
  const commit = async () => {
    const v = draft.trim();
    if (v && v !== value) await onSave(v);
    setEditing(false);
  };
  return (
    <input className={`inline-input ${className ?? ''}`} aria-label={label} autoFocus value={draft}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(value); setEditing(false); } }} />
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then((data) => live && setState({ data, loading: false }), (error) => live && setState({ error, loading: false }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { ...state, reload: () => setNonce((n) => n + 1), setData: (data: T) => setState({ data, loading: false }) };
}
