import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type Issue } from '../api';
import { useShell } from '../Layout';
import { StatusLozenge, TypeIcon } from '../ui';
import { useProject } from './ProjectPages';

/**
 * Timeline (Jira "Timeline"): epics with their child work as rows, bars from start date to due date.
 * Drag a bar to move it, drag its ends to change start/due, click an empty lane to schedule.
 * Epics without their own dates show a dashed bar rolled up from their children.
 */
const DAY = 86400_000;
const ZOOM = { weeks: 32, months: 12, quarters: 5 } as const; // px per day
type Zoom = keyof typeof ZOOM;

const parse = (d: string) => new Date(`${d}T00:00:00`);
const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const days = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY);
const today = () => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); };

type Row = { issue: Issue; depth: 0 | 1; children?: Issue[] };
type Drag = { key: string; mode: 'move' | 'start' | 'end'; x0: number; start: Date; end: Date; delta: number };

export function Timeline() {
  const project = useProject();
  const { version, bump, toast } = useShell();
  const [epics, setEpics] = useState<Issue[]>([]);
  const [children, setChildren] = useState<Issue[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState<Zoom>('weeks');
  const [drag, setDrag] = useState<Drag | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const canEdit = project.myPermissions.includes('EDIT_ISSUES');
  const px = ZOOM[zoom];

  const load = async () => {
    const [e, c] = await Promise.all([
      api.search(`project = ${project.key} AND type = Epic ORDER BY rank`, 0, 200),
      api.search(`project = ${project.key} AND parent is not EMPTY AND type != Subtask ORDER BY rank`, 0, 200),
    ]);
    setEpics(e.issues);
    setChildren(c.issues);
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

  return (
    <div className="timeline">
      <div className="toolbar">
        <div className="seg" role="radiogroup" aria-label="Zoom">
          {(Object.keys(ZOOM) as Zoom[]).map((z) => (
            <button key={z} role="radio" aria-checked={zoom === z} className={zoom === z ? 'on' : ''} onClick={() => setZoom(z)}>{z[0].toUpperCase() + z.slice(1)}</button>
          ))}
        </div>
        <button className="btn subtle" onClick={() => scroller.current && (scroller.current.scrollLeft = Math.max(0, x(today()) - scroller.current.clientWidth / 3))}>Today</button>
        <span className="grow" />
        <span className="muted small">{canEdit ? 'Drag bars to reschedule · drag ends to change start/due · click an empty lane to add dates' : 'Read-only'}</span>
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
                {depth === 1 && <StatusLozenge status={i.fields.status} />}
              </div>
            ))}
          </div>
          <div className="tl-scroll" ref={scroller}>
            <div className="tl-canvas" style={{ width }}>
              <div className="tl-head" style={{ width }}>
                {header.months.map((m) => <div key={m.x} className="tl-month" style={{ left: m.x, width: m.w }}>{zoom === 'quarters' ? m.label.split(' ')[0].slice(0, 3) : m.label}</div>)}
                {header.ticks.map((tk) => <div key={tk.x} className="tl-tick" style={{ left: tk.x }}>{tk.label}</div>)}
              </div>
              {zoom !== 'quarters' && header.ticks.map((tk) => <div key={`g${tk.x}`} className="tl-grid" style={{ left: tk.x }} />)}
              <div className="tl-today" style={{ left: x(t) + px / 2 }} aria-hidden><span>Today</span></div>
              {rows.map(({ issue: i, depth, children: ch }) => {
                let sp = span(i, ch);
                const isDrag = drag?.key === i.key;
                if (sp && isDrag) sp = { ...sp, ...dragged(drag!) };
                const cat = i.fields.status.statusCategory.key;
                return (
                  <div key={i.key} className="tl-lane" onPointerMove={onMove} onPointerUp={() => onUp(i)}
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
                        aria-label={`${i.key}: ${sp.start.toLocaleDateString()} to ${sp.end.toLocaleDateString()}`}>
                        {!sp.rolled && canEdit && <span className="tl-handle l" onPointerDown={(e) => onDown(e, i, 'start', sp!)} />}
                        <span className="tl-bar-label">{cat === 'done' ? '✓ ' : ''}{i.fields.summary}</span>
                        {!sp.rolled && canEdit && <span className="tl-handle r" onPointerDown={(e) => onDown(e, i, 'end', sp!)} />}
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
