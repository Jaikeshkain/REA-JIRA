/**
 * Site settings (site admins, Administration → Settings):
 * - Sign-up: open to anyone, open only to some email domains, or closed (people join by invitation or SSO).
 *   The very first sign-up on an empty install is always allowed: it creates the site and its first admin.
 * - Space creation: everyone, or site admins only.
 * Single sign-on has its own switch (OIDC_AUTO_CREATE) for creating accounts on first SSO sign-in.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from './db.js';
import { HttpError, h, forbidden } from './http.js';
import { audit } from './audit.js';

export interface SiteSettings { allowSignup: boolean; signupDomains: string[]; spaceCreation: 'everyone' | 'admins' }
const DEFAULTS: SiteSettings = { allowSignup: true, signupDomains: [], spaceCreation: 'everyone' };

export async function siteSettings(db: Db, tenantId: number): Promise<SiteSettings> {
  const [r] = await db.query(`SELECT * FROM site_settings WHERE tenant_id = $1`, [tenantId]);
  return r ? { allowSignup: r.allow_signup, signupDomains: r.signup_domains ?? [], spaceCreation: r.space_creation } : DEFAULTS;
}

/** Throws unless this email may sign up on this site. */
export async function assertSignupAllowed(db: Db, tenantId: number, email: string) {
  const s = await siteSettings(db, tenantId);
  if (!s.allowSignup) throw new HttpError(403, 'Sign-up is closed on this site. Ask a site admin to invite you.');
  const domain = email.split('@')[1]?.toLowerCase();
  if (s.signupDomains.length && !s.signupDomains.includes(domain)) {
    throw new HttpError(403, `Only ${s.signupDomains.map((d) => `@${d}`).join(', ')} email addresses can sign up here. Ask a site admin to invite you.`);
  }
}

export async function assertCanCreateSpace(db: Db, user: { tenantId: number; isSiteAdmin: boolean }) {
  if (user.isSiteAdmin) return;
  if ((await siteSettings(db, user.tenantId)).spaceCreation === 'admins') throw forbidden('CREATE_PROJECT');
}

const Domain = z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Enter domains like example.com');

export function siteSettingsRoutes(db: Db) {
  const r = Router();
  r.get('/admin/settings', h(async (req) => {
    if (!req.user!.isSiteAdmin) throw forbidden('ADMINISTER');
    return siteSettings(db, req.user!.tenantId);
  }));
  r.put('/admin/settings', h(async (req) => {
    const u = req.user!;
    if (!u.isSiteAdmin) throw forbidden('ADMINISTER');
    const body = z.object({
      allowSignup: z.boolean().optional(), signupDomains: z.array(Domain).max(50).optional(),
      spaceCreation: z.enum(['everyone', 'admins']).optional(),
    }).parse(req.body ?? {});
    const cur = await siteSettings(db, u.tenantId);
    const next: SiteSettings = { ...cur, ...body, signupDomains: body.signupDomains ? [...new Set(body.signupDomains)] : cur.signupDomains };
    await db.query(
      `INSERT INTO site_settings (tenant_id, allow_signup, signup_domains, space_creation) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id) DO UPDATE SET allow_signup = $2, signup_domains = $3, space_creation = $4, updated_at = now()`,
      [u.tenantId, next.allowSignup, next.signupDomains, next.spaceCreation],
    );
    const what = [
      cur.allowSignup !== next.allowSignup ? (next.allowSignup ? 'opened sign-up' : 'closed sign-up') : '',
      cur.signupDomains.join() !== next.signupDomains.join() ? `sign-up domains: ${next.signupDomains.join(', ') || 'any'}` : '',
      cur.spaceCreation !== next.spaceCreation ? `space creation: ${next.spaceCreation === 'admins' ? 'site admins only' : 'everyone'}` : '',
    ].filter(Boolean).join('; ');
    if (what) await audit(db, { tenantId: u.tenantId, actorId: u.id, actorName: u.displayName, category: 'admin', action: 'Changed site settings', target: what, ip: req.ip });
    return next;
  }));
  return r;
}

/** Public: what the login page should offer. */
export function publicSiteRoutes(db: Db) {
  const r = Router();
  r.get('/site', h(async () => {
    const [t] = await db.query(`SELECT id FROM tenants ORDER BY id LIMIT 1`);
    if (!t) return { setup: true, allowSignup: true, signupDomains: [] }; // empty install: first sign-up creates the site
    const s = await siteSettings(db, t.id);
    return { setup: false, allowSignup: s.allowSignup, signupDomains: s.signupDomains };
  }));
  return r;
}
