import { useRef, useState } from 'react';
import type { User } from './api';
import { Avatar } from './ui';

/**
 * Textarea with @mention suggestions. Typing "@" + letters lists matching people; Enter/Tab/click inserts
 * "@Display Name ", which the server turns into a mention (and a Direct notification).
 */
export function MentionTextarea({ value, onChange, people, label, rows = 3, autoFocus }: {
  value: string; onChange: (v: string) => void; people: User[]; label: string; rows?: number; autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<{ start: number; text: string } | null>(null);
  const [active, setActive] = useState(0);
  const matches = query
    ? people.filter((p) => p.displayName.toLowerCase().split(/\s+/).some((w) => w.startsWith(query.text.toLowerCase())) || p.displayName.toLowerCase().startsWith(query.text.toLowerCase())).slice(0, 6)
    : [];

  const detect = (text: string, caret: number) => {
    const m = /(^|\s)@([\p{L}\p{N}._-]{0,30})$/u.exec(text.slice(0, caret));
    setQuery(m ? { start: caret - m[2].length - 1, text: m[2] } : null);
    setActive(0);
  };

  const insert = (p: User) => {
    if (!query) return;
    const caret = ref.current?.selectionStart ?? value.length;
    const next = `${value.slice(0, query.start)}@${p.displayName} ${value.slice(caret)}`;
    onChange(next);
    setQuery(null);
    const pos = query.start + p.displayName.length + 2;
    requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(pos, pos); });
  };

  return (
    <div className="mention-wrap">
      <textarea ref={ref} rows={rows} value={value} aria-label={label} autoFocus={autoFocus}
        aria-autocomplete="list" aria-expanded={matches.length > 0}
        onChange={(e) => { onChange(e.target.value); detect(e.target.value, e.target.selectionStart); }}
        onKeyDown={(e) => {
          if (!matches.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % matches.length); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + matches.length) % matches.length); }
          else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insert(matches[active]); }
          else if (e.key === 'Escape') { e.stopPropagation(); setQuery(null); }
        }}
        onBlur={() => setTimeout(() => setQuery(null), 150)} />
      {matches.length > 0 && (
        <ul className="mention-list" role="listbox" aria-label="Mention someone">
          {matches.map((p, i) => (
            <li key={p.accountId}>
              <button type="button" role="option" aria-selected={i === active} className={`menu-item ${i === active ? 'on' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); insert(p); }}>
                <Avatar user={p} size={20} /> {p.displayName}
              </button>
            </li>
          ))}
        </ul>
      )}
      <span className="muted small">Type @ to mention someone</span>
    </div>
  );
}
