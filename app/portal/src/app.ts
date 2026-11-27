/**
 * Tracker owner portal — for the software owner only. Never ship it to customers: it signs licence keys with your
 * private key. Run it on your own computer or a private server (it listens on 127.0.0.1 by default).
 *
 * Customers → installations (their Installation IDs) → licences (signed keys, issued / renewed / emailed).
 * Sign-in is for owner accounts only (first run: create yours on /setup). Forms carry a CSRF token; the session
 * cookie is HttpOnly + SameSite=Strict; sign-in attempts are rate-limited.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import bcrypt from 'bcryptjs';
import express, { type Request, type Response, type NextFunction } from 'express';
import nodemailer from 'nodemailer';
import { signLicense, verifyLicense, type LicensePayload } from '../../server/src/license.js';
import type { PDb } from './db.js';

export interface PortalOptions {
  db: PDb;
  privateKeyPath: string;
  publicKey: string;
  smtpUrl?: string;
  mailFrom?: string;
  secureCookies?: boolean;
  /** Behind a reverse proxy (Caddy): use the client address it reports, for the sign-in lockout. */
  trustProxy?: boolean;
  /** Test hook: capture emails instead of sending them. */
  sendMail?: (m: { to: string; subject: string; text: string; html: string }) => Promise<void>;
}

