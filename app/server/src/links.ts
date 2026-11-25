/**
 * Issue links (Phase 3). Jira semantics: a link has a type with an outward and an inward phrase.
 * "DEMO-11 blocks DEMO-6" → outward issue DEMO-11, inward issue DEMO-6; DEMO-6 shows "is blocked by DEMO-11".
 * API shapes follow Jira REST: GET /issueLinkType, POST /issueLink, DELETE /issueLink/:id.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from './db.js';
import type { AuthUser } from './auth.js';
import { h, bad, notFound, forbidden } from './http.js';
import { roleIn } from './access.js';
import { can } from './permissions.js';

const typeJson = (t: any) => ({ id: String(t.id), name: t.name, inward: t.inward, outward: t.outward });

/** Links on one issue, limited to linked issues the user may browse. */
export async function linksFor(db: Db, user: AuthUser, issueId: number) {
  const rows = await db.query(
    `SELECT l.id, lt.id AS type_id, lt.name, lt.inward, lt.outward,
            (l.outward_issue_id = $1) AS is_outward,
            o.id AS o_id, o.key AS o_key, o.summary AS o_summary, o.project_id AS o_project,
            s.name AS s_name, s.category AS s_category, t.name AS t_name, t.color AS t_color,
            pr.name AS pr_name, pr.color AS pr_color
     FROM issue_links l
     JOIN link_types lt ON lt.id = l.type_id
     JOIN issues o ON o.id = CASE WHEN l.outward_issue_id = $1 THEN l.inward_issue_id ELSE l.outward_issue_id END
     JOIN statuses s ON s.id = o.status_id
     JOIN issue_types t ON t.id = o.type_id
     LEFT JOIN priorities pr ON pr.id = o.priority_id
     WHERE (l.outward_issue_id = $1 OR l.inward_issue_id = $1)
       AND ($2 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = o.project_id AND pm.user_id = $3))
     ORDER BY lt.name, (l.outward_issue_id = $1) DESC, l.id`,
    [issueId, user.isSiteAdmin, user.id],
  );
  return rows.map((r) => {
    const other = {
      id: String(r.o_id),
      key: r.o_key,
      fields: {
        summary: r.o_summary,
        status: { name: r.s_name, statusCategory: { key: r.s_category } },
        issuetype: { name: r.t_name, color: r.t_color },
        priority: r.pr_name ? { name: r.pr_name, color: r.pr_color } : null,
      },
    };
    // Jira: on the outward issue the other end is `inwardIssue` (phrase = type.outward), and vice versa
    return r.is_outward
      ? { id: String(r.id), type: typeJson({ id: r.type_id, ...r }), relation: r.outward, inwardIssue: other }
      : { id: String(r.id), type: typeJson({ id: r.type_id, ...r }), relation: r.inward, outwardIssue: other };
  });
}

async function issueFor(q: Db, user: AuthUser, key: string, perm: 'LINK_ISSUES') {
  const [i] = await q.query(`SELECT id, key, project_id FROM issues WHERE tenant_id = $1 AND upper(key) = upper($2)`, [user.tenantId, key]);
  if (!i) throw notFound(`Issue ${key}`);
  const role = await roleIn(q, user, i.project_id);
  if (!can(role, 'BROWSE_PROJECTS', user.isSiteAdmin)) throw notFound(`Issue ${key}`);
  if (!can(role, perm, user.isSiteAdmin)) throw forbidden(perm);
  return i;
}

const log = (q: Db, issueId: number, actor: number, from: string | null, to: string | null) =>
  q.query(`INSERT INTO changelog (issue_id, actor_id, field, from_string, to_string) VALUES ($1,$2,'Link',$3,$4)`, [issueId, actor, from, to]);

const Ref = z.object({ key: z.string().min(1) });
const CreateLink = z.object({
  type: z.object({ name: z.string().optional(), id: z.union([z.string(), z.number()]).optional() }),
  outwardIssue: Ref,
  inwardIssue: Ref,
});

export function linkRoutes(db: Db) {
  const r = Router();

  r.get('/issueLinkType', h(async () => ({ issueLinkTypes: (await db.query(`SELECT * FROM link_types ORDER BY name`)).map(typeJson) })));

  r.post(
    '/issueLink',
    h(async (req, res) => {
      const user = req.user!;
      const body = CreateLink.parse(req.body);
      const out = await db.tx(async (q) => {
        const [t] = await q.query(`SELECT * FROM link_types WHERE id::text = $1 OR lower(name) = lower($2)`, [
          String(body.type.id ?? ''),
          body.type.name ?? '',
        ]);
        if (!t) throw bad('Unknown link type', { type: 'not found' });
        const a = await issueFor(q, user, body.outwardIssue.key, 'LINK_ISSUES');
        const b = await issueFor(q, user, body.inwardIssue.key, 'LINK_ISSUES');
        if (a.id === b.id) throw bad('An issue cannot be linked to itself');
        // symmetric types ("relates to") must not exist in either direction already
        const dup = await q.query(
          `SELECT 1 FROM issue_links WHERE type_id = $1 AND ((outward_issue_id = $2 AND inward_issue_id = $3) OR ($4 AND outward_issue_id = $3 AND inward_issue_id = $2))`,
          [t.id, a.id, b.id, t.inward === t.outward],
        );
        if (dup.length) throw bad(`${a.key} already ${t.outward} ${b.key}`);
        const [l] = await q.query(
          `INSERT INTO issue_links (type_id, outward_issue_id, inward_issue_id, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
          [t.id, a.id, b.id, user.id],
        );
        await log(q, a.id, user.id, null, `This issue ${t.outward} ${b.key}`);
        await log(q, b.id, user.id, null, `This issue ${t.inward} ${a.key}`);
        await q.query(`UPDATE issues SET updated_at = now() WHERE id = ANY($1::int[])`, [[a.id, b.id]]);
        return { id: String(l.id) };
      });
      res.status(201);
      return out;
    }),
  );

  r.delete(
    '/issueLink/:id',
    h(async (req, res) => {
      const user = req.user!;
      await db.tx(async (q) => {
        const [l] = await q.query(
          `SELECT l.*, lt.inward, lt.outward, a.key AS a_key, b.key AS b_key
           FROM issue_links l JOIN link_types lt ON lt.id = l.type_id
           JOIN issues a ON a.id = l.outward_issue_id JOIN issues b ON b.id = l.inward_issue_id
           WHERE l.id = $1 AND a.tenant_id = $2`,
          [Number(req.params.id), user.tenantId],
        );
        if (!l) throw notFound('Link');
        await issueFor(q, user, l.a_key, 'LINK_ISSUES');
        await issueFor(q, user, l.b_key, 'LINK_ISSUES');
        await q.query(`DELETE FROM issue_links WHERE id = $1`, [l.id]);
        await log(q, l.outward_issue_id, user.id, `This issue ${l.outward} ${l.b_key}`, null);
        await log(q, l.inward_issue_id, user.id, `This issue ${l.inward} ${l.a_key}`, null);
      });
      res.status(204).end();
      return undefined;
    }),
  );

  return r;
}
