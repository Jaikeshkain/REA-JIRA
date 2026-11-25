/**
 * A tiny OpenID Connect provider for local development and tests only. It never asks for a password: it shows a
 * list of test identities and signs an ID token for the one you pick. Binds to 127.0.0.1.
 *
 *   npm --prefix server run dev:idp        → http://127.0.0.1:4100 (client id "tracker-dev")
 *   then start the API with OIDC_ISSUER=http://127.0.0.1:4100 OIDC_CLIENT_ID=tracker-dev OIDC_CLIENT_SECRET=dev-idp-secret
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';

export interface MockIdentity { email: string; name: string; verified: boolean; sub?: string }
type Tamper = (t: { header: Record<string, any>; claims: Record<string, any> }) => { header?: Record<string, any>; claims?: Record<string, any>; key?: 'other' | 'none' } | void;

export const MOCK_USERS: MockIdentity[] = [
  { email: 'admin@tracker.test', name: 'Alex Admin', verified: true },
  { email: 'dev@tracker.test', name: 'Dana Dev', verified: true },
  { email: 'new.person@tracker.test', name: 'Nia Newcomer', verified: true },
  { email: 'unverified@tracker.test', name: 'Uma Unverified', verified: false },
];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const subOf = (u: MockIdentity) => u.sub ?? `mock-${createHash('sha256').update(u.email).digest('hex').slice(0, 16)}`;

export async function startMockIdp(opts: { port?: number; clientId?: string; clientSecret?: string; users?: MockIdentity[] } = {}) {
  const clientId = opts.clientId ?? 'tracker-dev';
  const clientSecret = opts.clientSecret ?? 'dev-idp-secret';
  const users = opts.users ?? MOCK_USERS;
  const kid = randomBytes(6).toString('hex');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey; // for "wrong key" tests
  const codes = new Map<string, { redirectUri: string; nonce: string; challenge: string; user: MockIdentity; at: number }>();
  const state: { tamper: Tamper | null; issuer: string } = { tamper: null, issuer: '' };

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.get('/.well-known/openid-configuration', (_req, res) => res.json({
    issuer: state.issuer, authorization_endpoint: `${state.issuer}/authorize`, token_endpoint: `${state.issuer}/token`,
    jwks_uri: `${state.issuer}/jwks`, userinfo_endpoint: `${state.issuer}/userinfo`, response_types_supported: ['code'],
    id_token_signing_alg_values_supported: ['RS256'], subject_types_supported: ['public'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'], code_challenge_methods_supported: ['S256'],
  }));
  app.get('/jwks', (_req, res) => res.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] }));

  const approve = (q: Record<string, any>, user: MockIdentity) => {
    const code = randomBytes(16).toString('base64url');
    codes.set(code, { redirectUri: q.redirect_uri, nonce: q.nonce, challenge: q.code_challenge, user, at: Date.now() });
    const to = new URL(q.redirect_uri);
    to.searchParams.set('code', code);
    to.searchParams.set('state', q.state);
    return to.toString();
  };
  app.get('/authorize', (req, res) => {
    const q = req.query as Record<string, string>;
    if (q.client_id !== clientId || q.response_type !== 'code' || q.code_challenge_method !== 'S256' || !q.code_challenge || !q.redirect_uri) {
      res.status(400).send('invalid_request');
      return;
    }
    const pick = users.find((u) => u.email === (q.login_hint ?? q.pick));
    if (pick) { res.redirect(302, approve(q, pick)); return; }
    const deny = new URL(q.redirect_uri); deny.searchParams.set('error', 'access_denied'); deny.searchParams.set('state', q.state ?? '');
    const link = (u: MockIdentity) => { const p = new URLSearchParams(q); p.set('pick', u.email); return `/authorize?${p}`; };
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Mock identity provider</title>
<body style="font:15px system-ui;max-width:440px;margin:48px auto;color:#172b4d">
<h1 style="font-size:20px">Mock identity provider</h1>
<p style="color:#626f86">Local development only. Choose who to sign in as — no password is asked.</p>
<ul style="list-style:none;padding:0">${users.map((u) => `<li style="margin:8px 0"><a style="display:block;padding:10px 12px;border:1px solid #dcdfe4;border-radius:6px;text-decoration:none;color:#0c66e4" href="${esc(link(u))}"><b>${esc(u.name)}</b><br><span style="color:#626f86">${esc(u.email)}${u.verified ? '' : ' · email not verified'}</span></a></li>`).join('')}</ul>
<a href="${esc(deny.toString())}" style="color:#c9372c">Cancel</a></body>`);
  });

  app.post('/token', (req, res) => {
    let id = req.body.client_id, secret = req.body.client_secret;
    const basic = /^Basic (.+)$/.exec(req.header('authorization') ?? '');
    if (basic) [id, secret] = Buffer.from(basic[1], 'base64').toString().split(':').map(decodeURIComponent);
    if (id !== clientId || secret !== clientSecret) { res.status(401).json({ error: 'invalid_client' }); return; }
    const c = codes.get(req.body.code);
    codes.delete(req.body.code); // one use
    const pkce = createHash('sha256').update(String(req.body.code_verifier ?? '')).digest('base64url');
    if (!c || Date.now() - c.at > 60_000 || c.redirectUri !== req.body.redirect_uri || pkce !== c.challenge) {
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    let header: Record<string, any> = { alg: 'RS256', typ: 'JWT', kid };
    let claims: Record<string, any> = {
      iss: state.issuer, aud: clientId, sub: subOf(c.user), iat: now, exp: now + 300, nonce: c.nonce,
      email: c.user.email, email_verified: c.user.verified, name: c.user.name,
    };
    let key: KeyObject | null = privateKey;
    const t = state.tamper?.({ header, claims });
    if (t) {
      header = t.header ?? header; claims = t.claims ?? claims;
      if (t.key === 'other') key = other;
      if (t.key === 'none') key = null;
    }
    const data = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    const sig = key ? sign('sha256', Buffer.from(data), key).toString('base64url') : '';
    res.json({ access_token: randomBytes(16).toString('base64url'), token_type: 'Bearer', expires_in: 300, id_token: `${data}.${sig}` });
  });
  app.get('/userinfo', (_req, res) => res.json({}));

  const server = app.listen(opts.port ?? 0, '127.0.0.1');
  await new Promise<void>((ok) => server.once('listening', () => ok()));
  state.issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer: state.issuer, clientId, clientSecret, users,
    set tamper(f: Tamper | null) { state.tamper = f; },
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const idp = await startMockIdp({ port: Number(process.env.IDP_PORT ?? 4100) });
  console.log(`Mock OIDC provider on ${idp.issuer} (client id "${idp.clientId}", secret "${idp.clientSecret}") — development only`);
}
