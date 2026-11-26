import { useEffect, useState } from 'react';
import { api, ApiError, type CfType, type CustomField, type Project, type Workflow } from '../api';
import { useShell } from '../Layout';
import { StatusLozenge, TypeIcon } from '../ui';

const TYPE_LABEL: Record<CfType, string> = {
  text: 'Short text', paragraph: 'Paragraph', number: 'Number', date: 'Date', select: 'Dropdown', multiselect: 'Checkboxes', user: 'People',
};
const ROLES = ['admin', 'member', 'viewer', 'guest'] as const;

// ------------------------------------------------------------------ Fields

export function FieldsEditor({ project }: { project: Project }) {
  const { toast } = useShell();
  const [fields, setFields] = useState<CustomField[]>([]);
  const [editing, setEditing] = useState<CustomField | 'new' | null>(null);
  const load = () => api.fields(project.key).then(setFields);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [project.key]);
  const err = (e: unknown) => toast(e instanceof ApiError ? e.message : String(e));
  const typeName = (ids: string[] | null) =>
    !ids ? 'All work types' : ids.map((id) => project.issueTypes.find((t) => t.id === id)?.name).filter(Boolean).join(', ');

  return (
    <section className="panel">
      <div className="section-row" style={{ marginTop: 0 }}>
        <h2 className="section-title" style={{ margin: 0 }}>Fields</h2><span className="grow" />
        <button className="btn primary" onClick={() => setEditing('new')}>+ Add field</button>
      </div>
      <p className="muted small">Custom fields appear on the create dialog and in the issue Details panel. Search them in JQL by name, e.g. <code>"Severity" = "S1 - Critical"</code>.</p>
      {fields.length === 0 ? <p className="muted">No custom fields yet.</p> : (
        <table className="table">
          <thead><tr><th>Name</th><th>Type</th><th>Applies to</th><th>Required</th><th aria-label="Actions" /></tr></thead>
          <tbody>{fields.map((f, i) => (
            <tr key={f.id}>
              <td><strong>{f.name}</strong>{f.description && <div className="muted small">{f.description}</div>}
                {f.options.length > 0 && <div className="muted small">{f.options.map((o) => o.value).join(' · ')}</div>}</td>
              <td>{TYPE_LABEL[f.type]}</td>
              <td>{typeName(f.issueTypeIds)}</td>
              <td>{f.required ? 'Yes' : 'No'}</td>
              <td className="nowrap">
                <button className="icon-btn tiny" aria-label={`Move ${f.name} up`} disabled={i === 0} onClick={() => api.updateField(f.fieldId, { position: i - 1 }).then(load, err)}>↑</button>
                <button className="icon-btn tiny" aria-label={`Move ${f.name} down`} disabled={i === fields.length - 1} onClick={() => api.updateField(f.fieldId, { position: i + 1 }).then(load, err)}>↓</button>
                <button className="link-btn" onClick={() => setEditing(f)}>Edit</button>{' '}
                <button className="link-btn danger-text" onClick={() => {
                  if (confirm(`Delete field "${f.name}"? Its values on every work item are removed. This can't be undone.`)) api.deleteField(f.fieldId).then(load, err);
                }}>Delete</button>
              </td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {editing && (
        <FieldDialog project={project} field={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }} />
      )}
    </section>
  );
}

function FieldDialog({ project, field, onClose, onSaved }: { project: Project; field: CustomField | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(field?.name ?? '');
  const [description, setDescription] = useState(field?.description ?? '');
  const [type, setType] = useState<CfType>(field?.type ?? 'text');
  const [required, setRequired] = useState(field?.required ?? false);
  const [allTypes, setAllTypes] = useState(!field?.issueTypeIds);
  const [typeIds, setTypeIds] = useState<string[]>(field?.issueTypeIds ?? []);
  const [options, setOptions] = useState<{ id?: string; value: string }[]>(field?.options.length ? field.options : [{ value: '' }, { value: '' }]);
  const [error, setError] = useState<string | null>(null);
  const choice = type === 'select' || type === 'multiselect';
  const types = project.issueTypes.filter((t) => t.hierarchyLevel >= -1);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = {
      name, description, required,
      issueTypeIds: allTypes ? null : typeIds,
      ...(choice ? { options: options.filter((o) => o.value.trim()) } : {}),
    };
    try {
      if (field) await api.updateField(field.fieldId, body);
      else await api.createField(project.key, { ...body, type });
      onSaved();
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal narrow" role="dialog" aria-modal="true" aria-label={field ? 'Edit field' : 'Add field'} onSubmit={save}>
        <header className="modal-head"><h1>{field ? `Edit ${field.name}` : 'Add field'}</h1><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button></header>
        <div className="modal-body">
          <label>Name*<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} autoFocus /></label>
          <label>Type
            <select value={type} onChange={(e) => setType(e.target.value as CfType)} disabled={!!field}>
              {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            {field && <span className="muted small">A field’s type can’t change after it’s created.</span>}
          </label>
          <label>Description<input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} /></label>
          {choice && (
            <fieldset className="radio-group">
              <legend>Options</legend>
              {options.map((o, i) => (
                <div key={o.id ?? `new-${i}`} className="option-row">
                  <input aria-label={`Option ${i + 1}`} value={o.value} onChange={(e) => setOptions(options.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                  <button type="button" className="icon-btn tiny" aria-label={`Remove option ${i + 1}`} disabled={options.length <= 1}
                    onClick={() => setOptions(options.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
              <button type="button" className="link-btn" onClick={() => setOptions([...options, { value: '' }])}>+ Add option</button>
              {field && <span className="muted small">Removing an option clears it from work items that use it.</span>}
            </fieldset>
          )}
          <fieldset className="radio-group">
            <legend>Applies to</legend>
            <label className="check"><input type="checkbox" checked={allTypes} onChange={(e) => setAllTypes(e.target.checked)} /> All work types</label>
            {!allTypes && types.map((t) => (
              <label key={t.id} className="check">
                <input type="checkbox" checked={typeIds.includes(t.id)} onChange={(e) => setTypeIds(e.target.checked ? [...typeIds, t.id] : typeIds.filter((x) => x !== t.id))} />
                <TypeIcon type={t} /> {t.name}
              </label>
            ))}
          </fieldset>
          <label className="check"><input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Required when creating work</label>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <footer className="modal-foot"><span className="grow" />
          <button type="button" className="btn subtle" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!name.trim() || (!allTypes && !typeIds.length)}>{field ? 'Save' : 'Add field'}</button>
        </footer>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ Workflow

export function WorkflowEditor({ project }: { project: Project }) {
  const { toast, bump } = useShell();
  const [wf, setWf] = useState<Workflow | null>(null);
  const [newStatus, setNewStatus] = useState({ name: '', category: 'in_progress' });
  const [adding, setAdding] = useState(false);
  const [rules, setRules] = useState<Workflow['transitions'][number] | null>(null);
  const [removing, setRemoving] = useState<Workflow['statuses'][number] | null>(null);
  useEffect(() => { api.workflow(project.key).then(setWf); }, [project.key]);
  const apply = (p: Promise<Workflow>) => p.then((w) => { setWf(w); bump(); }, (e) => toast(e instanceof ApiError ? e.message : String(e)));
  if (!wf) return <p className="muted">Loading…</p>;
  const sName = (id: string | null) => (id == null ? 'Any status' : wf.statuses.find((s) => s.id === id)?.name ?? '?');
  const fName = (id: string) => wf.requirableFields.find((f) => f.id === id)?.name ?? id;

  return (
    <>
      <section className="panel">
        <h2>Statuses</h2>
        <p className="muted small">Each status is a board column, left to right. The first status is where new work starts. The category decides colour and whether work counts as done (resolved).</p>
        <table className="table">
          <thead><tr><th>Order</th><th>Status</th><th>Category</th><th>Work items</th><th title="Most work items allowed in this board column">WIP limit</th><th aria-label="Actions" /></tr></thead>
          <tbody>{wf.statuses.map((s, i) => (
            <tr key={s.id}>
              <td className="nowrap">
                <button className="icon-btn tiny" aria-label={`Move ${s.name} left`} disabled={i === 0} onClick={() => apply(api.updateStatus(s.id, { position: i - 1 }))}>↑</button>
                <button className="icon-btn tiny" aria-label={`Move ${s.name} right`} disabled={i === wf.statuses.length - 1} onClick={() => apply(api.updateStatus(s.id, { position: i + 1 }))}>↓</button>
              </td>
              <td><input className="inline-edit" aria-label={`Rename ${s.name}`} defaultValue={s.name} key={s.name}
                onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== s.name && apply(api.updateStatus(s.id, { name: e.target.value.trim() }))}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} /></td>
              <td>
                <select aria-label={`Category of ${s.name}`} value={s.statusCategory.key} onChange={(e) => apply(api.updateStatus(s.id, { category: e.target.value }))}>
                  <option value="todo">To do</option><option value="in_progress">In progress</option><option value="done">Done</option>
                </select>
              </td>
              <td>{s.issueCount}</td>
              <td><input type="number" min={1} max={999} className="inline-small" aria-label={`WIP limit for ${s.name}`} placeholder="None" defaultValue={s.wipLimit ?? ''} key={`w${s.wipLimit}`}
                onBlur={(e) => { const v = e.target.value ? Number(e.target.value) : null; if (v !== (s.wipLimit ?? null)) apply(api.updateStatus(s.id, { wipLimit: v })); }} /></td>
              <td><button className="link-btn danger-text" disabled={wf.statuses.length <= 1}
                onClick={() => (s.issueCount ? setRemoving(s) : confirm(`Delete status "${s.name}"?`) && apply(api.deleteStatus(s.id)))}>Delete</button></td>
            </tr>
          ))}</tbody>
        </table>
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); apply(api.addStatus(project.key, newStatus.name, newStatus.category)).then(() => setNewStatus({ ...newStatus, name: '' })); }}>
          <label>New status<input value={newStatus.name} onChange={(e) => setNewStatus({ ...newStatus, name: e.target.value })} required maxLength={40} /></label>
          <label>Category<select value={newStatus.category} onChange={(e) => setNewStatus({ ...newStatus, category: e.target.value })}>
            <option value="todo">To do</option><option value="in_progress">In progress</option><option value="done">Done</option></select></label>
          <button className="btn">Add status</button>
        </form>
      </section>

      <section className="panel">
        <div className="section-row" style={{ marginTop: 0 }}>
          <h2 className="section-title" style={{ margin: 0 }}>Transitions</h2><span className="grow" />
          <button className="btn" onClick={() => setAdding(true)}>+ Add transition</button>
        </div>
        <p className="muted small">Where work can move. “Any status” transitions are the team-managed default. Rules: required fields must be filled first; restricted transitions are only offered to the listed roles.</p>
        <table className="table">
          <thead><tr><th>From</th><th>To</th><th>Name</th><th>Rules</th><th aria-label="Actions" /></tr></thead>
          <tbody>{wf.transitions.map((t) => {
            const to = wf.statuses.find((s) => s.id === t.to);
            return (
              <tr key={t.id}>
                <td>{sName(t.from)}</td>
                <td>{to && <StatusLozenge status={to} />}</td>
                <td>{t.name}</td>
                <td className="small">
                  {t.requiredFields.length > 0 && <div>Requires: {t.requiredFields.map(fName).join(', ')}</div>}
                  {t.allowedRoles?.length ? <div>Only: {t.allowedRoles.join(', ')}</div> : null}
                  {!t.requiredFields.length && !t.allowedRoles?.length && <span className="muted">None</span>}
                </td>
                <td className="nowrap">
                  <button className="link-btn" onClick={() => setRules(t)}>Rules</button>{' '}
                  <button className="link-btn danger-text" onClick={() => apply(api.deleteTransition(t.id))}>Delete</button>
                </td>
              </tr>
            );
          })}</tbody>
        </table>
        {wf.statuses.filter((s) => !wf.transitions.some((t) => t.to === s.id)).map((s) => (
          <p key={s.id} className="error small">⚠ Nothing can move into “{s.name}”. Add a transition to it.</p>
        ))}
      </section>

      {adding && <TransitionDialog wf={wf} onClose={() => setAdding(false)}
        onSave={(body) => apply(api.addTransition(project.key, body)).then(() => setAdding(false))} />}
      {rules && <TransitionDialog wf={wf} transition={rules} onClose={() => setRules(null)}
        onSave={(body) => apply(api.updateTransition(rules.id, body)).then(() => setRules(null))} />}
      {removing && (
        <MoveWorkDialog status={removing} others={wf.statuses.filter((s) => s.id !== removing.id)} onClose={() => setRemoving(null)}
          onConfirm={(moveTo) => apply(api.deleteStatus(removing.id, moveTo)).then(() => setRemoving(null))} />
      )}
    </>
  );
}

function TransitionDialog({ wf, transition, onClose, onSave }: {
  wf: Workflow; transition?: Workflow['transitions'][number]; onClose: () => void;
  onSave: (b: { name?: string; from: string | null; to: string; requiredFields: string[]; allowedRoles: string[] | null }) => void;
}) {
  const [from, setFrom] = useState<string>(transition?.from ?? '');
  const [to, setTo] = useState(transition?.to ?? wf.statuses[0]?.id ?? '');
  const [name, setName] = useState(transition?.name ?? '');
  const [req, setReq] = useState<string[]>(transition?.requiredFields ?? []);
  const [roles, setRoles] = useState<string[]>(transition?.allowedRoles ?? []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal narrow" role="dialog" aria-modal="true" aria-label={transition ? 'Transition rules' : 'Add transition'}
        onSubmit={(e) => { e.preventDefault(); onSave({ name: name.trim() || undefined, from: from || null, to, requiredFields: req, allowedRoles: roles.length ? roles : null }); }}>
        <header className="modal-head"><h1>{transition ? 'Transition rules' : 'Add transition'}</h1><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button></header>
        <div className="modal-body">
          <div className="row2">
            <label>From<select value={from} onChange={(e) => setFrom(e.target.value)} disabled={!!transition}>
              <option value="">Any status</option>{wf.statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            <label>To<select value={to} onChange={(e) => setTo(e.target.value)} disabled={!!transition}>
              {wf.statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          </div>
          <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Defaults to the target status" maxLength={60} /></label>
          <fieldset className="radio-group">
            <legend>Required fields (validator)</legend>
            <div className="checks">{wf.requirableFields.map((f) => (
              <label key={f.id} className="check small-check"><input type="checkbox" checked={req.includes(f.id)}
                onChange={(e) => setReq(e.target.checked ? [...req, f.id] : req.filter((x) => x !== f.id))} /> {f.name}</label>
            ))}</div>
          </fieldset>
          <fieldset className="radio-group">
            <legend>Who can use it (condition)</legend>
            <div className="checks">{ROLES.map((r) => (
              <label key={r} className="check small-check"><input type="checkbox" checked={roles.includes(r)}
                onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))} /> {r}</label>
            ))}</div>
            <span className="muted small">Leave all unchecked to let anyone who can move work use it.</span>
          </fieldset>
        </div>
        <footer className="modal-foot"><span className="grow" />
          <button type="button" className="btn subtle" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!to || from === to}>{transition ? 'Save rules' : 'Add transition'}</button>
        </footer>
      </form>
    </div>
  );
}

function MoveWorkDialog({ status, others, onClose, onConfirm }: {
  status: Workflow['statuses'][number]; others: Workflow['statuses']; onClose: () => void; onConfirm: (moveTo: string) => void;
}) {
  const [moveTo, setMoveTo] = useState(others[0]?.id ?? '');
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal narrow" role="dialog" aria-modal="true" aria-label={`Delete ${status.name}`} onSubmit={(e) => { e.preventDefault(); onConfirm(moveTo); }}>
        <header className="modal-head"><h1>Delete “{status.name}”</h1><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button></header>
        <div className="modal-body">
          <p>{status.issueCount} work item{status.issueCount === 1 ? ' is' : 's are'} in this status. Move {status.issueCount === 1 ? 'it' : 'them'} to:</p>
          <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} aria-label="Move work to">
            {others.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <p className="muted small">Moves are recorded in each work item’s History. Deleting the status can’t be undone.</p>
        </div>
        <footer className="modal-foot"><span className="grow" />
          <button type="button" className="btn subtle" onClick={onClose}>Cancel</button>
          <button className="btn danger">Move work and delete</button>
        </footer>
      </form>
    </div>
  );
}
