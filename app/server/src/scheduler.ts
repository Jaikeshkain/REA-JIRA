/**
 * Background scheduler (Phase 4). One tick (every minute in the server; on demand in tests and from Admin):
 *   1. notification emails — "immediate" people get one email per minute batch, "digest" people one a day,
 *      "off" people none. Notifications already read in the app are never emailed.
 *   2. filter subscriptions — daily/weekly emails of a filter's results, run with the subscriber's permissions.
 *   3. scheduled automation rules.
 *   4. delivery of queued emails (SMTP or the dev outbox).
 * All "what's due" state lives in the database (next_run_at, emailed_at), so restarts don't lose or repeat work.
 * With several server instances, each pass runs under a Postgres advisory lock, so only one instance works at a time.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from './db.js';
import type { AuthUser } from './auth.js';
import { h, forbidden, notFound } from './http.js';
import { parse, compile, FROM } from './jql.js';
import { jqlCtx } from './customfields.js';
import { loadFilter } from './filters.js';
import { APP_URL, deliver, esc, frame, mailMode, queueEmail } from './mail.js';
import { runScheduledRule } from './automation.js';
import { deliverWebhooks } from './webhooks.js';

const DIGEST_HOUR_UTC = Number(process.env.DIGEST_HOUR_UTC || 8);
const BATCH_WINDOW_MS = 60_000;

const sentence = (n: any) => {
  switch (n.kind) {
    case 'assigned': return `${n.actor} assigned ${n.key} to you`;
    case 'mentioned': return `${n.actor} mentioned you on ${n.key}`;
    case 'commented': return `${n.actor} commented on ${n.key}`;
    default: return `${n.actor} moved ${n.key} from ${n.data?.from ?? '?'} to ${n.data?.to ?? '?'}`;
  }
};

async function notificationEmails(db: Db, now: Date) {
  // "off": never email — mark as handled so they don't pile up
  await db.query(
    `UPDATE notifications n SET emailed_at = $1 FROM users u WHERE u.id = n.user_id AND n.emailed_at IS NULL AND u.email_pref = 'off'`,
    [now.toISOString()],
  );
  // already read in the app → don't email
  await db.query(`UPDATE notifications SET emailed_at = $1 WHERE emailed_at IS NULL AND read_at IS NOT NULL`, [now.toISOString()]);

  const cutoff = new Date(now.getTime() - BATCH_WINDOW_MS).toISOString();
  const digestDue = now.getUTCHours() === DIGEST_HOUR_UTC;
  const rows = await db.query(
    `SELECT n.*, u.email, u.display_name AS recipient, u.email_pref, u.last_digest_at, u.tenant_id AS t_id,
            a.display_name AS actor, i.key, i.summary
     FROM notifications n JOIN users u ON u.id = n.user_id JOIN users a ON a.id = n.actor_id JOIN issues i ON i.id = n.issue_id
     WHERE n.emailed_at IS NULL AND n.read_at IS NULL AND u.active AND n.created_at <= $1
     ORDER BY n.user_id, n.created_at`,
    [cutoff],
  );
  const byUser = new Map<number, any[]>();
  for (const r of rows) {
    if (r.email_pref === 'digest') {
      const recent = r.last_digest_at && now.getTime() - new Date(r.last_digest_at).getTime() < 20 * 3600_000;
      if (!digestDue || recent) continue;
    }
    byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
  }
  for (const [userId, list] of byUser) {
    const first = list[0];
    const digest = first.email_pref === 'digest';
    const subject = digest
      ? `Your Tracker digest: ${list.length} update${list.length === 1 ? '' : 's'}`
      : list.length === 1 ? sentence(first) : `${list.length} updates on your work`;
    const text = list.map((n) => `• ${sentence(n)} — ${n.summary}${n.data?.excerpt ? `\n  “${n.data.excerpt}”` : ''}\n  ${APP_URL}/browse/${n.key}`).join('\n\n');
    const html = frame(
      subject,
      `<ul style="padding-left:18px;margin:0">${list
        .map((n) => `<li style="margin-bottom:10px"><a href="${esc(`${APP_URL}/browse/${n.key}`)}" style="color:#0c66e4;font-weight:600">${esc(sentence(n))}</a><br>
          <span style="color:#44546f">${esc(n.summary)}</span>${n.data?.excerpt ? `<br><span style="color:#626f86">“${esc(n.data.excerpt)}”</span>` : ''}</li>`)
        .join('')}</ul>`,
      `You get these emails because email notifications are <b>${digest ? 'daily digest' : 'on'}</b>. Change it in <a href="${esc(`${APP_URL}/settings/notifications`)}">notification settings</a>.`,
    );
    await queueEmail(db, { tenantId: first.t_id, userId, to: first.email, kind: digest ? 'digest' : 'notification', subject, text: `${subject}\n\n${text}`, html });
    await db.query(`UPDATE notifications SET emailed_at = $1 WHERE id = ANY($2::int[])`, [now.toISOString(), list.map((n) => n.id)]);
    if (digest) await db.query(`UPDATE users SET last_digest_at = $1 WHERE id = $2`, [now.toISOString(), userId]);
  }
  return byUser.size;
}

export function nextSubscriptionRun(s: { frequency: string; hour_utc: number; weekday: number | null }, from: Date) {
  const d = new Date(from);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(s.hour_utc);
  if (d <= from) d.setUTCDate(d.getUTCDate() + 1);
  if (s.frequency === 'weekly') while (d.getUTCDay() !== (s.weekday ?? 1)) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

async function filterSubscriptions(db: Db, now: Date) {
  const due = await db.query(
    `SELECT fs.*, u.id AS uid, u.tenant_id, u.email, u.display_name, u.avatar_color, u.is_site_admin, u.active, f.name AS filter_name, f.jql
     FROM filter_subscriptions fs JOIN users u ON u.id = fs.user_id JOIN filters f ON f.id = fs.filter_id
     WHERE fs.next_run_at <= $1`,
    [now.toISOString()],
  );
  let sent = 0;
  for (const s of due) {
    const user: AuthUser = { id: s.uid, tenantId: s.tenant_id, email: s.email, displayName: s.display_name, avatarColor: s.avatar_color, isSiteAdmin: s.is_site_admin };
    const next = nextSubscriptionRun(s, now).toISOString();
    try {
      if (!s.active) throw new Error('inactive');
      await loadFilter(db, user, s.filter_id); // still shared with the subscriber?
      const params: unknown[] = [];
      const { where, order } = compile(parse(s.jql), await jqlCtx(db, user), params);
      const [{ total }] = await db.query(`SELECT count(*)::int AS total ${FROM} WHERE ${where}`, params);
      if (total > 0 || s.email_when_empty) {
        const rows = await db.query(
          `SELECT i.key, i.summary, s.name AS status, a.display_name AS assignee, pr.name AS priority ${FROM} WHERE ${where} ORDER BY ${order} LIMIT 50`,
          params,
        );
        const link = `${APP_URL}/issues?filter=${s.filter_id}`;
        const subject = `${s.filter_name}: ${total} work item${total === 1 ? '' : 's'}`;
        const text = rows.map((r) => `${r.key}  ${r.summary}  [${r.status}]${r.assignee ? `  @${r.assignee}` : ''}`).join('\n')
          + (total > rows.length ? `\n…and ${total - rows.length} more` : '') + `\n\nOpen the filter: ${link}`;
        const html = frame(
          subject,
          rows.length
            ? `<table style="border-collapse:collapse;width:100%;font-size:13px">${rows
                .map((r) => `<tr><td style="padding:4px 8px 4px 0;white-space:nowrap"><a href="${esc(`${APP_URL}/browse/${r.key}`)}" style="color:#0c66e4">${esc(r.key)}</a></td>
                  <td style="padding:4px 8px">${esc(r.summary)}</td><td style="padding:4px 8px;color:#44546f">${esc(r.status)}</td>
                  <td style="padding:4px 0;color:#44546f">${esc(r.assignee ?? 'Unassigned')}</td></tr>`).join('')}</table>
               ${total > rows.length ? `<p style="color:#626f86">…and ${total - rows.length} more.</p>` : ''}`
            : '<p>No work items match this filter right now.</p>',
          `<a href="${esc(link)}">Open the filter</a> · You subscribed to this filter (${esc(s.frequency)}). Unsubscribe from the filter's page.`,
        );
        await queueEmail(db, { tenantId: s.tenant_id, userId: s.uid, to: s.email, kind: 'subscription', subject, text: `${subject}\n\n${text}`, html });
        sent++;
      }
    } catch {
      // filter deleted/unshared or user inactive: skip this run, keep the schedule (it is removed with the filter)
    }
    await db.query(`UPDATE filter_subscriptions SET next_run_at = $2, last_run_at = $3 WHERE id = $1`, [s.id, next, now.toISOString()]);
  }
  return sent;
}

async function scheduledRules(db: Db, now: Date) {
  const rules = await db.query(
    `SELECT * FROM automation_rules WHERE enabled AND trigger->>'type' = 'scheduled' AND next_run_at IS NOT NULL AND next_run_at <= $1`,
    [now.toISOString()],
  );
  let items = 0;
  for (const r of rules) items += await runScheduledRule(db, r, now);
  return { rules: rules.length, items };
}

let running = false;
/** Advisory lock id for the scheduler ("trak"); any instance holding it is the one doing the work. */
export const SCHEDULER_LOCK = 0x7472616b;
/** One scheduler pass. Safe to call any time; overlapping calls (here or on another instance) are skipped. */
export async function tick(db: Db, now = new Date()) {
  if (running) return { skipped: true as const };
  running = true;
  try {
    const pass = async () => {
      const notifications = await notificationEmails(db, now);
      const subscriptions = await filterSubscriptions(db, now);
      const rules = await scheduledRules(db, now);
      const delivery = await deliver(db, now);
      const webhooks = await deliverWebhooks(db, now);
      return { notifications, subscriptions, rules, delivery, webhooks };
    };
    if (!db.withLock) return await pass();
    const r = await db.withLock(SCHEDULER_LOCK, pass);
    return r.ran ? r.value : { skipped: true as const };
  } finally {
    running = false;
  }
}

