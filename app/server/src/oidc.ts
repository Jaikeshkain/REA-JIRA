/**
 * Single sign-on with OpenID Connect (Phase 4): works with any OIDC provider (Okta, Entra ID, Google, Keycloak…).
 *
 *   OIDC_ISSUER          e.g. https://login.example.com/        (discovery: <issuer>/.well-known/openid-configuration)
 *   OIDC_CLIENT_ID / OIDC_CLIENT_SECRET
 *   OIDC_NAME            button label, default "SSO"
 *   OIDC_REDIRECT_URI    default <APP_URL>/api/auth/oidc/callback (register this at the provider)
 *   OIDC_ALLOWED_DOMAINS optional comma list: only these email domains may sign in with SSO
 *   OIDC_AUTO_CREATE     "false" → only existing accounts may sign in (no just-in-time accounts)
 *   SSO_ONLY             "1" → password sign-in only for site admins (break-glass), sign-up disabled
 *
 * Flow: authorization code + PKCE (S256), one-time state and nonce. The ID token is verified here: RS256/ES256
 * signature against the provider's JWKS, issuer, audience/azp, expiry, issued-at and nonce. Accounts are matched by
 * (issuer, subject); the first SSO sign-in links to an existing account only when the provider says the email is
 * verified. The app session is handed to the browser through a one-time, 60-second code (never a token in a URL).
 */
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify, type JsonWebKey } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from './db.js';
import { createSession, userJson } from './auth.js';
import { HttpError, h } from './http.js';
import { APP_URL } from './mail.js';
import { audit } from './audit.js';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  name: string;
  redirectUri: string;
  allowedDomains: string[];
  autoCreate: boolean;
  appUrl: string;
}
export const ssoOnly = () => process.env.SSO_ONLY === '1' || process.env.SSO_ONLY === 'true';

export function oidcConfigFromEnv(): OidcConfig | null {
  const e = process.env;
  if (!e.OIDC_ISSUER || !e.OIDC_CLIENT_ID || !e.OIDC_CLIENT_SECRET) return null;
  return {
    issuer: e.OIDC_ISSUER,
    clientId: e.OIDC_CLIENT_ID,
    clientSecret: e.OIDC_CLIENT_SECRET,
    name: e.OIDC_NAME || 'SSO',
    redirectUri: e.OIDC_REDIRECT_URI || `${APP_URL}/api/auth/oidc/callback`,
    allowedDomains: (e.OIDC_ALLOWED_DOMAINS ?? '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
    autoCreate: e.OIDC_AUTO_CREATE !== 'false',
    appUrl: APP_URL,
  };
}

const b64url = (b: Buffer) => b.toString('base64url');
const sha256 = (s: string) => createHash('sha256').update(s).digest();
const STATE_TTL_MIN = 10;
const HANDOFF_TTL_SEC = 60;
const SKEW_SEC = 60;

type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; userinfo_endpoint?: string; token_endpoint_auth_methods_supported?: string[] };

class Provider {
  private disc?: { at: number; d: Discovery };
  private jwks?: { at: number; keys: (JsonWebKey & { kid?: string; alg?: string; use?: string })[] };
  constructor(readonly cfg: OidcConfig) {}

