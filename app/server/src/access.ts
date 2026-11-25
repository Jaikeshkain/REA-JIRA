import type { Db } from './db.js';
import type { AuthUser } from './auth.js';
import { can, type Permission, type Role } from './permissions.js';
import { forbidden, notFound } from './http.js';

export interface ProjectRow {
  id: number;
  tenant_id: number;
  key: string;
  name: string;
  description: string;
  lead_id: number | null;
  default_assignee_id: number | null;
  issue_counter: number;
  sprints_enabled: boolean;
  sprint_counter: number;
  created_at: string;
}

export async function projectByKey(db: Db, user: AuthUser, key: string): Promise<ProjectRow> {
  const [p] = await db.query<ProjectRow>(`SELECT * FROM projects WHERE tenant_id = $1 AND upper(key) = upper($2)`, [
    user.tenantId,
    key,
  ]);
  if (!p) throw notFound(`Project ${key}`);
  return p;
}

export async function roleIn(db: Db, user: AuthUser, projectId: number): Promise<Role | null> {
  const [m] = await db.query(`SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2`, [projectId, user.id]);
  return (m?.role as Role) ?? null;
}

/** Throws 404 when the user cannot browse the project (don't leak existence), 403 for other missing permissions. */
export async function requirePerm(db: Db, user: AuthUser, projectId: number, perm: Permission): Promise<Role | null> {
  const role = await roleIn(db, user, projectId);
  if (!can(role, 'BROWSE_PROJECTS', user.isSiteAdmin)) throw notFound('Project');
  if (!can(role, perm, user.isSiteAdmin)) throw forbidden(perm);
  return role;
}

export const userRef = (id: number | null, name?: string | null, email?: string | null, color?: string | null) =>
  id == null ? null : { accountId: String(id), displayName: name ?? '', emailAddress: email ?? '', avatarColor: color ?? '#0c66e4' };
