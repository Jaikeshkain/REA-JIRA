import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type AutoAction, type AutoTrigger, type AutomationRule, type AutomationRun, type CustomField, type Priority, type Project, type Workflow } from '../api';
import { useShell } from '../Layout';
import { timeAgo } from '../ui';

const TRIGGERS: { type: AutoTrigger['type']; label: string }[] = [
  { type: 'issue_created', label: 'Work item created' },
  { type: 'issue_transitioned', label: 'Work item transitioned' },
  { type: 'field_changed', label: 'Field value changed' },
  { type: 'comment_added', label: 'Comment added' },
];
const ACTIONS: { type: AutoAction['type']; label: string }[] = [
  { type: 'transition', label: 'Transition work item' },
  { type: 'assign', label: 'Assign work item' },
  { type: 'set_field', label: 'Edit a field' },
  { type: 'add_label', label: 'Add a label' },
  { type: 'comment', label: 'Add a comment' },
];
const BUILTIN_FIELDS = [['priority', 'Priority'], ['duedate', 'Due date'], ['storypoints', 'Story points']] as const;
const WATCHABLE = [['assignee', 'Assignee'], ['priority', 'Priority'], ['labels', 'Labels'], ['duedate', 'Due date'], ['storypoints', 'Story points'], ['summary', 'Summary'], ['description', 'Description'], ['sprint', 'Sprint']] as const;

type Ctx = { wf: Workflow; fields: CustomField[]; priorities: Priority[]; project: Project };

/** Human-readable "When … If … Then …" line for a rule. */
function describe(r: Pick<AutomationRule, 'trigger' | 'condition' | 'actions'>, c: Ctx) {
  const st = (id?: string | null) => c.wf.statuses.find((s) => s.id === id)?.name ?? 'any status';
  const fieldName = (f: string) =>
    [...BUILTIN_FIELDS, ...WATCHABLE].find(([k]) => k === f)?.[1] ?? c.fields.find((x) => x.id === f)?.name ?? f;
  const t = r.trigger;
  const when =
    t.type === 'issue_created' ? 'work is created'
    : t.type === 'issue_transitioned' ? `work moves${t.fromStatusId ? ` from ${st(t.fromStatusId)}` : ''} to ${t.toStatusId ? st(t.toStatusId) : 'any status'}`
    : t.type === 'field_changed' ? `${fieldName(t.field)} changes`
    : 'someone comments';
  const who = (to: string) => (to === 'reporter' ? 'the reporter' : to === 'initiator' ? 'the person who triggered it' : to === 'unassigned' ? 'nobody' : c.project.members.find((m) => m.accountId === to)?.displayName ?? 'someone');
  const then = r.actions.map((a) =>
    a.type === 'transition' ? `move to ${st(a.statusId)}`
    : a.type === 'assign' ? `assign ${who(a.to)}`
    : a.type === 'set_field' ? `set ${fieldName(a.field)} to ${a.value}`
    : a.type === 'add_label' ? `add label "${a.label}"`
    : `comment "${a.text.length > 40 ? `${a.text.slice(0, 39)}…` : a.text}"`,
  );
  return { when, cond: r.condition, then: then.join(', then ') };
}