  private async get<T>(url: string): Promise<T> {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
    return (await r.json()) as T;
  }
  async discovery() {
    if (this.disc && Date.now() - this.disc.at < 3600_000) return this.disc.d;
    const d = await this.get<Discovery>(`${this.cfg.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
    if (d.issuer !== this.cfg.issuer) throw new Error('Discovery issuer does not match OIDC_ISSUER');
    this.disc = { at: Date.now(), d };
    return d;
  }
  async key(kid: string | undefined, fresh = false) {
    if (fresh || !this.jwks || Date.now() - this.jwks.at > 600_000) {
      const { jwks_uri } = await this.discovery();
      this.jwks = { at: Date.now(), keys: (await this.get<{ keys: any[] }>(jwks_uri)).keys ?? [] };
    }
    const usable = this.jwks.keys.filter((k) => !k.use || k.use === 'sig');
    return kid ? usable.find((k) => k.kid === kid) : usable.length === 1 ? usable[0] : undefined;
  }

  /** Verify an ID token; returns its claims or throws. */
  async verifyIdToken(token: string, nonce: string) {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Malformed ID token');
    const [hB, pB, sB] = parts;
    const header = JSON.parse(Buffer.from(hB, 'base64url').toString('utf8'));
    const alg = header.alg;
    if (alg !== 'RS256' && alg !== 'ES256') throw new Error(`Unsupported ID token algorithm ${String(alg)}`);
    let jwk = await this.key(header.kid);
    if (!jwk) jwk = await this.key(header.kid, true); // provider rotated its keys
    if (!jwk) throw new Error('ID token signed with an unknown key');
    if ((alg === 'RS256' && jwk.kty !== 'RSA') || (alg === 'ES256' && jwk.kty !== 'EC') || (jwk.alg && jwk.alg !== alg)) {
      throw new Error('ID token key type does not match its algorithm');
    }
    const pub = createPublicKey({ key: jwk, format: 'jwk' });
    const ok = cryptoVerify('sha256', Buffer.from(`${hB}.${pB}`), alg === 'ES256' ? { key: pub, dsaEncoding: 'ieee-p1363' } : pub, Buffer.from(sB, 'base64url'));
    if (!ok) throw new Error('ID token signature is invalid');

    const c = JSON.parse(Buffer.from(pB, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    const aud: string[] = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (c.iss !== this.cfg.issuer) throw new Error('ID token issuer mismatch');
    if (!aud.includes(this.cfg.clientId)) throw new Error('ID token audience mismatch');
    if ((aud.length > 1 || c.azp) && c.azp !== this.cfg.clientId) throw new Error('ID token azp mismatch');
    if (typeof c.exp !== 'number' || c.exp < now - SKEW_SEC) throw new Error('ID token expired');
    if (typeof c.iat !== 'number' || c.iat > now + SKEW_SEC) throw new Error('ID token issued in the future');
    if (!c.nonce || c.nonce !== nonce) throw new Error('ID token nonce mismatch');
    if (typeof c.sub !== 'string' || !c.sub) throw new Error('ID token has no subject');
    return c as { sub: string; email?: string; email_verified?: boolean | string; name?: string; given_name?: string; family_name?: string; preferred_username?: string };
  }

  async exchange(code: string, verifier: string) {
    const d = await this.discovery();
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.cfg.redirectUri, code_verifier: verifier });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    const methods = d.token_endpoint_auth_methods_supported;
    if (methods && !methods.includes('client_secret_post') && methods.includes('client_secret_basic')) {
      const enc = (s: string) => encodeURIComponent(s);
      headers.authorization = `Basic ${Buffer.from(`${enc(this.cfg.clientId)}:${enc(this.cfg.clientSecret)}`).toString('base64')}`;
    } else {
      form.set('client_id', this.cfg.clientId);
      form.set('client_secret', this.cfg.clientSecret);
    }
    const r = await fetch(d.token_endpoint, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(10_000) });
    const body: any = await r.json().catch(() => ({}));
    if (!r.ok || !body.id_token) throw new Error(`Token exchange failed (${body.error ?? `HTTP ${r.status}`})`);
    return body as { id_token: string; access_token?: string };
  }

  async userinfo(accessToken: string) {
    const d = await this.discovery();
    if (!d.userinfo_endpoint) return {};
    const r = await fetch(d.userinfo_endpoint, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    return r.ok ? ((await r.json()) as Record<string, any>) : {};
  }
}

/** Only same-site relative paths; anything else returns to the start page. */
export const safeNext = (n: unknown) => (typeof n === 'string' && /^\/(?![/\\])[^\s]*$/.test(n) && n.length < 500 ? n : '/');

const verified = (v: unknown) => v === true || v === 'true';

export function oidcRoutes(db: Db, cfg: OidcConfig | null) {
  const r = Router();
  const provider = cfg ? new Provider(cfg) : null;
  const back = (params: Record<string, string>) => `${cfg!.appUrl}/#${new URLSearchParams(params)}`;

  r.get('/config', h(async () => ({ enabled: !!cfg, name: cfg?.name ?? null, passwordLogin: ssoOnly() ? 'admins' : 'all' })));

  r.get('/start', h(async (req, res) => {
    if (!provider) throw new HttpError(404, 'Single sign-on is not configured');
    const d = await provider.discovery();
    await db.query(`DELETE FROM oidc_logins WHERE created_at < now() - ($1 || ' minutes')::interval`, [String(STATE_TTL_MIN)]);
    const state = b64url(randomBytes(24)), nonce = b64url(randomBytes(24)), verifier = b64url(randomBytes(48));
    await db.query(`INSERT INTO oidc_logins (state, nonce, verifier, next) VALUES ($1,$2,$3,$4)`, [state, nonce, verifier, safeNext(req.query.next)]);
    const url = new URL(d.authorization_endpoint);
    for (const [k, v] of Object.entries({
      response_type: 'code', client_id: cfg!.clientId, redirect_uri: cfg!.redirectUri, scope: 'openid email profile',
      state, nonce, code_challenge: b64url(sha256(verifier)), code_challenge_method: 'S256',
    })) url.searchParams.set(k, v);
    res.redirect(302, url.toString());
    return undefined;
  }));

  r.get('/callback', h(async (req, res) => {
    if (!provider) throw new HttpError(404, 'Single sign-on is not configured');
    const fail = (msg: string) => { res.redirect(302, back({ sso_error: msg })); return undefined; };
    const state = String(req.query.state ?? '');
    // one-time: the state row is consumed whatever happens next
    const [login] = state
      ? await db.query(`DELETE FROM oidc_logins WHERE state = $1 AND created_at > now() - ($2 || ' minutes')::interval RETURNING *`, [state, String(STATE_TTL_MIN)])
      : [];
    if (!login) return fail('This sign-in link has expired. Please try again.');
    if (req.query.error) return fail(`${cfg!.name} sign-in was cancelled or refused (${String(req.query.error).slice(0, 60)}).`);
    const code = String(req.query.code ?? '');
    if (!code) return fail('The identity provider did not return a code.');

    let claims: Awaited<ReturnType<Provider['verifyIdToken']>>;
    try {
      const tokens = await provider.exchange(code, login.verifier);
      claims = await provider.verifyIdToken(tokens.id_token, login.nonce);
      if (!claims.email && tokens.access_token) {
        const info = await provider.userinfo(tokens.access_token);
        if (info.sub === claims.sub) claims = { ...info, ...claims, email: info.email, email_verified: info.email_verified };
      }
    } catch (e: any) {
      console.warn('SSO sign-in failed:', e?.message ?? e);
      return fail('Single sign-on failed. Please try again or contact your site admin.');
    }

    const email = String(claims.email ?? '').toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) return fail('Your identity provider did not share an email address.');
    const domain = email.split('@')[1];
    if (cfg!.allowedDomains.length && !cfg!.allowedDomains.includes(domain)) return fail(`Accounts from ${domain} can’t sign in here.`);

    let [user] = await db.query(
      `SELECT u.* FROM user_identities i JOIN users u ON u.id = i.user_id WHERE i.issuer = $1 AND i.subject = $2`,
      [cfg!.issuer, claims.sub],
    );
    if (!user) {
      const [existing] = await db.query(`SELECT * FROM users WHERE email = $1 ORDER BY id LIMIT 1`, [email]);
      if (existing) {
        // never take over an account on an unverified email claim
        if (!verified(claims.email_verified)) return fail('Your email isn’t verified with your identity provider, so it can’t be linked to your account.');
        user = existing;
      } else {
        if (!cfg!.autoCreate) return fail('There’s no account for you on this site yet. Ask a site admin to add you.');
        if (!verified(claims.email_verified)) return fail('Your email isn’t verified with your identity provider.');
        const [tenant] = await db.query(`SELECT id FROM tenants ORDER BY id LIMIT 1`);
        if (!tenant) return fail('This site isn’t set up yet.');
        const name = (claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ') || email.split('@')[0]).slice(0, 80);
        const colors = ['#0c66e4', '#6e5dc6', '#1f845a', '#c9372c', '#a54800', '#206a83', '#943d73'];
        // no usable password: '!' is never a valid bcrypt hash, so password sign-in is impossible for this account
        [user] = await db.query(
          `INSERT INTO users (tenant_id, email, display_name, password_hash, avatar_color) VALUES ($1,$2,$3,'!sso',$4) RETURNING *`,
          [tenant.id, email, name, colors[Math.floor(Math.random() * colors.length)]],
        );
      }
      await db.query(`INSERT INTO user_identities (issuer, subject, user_id, email) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [cfg!.issuer, claims.sub, user.id, email]);
    }
    if (!user.active) return fail('Your account is deactivated. Contact your site admin.');

    const handoff = b64url(randomBytes(24));
    await db.query(`DELETE FROM sso_handoffs WHERE created_at < now() - interval '10 minutes'`);
    await db.query(`INSERT INTO sso_handoffs (code_hash, user_id, next) VALUES ($1,$2,$3)`, [sha256(handoff).toString('hex'), user.id, login.next]);
    res.redirect(302, back({ sso: handoff }));
    return undefined;
  }));

  /** Browser trades the one-time code (from the URL fragment) for a normal session. */
  r.post('/exchange', h(async (req) => {
    const { code } = z.object({ code: z.string().min(10).max(200) }).parse(req.body ?? {});
    const [row] = await db.query(
      `DELETE FROM sso_handoffs WHERE code_hash = $1 AND created_at > now() - ($2 || ' seconds')::interval RETURNING *`,
      [sha256(code).toString('hex'), String(HANDOFF_TTL_SEC)],
    );
    if (!row) throw new HttpError(401, 'This sign-in link has expired. Please try again.');
    const [u] = await db.query(`SELECT * FROM users WHERE id = $1 AND active`, [row.user_id]);
    if (!u) throw new HttpError(401, 'Your account is deactivated.');
    const token = await createSession(db, u.id);
    await audit(db, { tenantId: u.tenant_id, actorId: u.id, actorName: u.display_name, category: 'sign-in', action: 'Signed in with SSO', target: u.email, ip: req.ip });
    return {
      token, next: row.next,
      user: userJson({ id: u.id, tenantId: u.tenant_id, email: u.email, displayName: u.display_name, avatarColor: u.avatar_color, isSiteAdmin: u.is_site_admin }),
    };
  }));

  return r;
}

