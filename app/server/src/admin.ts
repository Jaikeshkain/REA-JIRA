/**
 * Site administration (must-haves): people and groups.
 * - Users: list/search, invite by email (they set their own password from the emailed link), deactivate (signs them
 *   out everywhere; API tokens stop working; history and assignments are kept), reactivate, grant/revoke site admin.
 *   The last active site admin can't be deactivated or demoted, and you can't deactivate yourself.
 * - Groups: named sets of people. A space can give a group a role; every member gets that access. Access from groups is
 *   materialised into project_members (via_group_id), so every existing permission check keeps working, and it's
 *   recomputed whenever a group, its members or a space's groups change. Direct memberships are never touched; when
 *   several groups give access, the highest role wins.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from './db.js';
import type { AuthUser } from './auth.js';
import { h, bad, notFound, forbidden } from './http.js';
import { projectByKey, roleIn } from './access.js';
import { can } from './permissions.js';
import { audit } from './audit.js';
import { issueToken, sendAccountEmail } from './accounts.js';
import type { Licensing } from './license.js';

const SYSTEM = `email NOT LIKE '%@tracker.system'`; // the Automation bot isn't a person
const RANK = `CASE role WHEN 'admin' THEN 4 WHEN 'member' THEN 3 WHEN 'viewer' THEN 2 ELSE 1 END`;

/** Recompute group-granted space access for a site. */
export async function syncGroupAccess(q: Db, tenantId: number) {
  await q.query(
    `DELETE FROM project_members pm USING projects p WHERE p.id = pm.project_id AND p.tenant_id = $1 AND pm.via_group_id IS NOT NULL`,
    [tenantId],
  );
  await q.query(
    `INSERT INTO project_members (project_id, user_id, role, via_group_id)
     SELECT DISTINCT ON (x.project_id, x.user_id) x.project_id, x.user_id, x.role, x.group_id
     FROM (SELECT pg.project_id, gm.user_id, pg.role, pg.group_id, ${RANK.replace('role', 'pg.role')} AS rk
           FROM project_groups pg JOIN group_members gm ON gm.group_id = pg.group_id
           JOIN groups g ON g.id = pg.group_id JOIN users u ON u.id = gm.user_id
           WHERE g.tenant_id = $1 AND u.active) x
     WHERE NOT EXISTS (SELECT 1 FROM project_members d WHERE d.project_id = x.project_id AND d.user_id = x.user_id)
     ORDER BY x.project_id, x.user_id, x.rk DESC`,
    [tenantId],
  );
}

const userJson = (u: any) => ({
  accountId: String(u.id), displayName: u.display_name, emailAddress: u.email, avatarColor: u.avatar_color,
  active: u.active, isSiteAdmin: u.is_site_admin, emailVerified: !!u.email_verified_at,
  status: !u.active ? 'deactivated' : !String(u.password_hash).startsWith('$2') && !u.has_sso ? 'invited' : 'active',
  sso: !!u.has_sso, lastLogin: u.last_login_at, created: u.created_at, groups: u.groups ?? [],
});

