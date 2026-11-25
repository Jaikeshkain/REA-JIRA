import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type Comment, type Issue, type Priority, type Sprint, type Transition, type User } from '../api';
import { BUILTIN_LABELS, BuiltinInput, CustomFieldInput, inputValue, isMissing, rawValue } from '../fields';
import { useAuth } from '../auth';
import { useShell } from '../Layout';
import { Attachments, LinkedItems } from '../IssueExtras';
import { AdfView, Avatar, InlineText, Popover, PriorityIcon, StatusLozenge, TypeIcon, adfToEditable, fmtDate, timeAgo } from '../ui';

export function IssuePage() {
  const { key = '' } = useParams();
  const { user } = useAuth();
  const { bump, toast } = useShell();
  const nav = useNavigate();
  const [issue, setIssue] = useState<Issue | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [priorities, setPriorities] = useState<Priority[]>([]);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [tab, setTab] = useState<'comments' | 'history'>('comments');
  const [statusOpen, setStatusOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [needs, setNeeds] = useState<{ transition: Transition; fields: string[] } | null>(null);
  const [editDesc, setEditDesc] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);

  const load = async () => {
    try {
      const i = await api.issue(key);
      setIssue(i);
      setComments((await api.comments(key)).comments);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };
  useEffect(() => { load(); setEditDesc(null); setDraft(null); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [key]);
  useEffect(() => {
    if (!issue) return;
    api.assignable(issue.fields.project.key).then(setUsers).catch(() => {});
    api.priorities().then(setPriorities);
    api.sprints(issue.fields.project.key, 'active,future').then(setSprints).catch(() => setSprints([]));
  }, [issue?.fields.project.key]);

  // "m" focuses the comment box (Jira shortcut observed: "press M to comment")
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === 'm' && !/INPUT|TEXTAREA|SELECT/.test(t.tagName) && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setDraft((d) => d ?? ''); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  if (error) return <div className="page"><p className="error">{error}</p><Link to="/for-you">Back to For you</Link></div>;
  if (!issue) return <div className="page"><p className="muted">Loading…</p></div>;
  const f = issue.fields;
  const can = (p: string) => !!issue.permissions?.[p];

  const run = async (fn: () => Promise<Issue | unknown>) => {
    try {
      await fn();
      await load();
      bump();
    } catch (e) {
      setError(null);
      toast(e instanceof ApiError ? e.message : String(e));
    }
  };
  const edit = (field: string, value: unknown, op?: 'SET' | 'ADD' | 'REMOVE') => run(() => api.editField(key, field, value, op));

  return (
    <div className="page issue-page">
      <div className="crumbs">
        <Link to="/projects">Spaces</Link> / <Link to={`/projects/${f.project.key}/board`}>{f.project.name}</Link> /{' '}
        {f.parent && <><Link to={`/browse/${f.parent.key}`}>{f.parent.key}</Link> / </>}
        <TypeIcon type={f.issuetype} /> <span className="key">{issue.key}</span>
        <button className="icon-btn tiny" aria-label="Copy link" onClick={() => { navigator.clipboard?.writeText(location.href); toast('Link copied'); }}>🔗</button>
      </div>
      <div className="issue-layout">
        <div className="issue-main">
          <InlineText className="issue-title" label="Summary" value={f.summary} disabled={!can('EDIT_ISSUES')} onSave={(v) => edit('summary', v)} />

          <h2 className="section-title">Description</h2>
          {editDesc !== null ? (
            <div className="editor">
              <textarea rows={8} value={editDesc} onChange={(e) => setEditDesc(e.target.value)} aria-label="Description" autoFocus />
              <div className="editor-actions">
                <button className="btn primary" onClick={async () => { await edit('description', editDesc || null); setEditDesc(null); }}>Save</button>
                <button className="btn subtle" onClick={() => setEditDesc(null)}>Cancel</button>
                <span className="muted small">Blank line = paragraph · "- " = bullet</span>
              </div>
            </div>
          ) : (
            <div className={`desc ${can('EDIT_ISSUES') ? 'editable' : ''}`} role={can('EDIT_ISSUES') ? 'button' : undefined} tabIndex={can('EDIT_ISSUES') ? 0 : -1}
              onClick={() => can('EDIT_ISSUES') && setEditDesc(adfToEditable(f.description))}
              onKeyDown={(e) => e.key === 'Enter' && can('EDIT_ISSUES') && setEditDesc(adfToEditable(f.description))}>
              <AdfView doc={f.description} empty={<span className="muted">Add a description…</span>} />
            </div>
          )}

          <Attachments issue={issue} canAdd={can('CREATE_ATTACHMENTS')} canDeleteOwn={can('DELETE_OWN_ATTACHMENTS')}
            canDeleteAll={can('DELETE_ALL_ATTACHMENTS')} onChange={() => { load(); bump(); }} onError={toast} />

          {(issue.children?.length ?? 0) > 0 || f.issuetype.hierarchyLevel >= 0 ? (
            <>
              <h2 className="section-title">{f.issuetype.hierarchyLevel === 1 ? 'Child work items' : 'Subtasks'}</h2>
              <ul className="child-list">
                {issue.children?.map((c) => (
                  <li key={c.key}>
                    <TypeIcon type={c.fields.issuetype} /> <Link to={`/browse/${c.key}`} className="key">{c.key}</Link>
                    <span className="grow">{c.fields.summary}</span>
                    <PriorityIcon priority={c.fields.priority} /><Avatar user={c.fields.assignee} size={20} /><StatusLozenge status={c.fields.status} />
                  </li>
                ))}
              </ul>
              {can('EDIT_ISSUES') && <ChildCreator parent={issue} onCreated={() => { load(); bump(); }} />}
            </>
          ) : null}

          <LinkedItems issue={issue} canLink={can('LINK_ISSUES')} onChange={() => { load(); bump(); }} onError={toast} />

          <h2 className="section-title">Activity</h2>
          <div className="tabs small" role="tablist">
            <button role="tab" aria-selected={tab === 'comments'} className={tab === 'comments' ? 'on' : ''} onClick={() => setTab('comments')}>Comments</button>
            <button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>History</button>
          </div>
          {tab === 'comments' ? (
            <div className="comments">
              {can('ADD_COMMENTS') && (
                <div className="comment-new">
                  <Avatar user={user} size={28} />
                  {draft === null ? (
                    <button className="fake-input" onClick={() => setDraft('')}>Add a comment…</button>
                  ) : (
                    <div className="editor grow">
                      <textarea rows={3} autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Comment" />
                      <div className="editor-actions">
                        <button className="btn primary" disabled={!draft.trim()}
                          onClick={() => run(async () => { await api.addComment(key, draft); setDraft(null); })}>Save</button>
                        <button className="btn subtle" onClick={() => setDraft(null)}>Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {draft === null && can('ADD_COMMENTS') && <p className="muted small tip"><strong>Pro tip:</strong> press <kbd>M</kbd> to comment</p>}
              {comments.map((c) => (
                <CommentItem key={c.id} c={c} mine={c.author.accountId === user?.accountId} issueKey={key} onChange={() => run(async () => {})} />
              ))}
            </div>
          ) : (
            <ul className="history">
              {issue.changelog?.map((h) => (
                <li key={h.id}>
                  <Avatar user={h.author} size={22} />
                  <div>
                    <strong>{h.author.displayName}</strong>{' '}
                    {h.items[0].field === 'created' ? 'created the work item' : <>changed the <strong>{h.items[0].field}</strong></>}
                    <span className="muted small"> · {timeAgo(h.created)}</span>
                    {h.items[0].field !== 'created' && (
                      <div className="change"><span className="old">{h.items[0].fromString ?? 'None'}</span> → <span>{h.items[0].toString ?? 'None'}</span></div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <aside className="issue-side">
          <div className="side-actions">
            <div className="menu-anchor">
              <button className={`status-btn cat-${f.status.statusCategory.key}`} disabled={!can('TRANSITION_ISSUES')}
                onClick={() => setStatusOpen((o) => !o)} aria-haspopup="menu" aria-expanded={statusOpen} aria-label={`Status: ${f.status.name}`}>
                {f.status.name} ▾
              </button>
              <Popover open={statusOpen} onClose={() => setStatusOpen(false)}>
                {issue.transitions?.filter((t) => t.to.id !== f.status.id).map((t) => (
                  <button key={t.id} role="menuitem" className="menu-item" onClick={() => {
                    setStatusOpen(false);
                    // validator: ask for required fields that are still empty before moving
                    const missing = (t.requiredFields ?? []).filter((id) => isMissing(issue, id));
                    if (missing.length) setNeeds({ transition: t, fields: missing });
                    else run(() => api.transition(key, t.id));
                  }}>
                    <StatusLozenge status={t.to} />
                  </button>
                ))}
              </Popover>
            </div>
            <button className="btn subtle" onClick={() => run(() => api.watch(key, !f.watches.isWatching))} aria-pressed={!!f.watches.isWatching}>
              {f.watches.isWatching ? '👁 Watching' : '👁 Watch'} {f.watches.watchCount}
            </button>
            <div className="menu-anchor">
              <button className="icon-btn" aria-label="More actions" onClick={() => setMoreOpen((o) => !o)}>⋯</button>
              <Popover open={moreOpen} onClose={() => setMoreOpen(false)} align="right">
                {can('DELETE_ISSUES') && (
                  <button className="menu-item danger" onClick={async () => {
                    setMoreOpen(false);
                    if (!confirm(`Delete ${key}${issue.children?.length ? ` and its ${issue.children.length} child item(s)` : ''}? This can't be undone.`)) return;
                    await api.deleteIssue(key);
                    bump();
                    toast(`Deleted ${key}`);
                    nav(`/projects/${f.project.key}/board`);
                  }}>Delete</button>
                )}
                <button className="menu-item" onClick={() => { setMoreOpen(false); navigator.clipboard?.writeText(key); toast('Key copied'); }}>Copy key</button>
              </Popover>
            </div>
          </div>

          <section className="details">
            <h2>Details</h2>
            <Field label="Assignee">
              <select value={f.assignee?.accountId ?? ''} disabled={!can('ASSIGN_ISSUES')} aria-label="Assignee"
                onChange={(e) => edit('assignee', e.target.value ? { accountId: e.target.value } : null)}>
                <option value="">Unassigned</option>
                {users.map((u) => <option key={u.accountId} value={u.accountId}>{u.displayName}</option>)}
              </select>
              {can('ASSIGN_ISSUES') && f.assignee?.accountId !== user?.accountId && (
                <button className="link-btn" onClick={() => edit('assignee', { accountId: user!.accountId })}>Assign to me</button>
              )}
            </Field>
            <Field label="Parent">
              {f.parent ? <Link to={`/browse/${f.parent.key}`}>{f.parent.key} {f.parent.summary}</Link> : <span className="muted">None</span>}
              {can('EDIT_ISSUES') && f.issuetype.hierarchyLevel === 0 && <ParentPicker issue={issue} onPick={(k) => edit('parent', k)} />}
            </Field>
            {f.issuetype.hierarchyLevel === 0 && (sprints.length > 0 || f.sprint) && (
              <Field label="Sprint">
                {f.sprint?.state === 'closed' ? (
                  <span>{f.sprint.name} <span className="muted small">(closed)</span></span>
                ) : (
                  <select value={f.sprint?.id ?? ''} disabled={!can('EDIT_ISSUES')} aria-label="Sprint" onChange={(e) => edit('sprint', e.target.value || null)}>
                    <option value="">Backlog (no sprint)</option>
                    {sprints.map((s) => <option key={s.id} value={s.id}>{s.name}{s.state === 'active' ? ' (active)' : ''}</option>)}
                  </select>
                )}
              </Field>
            )}
            <Field label="Priority">
              <select value={f.priority?.name ?? ''} disabled={!can('EDIT_ISSUES')} aria-label="Priority" onChange={(e) => edit('priority', e.target.value)}>
                {priorities.map((p) => <option key={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Labels">
              <div className="labels">
                {f.labels.map((l) => (
                  <span key={l} className="label">{l}{can('EDIT_ISSUES') && <button className="x" aria-label={`Remove label ${l}`} onClick={() => edit('labels', [l], 'REMOVE')}>×</button>}</span>
                ))}
                {can('EDIT_ISSUES') && <LabelAdder onAdd={(l) => edit('labels', [l], 'ADD')} />}
              </div>
            </Field>
            <Field label="Due date">
              <input type="date" value={f.duedate ?? ''} disabled={!can('EDIT_ISSUES')} aria-label="Due date" onChange={(e) => edit('duedate', e.target.value || null)} />
            </Field>
            <Field label="Start date">
              <input type="date" value={f.startdate ?? ''} disabled={!can('EDIT_ISSUES')} aria-label="Start date" onChange={(e) => edit('startdate', e.target.value || null)} />
            </Field>
            <Field label="Story points">
              <input type="number" min={0} step={0.5} defaultValue={f.storypoints ?? ''} key={String(f.storypoints)} disabled={!can('EDIT_ISSUES')} aria-label="Story points"
                onBlur={(e) => String(f.storypoints ?? '') !== e.target.value && edit('storypoints', e.target.value === '' ? null : Number(e.target.value))} />
            </Field>
            {issue.customFields?.map((cf) => (
              <Field key={cf.id} label={cf.name + (cf.required ? ' *' : '')}>
                <CustomFieldInput field={cf} value={rawValue(cf, (f as any)[cf.id])} users={users} disabled={!can('EDIT_ISSUES')}
                  onCommit={(v) => edit(cf.id, v)} />
              </Field>
            ))}
            <Field label="Reporter"><span className="user-cell"><Avatar user={f.reporter} size={20} /> {f.reporter?.displayName}</span></Field>
            <Field label="Resolution">{f.resolution?.name ?? 'Unresolved'}</Field>
          </section>
          <p className="muted small">Created {timeAgo(f.created)}<br />Updated {timeAgo(f.updated)}{f.duedate ? <><br />Due {fmtDate(f.duedate)}</> : null}</p>
        </aside>
      </div>
      {needs && (
        <TransitionFields issue={issue} users={users} priorities={priorities} transition={needs.transition} fields={needs.fields}
          onClose={() => setNeeds(null)}
          onDone={() => { setNeeds(null); load(); bump(); }} />
      )}
    </div>
  );
}

/** Transition screen: fill the fields a workflow rule requires, then move the work item. */
function TransitionFields({ issue, users, priorities, transition, fields, onClose, onDone }: {
  issue: Issue; users: User[]; priorities: Priority[]; transition: Transition; fields: string[]; onClose: () => void; onDone: () => void;
}) {
  const [values, setValues] = useState<Record<string, any>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cfs = issue.customFields ?? [];
  const ready = fields.every((id) => {
    const v = values[id];
    return v != null && v !== '' && !(Array.isArray(v) && v.length === 0);
  });
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal narrow" role="dialog" aria-modal="true" aria-label={`Move to ${transition.to.name}`} onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          for (const id of fields) await api.editField(issue.key, id, values[id]);
          await api.transition(issue.key, transition.id);
          onDone();
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}>
        <header className="modal-head"><h1>Move to <StatusLozenge status={transition.to} /></h1>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button></header>
        <div className="modal-body">
          <p className="muted">This step needs a few more details first.</p>
          {fields.map((id) => {
            const cf = cfs.find((c) => c.id === id);
            return (
              <label key={id}>{cf?.name ?? BUILTIN_LABELS[id] ?? id}*
                {cf
                  ? <CustomFieldInput field={cf} value={values[id] == null ? (cf.type === 'multiselect' ? [] : '') : inputValue(values[id])} users={users} autoCommit={false} onCommit={(v) => setValues((x) => ({ ...x, [id]: v }))} />
                  : <BuiltinInput id={id} users={users} priorities={priorities} onChange={(v) => setValues((x) => ({ ...x, [id]: v }))} />}
              </label>
            );
          })}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <footer className="modal-foot"><span className="grow" />
          <button type="button" className="btn subtle" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!ready || busy}>{busy ? 'Moving…' : transition.name}</button>
        </footer>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="field"><span className="field-label">{label}</span><div className="field-value">{children}</div></div>;
}

function LabelAdder({ onAdd }: { onAdd: (l: string) => void }) {
  const [v, setV] = useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); const l = v.trim().replace(/\s+/g, '-'); if (l) onAdd(l); setV(''); }}>
      <input className="label-input" placeholder="+ label" value={v} onChange={(e) => setV(e.target.value)} aria-label="Add label" />
    </form>
  );
}

function ParentPicker({ issue, onPick }: { issue: Issue; onPick: (key: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [epics, setEpics] = useState<Issue[]>([]);
  useEffect(() => {
    if (open) api.search(`project = ${issue.fields.project.key} AND type = Epic ORDER BY created DESC`).then((r) => setEpics(r.issues));
  }, [open, issue.fields.project.key]);
  return (
    <span className="menu-anchor">
      <button className="link-btn" onClick={() => setOpen((o) => !o)}>Change</button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <button className="menu-item" onClick={() => { setOpen(false); onPick(null); }}>No parent</button>
        {epics.map((e) => <button key={e.key} className="menu-item" onClick={() => { setOpen(false); onPick(e.key); }}><TypeIcon type={e.fields.issuetype} /> {e.key} {e.fields.summary}</button>)}
      </Popover>
    </span>
  );
}

function ChildCreator({ parent, onCreated }: { parent: Issue; onCreated: () => void }) {
  const [summary, setSummary] = useState('');
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const childType = parent.fields.issuetype.hierarchyLevel === 1 ? 'Task' : 'Subtask';
  if (!open) return <button className="link-btn" onClick={() => setOpen(true)}>+ Add {childType === 'Task' ? 'child work item' : 'subtask'}</button>;
  return (
    <form className="inline-form" onSubmit={async (e) => {
      e.preventDefault();
      try {
        await api.createIssue({ project: { key: parent.fields.project.key }, issuetype: { name: childType }, summary, parent: { key: parent.key } });
        setSummary(''); setOpen(false); onCreated();
      } catch (ex) { setErr(ex instanceof ApiError ? ex.message : String(ex)); }
    }}>
      <input autoFocus value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What needs to be done?" aria-label="Child summary" required />
      <button className="btn primary">Create</button>
      <button type="button" className="btn subtle" onClick={() => setOpen(false)}>Cancel</button>
      {err && <span className="error">{err}</span>}
    </form>
  );
}

function CommentItem({ c, mine, issueKey, onChange }: { c: Comment; mine: boolean; issueKey: string; onChange: () => void }) {
  const [edit, setEdit] = useState<string | null>(null);
  return (
    <div className="comment">
      <Avatar user={c.author} size={28} />
      <div className="grow">
        <div><strong>{c.author.displayName}</strong> <span className="muted small">{timeAgo(c.created)}{c.updated !== c.created ? ' · edited' : ''}</span></div>
        {edit !== null ? (
          <div className="editor">
            <textarea rows={3} value={edit} onChange={(e) => setEdit(e.target.value)} aria-label="Edit comment" />
            <div className="editor-actions">
              <button className="btn primary" onClick={async () => { await api.editComment(issueKey, c.id, edit); setEdit(null); onChange(); }}>Save</button>
              <button className="btn subtle" onClick={() => setEdit(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <AdfView doc={c.body} />
        )}
        {mine && edit === null && (
          <div className="comment-actions">
            <button className="link-btn" onClick={() => setEdit(adfToEditable(c.body))}>Edit</button>
            <button className="link-btn" onClick={async () => { if (confirm('Delete this comment?')) { await api.deleteComment(issueKey, c.id); onChange(); } }}>Delete</button>
          </div>
        )}
      </div>
    </div>
  );
}
