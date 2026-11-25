import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type Dependency, type Issue } from '../api';
import { useShell } from '../Layout';
import { StatusLozenge, TypeIcon } from '../ui';
import { useProject } from './ProjectPages';

/**
 * Timeline (Jira "Timeline"): epics with their child work as rows, bars from start date to due date.
 * Drag a bar to move it, drag its ends to change start/due, click an empty lane to schedule.
 * Epics without their own dates show a dashed bar rolled up from their children.
 * Dependencies ("blocks" links inside the space) are arrows from the end of the blocking work to the start of the
 * blocked work; an arrow is flagged when the blocked work starts before its blocker ends. Drag from a bar's
 * connector dot onto another bar to add one; click an arrow to remove it.
 */
const DAY = 86400_000;
const ROW_H = 40;
const ZOOM = { weeks: 32, months: 12, quarters: 5 } as const; // px per day
type Zoom = keyof typeof ZOOM;

const parse = (d: string) => new Date(`${d}T00:00:00`);
const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const days = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY);
const today = () => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); };

type Row = { issue: Issue; depth: 0 | 1; children?: Issue[] };
type Drag = { key: string; mode: 'move' | 'start' | 'end'; x0: number; start: Date; end: Date; delta: number };
type Linking = { from: string; x1: number; y1: number; x: number; y: number };