export function adminRoutes(db: Db, onAccessChanged: () => void) {
  const r = Router();
  const admin = (u: AuthUser) => { if (!u.isSiteAdmin) throw forbidden('ADMINISTER'); };
  const log = (u: AuthUser, ip: string | undefined, category: 'admin' | 'permissions', action: string, target: string) =>
    audit(db, { tenantId: u.tenantId, actorId: u.id, actorName: u.displayName, category, action, target, ip });
  const load = async (actor: AuthUser, id: string) => {
    const [u] = await db.query(`SELECT * FROM users WHERE id = $1 AND tenant_id = $2 AND ${SYSTEM}`, [Number(id), actor.tenantId]);
    if (!u) throw notFound('User');
    return u;
  };
  const otherActiveAdmins = async (tenantId: number, exceptId: number) =>
    Number((await db.query(`SELECT count(*)::int AS n FROM users WHERE tenant_id = $1 AND is_site_admin AND active AND id <> $2`, [tenantId, exceptId]))[0].n);

  // ---- users
  r.get('/admin/users', h(async (req) => {
    const u = req.user!;
    admin(u);
    const q = String(req.query.query ?? '').trim();
    const rows = await db.query(
      `SELECT u.*, EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = u.id) AS has_sso,
              coalesce((SELECT json_agg(g.name ORDER BY lower(g.name)) FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = u.id), '[]'::json) AS groups
       FROM users u WHERE u.tenant_id = $1 AND ${SYSTEM.replace('email', 'u.email')}
         AND ($2 = '' OR u.email ILIKE '%' || $2 || '%' OR u.display_name ILIKE '%' || $2 || '%')
       ORDER BY u.active DESC, lower(u.display_name)`,
      [u.tenantId, q],
    );
    return rows.map(userJson);
  }));

  r.post('/admin/users/invite', h(async (req, res) => {
    const actor = req.user!;
    admin(actor);
    const body = z.object({ email: z.string().email(), displayName: z.string().trim().min(1).max(80), siteAdmin: z.boolean().default(false) }).parse(req.body ?? {});
    const [dup] = await db.query(`SELECT 1 FROM users WHERE tenant_id = $1 AND email = lower($2)`, [actor.tenantId, body.email]);
    if (dup) throw bad('Someone with that email already has an account');
    await (req.app.locals.licensing as Licensing | undefined)?.assertSeats();
    const colors = ['#0c66e4', '#6e5dc6', '#1f845a', '#c9372c', '#a54800', '#206a83', '#943d73'];
    const [u] = await db.query(
      `INSERT INTO users (tenant_id, email, display_name, password_hash, avatar_color, is_site_admin) VALUES ($1, lower($2), $3, '!invited', $4, $5) RETURNING *`,
      [actor.tenantId, body.email, body.displayName, colors[Math.floor(Math.random() * colors.length)], body.siteAdmin],
    );
    await sendAccountEmail(db, u, 'invite', await issueToken(db, u.id, 'invite'), actor.displayName);
    await log(actor, req.ip, 'admin', 'Invited a user', u.email);
    res.status(201);
    return userJson(u);
  }));
  r.post('/admin/users/:id/resend-invite', h(async (req) => {
    const actor = req.user!;
    admin(actor);
    const u = await load(actor, String(req.params.id));
    if (String(u.password_hash).startsWith('$2')) throw bad(`${u.display_name} has already accepted`);
    await sendAccountEmail(db, u, 'invite', await issueToken(db, u.id, 'invite'), actor.displayName);
    return { ok: true };
  }));

  r.post('/admin/users/:id/deactivate', h(async (req) => {
    const actor = req.user!;
    admin(actor);
    const u = await load(actor, String(req.params.id));
    if (u.id === actor.id) throw bad('You can’t deactivate yourself');
    if (u.is_site_admin && (await otherActiveAdmins(actor.tenantId, u.id)) === 0) throw bad('Keep at least one active site admin');
    await db.tx(async (q) => {
      await q.query(`UPDATE users SET active = false WHERE id = $1`, [u.id]);
      await q.query(`DELETE FROM sessions WHERE user_id = $1`, [u.id]);
      await syncGroupAccess(q, actor.tenantId);
    });
    await log(actor, req.ip, 'admin', 'Deactivated a user', u.email);
    onAccessChanged();
    return userJson({ ...u, active: false });
  }));
  r.post('/admin/users/:id/activate', h(async (req) => {
    const actor = req.user!;
    admin(actor);
    const u = await load(actor, String(req.params.id));
    if (!u.active) await (req.app.locals.licensing as Licensing | undefined)?.assertSeats();
    await db.tx(async (q) => {
      await q.query(`UPDATE users SET active = true WHERE id = $1`, [u.id]);
      await syncGroupAccess(q, actor.tenantId);
    });
    await log(actor, req.ip, 'admin', 'Reactivated a user', u.email);
    onAccessChanged();
    return userJson({ ...u, active: true });
  }));
  r.put('/admin/users/:id', h(async (req) => {
    const actor = req.user!;
    admin(actor);
    const u = await load(actor, String(req.params.id));
    const body = z.object({ siteAdmin: z.boolean() }).parse(req.body ?? {});
    if (!body.siteAdmin && u.is_site_admin && (await otherActiveAdmins(actor.tenantId, u.id)) === 0) throw bad('Keep at least one active site admin');
    await db.query(`UPDATE users SET is_site_admin = $2 WHERE id = $1`, [u.id, body.siteAdmin]);
    if (body.siteAdmin !== u.is_site_admin) await log(actor, req.ip, 'permissions', body.siteAdmin ? 'Made someone a site admin' : 'Removed site admin rights', u.email);
    return userJson({ ...u, is_site_admin: body.siteAdmin });
  }));

  // ---- groups
  const group = async (actor: AuthUser, id: string) => {
    const [g] = await db.query(`SELECT * FROM groups WHERE id = $1 AND tenant_id = $2`, [Number(id), actor.tenantId]);
    if (!g) throw notFound('Group');
    return g;
  };
  const groupJson = async (tenantId: number, where = 'TRUE', params: unknown[] = []) => db.query(
    `SELECT g.id::text AS id, g.name, g.description,
       coalesce((SELECT json_agg(json_build_object('accountId', u.id::text, 'displayName', u.display_name, 'active', u.active) ORDER BY lower(u.display_name))
                 FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = g.id), '[]'::json) AS members,
       coalesce((SELECT json_agg(json_build_object('key', p.key, 'role', pg.role) ORDER BY p.key)
                 FROM project_groups pg JOIN projects p ON p.id = pg.project_id WHERE pg.group_id = g.id), '[]'::json) AS spaces
     FROM groups g WHERE g.tenant_id = $1 AND ${where} ORDER BY lower(g.name)`,
    [tenantId, ...params],
  );
  r.get('/admin/groups', h(async (req) => { admin(req.user!); return groupJson(req.user!.tenantId); }));
  r.post('/admin/groups', h(async (req, res) => {
    const actor = req.user!;
    admin(actor);
    const body = z.object({ name: z.string().trim().min(1).max(60), description: z.string().max(500).optional() }).parse(req.body ?? {});
    const [dup] = await db.query(`SELECT 1 FROM groups WHERE tenant_id = $1 AND lower(name) = lower($2)`, [actor.tenantId, body.name]);
    if (dup) throw bad(`A group named "${body.name}" already exists`);
    const [g] = await db.query(`INSERT INTO groups (tenant_id, name, description) VALUES ($1,$2,$3) RETURNING id`, [actor.tenantId, body.name, body.description ?? '']);
    await log(actor, req.ip, 'permissions', 'Created a group', body.name);
    res.status(201);
    return (await groupJson(actor.tenantId, 'g.id = $2', [g.id]))[0];
  }));
  r.delete('/admin/groups/:id', h(async (req, res) => {
    const actor = req.user!;
    admin(actor);
    const g = await group(actor, String(req.params.id));
    await db.tx(async (q) => {
      await q.query(`DELETE FROM groups WHERE id = $1`, [g.id]);
      await syncGroupAccess(q, actor.tenantId);
    });
    await log(actor, req.ip, 'permissions', 'Deleted a group', g.name);
    onAccessChanged();
    res.status(204).end();
    return undefined;
  }));
  r.post('/admin/groups/:id/members', h(async (req) => {
    const actor = req.user!;
    admin(actor);
    const g = await group(actor, String(req.params.id));
    const { accountIds } = z.object({ accountIds: z.array(z.union([z.string(), z.number()])).min(1).max(200) }).parse(req.body ?? {});
    const ids = accountIds.map(Number);
    const ok = await db.query(`SELECT id FROM users WHERE tenant_id = $1 AND id = ANY($2::int[]) AND ${SYSTEM}`, [actor.tenantId, ids]);
    if (ok.length !== new Set(ids).size) throw bad('Unknown user');
    await db.tx(async (q) => {
      for (const id of ids) await q.query(`INSERT INTO group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [g.id, id]);
      await syncGroupAccess(q, actor.tenantId);
    });
    await log(actor, req.ip, 'permissions', 'Added people to a group', g.name);
    onAccessChanged();
    return (await groupJson(actor.tenantId, 'g.id = $2', [g.id]))[0];
  }));
  r.delete('/admin/groups/:id/members/:userId', h(async (req) => {
    const actor = req.user!;
    admin(actor);
    const g = await group(actor, String(req.params.id));
    await db.tx(async (q) => {
      await q.query(`DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`, [g.id, Number(req.params.userId)]);
      await syncGroupAccess(q, actor.tenantId);
    });
    await log(actor, req.ip, 'permissions', 'Removed someone from a group', g.name);
    onAccessChanged();
    return (await groupJson(actor.tenantId, 'g.id = $2', [g.id]))[0];
  }));

  // ---- a space's groups (space admins)
  const spaceAdmin = async (actor: AuthUser, key: string, write: boolean) => {
    const p = await projectByKey(db, actor, key);
    const role = await roleIn(db, actor, p.id);
    if (!can(role, 'BROWSE_PROJECTS', actor.isSiteAdmin)) throw notFound(`Project ${key}`);
    if (write && !can(role, 'ADMINISTER_PROJECTS', actor.isSiteAdmin)) throw forbidden('ADMINISTER_PROJECTS');
    return p;
  };
  const spaceGroups = (projectId: number) => db.query(
    `SELECT g.id::text AS id, g.name, pg.role, (SELECT count(*)::int FROM group_members gm WHERE gm.group_id = g.id) AS "memberCount"
     FROM project_groups pg JOIN groups g ON g.id = pg.group_id WHERE pg.project_id = $1 ORDER BY lower(g.name)`,
    [projectId],
  );
  r.get('/project/:key/groups', h(async (req) => {
    const p = await spaceAdmin(req.user!, String(req.params.key), false);
    return { groups: await spaceGroups(p.id), available: (await db.query(`SELECT id::text AS id, name FROM groups WHERE tenant_id = $1 ORDER BY lower(name)`, [req.user!.tenantId])) };
  }));
  r.post('/project/:key/groups', h(async (req) => {
    const actor = req.user!;
    const p = await spaceAdmin(actor, String(req.params.key), true);
    const body = z.object({ groupId: z.union([z.string(), z.number()]), role: z.enum(['admin', 'member', 'viewer', 'guest']) }).parse(req.body ?? {});
    const g = await group(actor, String(body.groupId));
    await db.tx(async (q) => {
      await q.query(`INSERT INTO project_groups (project_id, group_id, role) VALUES ($1,$2,$3) ON CONFLICT (project_id, group_id) DO UPDATE SET role = EXCLUDED.role`, [p.id, g.id, body.role]);
      await syncGroupAccess(q, actor.tenantId);
    });
    await audit(db, { tenantId: actor.tenantId, actorId: actor.id, actorName: actor.displayName, category: 'permissions', action: `Gave a group the ${body.role} role`, target: `${p.key} · ${g.name}`, ip: req.ip });
    onAccessChanged();
    return { groups: await spaceGroups(p.id) };
  }));
  r.delete('/project/:key/groups/:groupId', h(async (req) => {
    const actor = req.user!;
    const p = await spaceAdmin(actor, String(req.params.key), true);
    await db.tx(async (q) => {
      await q.query(`DELETE FROM project_groups WHERE project_id = $1 AND group_id = $2`, [p.id, Number(req.params.groupId)]);
      await syncGroupAccess(q, actor.tenantId);
    });
    await audit(db, { tenantId: actor.tenantId, actorId: actor.id, actorName: actor.displayName, category: 'permissions', action: 'Removed a group from a space', target: p.key, ip: req.ip });
    onAccessChanged();
    return { groups: await spaceGroups(p.id) };
  }));
  return r;
}
