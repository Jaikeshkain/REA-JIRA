import { useEffect, useState } from 'react';
import type { CustomField, Issue, Priority, User } from './api';

/** Issue JSON → the raw value an input edits (option ids, account ids, plain scalars). */
export function rawValue(f: CustomField, v: any): any {
  if (v == null) return f.type === 'multiselect' ? [] : '';
  if (f.type === 'select') return v.id ?? '';
  if (f.type === 'multiselect') return (v as { id: string }[]).map((o) => o.id);
  if (f.type === 'user') return v.accountId ?? '';
  return v;
}

/** A value already in input form (dialog state): user picks are stored as {accountId}. */
export const inputValue = (v: any) => (v && typeof v === 'object' && !Array.isArray(v) ? v.accountId ?? '' : v ?? '');

export function displayValue(f: CustomField, v: any): string {
  if (v == null || (Array.isArray(v) && !v.length)) return '';
  if (f.type === 'select') return v.value;
  if (f.type === 'multiselect') return (v as { value: string }[]).map((o) => o.value).join(', ');
  if (f.type === 'user') return v.displayName;
  return String(v);
}

/**
 * One input per custom field type. Text-like inputs commit on blur/Enter (so History gets one entry per edit),
 * choice inputs commit on change.
 */
export function CustomFieldInput({ field, value, users, disabled, onCommit, autoCommit = true }: {
  field: CustomField; value: any; users: User[]; disabled?: boolean; onCommit: (v: any) => void; autoCommit?: boolean;
}) {
  const [draft, setDraft] = useState<any>(value);
  useEffect(() => setDraft(value), [JSON.stringify(value)]);
  const label = field.name;
  const commitIfChanged = (v: any) => { if (JSON.stringify(v) !== JSON.stringify(value)) onCommit(v); };
  const live = (v: any) => { setDraft(v); if (autoCommit) commitIfChanged(v); else onCommit(v); };
  const blur = () => autoCommit && commitIfChanged(field.type === 'number' ? (draft === '' ? null : Number(draft)) : draft);
  const type = (v: string) => (autoCommit ? setDraft(v) : (setDraft(v), onCommit(field.type === 'number' ? (v === '' ? null : Number(v)) : v)));

  switch (field.type) {
    case 'text':
      return <input aria-label={label} value={draft ?? ''} disabled={disabled} maxLength={255} onChange={(e) => type(e.target.value)} onBlur={blur}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />;
    case 'paragraph':
      return <textarea aria-label={label} rows={3} value={draft ?? ''} disabled={disabled} onChange={(e) => type(e.target.value)} onBlur={blur} />;
    case 'number':
      return <input aria-label={label} type="number" step="any" value={draft ?? ''} disabled={disabled} onChange={(e) => type(e.target.value)} onBlur={blur}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />;
    case 'date':
      return <input aria-label={label} type="date" value={draft ?? ''} disabled={disabled} onChange={(e) => live(e.target.value || null)} />;
    case 'select':
      return (
        <select aria-label={label} value={draft ?? ''} disabled={disabled} onChange={(e) => live(e.target.value || null)}>
          <option value="">None</option>
          {field.options.map((o) => <option key={o.id} value={o.id}>{o.value}</option>)}
        </select>
      );
    case 'multiselect':
      return (
        <div className="checks" role="group" aria-label={label}>
          {field.options.map((o) => {
            const on = (draft ?? []).includes(o.id);
            return (
              <label key={o.id} className="check small-check">
                <input type="checkbox" checked={on} disabled={disabled}
                  onChange={() => live(on ? draft.filter((x: string) => x !== o.id) : [...(draft ?? []), o.id])} /> {o.value}
              </label>
            );
          })}
        </div>
      );
    case 'user':
      return (
        <select aria-label={label} value={draft ?? ''} disabled={disabled} onChange={(e) => live(e.target.value ? { accountId: e.target.value } : null)}>
          <option value="">None</option>
          {users.map((u) => <option key={u.accountId} value={u.accountId}>{u.displayName}</option>)}
        </select>
      );
  }
}

/** Is a required field (built-in id or customfield_N) empty on this issue? Mirrors the server validator. */
export function isMissing(issue: Issue, id: string): boolean {
  const f = issue.fields as any;
  switch (id) {
    case 'assignee': return !f.assignee;
    case 'priority': return !f.priority;
    case 'duedate': return !f.duedate;
    case 'startdate': return !f.startdate;
    case 'storypoints': return f.storypoints == null;
    case 'labels': return !f.labels?.length;
    case 'description': return !f.description?.content?.length;
    default: {
      if (!issue.customFields?.some((c) => c.id === id)) return false; // not applicable to this type
      const v = f[id];
      return v == null || (Array.isArray(v) && v.length === 0);
    }
  }
}

export const BUILTIN_LABELS: Record<string, string> = {
  assignee: 'Assignee', priority: 'Priority', duedate: 'Due date', startdate: 'Start date',
  storypoints: 'Story points', labels: 'Labels', description: 'Description',
};

/** Input for a built-in field inside the transition dialog; returns the PATCH value via onChange. */
export function BuiltinInput({ id, users, priorities, onChange }: { id: string; users: User[]; priorities: Priority[]; onChange: (v: any) => void }) {
  switch (id) {
    case 'assignee':
      return <select aria-label="Assignee" defaultValue="" onChange={(e) => onChange(e.target.value ? { accountId: e.target.value } : null)}>
        <option value="">Choose…</option>{users.map((u) => <option key={u.accountId} value={u.accountId}>{u.displayName}</option>)}</select>;
    case 'priority':
      return <select aria-label="Priority" defaultValue="" onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Choose…</option>{priorities.map((p) => <option key={p.id}>{p.name}</option>)}</select>;
    case 'duedate': case 'startdate':
      return <input type="date" aria-label={BUILTIN_LABELS[id]} onChange={(e) => onChange(e.target.value || null)} />;
    case 'storypoints':
      return <input type="number" min={0} step={0.5} aria-label="Story points" onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />;
    case 'labels':
      return <input aria-label="Labels" placeholder="comma or space separated" onChange={(e) => onChange(e.target.value.split(/[\s,]+/).filter(Boolean))} />;
    case 'description':
      return <textarea aria-label="Description" rows={3} onChange={(e) => onChange(e.target.value || null)} />;
    default:
      return null;
  }
}