const DAY = 86400_000;
const SESSION_DAYS = 7;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmtDate = (d: unknown) => (d ? new Date(d as string).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

type Owner = { id: number; email: string; name: string };
declare module 'express-serve-static-core' { interface Request { owner?: Owner; csrf?: string } }

/** Licence status from its expiry (same thresholds as the app: 7-day warning, 14-day grace). */
export function licenseState(expires: Date | null, now = new Date()) {
  if (!expires) return { key: 'none', label: 'No licence', tone: 'muted' };
  const left = Math.ceil((expires.getTime() - now.getTime()) / DAY);
  if (left > 14) return { key: 'active', label: `Active · ${left} days left`, tone: 'good' };
  if (left > 0) return { key: 'renew', label: `Renew now · ${left} day${left === 1 ? '' : 's'} left`, tone: 'warn' };
  if (left > -14) return { key: 'grace', label: `Expired · grace ${14 + left} day${14 + left === 1 ? '' : 's'}`, tone: 'bad' };
  return { key: 'expired', label: 'Expired · read-only', tone: 'bad' };
}

// ------------------------------------------------------------------ HTML

const CSS = `
:root{--bg:#f7f8f9;--surface:#fff;--text:#172b4d;--muted:#626f86;--border:#dcdfe4;--brand:#0c66e4;--good-bg:#dcfff1;--good:#216e4e;--warn-bg:#fff7d6;--warn:#7f5f01;--bad-bg:#ffeceb;--bad:#ae2e24}
@media (prefers-color-scheme:dark){:root{--bg:#1d2125;--surface:#22272b;--text:#dee4ea;--muted:#9fadbc;--border:#38414a;--brand:#579dff;--good-bg:#1c3329;--good:#7ee2b8;--warn-bg:#3d2e00;--warn:#f8e6a0;--bad-bg:#42221f;--bad:#fd9891}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text)}
a{color:var(--brand);text-decoration:none}a:hover{text-decoration:underline}
header{display:flex;align-items:center;gap:20px;padding:10px 20px;background:var(--surface);border-bottom:1px solid var(--border)}
header .brand{font-weight:700}header nav{display:flex;gap:14px;flex:1}header form{margin:0}
main{max-width:1060px;margin:0 auto;padding:20px 16px 60px}h1{font-size:22px;margin:4px 0 16px}h2{font-size:16px;margin:0 0 10px}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 14px}.stat b{display:block;font-size:24px}
table{width:100%;border-collapse:collapse}th{text-align:left;font-size:12px;color:var(--muted);border-bottom:2px solid var(--border);padding:6px 8px}
td{border-bottom:1px solid var(--border);padding:7px 8px;vertical-align:top}.wrap{overflow-x:auto}
.pill{display:inline-block;padding:0 8px;border-radius:10px;font-size:12px;font-weight:600;white-space:nowrap}
.good{background:var(--good-bg);color:var(--good)}.warn{background:var(--warn-bg);color:var(--warn)}.bad{background:var(--bad-bg);color:var(--bad)}.muted{color:var(--muted)}
form.stack{display:flex;flex-direction:column;gap:10px;max-width:520px}form.row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
label{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:600;color:var(--muted)}
input,select,textarea{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:6px 8px}
button,.btn{font:inherit;font-weight:600;border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:4px;padding:6px 12px;cursor:pointer}
button.primary,.btn.primary{background:var(--brand);border-color:var(--brand);color:#fff}button.link{border:0;background:none;color:var(--brand);padding:0;font-weight:400}
.key{font-family:ui-monospace,monospace;font-size:12px;word-break:break-all;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px}
.notice{padding:10px 14px;border-radius:6px;margin-bottom:14px}.small{font-size:12px}
.auth{max-width:380px;margin:60px auto}.inline{display:inline}
`;

function page(title: string, body: string, o: { owner?: Owner; csrf?: string; flash?: string; error?: string } = {}) {
  const nav = o.owner
    ? `<header><span class="brand">◆ Tracker · Owner portal</span><nav><a href="/">Dashboard</a><a href="/customers">Customers</a><a href="/activity">Activity</a></nav>
       <span class="muted small">${esc(o.owner.name)}</span><form method="post" action="/logout"><input type="hidden" name="_csrf" value="${esc(o.csrf)}"><button class="link">Sign out</button></form></header>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Tracker owner portal</title><style>${CSS}</style></head><body>${nav}<main>
${o.flash ? `<div class="notice good" role="status">${esc(o.flash)}</div>` : ''}${o.error ? `<div class="notice bad" role="alert">${esc(o.error)}</div>` : ''}
${body}</main></body></html>`;
}
const hidden = (req: Request) => `<input type="hidden" name="_csrf" value="${esc(req.csrf)}">`;

// ------------------------------------------------------------------ app

export function buildPortal(opts: PortalOptions) {
  const { db } = opts;
  const app = express();
  app.disable('x-powered-by');
  if (opts.trustProxy) app.set('trust proxy', 1);
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('Cache-Control', 'no-store');
    if (opts.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  const transport = opts.smtpUrl ? nodemailer.createTransport(opts.smtpUrl) : null;
  const canEmail = !!(opts.sendMail || transport);
  const sendMail = opts.sendMail ?? (async (m: { to: string; subject: string; text: string; html: string }) => {
    await transport!.sendMail({ from: opts.mailFrom ?? 'Tracker licensing <licensing@localhost>', ...m });
  });
  const log = (owner: Owner | undefined, action: string, detail = '') =>
    db.query(`INSERT INTO events (owner_name, action, detail) VALUES ($1,$2,$3)`, [owner?.name ?? null, action, detail]);

  // ---- sessions
  const cookie = (req: Request) => /(?:^|;\s*)tp_session=([A-Za-z0-9_-]+)/.exec(req.header('cookie') ?? '')?.[1];
  const setCookie = (res: Response, v: string, maxAge: number) =>
    res.setHeader('Set-Cookie', `tp_session=${v}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${opts.secureCookies ? '; Secure' : ''}`);
  app.use(async (req, _res, next) => {
    try {
      const t = cookie(req);
      if (t) {
        const [s] = await db.query(
          `SELECT o.id, o.email, o.name, s.csrf FROM sessions s JOIN owners o ON o.id = s.owner_id WHERE s.token_hash = $1 AND s.expires_at > now()`,
          [sha(t)],
        );
        if (s) { req.owner = { id: s.id, email: s.email, name: s.name }; req.csrf = s.csrf; }
      }
      next();
    } catch (e) { next(e); }
  });
  // every POST from a signed-in owner must carry the session's CSRF token
  app.use((req, res, next) => {
    if (req.method !== 'POST' || !req.owner) return next();
    if (req.body?._csrf !== req.csrf) { res.status(403).send(page('Forbidden', '<h1>That form expired</h1><p><a href="/">Go back</a> and try again.</p>')); return; }
    next();
  });
  const newSession = async (res: Response, ownerId: number) => {
    const token = randomBytes(32).toString('base64url');
    await db.query(`INSERT INTO sessions (token_hash, owner_id, csrf, expires_at) VALUES ($1,$2,$3, now() + interval '${SESSION_DAYS} days')`,
      [sha(token), ownerId, randomBytes(24).toString('base64url')]);
    setCookie(res, token, SESSION_DAYS * 86400);
  };
  const needOwner = (req: Request, res: Response, next: NextFunction) => (req.owner ? next() : res.redirect(303, '/login'));
  const ownerCount = async () => Number((await db.query(`SELECT count(*)::int AS n FROM owners`))[0].n);

  // ---- first run + sign-in (rate-limited per IP)
  const fails = new Map<string, number[]>();
  const tooMany = (ip: string) => (fails.get(ip) ?? []).filter((t) => Date.now() - t < 15 * 60_000).length >= 5;

  app.get('/setup', async (req, res) => {
    if (await ownerCount()) { res.redirect(303, '/login'); return; }
    res.send(page('Set up', `<div class="auth panel"><h1>Create the owner account</h1>
      <p class="muted small">This portal signs licence keys with your private key. Only you should have an account.</p>
      <form class="stack" method="post" action="/setup">
        <label>Your name<input name="name" required maxlength="80"></label>
        <label>Email<input name="email" type="email" required></label>
        <label>Password (12+ characters)<input name="password" type="password" required minlength="12" autocomplete="new-password"></label>
        <button class="primary">Create account</button></form></div>`));
  });
  app.post('/setup', async (req, res, next) => {
    try {
      if (await ownerCount()) { res.redirect(303, '/login'); return; }
      const { name, email, password } = req.body ?? {};
      if (!name || !/^[^@\s]+@[^@\s]+$/.test(String(email)) || String(password ?? '').length < 12) {
        res.status(400).send(page('Set up', '<p><a href="/setup">Back</a></p>', { error: 'Enter a name, an email and a password of at least 12 characters.' })); return;
      }
      const [o] = await db.query(`INSERT INTO owners (email, name, password_hash) VALUES (lower($1),$2,$3) RETURNING id`, [email, name, await bcrypt.hash(String(password), 12)]);
      await log({ id: o.id, email, name }, 'Created the owner account', String(email));
      await newSession(res, o.id);
      res.redirect(303, '/');
    } catch (e) { next(e); }
  });
  app.get('/login', async (req, res) => {
    if (!(await ownerCount())) { res.redirect(303, '/setup'); return; }
    res.send(page('Sign in', `<div class="auth panel"><h1>Owner portal</h1>
      <form class="stack" method="post" action="/login">
        <label>Email<input name="email" type="email" required autofocus></label>
        <label>Password<input name="password" type="password" required autocomplete="current-password"></label>
        <button class="primary">Sign in</button></form></div>`, { error: req.query.e === '1' ? 'Wrong email or password.' : req.query.e === '2' ? 'Too many attempts. Wait 15 minutes.' : undefined }));
  });
  app.post('/login', async (req, res, next) => {
    try {
      const ip = req.ip ?? '';
      if (tooMany(ip)) { res.redirect(303, '/login?e=2'); return; }
      const [o] = await db.query(`SELECT * FROM owners WHERE email = lower($1)`, [String(req.body?.email ?? '')]);
      if (!o || !(await bcrypt.compare(String(req.body?.password ?? ''), o.password_hash))) {
        fails.set(ip, [...(fails.get(ip) ?? []), Date.now()]);
        res.redirect(303, '/login?e=1'); return;
      }
      fails.delete(ip);
      await newSession(res, o.id);
      await log(o, 'Signed in');
      res.redirect(303, '/');
    } catch (e) { next(e); }
  });
  app.post('/logout', async (req, res) => {
    const t = cookie(req);
    if (t) await db.query(`DELETE FROM sessions WHERE token_hash = $1`, [sha(t)]);
    setCookie(res, '', 0);
    res.redirect(303, '/login');
  });

  // ---- data helpers
  const customers = () => db.query(
    `SELECT c.*, l.expires AS latest_expires, l.seats AS latest_seats, l.lid AS latest_lid,
       (SELECT count(*)::int FROM installations i WHERE i.customer_id = c.id) AS installs
     FROM customers c LEFT JOIN LATERAL (SELECT * FROM licenses WHERE customer_id = c.id ORDER BY expires DESC, id DESC LIMIT 1) l ON true
     WHERE NOT c.archived ORDER BY lower(c.company)`,
  );
  const customer = async (id: string) => {
    const [c] = await db.query(`SELECT * FROM customers WHERE id = $1`, [Number(id)]);
    return c ?? null;
  };
  const notFound = (res: Response, req: Request) => res.status(404).send(page('Not found', '<h1>Not found</h1><p><a href="/customers">Customers</a></p>', { owner: req.owner, csrf: req.csrf }));
  const flashOf = (req: Request) => (typeof req.query.ok === 'string' ? req.query.ok.slice(0, 200) : undefined);
  const errOf = (req: Request) => (typeof req.query.err === 'string' ? req.query.err.slice(0, 300) : undefined);
  const back = (res: Response, url: string, msg: { ok?: string; err?: string }) =>
    res.redirect(303, `${url}${url.includes('?') ? '&' : '?'}${msg.ok ? `ok=${encodeURIComponent(msg.ok)}` : `err=${encodeURIComponent(msg.err ?? '')}`}`);

  // ---- dashboard
  app.get('/', needOwner, async (req, res, next) => {
    try {
      const list = await customers();
      const st = list.map((c) => ({ c, s: licenseState(c.latest_expires ? new Date(c.latest_expires) : null) }));
      const count = (k: string) => st.filter((x) => x.s.key === k).length;
      const attention = st.filter((x) => ['renew', 'grace', 'expired'].includes(x.s.key))
        .sort((a, b) => new Date(a.c.latest_expires).getTime() - new Date(b.c.latest_expires).getTime());
      const recent = await db.query(`SELECT l.*, c.company FROM licenses l JOIN customers c ON c.id = l.customer_id ORDER BY l.id DESC LIMIT 8`);
      const keyOk = existsSync(opts.privateKeyPath);
      res.send(page('Dashboard', `<h1>Dashboard</h1>
        ${keyOk ? '' : `<div class="notice bad">Your private key isn't at <code>${esc(opts.privateKeyPath)}</code>, so licences can't be issued. Set PORTAL_PRIVATE_KEY or run <code>npm run license -- keygen</code>.</div>`}
        <div class="grid">
          <div class="stat"><span class="muted small">Customers</span><b>${list.length}</b></div>
          <div class="stat"><span class="muted small">Active</span><b>${count('active')}</b></div>
          <div class="stat"><span class="muted small">Renew within 14 days</span><b>${count('renew')}</b></div>
          <div class="stat"><span class="muted small">Expired</span><b>${count('grace') + count('expired')}</b></div>
        </div>
        <section class="panel"><h2>Needs renewal</h2>${attention.length ? `<div class="wrap"><table><thead><tr><th>Customer</th><th>Status</th><th>Expires</th><th>Users</th><th></th></tr></thead><tbody>
          ${attention.map(({ c, s }) => `<tr><td><a href="/customers/${c.id}">${esc(c.company)}</a></td><td><span class="pill ${s.tone}">${esc(s.label)}</span></td>
            <td>${fmtDate(c.latest_expires)}</td><td>${esc(c.latest_seats)}</td><td><a class="btn" href="/customers/${c.id}#renew">Renew</a></td></tr>`).join('')}
          </tbody></table></div>` : '<p class="muted">Nothing due. Licences that expire within 14 days show up here.</p>'}</section>
        <section class="panel"><h2>Recently issued</h2>${recent.length ? `<div class="wrap"><table><thead><tr><th>Licence</th><th>Customer</th><th>Users</th><th>Valid until</th><th>Sent</th></tr></thead><tbody>
          ${recent.map((l) => `<tr><td><a href="/licenses/${l.id}">${esc(l.lid)}</a></td><td>${esc(l.company)}</td><td>${l.seats}</td><td>${fmtDate(l.expires)}</td>
            <td>${l.sent_at ? `${fmtDate(l.sent_at)} <span class="muted small">to ${esc(l.sent_to)}</span>` : '<span class="muted">Not yet</span>'}</td></tr>`).join('')}
          </tbody></table></div>` : '<p class="muted">No licences yet. <a href="/customers">Add a customer</a> to issue the first one.</p>'}</section>`,
        { owner: req.owner, csrf: req.csrf, flash: flashOf(req) }));
    } catch (e) { next(e); }
  });

  // ---- customers
  app.get('/customers', needOwner, async (req, res, next) => {
    try {
      const list = await customers();
      res.send(page('Customers', `<h1>Customers</h1>
        <section class="panel"><h2>Add a customer</h2><form class="row" method="post" action="/customers">${hidden(req)}
          <label>Company<input name="company" required maxlength="120"></label>
          <label>Contact name<input name="contact_name" maxlength="120"></label>
          <label>Contact email (licences are sent here)<input name="contact_email" type="email"></label>
          <button class="primary">Add</button></form></section>
        <section class="panel">${list.length ? `<div class="wrap"><table><thead><tr><th>Company</th><th>Contact</th><th>Installations</th><th>Users</th><th>Licence</th></tr></thead><tbody>
          ${list.map((c) => { const s = licenseState(c.latest_expires ? new Date(c.latest_expires) : null); return `<tr><td><a href="/customers/${c.id}">${esc(c.company)}</a></td>
            <td>${esc(c.contact_name)}<br><span class="muted small">${esc(c.contact_email)}</span></td><td>${c.installs}</td><td>${esc(c.latest_seats ?? '—')}</td>
            <td><span class="pill ${s.tone}">${esc(s.label)}</span></td></tr>`; }).join('')}</tbody></table></div>` : '<p class="muted">No customers yet.</p>'}</section>`,
        { owner: req.owner, csrf: req.csrf, flash: flashOf(req), error: errOf(req) }));
    } catch (e) { next(e); }
  });
  app.post('/customers', needOwner, async (req, res, next) => {
    try {
      const company = String(req.body.company ?? '').trim();
      if (!company) { back(res, '/customers', { err: 'Enter the company name' }); return; }
      const email = String(req.body.contact_email ?? '').trim();
      if (email && !/^[^@\s]+@[^@\s]+$/.test(email)) { back(res, '/customers', { err: 'That contact email isn’t valid' }); return; }
      const [c] = await db.query(`INSERT INTO customers (company, contact_name, contact_email) VALUES ($1,$2,lower($3)) RETURNING id`,
        [company.slice(0, 120), String(req.body.contact_name ?? '').trim().slice(0, 120), email]);
      await log(req.owner, 'Added a customer', company);
      back(res, `/customers/${c.id}`, { ok: `${company} added. Add their installation ID, then issue a licence.` });
    } catch (e) { next(e); }
  });

  app.get('/customers/:id', needOwner, async (req, res, next) => {
    try {
      const c = await customer(String(req.params.id));
      if (!c) { notFound(res, req); return; }
      const installs = await db.query(`SELECT * FROM installations WHERE customer_id = $1 ORDER BY id`, [c.id]);
      const lics = await db.query(`SELECT * FROM licenses WHERE customer_id = $1 ORDER BY expires DESC, id DESC`, [c.id]);
      const latest = lics[0];
      const s = licenseState(latest ? new Date(latest.expires) : null);
      // renewal continues from the current expiry (or today, if it's long gone)
      const renewFrom = latest ? new Date(Math.max(new Date(latest.expires).getTime(), Date.now() - 14 * DAY)) : new Date();
      const installOptions = (sel?: string) => `${installs.map((i) => `<option value="${esc(i.install_id)}" ${sel === i.install_id ? 'selected' : ''}>${esc(i.label || 'Installation')} · ${esc(i.install_id)}</option>`).join('')}
        <option value="*" ${sel === '*' ? 'selected' : ''}>Any installation (*) — only for your own servers</option>`;
      res.send(page(c.company, `<p class="small"><a href="/customers">Customers</a> /</p>
        <h1>${esc(c.company)} <span class="pill ${s.tone}">${esc(s.label)}</span></h1>
        <section class="panel"><h2>Details</h2><form class="row" method="post" action="/customers/${c.id}">${hidden(req)}
          <label>Company<input name="company" value="${esc(c.company)}" required maxlength="120"></label>
          <label>Contact name<input name="contact_name" value="${esc(c.contact_name)}" maxlength="120"></label>
          <label>Contact email<input name="contact_email" type="email" value="${esc(c.contact_email)}"></label>
          <label>Notes<input name="notes" value="${esc(c.notes)}" maxlength="500"></label>
          <button>Save</button></form></section>
        <section class="panel"><h2>Installations</h2>
          <p class="muted small">The customer finds the Installation ID in Tracker → Administration → Licence and sends it to you.</p>
          ${installs.length ? `<table><thead><tr><th>Label</th><th>Installation ID</th><th>Added</th><th></th></tr></thead><tbody>${installs.map((i) => `<tr><td>${esc(i.label)}</td><td><code>${esc(i.install_id)}</code></td><td>${fmtDate(i.created_at)}</td>
            <td><form class="inline" method="post" action="/installations/${i.id}/delete">${hidden(req)}<button class="link">Remove</button></form></td></tr>`).join('')}</tbody></table>` : '<p class="muted">None yet.</p>'}
          <form class="row" method="post" action="/customers/${c.id}/installations" style="margin-top:10px">${hidden(req)}
            <label>Installation ID<input name="install_id" required pattern="[A-Za-z0-9-]{8,64}" placeholder="e.g. d4985f24-1bcf-…" size="40"></label>
            <label>Label<input name="label" placeholder="e.g. Production" maxlength="60"></label>
            <button>Add installation</button></form></section>
        <section class="panel" id="renew"><h2>${latest ? 'Renew or issue a licence' : 'Issue the first licence'}</h2>
          ${installs.length ? `<form class="row" method="post" action="/customers/${c.id}/licenses">${hidden(req)}
            <label>Installation<select name="install">${installOptions(latest?.install)}</select></label>
            <label>Users<input name="seats" type="number" min="1" max="100000" value="${esc(latest?.seats ?? 10)}" required></label>
            <label>Starts<input name="from" type="date" value="${isoDay(renewFrom)}" required></label>
            <label>Months<input name="months" type="number" min="1" max="36" value="1" required></label>
            <label>Note<input name="note" maxlength="200" placeholder="e.g. Invoice 2026-12"></label>
            <button class="primary">${latest ? 'Issue renewal' : 'Issue licence'}</button></form>
            ${latest ? `<p class="muted small">Starts when the current licence ends (${fmtDate(latest.expires)}), so months follow on without a gap.</p>` : ''}`
          : '<p class="muted">Add an installation first.</p>'}</section>
        <section class="panel"><h2>Licence history</h2>${lics.length ? `<div class="wrap"><table><thead><tr><th>Licence</th><th>Installation</th><th>Users</th><th>From</th><th>Until</th><th>Sent</th><th>Note</th></tr></thead><tbody>
          ${lics.map((l) => `<tr><td><a href="/licenses/${l.id}">${esc(l.lid)}</a></td><td><code class="small">${esc(l.install === '*' ? 'any (*)' : l.install.slice(0, 13) + '…')}</code></td><td>${l.seats}</td>
            <td>${fmtDate(l.issued)}</td><td>${fmtDate(l.expires)}</td><td>${l.sent_at ? fmtDate(l.sent_at) : '<span class="muted">—</span>'}</td><td class="small">${esc(l.note)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No licences yet.</p>'}</section>`,
        { owner: req.owner, csrf: req.csrf, flash: flashOf(req), error: errOf(req) }));
    } catch (e) { next(e); }
  });
  app.post('/customers/:id', needOwner, async (req, res, next) => {
    try {
      const c = await customer(String(req.params.id));
      if (!c) { notFound(res, req); return; }
      const email = String(req.body.contact_email ?? '').trim();
      if (email && !/^[^@\s]+@[^@\s]+$/.test(email)) { back(res, `/customers/${c.id}`, { err: 'That contact email isn’t valid' }); return; }
      await db.query(`UPDATE customers SET company = $2, contact_name = $3, contact_email = lower($4), notes = $5 WHERE id = $1`,
        [c.id, String(req.body.company ?? c.company).trim().slice(0, 120) || c.company, String(req.body.contact_name ?? '').trim().slice(0, 120), email, String(req.body.notes ?? '').slice(0, 500)]);
      await log(req.owner, 'Updated a customer', c.company);
      back(res, `/customers/${c.id}`, { ok: 'Saved' });
    } catch (e) { next(e); }
  });
  app.post('/customers/:id/installations', needOwner, async (req, res, next) => {
    try {
      const c = await customer(String(req.params.id));
      if (!c) { notFound(res, req); return; }
      const id = String(req.body.install_id ?? '').trim();
      if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) { back(res, `/customers/${c.id}`, { err: 'That doesn’t look like an Installation ID' }); return; }
      const [other] = await db.query(`SELECT c.company FROM installations i JOIN customers c ON c.id = i.customer_id WHERE i.install_id = $1 AND i.customer_id <> $2`, [id, c.id]);
      if (other) { back(res, `/customers/${c.id}`, { err: `That installation already belongs to ${other.company}` }); return; }
      await db.query(`INSERT INTO installations (customer_id, install_id, label) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [c.id, id, String(req.body.label ?? '').trim().slice(0, 60)]);
      await log(req.owner, 'Added an installation', `${c.company} · ${id}`);
      back(res, `/customers/${c.id}`, { ok: 'Installation added' });
    } catch (e) { next(e); }
  });
  app.post('/installations/:id/delete', needOwner, async (req, res, next) => {
    try {
      const [i] = await db.query(`DELETE FROM installations WHERE id = $1 RETURNING customer_id, install_id`, [Number(req.params.id)]);
      if (!i) { notFound(res, req); return; }
      await log(req.owner, 'Removed an installation', i.install_id);
      back(res, `/customers/${i.customer_id}`, { ok: 'Installation removed (licences already issued keep working until they expire)' });
    } catch (e) { next(e); }
  });

  // ---- licences
  app.post('/customers/:id/licenses', needOwner, async (req, res, next) => {
    try {
      const c = await customer(String(req.params.id));
      if (!c) { notFound(res, req); return; }
      const url = `/customers/${c.id}`;
      const install = String(req.body.install ?? '');
      const seats = Number(req.body.seats), months = Number(req.body.months);
      const from = new Date(`${String(req.body.from ?? '')}T00:00:00Z`);
      if (install !== '*' && !(await db.query(`SELECT 1 FROM installations WHERE customer_id = $1 AND install_id = $2`, [c.id, install])).length) {
        back(res, url, { err: 'Pick one of this customer’s installations' }); return;
      }
      if (!Number.isInteger(seats) || seats < 1 || seats > 100000) { back(res, url, { err: 'Users must be a whole number from 1' }); return; }
      if (!Number.isInteger(months) || months < 1 || months > 36) { back(res, url, { err: 'Months must be 1–36' }); return; }
      if (Number.isNaN(from.getTime())) { back(res, url, { err: 'Pick a start date' }); return; }
      if (!existsSync(opts.privateKeyPath)) { back(res, url, { err: `No private key at ${opts.privateKeyPath}` }); return; }
      const until = new Date(from); until.setUTCMonth(until.getUTCMonth() + months);
      const payload: LicensePayload = {
        v: 1, lid: `L-${isoDay(from).replace(/-/g, '')}-${randomBytes(3).toString('hex')}`, customer: c.company, seats,
        issued: from.toISOString(), expires: until.toISOString(), install,
      };
      const key = signLicense(payload, readFileSync(opts.privateKeyPath, 'utf8'));
      const check = verifyLicense(key, opts.publicKey);
      if (!check.ok) { back(res, url, { err: `The private key doesn’t match this build’s public key (${check.reason})` }); return; }
      const [l] = await db.query(
        `INSERT INTO licenses (lid, customer_id, install, seats, issued, expires, key, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [payload.lid, c.id, install, seats, payload.issued, payload.expires, key, String(req.body.note ?? '').trim().slice(0, 200), req.owner!.id],
      );
      await log(req.owner, 'Issued a licence', `${c.company} · ${payload.lid} · ${seats} users · until ${isoDay(until)}`);
      back(res, `/licenses/${l.id}`, { ok: `Licence ${payload.lid} issued. Send it to ${c.company}.` });
    } catch (e) { next(e); }
  });
  const license = async (id: string) => (await db.query(
    `SELECT l.*, c.company, c.contact_email, c.contact_name, c.id AS cid FROM licenses l JOIN customers c ON c.id = l.customer_id WHERE l.id = $1`, [Number(id)],
  ))[0] ?? null;

  app.get('/licenses/:id', needOwner, async (req, res, next) => {
    try {
      const l = await license(String(req.params.id));
      if (!l) { notFound(res, req); return; }
      res.send(page(l.lid, `<p class="small"><a href="/customers/${l.cid}">${esc(l.company)}</a> /</p><h1>Licence ${esc(l.lid)}</h1>
        <section class="panel"><table><tbody>
          <tr><th>Customer</th><td>${esc(l.company)}</td></tr><tr><th>Users</th><td>${l.seats}</td></tr>
          <tr><th>Valid</th><td>${fmtDate(l.issued)} – ${fmtDate(l.expires)}</td></tr>
          <tr><th>Installation</th><td><code>${esc(l.install)}</code></td></tr>
          <tr><th>Sent</th><td>${l.sent_at ? `${fmtDate(l.sent_at)} to ${esc(l.sent_to)}` : 'Not yet'}</td></tr></tbody></table></section>
        <section class="panel"><h2>Licence key</h2><div class="key" id="key">${esc(l.key)}</div>
          <p class="small"><a href="/licenses/${l.id}/download">Download as a file</a> · the customer pastes it in Tracker → Administration → Licence.</p></section>
        <section class="panel"><h2>Send to the customer</h2>${canEmail ? `<form class="row" method="post" action="/licenses/${l.id}/send">${hidden(req)}
          <label>To<input name="to" type="email" value="${esc(l.contact_email)}" required size="32"></label><button class="primary">Email the key</button></form>`
          : '<p class="muted">Email isn’t set up (PORTAL_SMTP_URL). Download the key or copy it into your own email.</p>'}</section>`,
        { owner: req.owner, csrf: req.csrf, flash: flashOf(req), error: errOf(req) }));
    } catch (e) { next(e); }
  });
  app.get('/licenses/:id/download', needOwner, async (req, res, next) => {
    try {
      const l = await license(String(req.params.id));
      if (!l) { notFound(res, req); return; }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="tracker-licence-${l.lid}.txt"`);
      res.send(`Tracker licence for ${l.company}\n${l.seats} users, valid until ${fmtDate(l.expires)}\nInstall it in Tracker → Administration → Licence.\n\n${l.key}\n`);
    } catch (e) { next(e); }
  });
  app.post('/licenses/:id/send', needOwner, async (req, res, next) => {
    try {
      const l = await license(String(req.params.id));
      if (!l) { notFound(res, req); return; }
      const to = String(req.body.to ?? '').trim();
      if (!/^[^@\s]+@[^@\s]+$/.test(to)) { back(res, `/licenses/${l.id}`, { err: 'Enter a valid email address' }); return; }
      if (!canEmail) { back(res, `/licenses/${l.id}`, { err: 'Email isn’t set up' }); return; }
      const subject = `Your Tracker licence key (${l.seats} users, until ${fmtDate(l.expires)})`;
      const steps = 'Open Tracker, go to Administration → Licence, paste the key into "Install a licence key" and click Install key.';
      try {
        await sendMail({
          to, subject,
          text: `Hello${l.contact_name ? ` ${l.contact_name}` : ''},\n\nHere is the Tracker licence key for ${l.company}: ${l.seats} users, valid until ${fmtDate(l.expires)}.\n\n${steps}\n\n${l.key}\n`,
          html: `<p>Hello${l.contact_name ? ` ${esc(l.contact_name)}` : ''},</p><p>Here is the Tracker licence key for <b>${esc(l.company)}</b>: ${l.seats} users, valid until <b>${fmtDate(l.expires)}</b>.</p><p>${esc(steps)}</p><pre style="white-space:pre-wrap;word-break:break-all;background:#f7f8f9;padding:10px;border-radius:6px;font-size:12px">${esc(l.key)}</pre>`,
        });
      } catch (err: any) {
        back(res, `/licenses/${l.id}`, { err: `Sending failed: ${String(err?.message ?? err).slice(0, 200)}` }); return;
      }
      await db.query(`UPDATE licenses SET sent_at = now(), sent_to = $2 WHERE id = $1`, [l.id, to.toLowerCase()]);
      await log(req.owner, 'Emailed a licence', `${l.company} · ${l.lid} → ${to}`);
      back(res, `/licenses/${l.id}`, { ok: `Sent to ${to}` });
    } catch (e) { next(e); }
  });

  app.get('/activity', needOwner, async (req, res, next) => {
    try {
      const rows = await db.query(`SELECT * FROM events ORDER BY id DESC LIMIT 200`);
      res.send(page('Activity', `<h1>Activity</h1><section class="panel">${rows.length ? `<div class="wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead><tbody>
        ${rows.map((e) => `<tr><td class="small">${new Date(e.at).toLocaleString('en-GB')}</td><td>${esc(e.owner_name ?? '')}</td><td>${esc(e.action)}</td><td class="small">${esc(e.detail)}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">Nothing yet.</p>'}</section>`, { owner: req.owner, csrf: req.csrf }));
    } catch (e) { next(e); }
  });

  app.use((req, res) => { res.status(404).send(page('Not found', '<h1>Not found</h1><p><a href="/">Dashboard</a></p>', { owner: req.owner, csrf: req.csrf })); });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('portal error', err);
    res.status(500).send(page('Error', '<h1>Something went wrong</h1><p><a href="/">Dashboard</a></p>'));
  });
  return app;
}
