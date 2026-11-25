import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Db } from './db.js';
import { HttpError, h, bad } from './http.js';
import { ssoOnly } from './oidc.js';

export interface AuthUser {
  id: number;
  tenantId: number;
  email: string;
  displayName: string;
  avatarColor: string;
  isSiteAdmin: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

const SESSION_DAYS = 14;
const COLORS = ['#0c66e4', '#6e5dc6', '#1f845a', '#c9372c', '#a54800', '#206a83', '#943d73'];

export const userJson = (u: AuthUser) => ({
  accountId: String(u.id),
  emailAddress: u.email,
  displayName: u.displayName,
  avatarColor: u.avatarColor,
  isSiteAdmin: u.isSiteAdmin,
});

const rowToUser = (r: any): AuthUser => ({
  id: r.id,
  tenantId: r.tenant_id,
  email: r.email,
  displayName: r.display_name,
  avatarColor: r.avatar_color,
  isSiteAdmin: r.is_site_admin,
});

export async function createSession(db: Db, userId: number): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await db.query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2, now() + $3::interval)`, [
    token,
    userId,
    `${SESSION_DAYS} days`,
  ]);
  return token;
}

export async function createUser(
  db: Db,
  tenantId: number,
  email: string,
  displayName: string,
  password: string,
  isSiteAdmin = false,
): Promise<AuthUser> {
  const hash = await bcrypt.hash(password, 10);
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  const [row] = await db.query(
    `INSERT INTO users (tenant_id, email, display_name, password_hash, avatar_color, is_site_admin)
     VALUES ($1, lower($2), $3, $4, $5, $6) RETURNING *`,
    [tenantId, email, displayName, hash, color, isSiteAdmin],
  );
  return rowToUser(row);
}

export function authMiddleware(db: Db) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return next(new HttpError(401, 'Not signed in'));
    try {
      const [row] = await db.query(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = $1 AND s.expires_at > now() AND u.active`,
        [token],
      );
      if (!row) return next(new HttpError(401, 'Session expired'));
      req.user = rowToUser(row);
      next();
    } catch (e) {
      next(e);
    }
  };
}

const Register = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(80),
  password: z.string().min(8),
  siteName: z.string().min(1).max(80).optional(),
});
const Login = z.object({ email: z.string().email(), password: z.string().min(1) });

/**
 * MVP tenancy: the first registration creates the site (tenant) and becomes site admin;
 * later registrations join that site. Multi-site sign-up comes later.
 */
export function authRoutes(db: Db) {
  const r = Router();
  r.post(
    '/register',
    h(async (req, res) => {
      const body = Register.parse(req.body);
      let [tenant] = await db.query(`SELECT id FROM tenants ORDER BY id LIMIT 1`);
      let isFirst = false;
      if (!tenant) {
        [tenant] = await db.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [body.siteName ?? 'My site']);
        isFirst = true;
      } else if (ssoOnly()) {
        throw new HttpError(403, 'This site uses single sign-on. Sign in with SSO instead.');
      }
      const exists = await db.query(`SELECT 1 FROM users WHERE tenant_id=$1 AND email=lower($2)`, [tenant.id, body.email]);
      if (exists.length) throw bad('An account with this email already exists');
      const user = await createUser(db, tenant.id, body.email, body.displayName, body.password, isFirst);
      const token = await createSession(db, user.id);
      res.status(201);
      return { token, user: userJson(user) };
    }),
  );
  r.post(
    '/login',
    h(async (req) => {
      const body = Login.parse(req.body);
      const [row] = await db.query(`SELECT * FROM users WHERE email = lower($1) AND active`, [body.email]);
      // SSO-only accounts have no bcrypt hash; treat them like a wrong password (no account enumeration)
      const usable = row && typeof row.password_hash === 'string' && row.password_hash.startsWith('$2');
      if (!usable || !(await bcrypt.compare(body.password, row.password_hash))) {
        throw new HttpError(401, 'Incorrect email or password');
      }
      if (ssoOnly() && !row.is_site_admin) throw new HttpError(403, 'This site uses single sign-on. Sign in with SSO instead.');
      const token = await createSession(db, row.id);
      return { token, user: userJson(rowToUser(row)) };
    }),
  );
  r.post(
    '/logout',
    h(async (req) => {
      const token = (req.header('authorization') ?? '').replace(/^Bearer /, '');
      await db.query(`DELETE FROM sessions WHERE token = $1`, [token]);
      return { ok: true };
    }),
  );
  return r;
}