export function AutomationEditor({ project }: { project: Project }) {
  const { toast } = useShell();
  const [rules, setRules] = useState<AutomationRule[] | null>(null);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [editing, setEditing] = useState<AutomationRule | 'new' | null>(null);
  const [log, setLog] = useState<AutomationRule | null>(null);
  const load = () => api.rules(project.key).then(setRules, (e) => toast(e.message));
  useEffect(() => {
    load();
    Promise.all([api.workflow(project.key), api.fields(project.key), api.priorities()]).then(([wf, fields, priorities]) => setCtx({ wf, fields, priorities, project }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.key]);
  const err = (e: unknown) => toast(e instanceof ApiError ? e.message : String(e));
  if (!rules || !ctx) return <p className="muted">Loading…</p>;

  return (
    <section className="panel">
      <div className="section-row" style={{ marginTop: 0 }}>
        <h2 className="section-title" style={{ margin: 0 }}>Automation</h2><span className="grow" />
        <button className="btn primary" onClick={() => setEditing('new')}>+ Create rule</button>
      </div>
      <p className="muted small">Rules run right after a change, as the <strong>Automation</strong> user. Changes made by rules don’t trigger other rules, so rules can’t loop. If any action fails, that rule’s changes are undone and the error is logged.</p>
      {rules.length === 0 ? <p className="muted">No rules yet.</p> : (
        <ul className="rules">
          {rules.map((r) => {
            const d = describe(r, ctx);
            return (
              <li key={r.id} className={`rule ${r.enabled ? '' : 'off'}`}>
                <label className="switch" title={r.enabled ? 'Enabled' : 'Disabled'}>
                  <input type="checkbox" role="switch" checked={r.enabled} aria-label={`${r.enabled ? 'Disable' : 'Enable'} ${r.name}`}
                    onChange={(e) => api.updateRule(r.id, { enabled: e.target.checked }).then(load, err)} />
                  <span />
                </label>
                <div className="rule-body">
                  <strong>{r.name}</strong>
                  <div className="rule-flow small">
                    <span><b>When</b> {d.when}</span>
                    {d.cond && <span><b>If</b> <code>{d.cond}</code></span>}
                    <span><b>Then</b> {d.then}</span>
                  </div>
                  <div className="muted small">
                    {r.stats.runs} run{r.stats.runs === 1 ? '' : 's'}{r.stats.errors ? <span className="danger-text"> · {r.stats.errors} failed</span> : null}
                    {r.stats.lastRun && <> · last {timeAgo(r.stats.lastRun)}</>}
                  </div>
                </div>
                <div className="nowrap">
                  <button className="link-btn" onClick={() => setLog(r)}>Audit log</button>{' '}
                  <button className="link-btn" onClick={() => setEditing(r)}>Edit</button>{' '}
                  <button className="link-btn danger-text" onClick={() => confirm(`Delete rule "${r.name}"? Its audit log is deleted too.`) && api.deleteRule(r.id).then(load, err)}>Delete</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {editing && <RuleDialog ctx={ctx} rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {log && <AuditLog rule={log} onClose={() => setLog(null)} />}
    </section>
  );
}

function RuleDialog({ ctx, rule, onClose, onSaved }: { ctx: Ctx; rule: AutomationRule | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(rule?.name ?? '');
  const [trigger, setTrigger] = useState<AutoTrigger>(rule?.trigger ?? { type: 'issue_created' });
  const [condition, setCondition] = useState(rule?.condition ?? '');
  const [actions, setActions] = useState<AutoAction[]>(rule?.actions ?? [{ type: 'add_label', label: '' }]);
  const [error, setError] = useState<string | null>(null);
  const { wf, fields, priorities, project } = ctx;
  const blank = (type: AutoAction['type']): AutoAction =>
    type === 'transition' ? { type, statusId: wf.statuses[0]?.id ?? '' }
    : type === 'assign' ? { type, to: 'reporter' }
    : type === 'set_field' ? { type, field: 'priority', value: priorities[1]?.name ?? 'High' }
    : type === 'add_label' ? { type, label: '' }
    : { type, text: '' };
  const setAction = (i: number, a: AutoAction) => setActions(actions.map((x, j) => (j === i ? a : x)));
  const move = (i: number, d: -1 | 1) => { const n = [...actions]; [n[i], n[i + d]] = [n[i + d], n[i]]; setActions(n); };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = { name, trigger, condition: condition.trim() || null, actions };
    try {
      if (rule) await api.updateRule(rule.id, body);
      else await api.createRule(project.key, body);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}${err.errors && Object.keys(err.errors).length ? ` (${Object.keys(err.errors).join(', ')})` : ''}` : String(err));
    }
  };

  const statusSelect = (value: string | null | undefined, onChange: (v: string | null) => void, anyLabel?: string, label = 'Status') => (
    <select aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      {anyLabel && <option value="">{anyLabel}</option>}
      {wf.statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  );

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" role="dialog" aria-modal="true" aria-label={rule ? 'Edit rule' : 'Create rule'} onSubmit={save}>
        <header className="modal-head"><h1>{rule ? 'Edit rule' : 'Create rule'}</h1><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button></header>
        <div className="modal-body">
          <label>Rule name*<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoFocus /></label>

          <fieldset className="rule-step">
            <legend><span className="step-badge when">When</span> Trigger</legend>
            <select aria-label="Trigger" value={trigger.type} onChange={(e) => {
              const t = e.target.value as AutoTrigger['type'];
              setTrigger(t === 'field_changed' ? { type: t, field: 'assignee' } : t === 'issue_transitioned' ? { type: t, toStatusId: null, fromStatusId: null } : { type: t } as AutoTrigger);
            }}>
              {TRIGGERS.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
            </select>
            {trigger.type === 'issue_transitioned' && (
              <div className="row2">
                <label>From {statusSelect(trigger.fromStatusId, (v) => setTrigger({ ...trigger, fromStatusId: v }), 'Any status', 'From status')}</label>
                <label>To {statusSelect(trigger.toStatusId, (v) => setTrigger({ ...trigger, toStatusId: v }), 'Any status', 'To status')}</label>
              </div>
            )}
            {trigger.type === 'field_changed' && (
              <label>Field
                <select aria-label="Watched field" value={trigger.field} onChange={(e) => setTrigger({ ...trigger, field: e.target.value })}>
                  {WATCHABLE.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  {fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </label>
            )}
          </fieldset>

          <fieldset className="rule-step">
            <legend><span className="step-badge if">If</span> Condition (optional)</legend>
            <input className="jql-input" aria-label="JQL condition" placeholder='e.g. type = Bug AND priority >= High' value={condition} onChange={(e) => setCondition(e.target.value)} spellCheck={false} />
            <span className="muted small">JQL the work item must match. Leave empty to always run.</span>
          </fieldset>

          <fieldset className="rule-step">
            <legend><span className="step-badge then">Then</span> Actions (run in order)</legend>
            {actions.map((a, i) => (
              <div key={i} className="action-row">
                <span className="muted small">{i + 1}.</span>
                <select aria-label={`Action ${i + 1} type`} value={a.type} onChange={(e) => setAction(i, blank(e.target.value as AutoAction['type']))}>
                  {ACTIONS.map((x) => <option key={x.type} value={x.type}>{x.label}</option>)}
                </select>
                {a.type === 'transition' && statusSelect(a.statusId, (v) => setAction(i, { ...a, statusId: v ?? '' }), undefined, `Action ${i + 1} status`)}
                {a.type === 'assign' && (
                  <select aria-label={`Action ${i + 1} assignee`} value={a.to} onChange={(e) => setAction(i, { ...a, to: e.target.value })}>
                    <option value="reporter">Reporter</option>
                    <option value="initiator">Person who triggered the rule</option>
                    <option value="unassigned">Unassigned</option>
                    {project.members.filter((m) => m.role === 'admin' || m.role === 'member').map((m) => <option key={m.accountId} value={m.accountId}>{m.displayName}</option>)}
                  </select>
                )}
                {a.type === 'set_field' && (
                  <>
                    <select aria-label={`Action ${i + 1} field`} value={a.field} onChange={(e) => setAction(i, { ...a, field: e.target.value, value: '' })}>
                      {BUILTIN_FIELDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      {fields.filter((f) => f.type !== 'multiselect' && f.type !== 'user').map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>
                    {a.field === 'priority' ? (
                      <select aria-label={`Action ${i + 1} value`} value={a.value} onChange={(e) => setAction(i, { ...a, value: e.target.value })}>
                        {priorities.map((p) => <option key={p.id}>{p.name}</option>)}
                      </select>
                    ) : fields.find((f) => f.id === a.field)?.type === 'select' ? (
                      <select aria-label={`Action ${i + 1} value`} value={a.value} onChange={(e) => setAction(i, { ...a, value: e.target.value })}>
                        <option value="">Choose…</option>
                        {fields.find((f) => f.id === a.field)!.options.map((o) => <option key={o.id} value={o.id}>{o.value}</option>)}
                      </select>
                    ) : (
                      <input aria-label={`Action ${i + 1} value`} value={a.value ?? ''} onChange={(e) => setAction(i, { ...a, value: e.target.value })}
                        placeholder={a.field === 'duedate' ? '+7d or 2026-12-31' : a.field === 'storypoints' ? '3' : 'value'} />
                    )}
                  </>
                )}
                {a.type === 'add_label' && <input aria-label={`Action ${i + 1} label`} value={a.label} onChange={(e) => setAction(i, { ...a, label: e.target.value.replace(/\s+/g, '-') })} placeholder="label" required />}
                {a.type === 'comment' && (
                  <textarea aria-label={`Action ${i + 1} comment`} rows={2} value={a.text} onChange={(e) => setAction(i, { ...a, text: e.target.value })}
                    placeholder="Use {{issue.key}}, {{issue.summary}}, {{issue.status}}, {{initiator}}" required />
                )}
                <span className="action-ctl">
                  <button type="button" className="icon-btn tiny" aria-label={`Move action ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button type="button" className="icon-btn tiny" aria-label={`Move action ${i + 1} down`} disabled={i === actions.length - 1} onClick={() => move(i, 1)}>↓</button>
                  <button type="button" className="icon-btn tiny" aria-label={`Remove action ${i + 1}`} disabled={actions.length === 1} onClick={() => setActions(actions.filter((_, j) => j !== i))}>✕</button>
                </span>
              </div>
            ))}
            {actions.length < 10 && <button type="button" className="link-btn" onClick={() => setActions([...actions, blank('comment')])}>+ Add action</button>}
          </fieldset>
          <p className="muted small rule-preview">
            {(() => { const d = describe({ trigger, condition, actions }, ctx); return <>When {d.when}{d.cond ? <>, if <code>{d.cond}</code></> : null}, then {d.then}.</>; })()}
          </p>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <footer className="modal-foot"><span className="grow" />
          <button type="button" className="btn subtle" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!name.trim()}>{rule ? 'Save rule' : 'Turn it on'}</button>
        </footer>
      </form>
    </div>
  );
}

const STATUS_LABEL = { success: 'Success', no_action: 'No action', error: 'Failed' } as const;

function AuditLog({ rule, onClose }: { rule: AutomationRule; onClose: () => void }) {
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  useEffect(() => { api.ruleRuns(rule.id).then(setRuns); }, [rule.id]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`Audit log: ${rule.name}`}>
        <header className="modal-head"><h1>Audit log · {rule.name}</h1><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button></header>
        <div className="modal-body">
          {!runs ? <p className="muted">Loading…</p> : runs.length === 0 ? <p className="muted">This rule hasn’t run yet.</p> : <RunList runs={runs} showIssue />}
        </div>
        <footer className="modal-foot"><span className="grow" /><button className="btn" onClick={onClose}>Close</button></footer>
      </div>
    </div>
  );
}

export function RunList({ runs, showIssue, showRule }: { runs: AutomationRun[]; showIssue?: boolean; showRule?: boolean }) {
  return (
    <ul className="runs">
      {runs.map((r) => (
        <li key={r.id}>
          <span className={`run-status ${r.status}`}>{r.status === 'success' ? '✓' : r.status === 'error' ? '!' : '–'} {STATUS_LABEL[r.status]}</span>
          <div className="run-body">
            {showRule && <strong>{r.rule.name}</strong>}
            {showIssue && r.issue && <span><Link to={`/browse/${r.issue.key}`} className="key">{r.issue.key}</Link> {r.issue.summary}</span>}
            <span className="small">{r.message}</span>
            {r.actions.length > 0 && <span className="muted small">{r.actions.join(' · ')}</span>}
            <span className="muted small">{timeAgo(r.created)}{r.initiator ? ` · triggered by ${r.initiator.displayName}` : ''}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
