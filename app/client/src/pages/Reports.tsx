import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type ReportRow } from '../api';
import { useShell } from '../Layout';
import { StatusLozenge, TypeIcon, useAsync } from '../ui';
import { BurndownChart, VelocityChart } from '../charts';
import { useProject } from './ProjectPages';
import { daysLeft, fmtShort } from './Backlog';

/** Reports tab: pick a sprint → burndown + sprint report; velocity across closed sprints. */
export function Reports() {
  const project = useProject();
  const { sprintId } = useParams();
  const nav = useNavigate();
  const { version } = useShell();
  const sprints = useAsync(() => api.sprints(project.key, 'active,closed'), [project.key, version]);
  const selected = sprintId ?? sprints.data?.[0]?.id;
  const report = useAsync(() => (selected ? api.sprintReport(selected) : Promise.resolve(null)), [selected, version]);
  const velocity = useAsync(() => api.velocity(project.key), [project.key, version]);

  if (sprints.data && sprints.data.length === 0) {
    return <div className="panel empty-state"><h2>No sprint reports yet</h2><p className="muted">Start a sprint from the <Link to="../backlog">Backlog</Link> to see its burndown here.</p></div>;
  }
  const r = report.data;
  const s = r?.summary;
  const left = r ? daysLeft(r.sprint) : null;

  return (
    <div className="reports">
      <div className="toolbar">
        <label className="inline-label">Sprint
          <select value={selected ?? ''} onChange={(e) => nav(`../reports/${e.target.value}`)}>
            {sprints.data?.map((x) => <option key={x.id} value={x.id}>{x.name}{x.state === 'active' ? ' (active)' : ''}</option>)}
          </select>
        </label>
        {r && (
          <span className="muted small">
            {fmtShort(r.sprint.startDate)} – {fmtShort(r.sprint.endDate)}
            {r.sprint.state === 'active' && left != null && ` · ${left < 0 ? `${-left} days overdue` : `${left} days left`}`}
            {r.sprint.state === 'closed' && ` · completed ${fmtShort(r.sprint.completeDate)}`}
          </span>
        )}
      </div>
      {report.error && <p className="error">{report.error.message}</p>}
      {r && s && (
        <>
          {r.sprint.goal && <p className="sprint-goal"><strong>Goal:</strong> {r.sprint.goal}</p>}
          <div className="stats4">
            <div className="stat"><strong>{s.committedPoints}</strong><span>points committed ({s.committedCount} items)</span></div>
            <div className="stat"><strong>{s.addedPoints}</strong><span>points added after start ({s.addedCount})</span></div>
            <div className="stat"><strong>{s.completedPoints}</strong><span>points completed ({s.completedCount})</span></div>
            <div className="stat"><strong>{s.notCompletedPoints}</strong><span>points not completed ({s.notCompletedCount})</span></div>
          </div>
          <section className="panel">
            <h2>Burndown</h2>
            <p className="muted small">Story points remaining each day. Unestimated work counts as 0.</p>
            <BurndownChart data={r.burndown} />
          </section>
          <div className="report-tables">
            <ReportTable title="Completed work" rows={r.completed} />
            <ReportTable title={r.sprint.state === 'closed' ? 'Not completed (moved out)' : 'Still open'} rows={r.notCompleted} />
            {r.removed.length > 0 && <ReportTable title="Removed from sprint" rows={r.removed} />}
          </div>
        </>
      )}
      <section className="panel">
        <h2>Velocity</h2>
        <p className="muted small">Story points committed at sprint start vs completed, last 7 completed sprints.</p>
        <VelocityChart data={velocity.data ?? []} />
      </section>
    </div>
  );
}

function ReportTable({ title, rows }: { title: string; rows: ReportRow[] }) {
  return (
    <section className="panel">
      <h2>{title} <span className="count">{rows.length}</span></h2>
      {rows.length === 0 ? <p className="muted small">None</p> : (
        <table className="table">
          <thead><tr><th>Key</th><th>Summary</th><th>Status</th><th>Points</th></tr></thead>
          <tbody>{rows.map((x) => (
            <tr key={x.key}>
              <td><TypeIcon type={x.type} /> <Link to={`/browse/${x.key}`} className="key">{x.key}</Link>{x.addedAfterStart && <span title="Added after the sprint started"> *</span>}</td>
              <td>{x.summary}</td>
              <td><StatusLozenge status={{ name: x.status, statusCategory: { key: x.category } }} /></td>
              <td>{x.points ?? '–'}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}
