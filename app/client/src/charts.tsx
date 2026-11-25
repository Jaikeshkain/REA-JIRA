/**
 * Sprint charts. Colors: categorical slot 1 (blue) and slot 2 (orange) from the reference palette,
 * validated light + dark (scripts/validate_palette.js: CVD ΔE 24.7 / 26.8, all checks pass).
 * One y-axis, recessive grid, 2px lines, legend + direct end labels, crosshair/hover tooltip, table view.
 */
import { useMemo, useRef, useState } from 'react';

const W = 720, H = 280, M = { t: 16, r: 92, b: 32, l: 40 };
const iw = W - M.l - M.r, ih = H - M.t - M.b;

function niceMax(v: number) {
  if (v <= 0) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = [1, 2, 2.5, 5, 10].find((m) => m * p >= v)!;
  return n * p;
}
const ticks = (max: number) => Array.from({ length: 5 }, (_, i) => (max / 4) * i);
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export interface BurnPoint { date: string; remainingPoints: number | null; scopePoints: number | null; idealPoints: number }

export function BurndownChart({ data, unit = 'pts' }: { data: BurnPoint[]; unit?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const max = useMemo(() => niceMax(Math.max(1, ...data.flatMap((d) => [d.remainingPoints ?? 0, d.scopePoints ?? 0, d.idealPoints]))), [data]);
  const x = (i: number) => M.l + (data.length <= 1 ? 0 : (i / (data.length - 1)) * iw);
  const y = (v: number) => M.t + ih - (v / max) * ih;
  const known = data.map((d, i) => ({ ...d, i })).filter((d) => d.remainingPoints != null);
  // step line: remaining changes when work is done, so hold the value until the next day
  const step = (key: 'remainingPoints' | 'scopePoints') =>
    known.map((d, n) => `${n === 0 ? 'M' : `H${x(d.i)} V`}${n === 0 ? `${x(d.i)},` : ''}${y(d[key]!)}`).join(' ');
  const ideal = `M${x(0)},${y(data[0]?.idealPoints ?? 0)} L${x(data.length - 1)},${y(0)}`;
  const last = known[known.length - 1];

  const onMove = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - M.l) / iw) * (data.length - 1));
    setHover(i >= 0 && i < data.length ? i : null);
  };
  const h = hover != null ? data[hover] : null;

  if (!data.length) return <p className="muted">No burndown yet.</p>;
  return (
    <figure className="viz">
      <div className="viz-head">
        <ul className="legend" aria-label="Legend">
          <li><span className="sw line s1" />Remaining work</li>
          <li><span className="sw line s2" />Scope</li>
          <li><span className="sw line guide" />Guideline</li>
        </ul>
        <button className="link-btn" onClick={() => setTable((t) => !t)}>{table ? 'View chart' : 'View as table'}</button>
      </div>
      {table ? (
        <table className="table">
          <thead><tr><th>Day</th><th>Remaining ({unit})</th><th>Scope ({unit})</th><th>Guideline ({unit})</th></tr></thead>
          <tbody>{data.map((d) => (
            <tr key={d.date}><td>{fmtDay(d.date)}</td><td>{d.remainingPoints ?? '—'}</td><td>{d.scopePoints ?? '—'}</td><td>{d.idealPoints.toFixed(1)}</td></tr>
          ))}</tbody>
        </table>
      ) : (
        <div className="viz-plot">
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Burndown: ${last?.remainingPoints ?? 0} ${unit} remaining`}
            onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
            {ticks(max).map((t) => (
              <g key={t}>
                <line className="grid" x1={M.l} x2={M.l + iw} y1={y(t)} y2={y(t)} />
                <text className="tick" x={M.l - 8} y={y(t)} dy="0.32em" textAnchor="end">{t}</text>
              </g>
            ))}
            {data.map((d, i) => (i % Math.ceil(data.length / 7) === 0 || i === data.length - 1) && (
              <text key={d.date} className="tick" x={x(i)} y={H - 10} textAnchor="middle">{fmtDay(d.date)}</text>
            ))}
            <path className="guide-line" d={ideal} />
            {known.length > 0 && <path className="series s2" d={step('scopePoints')} />}
            {known.length > 0 && <path className="series s1" d={step('remainingPoints')} />}
            {last && (
              <>
                <circle className="dot s1" cx={x(last.i)} cy={y(last.remainingPoints!)} r={4} />
                <text className="end-label" x={x(last.i) + 8} y={y(last.remainingPoints!)} dy="0.32em">{last.remainingPoints} {unit} left</text>
              </>
            )}
            {h && hover != null && (
              <g pointerEvents="none">
                <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={M.t} y2={M.t + ih} />
                {h.remainingPoints != null && <circle className="dot s1" cx={x(hover)} cy={y(h.remainingPoints)} r={4} />}
              </g>
            )}
            <rect x={M.l} y={M.t} width={iw} height={ih} fill="transparent" />
          </svg>
          {h && hover != null && (
            <div className="viz-tip" style={{ left: `${(x(hover) / W) * 100}%` }} role="status">
              <strong>{fmtDay(h.date)}</strong>
              <div><span className="sw line s1" />Remaining <b>{h.remainingPoints ?? '—'}</b></div>
              <div><span className="sw line s2" />Scope <b>{h.scopePoints ?? '—'}</b></div>
              <div><span className="sw line guide" />Guideline <b>{h.idealPoints.toFixed(1)}</b></div>
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

export function VelocityChart({ data }: { data: { sprint: { name: string }; committed: number; completed: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  if (!data.length) return <p className="muted">Velocity appears after you complete a sprint.</p>;
  const max = niceMax(Math.max(...data.flatMap((d) => [d.committed, d.completed])));
  const y = (v: number) => M.t + ih - (v / max) * ih;
  const band = iw / data.length;
  const bw = Math.min(28, (band - 24) / 2);
  const bar = (x0: number, v: number) => {
    // 4px rounded data end, square at the baseline
    const top = y(v), r = Math.min(4, (M.t + ih - top) / 2, bw / 2);
    return `M${x0},${M.t + ih} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + bw - r} Q${x0 + bw},${top} ${x0 + bw},${top + r} V${M.t + ih} Z`;
  };
  return (
    <figure className="viz">
      <div className="viz-head">
        <ul className="legend" aria-label="Legend">
          <li><span className="sw box s2" />Committed</li>
          <li><span className="sw box s1" />Completed</li>
        </ul>
        <button className="link-btn" onClick={() => setTable((t) => !t)}>{table ? 'View chart' : 'View as table'}</button>
      </div>
      {table ? (
        <table className="table"><thead><tr><th>Sprint</th><th>Committed (pts)</th><th>Completed (pts)</th></tr></thead>
          <tbody>{data.map((d) => <tr key={d.sprint.name}><td>{d.sprint.name}</td><td>{d.committed}</td><td>{d.completed}</td></tr>)}</tbody></table>
      ) : (
        <div className="viz-plot">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Velocity: committed vs completed story points per sprint" onPointerLeave={() => setHover(null)}>
            {ticks(max).map((t) => (
              <g key={t}>
                <line className="grid" x1={M.l} x2={M.l + iw} y1={y(t)} y2={y(t)} />
                <text className="tick" x={M.l - 8} y={y(t)} dy="0.32em" textAnchor="end">{t}</text>
              </g>
            ))}
            {data.map((d, i) => {
              const cx = M.l + band * i + band / 2;
              return (
                <g key={d.sprint.name} onPointerEnter={() => setHover(i)}>
                  <rect x={M.l + band * i} y={M.t} width={band} height={ih} fill="transparent" />
                  <path className="bar s2" d={bar(cx - bw - 1, d.committed)} />
                  <path className="bar s1" d={bar(cx + 1, d.completed)} />
                  <text className="tick" x={cx} y={H - 10} textAnchor="middle">{d.sprint.name}</text>
                </g>
              );
            })}
          </svg>
          {hover != null && (
            <div className="viz-tip" style={{ left: `${((M.l + band * hover + band / 2) / W) * 100}%` }} role="status">
              <strong>{data[hover].sprint.name}</strong>
              <div><span className="sw box s2" />Committed <b>{data[hover].committed}</b></div>
              <div><span className="sw box s1" />Completed <b>{data[hover].completed}</b></div>
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