export function startScheduler(db: Db) {
  if (process.env.DISABLE_SCHEDULER) return () => {};
  const t = setInterval(() => tick(db).catch((e) => console.error('scheduler tick failed', e)), 60_000);
  t.unref?.();
  return () => clearInterval(t);
}

// ------------------------------------------------------------------ API

const PrefInput = z.object({ emailNotifications: z.enum(['immediate', 'digest', 'off']) });
const SubInput = z.object({
  frequency: z.enum(['daily', 'weekly']),
  hourUtc: z.number().int().min(0).max(23).default(8),
  weekday: z.number().int().min(0).max(6).nullish(),
  emailWhenEmpty: z.boolean().default(false),
});
const subJson = (s: any) => ({
  id: String(s.id), filterId: String(s.filter_id), frequency: s.frequency, hourUtc: s.hour_utc, weekday: s.weekday,
  emailWhenEmpty: s.email_when_empty, nextRun: s.next_run_at, lastRun: s.last_run_at,
});

export function schedulerRoutes(db: Db) {
  const r = Router();

  r.get('/myself/preferences', h(async (req) => {
    const [u] = await db.query(`SELECT email_pref FROM users WHERE id = $1`, [req.user!.id]);
    return { emailNotifications: u.email_pref, emailMode: mailMode(), digestHourUtc: DIGEST_HOUR_UTC };
  }));
  r.put('/myself/preferences', h(async (req) => {
    const body = PrefInput.parse(req.body);
    await db.query(`UPDATE users SET email_pref = $1 WHERE id = $2`, [body.emailNotifications, req.user!.id]);
    return { emailNotifications: body.emailNotifications, emailMode: mailMode(), digestHourUtc: DIGEST_HOUR_UTC };
  }));

  r.get('/filter/:id/subscriptions', h(async (req) => {
    const user = req.user!;
    const f = await loadFilter(db, user, String(req.params.id));
    return (await db.query(`SELECT * FROM filter_subscriptions WHERE filter_id = $1 AND user_id = $2`, [f.id, user.id])).map(subJson);
  }));
  r.post('/filter/:id/subscriptions', h(async (req, res) => {
    const user = req.user!;
    const f = await loadFilter(db, user, String(req.params.id));
    const body = SubInput.parse(req.body ?? {});
    const weekday = body.frequency === 'weekly' ? body.weekday ?? 1 : null;
    const next = nextSubscriptionRun({ frequency: body.frequency, hour_utc: body.hourUtc, weekday }, new Date());
    const [s] = await db.query(
      `INSERT INTO filter_subscriptions (filter_id, user_id, frequency, hour_utc, weekday, email_when_empty, next_run_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (filter_id, user_id) DO UPDATE SET frequency = EXCLUDED.frequency, hour_utc = EXCLUDED.hour_utc,
         weekday = EXCLUDED.weekday, email_when_empty = EXCLUDED.email_when_empty, next_run_at = EXCLUDED.next_run_at
       RETURNING *`,
      [f.id, user.id, body.frequency, body.hourUtc, weekday, body.emailWhenEmpty, next.toISOString()],
    );
    res.status(201);
    return subJson(s);
  }));
  r.delete('/subscription/:id', h(async (req, res) => {
    const user = req.user!;
    const [s] = await db.query(`SELECT * FROM filter_subscriptions WHERE id = $1`, [Number(req.params.id)]);
    if (!s || s.user_id !== user.id) throw notFound('Subscription');
    await db.query(`DELETE FROM filter_subscriptions WHERE id = $1`, [s.id]);
    res.status(204).end();
    return undefined;
  }));

  // ---- site admin: outbox + run the scheduler now
  const admin = (user: AuthUser) => { if (!user.isSiteAdmin) throw forbidden('ADMINISTER'); };
  r.get('/admin/emails', h(async (req) => {
    const user = req.user!;
    admin(user);
    const rows = await db.query(
      `SELECT id, to_email, kind, subject, status, attempts, error, created_at, sent_at, text_body, html_body FROM emails
       WHERE tenant_id = $1 ORDER BY id DESC LIMIT 100`,
      [user.tenantId],
    );
    return {
      mode: mailMode(),
      emails: rows.map((e) => ({
        id: String(e.id), to: e.to_email, kind: e.kind, subject: e.subject, status: e.status, attempts: e.attempts,
        error: e.error, created: e.created_at, sent: e.sent_at, text: e.text_body, html: e.html_body,
      })),
    };
  }));
  r.post('/admin/scheduler/run', h(async (req) => {
    admin(req.user!);
    return tick(db);
  }));

  return r;
}

