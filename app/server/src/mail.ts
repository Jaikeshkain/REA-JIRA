/**
 * Email (Phase 4): an outbox table + a delivery step run by the scheduler.
 *   - SMTP_URL set (e.g. smtp://user:pass@smtp.example.com:587) → real delivery via nodemailer, with retries.
 *   - not set → "outbox" mode: emails are kept in the database and visible to site admins (Admin → Outbox),
 *     so development and demos never send anything.
 * All user-provided text is HTML-escaped in templates.
 */
import nodemailer from 'nodemailer';
import type { Db } from './db.js';

export const APP_URL = (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, '');
const FROM = process.env.MAIL_FROM ?? 'Tracker <no-reply@tracker.local>';
const MAX_ATTEMPTS = 5;

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

let transport: nodemailer.Transporter | null | undefined;
const getTransport = () => {
  if (transport === undefined) transport = process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;
  return transport;
};
export const mailMode = () => (process.env.SMTP_URL ? 'smtp' : 'outbox');

export async function queueEmail(
  q: Db,
  e: { tenantId: number; userId: number | null; to: string; kind: string; subject: string; text: string; html: string },
) {
  await q.query(
    `INSERT INTO emails (tenant_id, to_user_id, to_email, kind, subject, text_body, html_body) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [e.tenantId, e.userId, e.to, e.kind, e.subject.slice(0, 200), e.text, e.html],
  );
}

/** Deliver due queued emails. Returns counts. */
export async function deliver(db: Db, now = new Date()) {
  const due = await db.query(`SELECT * FROM emails WHERE status = 'queued' AND next_try_at <= $1 ORDER BY id LIMIT 50`, [now.toISOString()]);
  const t = getTransport();
  let sent = 0, failed = 0;
  for (const m of due) {
    if (!t) {
      await db.query(`UPDATE emails SET status = 'outbox', sent_at = $2 WHERE id = $1`, [m.id, now.toISOString()]);
      sent++;
      continue;
    }
    try {
      await t.sendMail({ from: FROM, to: m.to_email, subject: m.subject, text: m.text_body, html: m.html_body });
      await db.query(`UPDATE emails SET status = 'sent', sent_at = now(), attempts = attempts + 1, error = NULL WHERE id = $1`, [m.id]);
      sent++;
    } catch (e: any) {
      const attempts = m.attempts + 1;
      const backoffMin = Math.min(60, 2 ** attempts); // 2, 4, 8, 16, 32 minutes
      await db.query(
        `UPDATE emails SET attempts = $2, error = $3, status = $4, next_try_at = now() + ($5 || ' minutes')::interval WHERE id = $1`,
        [m.id, attempts, String(e?.message ?? e).slice(0, 500), attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', String(backoffMin)],
      );
      failed++;
    }
  }
  return { sent, failed };
}

/** Shared HTML frame: inline styles only (email clients), plain-text version always included. */
export function frame(title: string, bodyHtml: string, footer: string) {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f7f8f9;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#172b4d">
<div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #dcdfe4;border-radius:8px;padding:20px 24px">
<div style="font-weight:700;color:#0c66e4;margin-bottom:12px">◆ Tracker</div>
<h1 style="font-size:18px;margin:0 0 12px">${esc(title)}</h1>
${bodyHtml}
<p style="margin-top:20px;font-size:12px;color:#626f86">${footer}</p>
</div></body></html>`;
}