export function Timeline() {
  const project = useProject();
  const { version, bump, toast } = useShell();
  const [epics, setEpics] = useState<Issue[]>([]);
  const [children, setChildren] = useState<Issue[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState<Zoom>('weeks');
  const [drag, setDrag] = useState<Drag | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [deps, setDeps] = useState<Dependency[]>([]);
  const [showDeps, setShowDeps] = useState(true);
  const [linking, setLinking] = useState<Linking | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const canEdit = project.myPermissions.includes('EDIT_ISSUES');
  const px = ZOOM[zoom];

  const load = async () => {
    const [e, c, d] = await Promise.all([
      api.search(`project = ${project.key} AND type = Epic ORDER BY rank`, 0, 200),
      api.search(`project = ${project.key} AND parent is not EMPTY AND type != Subtask ORDER BY rank`, 0, 200),
      api.dependencies(project.key),
    ]);
    setEpics(e.issues);
    setChildren(c.issues);
    setDeps(d.dependencies);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [project.key, version]);
  useEffect(() => { setOpen(new Set(epics.map((e) => e.key))); }, [epics.length]);

  const kids = (e: Issue) => children.filter((c) => c.fields.parent?.key === e.key);
  const rows: Row[] = epics.flatMap((e) => [{ issue: e, depth: 0 as const, children: kids(e) }, ...(open.has(e.key) ? kids(e).map((c) => ({ issue: c, depth: 1 as const })) : [])]);

  /** Own dates, or (epics) rolled up from children. */
  const span = (i: Issue, list?: Issue[]): { start: Date; end: Date; rolled: boolean } | null => {
    const s = i.fields.startdate, d = i.fields.duedate;
    if (s || d) return { start: parse(s ?? d!), end: parse(d ?? s!), rolled: false };
    const dated = (list ?? []).filter((c) => c.fields.startdate || c.fields.duedate);
    if (!dated.length) return null;
    const starts = dated.map((c) => parse(c.fields.startdate ?? c.fields.duedate!).getTime());
    const ends = dated.map((c) => parse(c.fields.duedate ?? c.fields.startdate!).getTime());
    return { start: new Date(Math.min(...starts)), end: new Date(Math.max(...ends)), rolled: true };
  };

  const range = useMemo(() => {
    const t = today();
    const all = [...epics, ...children].flatMap((i) => [i.fields.startdate, i.fields.duedate]).filter(Boolean).map((d) => parse(d!).getTime());
    const min = new Date(Math.min(t.getTime() - 14 * DAY, ...all));
    const max = new Date(Math.max(t.getTime() + 45 * DAY, ...all));
    const from = addDays(min, -((min.getDay() + 6) % 7) - 7); // Monday before, plus a week of air
    return { from, n: days(from, max) + 21 };
  }, [epics, children]);
  const x = (d: Date) => days(range.from, d) * px;

  // scroll so today sits near the left third on first render / zoom change
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = Math.max(0, x(today()) - scroller.current.clientWidth / 3);
    // re-run once rows exist: before data loads the scroller isn't rendered
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, range.from.getTime(), epics.length > 0]);

  const header = useMemo(() => {
    const months: { label: string; x: number; w: number }[] = [];
    const ticks: { label: string; x: number }[] = [];
    for (let i = 0; i < range.n; i++) {
      const d = addDays(range.from, i);
      if (d.getDate() === 1 || i === 0) {
        const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
        months.push({ label: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }), x: i * px, w: Math.min(days(d, next), range.n - i) * px });
      }
      if (zoom === 'weeks' && d.getDay() === 1) ticks.push({ label: String(d.getDate()), x: i * px });
      if (zoom === 'months' && d.getDay() === 1) ticks.push({ label: String(d.getDate()), x: i * px });
    }
    return { months, ticks };
  }, [range, px, zoom]);

  const save = async (i: Issue, start: Date, end: Date) => {
    setSaving(i.key);
    try {
      const s = fmt(start), e = fmt(end);
      const oldStart = i.fields.startdate;
      // keep start <= due at every step (the server enforces it)
      if (oldStart && s > oldStart) { await api.editField(i.key, 'duedate', e); await api.editField(i.key, 'startdate', s); }
      else { await api.editField(i.key, 'startdate', s); await api.editField(i.key, 'duedate', e); }
      bump();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : String(err));
      load();
    } finally {
      setSaving(null);
    }
  };

  const onDown = (e: React.PointerEvent, i: Issue, mode: Drag['mode'], sp: { start: Date; end: Date }) => {
    if (!canEdit) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrag({ key: i.key, mode, x0: e.clientX, start: sp.start, end: sp.end, delta: 0 });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const delta = Math.round((e.clientX - drag.x0) / px);
    if (delta !== drag.delta) setDrag({ ...drag, delta });
  };
  const dragged = (d: Drag) => {
    let start = d.start, end = d.end;
    if (d.mode === 'move') { start = addDays(start, d.delta); end = addDays(end, d.delta); }
    if (d.mode === 'start') start = addDays(start, Math.min(d.delta, days(d.start, d.end)));
    if (d.mode === 'end') end = addDays(end, Math.max(d.delta, -days(d.start, d.end)));
    return { start, end };
  };
  const onUp = (i: Issue) => {
    if (!drag || drag.key !== i.key) return;
    const d = drag;
    setDrag(null);
    if (d.delta === 0) return;
    const { start, end } = dragged(d);
    // optimistic
    const patch = (list: Issue[]) => list.map((x) => (x.key === i.key ? { ...x, fields: { ...x.fields, startdate: fmt(start), duedate: fmt(end) } } : x));
    setEpics(patch); setChildren(patch);
    save(i, start, end);
  };

  const width = range.n * px;
  const t = today();

  /** Where each visible row's bar is right now (including a bar being dragged). */
  const geo = new Map<string, { row: number; start: Date; end: Date }>();
  rows.forEach(({ issue: i, children: ch }, row) => {
    let sp = span(i, ch);
    if (sp && drag?.key === i.key) sp = { ...sp, ...dragged(drag) };
    if (sp) geo.set(i.key, { row, start: sp.start, end: sp.end });
  });
  const arrows = deps.flatMap((d) => {
    const a = geo.get(d.blocker), b = geo.get(d.blocked);
    if (!a || !b) return [];
    const x1 = x(a.end) + px, y1 = a.row * ROW_H + ROW_H / 2;
    const x2 = x(b.start), y2 = b.row * ROW_H + ROW_H / 2;
    const conflict = b.start.getTime() <= a.end.getTime();
    // out of the blocker's end, down/up to the target lane, into the blocked bar's start
    const path = x2 - x1 >= 16
      ? `M${x1} ${y1} h8 V${y2} H${x2 - 2}`
      : `M${x1} ${y1} h8 V${y2 > y1 ? y2 - ROW_H / 2 : y2 + ROW_H / 2} H${x2 - 10} V${y2} H${x2 - 2}`;
    return [{ ...d, path, conflict }];
  });
  const conflicts = new Set(arrows.filter((a) => a.conflict).map((a) => a.blocked));
  const hiddenDeps = deps.length - arrows.length;
  const blockedBy = (key: string) => deps.filter((d) => d.blocked === key).map((d) => d.blocker);

  const local = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top - 44 };
  };
  const startLink = (e: React.PointerEvent, key: string) => {
    e.stopPropagation();
    e.preventDefault();
    const g = geo.get(key)!;
    const p = local(e);
    setLinking({ from: key, x1: x(g.end) + px, y1: g.row * ROW_H + ROW_H / 2, ...p });
  };
  const moveLink = (e: React.PointerEvent) => { if (linking) setLinking({ ...linking, ...local(e) }); };
  const endLink = async (e: React.PointerEvent) => {
    if (!linking) return;
    const from = linking.from;
    setLinking(null);
    const target = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-key]')?.dataset.key;
    if (!target || target === from) return;
    if (deps.some((d) => (d.blocker === from && d.blocked === target) || (d.blocker === target && d.blocked === from))) { toast('Those are already linked'); return; }
    try {
      await api.createLink('Blocks', from, target);
      toast(`${from} now blocks ${target}`);
      bump();
    } catch (err) { toast(err instanceof ApiError ? err.message : String(err)); }
  };
  const removeDep = async (d: Dependency) => {
    if (!confirm(`Remove dependency: ${d.blocker} blocks ${d.blocked}?`)) return;
    try { await api.deleteLink(d.id); toast('Dependency removed'); bump(); }
    catch (err) { toast(err instanceof ApiError ? err.message : String(err)); }
  };

  return (
    <div className="timeline">
      <div className="toolbar">
        <div className="seg" role="radiogroup" aria-label="Zoom">
          {(Object.keys(ZOOM) as Zoom[]).map((z) => (
            <button key={z} role="radio" aria-checked={zoom === z} className={zoom === z ? 'on' : ''} onClick={() => setZoom(z)}>{z[0].toUpperCase() + z.slice(1)}</button>
          ))}
        </div>
        <button className="btn subtle" onClick={() => scroller.current && (scroller.current.scrollLeft = Math.max(0, x(today()) - scroller.current.clientWidth / 3))}>Today</button>
        <label className="check small-check"><input type="checkbox" checked={showDeps} onChange={(e) => setShowDeps(e.target.checked)} /> Dependencies</label>
        {showDeps && deps.length > 0 && (
          <span className="muted small" role="status">
            {arrows.length} shown{hiddenDeps ? ` · ${hiddenDeps} with undated or collapsed work` : ''}
            {conflicts.size > 0 && <span className="danger-text"> · ⚠ {conflicts.size} starting before {conflicts.size === 1 ? 'its blocker ends' : 'their blockers end'}</span>}
          </span>
        )}
        <span className="grow" />
        <span className="muted small">{canEdit ? 'Drag bars to reschedule · drag ends to change start/due · click an empty lane to add dates · drag a bar’s dot onto another bar to add a dependency' : 'Read-only'}</span>
      </div>
      {epics.length === 0 ? (
        <div className="panel empty-state"><h2>No epics yet</h2><p className="muted">Create an Epic and give it child work to plan it on the timeline.</p></div>
      ) : (
        <div className="tl">
          <div className="tl-list">
            <div className="tl-head-left">Work</div>
            {rows.map(({ issue: i, depth, children: ch }) => (
              <div key={i.key} className={`tl-row-left depth-${depth}`}>
                {depth === 0 ? (
                  <button className="icon-btn tiny" aria-label={open.has(i.key) ? `Collapse ${i.key}` : `Expand ${i.key}`} aria-expanded={open.has(i.key)}
                    disabled={!ch?.length} onClick={() => setOpen((o) => { const n = new Set(o); n.has(i.key) ? n.delete(i.key) : n.add(i.key); return n; })}>
                    {ch?.length ? (open.has(i.key) ? '▾' : '▸') : '·'}
                  </button>
                ) : <span className="tiny-spacer" />}
                <TypeIcon type={i.fields.issuetype} />
                <Link to={`/browse/${i.key}`} className="tl-name" title={`${i.key} ${i.fields.summary}`}>
                  <span className="key">{i.key}</span> {i.fields.summary}
                </Link>
                {depth === 0 && ch && ch.length > 0 && (
                  <span className="muted small" title="Child work done">{ch.filter((c) => c.fields.status.statusCategory.key === 'done').length}/{ch.length}</span>
                )}
                {showDeps && conflicts.has(i.key) && <span className="danger-text small" title={`Starts before ${blockedBy(i.key).join(', ')} ends`} aria-label="Scheduling conflict">⚠</span>}
                {depth === 1 && <StatusLozenge status={i.fields.status} />}
              </div>
            ))}
          </div>
          <div className="tl-scroll" ref={scroller}>
            <div className="tl-canvas" style={{ width }} ref={canvas} onPointerMove={moveLink} onPointerUp={endLink}>
              <div className="tl-head" style={{ width }}>
                {header.months.map((m) => <div key={m.x} className="tl-month" style={{ left: m.x, width: m.w }}>{zoom === 'quarters' ? m.label.split(' ')[0].slice(0, 3) : m.label}</div>)}
                {header.ticks.map((tk) => <div key={tk.x} className="tl-tick" style={{ left: tk.x }}>{tk.label}</div>)}
              </div>
              {zoom !== 'quarters' && header.ticks.map((tk) => <div key={`g${tk.x}`} className="tl-grid" style={{ left: tk.x }} />)}
              <div className="tl-today" style={{ left: x(t) + px / 2 }} aria-hidden><span>Today</span></div>
              {(showDeps || linking) && (
                <svg className="tl-deps" width={width} height={rows.length * ROW_H} aria-label="Dependencies">
                  <defs>
                    <marker id="tl-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" className="tl-arrowhead" /></marker>
                    <marker id="tl-arrow-bad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" className="tl-arrowhead bad" /></marker>
                  </defs>
                  {showDeps && arrows.map((a) => (
                    <g key={a.id} className={`tl-dep ${a.conflict ? 'bad' : ''}`}>
                      <path d={a.path} className="tl-dep-line" markerEnd={`url(#${a.conflict ? 'tl-arrow-bad' : 'tl-arrow'})`} />
                      <path d={a.path} className="tl-dep-hit" onClick={() => canEdit && removeDep(a)}>
                        <title>{`${a.blocker} blocks ${a.blocked}${a.conflict ? ' — conflict: starts before the blocker ends' : ''}${canEdit ? '\nClick to remove' : ''}`}</title>
                      </path>
                    </g>
                  ))}
                  {linking && <path d={`M${linking.x1} ${linking.y1} L${linking.x} ${linking.y}`} className="tl-dep-draft" markerEnd="url(#tl-arrow)" />}
                </svg>
              )}
              {rows.map(({ issue: i, depth, children: ch }) => {
                let sp = span(i, ch);
                const isDrag = drag?.key === i.key;
                if (sp && isDrag) sp = { ...sp, ...dragged(drag!) };
                const cat = i.fields.status.statusCategory.key;
                return (
                  <div key={i.key} className="tl-lane" data-key={i.key} onPointerMove={onMove} onPointerUp={() => onUp(i)}
                    onClick={(e) => {
                      if (!canEdit || sp || depth === 0 && ch?.length) return;
                      // schedule unscheduled work: click picks the start; one week long
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      const start = addDays(range.from, Math.floor((e.clientX - r.left) / px));
                      save(i, start, addDays(start, 6));
                    }}>
                    {sp ? (
                      <div className={`tl-bar ${depth === 0 ? 'epic' : 'child'} cat-${cat} ${sp.rolled ? 'rolled' : ''} ${isDrag ? 'dragging' : ''} ${saving === i.key ? 'saving' : ''}`}
                        style={{ left: x(sp.start), width: (days(sp.start, sp.end) + 1) * px, ['--type' as any]: i.fields.issuetype.color }}
                        title={`${i.key} ${i.fields.summary}\n${fmt(sp.start)} → ${fmt(sp.end)}${sp.rolled ? ' (from child work)' : ''}`}
                        onPointerDown={(e) => !sp!.rolled && onDown(e, i, 'move', sp!)} role="img"
                        aria-label={`${i.key}: ${sp.start.toLocaleDateString()} to ${sp.end.toLocaleDateString()}${blockedBy(i.key).length ? `, blocked by ${blockedBy(i.key).join(', ')}` : ''}`}>
                        {!sp.rolled && canEdit && <span className="tl-handle l" onPointerDown={(e) => onDown(e, i, 'start', sp!)} />}
                        <span className="tl-bar-label">{cat === 'done' ? '✓ ' : ''}{i.fields.summary}</span>
                        {!sp.rolled && canEdit && <span className="tl-handle r" onPointerDown={(e) => onDown(e, i, 'end', sp!)} />}
                        {canEdit && showDeps && !sp.rolled && <span className="tl-connector" title="Drag onto another bar: this blocks it" onPointerDown={(e) => startLink(e, i.key)} />}
                      </div>
                    ) : canEdit && !(depth === 0 && ch?.length) ? <span className="tl-hint">Click to schedule</span> : null}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
