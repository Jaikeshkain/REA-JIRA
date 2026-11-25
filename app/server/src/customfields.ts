/**
 * Custom fields (Phase 3). Per-space fields with Jira-style ids `customfield_<id>`, typed values, optional
 * "required" and per-work-type applicability. Values live in issue_custom_values (empty = no row).
 * Field metadata is also handed to the JQL compiler so `"Severity" = "S1 - Critical"` and `cf[3] > 5` work.
 */
import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from './db.js';
import type { AuthUser } from './auth.js';
import { h, bad, notFound } from './http.js';
import { projectByKey, requirePerm, userRef } from './access.js';
import type { CfMeta, Ctx } from './jql.js';

export const CF_TYPES = ['text', 'paragraph', 'number', 'date', 'select', 'multiselect', 'user'] as const;
export type CfType = (typeof CF_TYPES)[number];
export interface CfRow {
  id: number; project_id: number; name: string; description: string; type: CfType;
  options: { id: string; value: string }[]; required: boolean; issue_type_ids: number[] | null; position: number;
}

/** Names of system fields a custom field may not shadow (they would be ambiguous in JQL). */
const RESERVED = new Set([
  'summary', 'description', 'status', 'statuscategory', 'priority', 'assignee', 'reporter', 'creator', 'project', 'key',
  'issuekey', 'type', 'issuetype', 'labels', 'label', 'created', 'updated', 'resolved', 'resolution', 'duedate', 'due',
  'startdate', 'parent', 'sprint', 'text', 'comment', 'id', 'issue', 'rank', 'storypoints',
]);

export const cfKey = (id: number | string) => `customfield_${id}`;

export const fieldJson = (f: CfRow) => ({
  id: cfKey(f.id), fieldId: String(f.id), name: f.name, description: f.description, type: f.type,
  options: f.options, required: f.required, issueTypeIds: f.issue_type_ids?.map(String) ?? null, position: f.position,
});

export const fieldsOf = (db: Db, projectId: number) =>
  db.query<CfRow>(`SELECT * FROM custom_fields WHERE project_id = $1 ORDER BY position, id`, [projectId]);

export const appliesTo = (f: CfRow, typeId: number) => !f.issue_type_ids || f.issue_type_ids.includes(typeId);

/** JQL context: every custom field on the tenant (names resolve across spaces, like Jira's global field names). */
export async function jqlCtx(db: Db, user: AuthUser): Promise<Ctx> {
  const rows = await db.query<CfRow>(
    `SELECT cf.* FROM custom_fields cf JOIN projects p ON p.id = cf.project_id WHERE p.tenant_id = $1`,
    [user.tenantId],
  );
  const customFields: CfMeta[] = rows.map((f) => ({ id: f.id, name: f.name.toLowerCase(), type: f.type, options: f.options }));
  return { userId: user.id, tenantId: user.tenantId, isSiteAdmin: user.isSiteAdmin, customFields };
}

/** Normalise + validate an incoming value for a field. Returns null for "empty". */
export async function normalise(q: Db, tenantId: number, f: CfRow, raw: unknown): Promise<unknown> {
  const empty = raw == null || raw === '' || (Array.isArray(raw) && raw.length === 0);
  if (empty) return null;
  const pick = (v: unknown) => {
    const s = String((v as any)?.id ?? (v as any)?.value ?? v);
    const o = f.options.find((x) => x.id === s) ?? f.options.find((x) => x.value.toLowerCase() === s.toLowerCase());
    if (!o) throw bad(`"${s}" is not an option of ${f.name}`, { [cfKey(f.id)]: 'invalid option' });
    return o.id;
  };
  switch (f.type) {
    case 'text': return z.string().trim().max(255).parse(raw) || null;
    case 'paragraph': return z.string().max(10000).parse(raw).trim() || null;
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw bad(`${f.name} must be a number`, { [cfKey(f.id)]: 'number' });
      return n;
    }
    case 'date': return z.string().regex(/^\d{4}-\d{2}-\d{2}$/, `${f.name} must be a date (YYYY-MM-DD)`).parse(raw);
    case 'select': return pick(raw);
    case 'multiselect': return [...new Set((Array.isArray(raw) ? raw : [raw]).map(pick))];
    case 'user': {
      const id = Number((raw as any)?.accountId ?? raw);
      const [u] = await q.query(`SELECT id FROM users WHERE tenant_id = $1 AND id = $2 AND active`, [tenantId, id]);
      if (!u) throw bad(`User ${String(raw)} not found`, { [cfKey(f.id)]: 'user' });
      return String(u.id);
    }
  }
}

/** Human-readable value (changelog + list display). */
export function display(f: CfRow, v: unknown, users: Map<string, string> = new Map()): string | null {
  if (v == null) return null;
  if (f.type === 'select') return f.options.find((o) => o.id === v)?.value ?? null;
  if (f.type === 'multiselect') return (v as string[]).map((id) => f.options.find((o) => o.id === id)?.value ?? id).join(', ');
  if (f.type === 'user') return users.get(String(v)) ?? `user ${v}`;
  return String(v);
}

/** Store (or clear) one value and write History. */
export async function setValue(q: Db, actorId: number, tenantId: number, issue: { id: number; type_id: number }, f: CfRow, raw: unknown) {
  if (!appliesTo(f, issue.type_id)) throw bad(`${f.name} does not apply to this work type`);
  const v = await normalise(q, tenantId, f, raw);
  if (v == null && f.required) throw bad(`${f.name} is required`, { [cfKey(f.id)]: 'required' });
  const [old] = await q.query(`SELECT value FROM issue_custom_values WHERE issue_id = $1 AND field_id = $2`, [issue.id, f.id]);
  const names = await userNames(q, [old?.value, v]);
  if (v == null) await q.query(`DELETE FROM issue_custom_values WHERE issue_id = $1 AND field_id = $2`, [issue.id, f.id]);
  else {
    await q.query(
      `INSERT INTO issue_custom_values (issue_id, field_id, value) VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (issue_id, field_id) DO UPDATE SET value = EXCLUDED.value`,
      [issue.id, f.id, JSON.stringify(v)],
    );
  }
  const from = display(f, old?.value ?? null, names);
  const to = display(f, v, names);
  if (from !== to) {
    await q.query(`INSERT INTO changelog (issue_id, actor_id, field, from_string, to_string) VALUES ($1,$2,$3,$4,$5)`, [issue.id, actorId, f.name, from, to]);
    await q.query(`UPDATE issues SET updated_at = now() WHERE id = $1`, [issue.id]);
  }
}

async function userNames(q: Db, values: unknown[]) {
  const ids = values.filter((v) => typeof v === 'string' && /^\d+$/.test(v)).map(Number);
  const m = new Map<string, string>();
  if (!ids.length) return m;
  for (const u of await q.query(`SELECT id, display_name FROM users WHERE id = ANY($1::int[])`, [ids])) m.set(String(u.id), u.display_name);
  return m;
}

/** Custom values for one issue as `{ customfield_N: value }`, with select/user values expanded for display. */
export async function valuesFor(db: Db, issueId: number, fields: CfRow[]) {
  const rows = await db.query(`SELECT field_id, value FROM issue_custom_values WHERE issue_id = $1`, [issueId]);
  const users = await userNames(db, rows.map((r) => r.value));
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = rows.find((r) => r.field_id === f.id)?.value ?? null;
    out[cfKey(f.id)] =
      v == null ? null
      : f.type === 'select' ? f.options.find((o) => o.id === v) ?? null
      : f.type === 'multiselect' ? (v as string[]).map((id) => f.options.find((o) => o.id === id)).filter(Boolean)
      : f.type === 'user' ? userRef(Number(v), users.get(String(v)) ?? '')
      : v;
  }
  return out;
}

const optionId = () => randomBytes(4).toString('hex');
const FieldInput = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().max(500).optional(),
  type: z.enum(CF_TYPES),
  options: z.array(z.object({ id: z.string().optional(), value: z.string().trim().min(1).max(100) })).max(100).optional(),
  required: z.boolean().optional(),
  issueTypeIds: z.array(z.union([z.string(), z.number()])).nullish(),
  position: z.number().int().min(0).optional(),
});

export function customFieldRoutes(db: Db) {
  const r = Router();

  const load = async (user: AuthUser, id: string) => {
    const [f] = await db.query(
      `SELECT cf.*, p.key AS p_key FROM custom_fields cf JOIN projects p ON p.id = cf.project_id WHERE cf.id = $1 AND p.tenant_id = $2`,
      [Number(id), user.tenantId],
    );
    if (!f) throw notFound('Field');
    await requirePerm(db, user, f.project_id, 'ADMINISTER_PROJECTS');
    return f as CfRow;
  };

  const checkName = async (projectId: number, name: string, exceptId = 0) => {
    if (RESERVED.has(name.toLowerCase().replace(/\s+/g, ''))) throw bad(`"${name}" is a system field name`, { name: 'reserved' });
    if (/^cf\[|^customfield_/i.test(name)) throw bad('Choose a descriptive name', { name: 'reserved' });
    const dup = await db.query(`SELECT 1 FROM custom_fields WHERE project_id = $1 AND lower(name) = lower($2) AND id <> $3`, [projectId, name, exceptId]);
    if (dup.length) throw bad(`A field named "${name}" already exists in this space`, { name: 'taken' });
  };

  const typeIds = async (projectId: number, ids: (string | number)[] | null | undefined) => {
    if (!ids || !ids.length) return null;
    const ok = await db.query(`SELECT id FROM issue_types WHERE project_id = $1 AND id = ANY($2::int[])`, [projectId, ids.map(Number)]);
    if (ok.length !== ids.length) throw bad('Unknown work type in "applies to"');
    return ok.map((t) => t.id as number);
  };

  r.get(
    '/project/:key/fields',
    h(async (req) => {
      const user = req.user!;
      const p = await projectByKey(db, user, String(req.params.key));
      await requirePerm(db, user, p.id, 'BROWSE_PROJECTS');
      return (await fieldsOf(db, p.id)).map(fieldJson);
    }),
  );

  r.post(
    '/project/:key/fields',
    h(async (req, res) => {
      const user = req.user!;
      const p = await projectByKey(db, user, String(req.params.key));
      await requirePerm(db, user, p.id, 'ADMINISTER_PROJECTS');
      const body = FieldInput.parse(req.body);
      await checkName(p.id, body.name);
      const isChoice = body.type === 'select' || body.type === 'multiselect';
      if (isChoice && !body.options?.length) throw bad('Add at least one option', { options: 'required' });
      const options = isChoice ? body.options!.map((o) => ({ id: optionId(), value: o.value })) : [];
      if (new Set(options.map((o) => o.value.toLowerCase())).size !== options.length) throw bad('Options must be unique');
      const [{ next }] = await db.query(`SELECT coalesce(max(position) + 1, 0) AS next FROM custom_fields WHERE project_id = $1`, [p.id]);
      const [f] = await db.query(
        `INSERT INTO custom_fields (project_id, name, description, type, options, required, issue_type_ids, position)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING *`,
        [p.id, body.name, body.description ?? '', body.type, JSON.stringify(options), body.required ?? false, await typeIds(p.id, body.issueTypeIds), next],
      );
      res.status(201);
      return fieldJson(f);
    }),
  );

  /** Edit name/description/required/applies-to/position and options (keep ids to rename; omit to remove). Type is fixed. */
  r.put(
    '/field/:id',
    h(async (req) => {
      const user = req.user!;
      const f = await load(user, String(req.params.id));
      const body = FieldInput.partial().parse(req.body ?? {});
      if (body.type && body.type !== f.type) throw bad('A field’s type cannot be changed; create a new field instead');
      if (body.name) await checkName(f.project_id, body.name, f.id);
      let options = f.options;
      await db.tx(async (q) => {
        if (body.options && (f.type === 'select' || f.type === 'multiselect')) {
          if (!body.options.length) throw bad('Keep at least one option');
          options = body.options.map((o) => ({ id: o.id && f.options.some((x) => x.id === o.id) ? o.id : optionId(), value: o.value }));
          if (new Set(options.map((o) => o.value.toLowerCase())).size !== options.length) throw bad('Options must be unique');
          const removed = f.options.filter((o) => !options.some((x) => x.id === o.id)).map((o) => o.id);
          if (removed.length) {
            // values that pointed at removed options are cleared (select) or trimmed (multiselect)
            await q.query(`DELETE FROM issue_custom_values WHERE field_id = $1 AND jsonb_typeof(value) = 'string' AND value #>> '{}' = ANY($2::text[])`, [f.id, removed]);
            await q.query(
              `UPDATE issue_custom_values SET value = (SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements_text(value) e WHERE e <> ALL($2::text[]))
               WHERE field_id = $1 AND jsonb_typeof(value) = 'array'`,
              [f.id, removed],
            );
            await q.query(`DELETE FROM issue_custom_values WHERE field_id = $1 AND value = '[]'::jsonb`, [f.id]);
          }
        }
        if (body.position !== undefined) {
          const ids = (await q.query(`SELECT id FROM custom_fields WHERE project_id = $1 AND id <> $2 ORDER BY position, id`, [f.project_id, f.id])).map((x) => x.id);
          ids.splice(Math.min(body.position, ids.length), 0, f.id);
          for (const [i, id] of ids.entries()) await q.query(`UPDATE custom_fields SET position = $1 WHERE id = $2`, [i, id]);
        }
        await q.query(
          `UPDATE custom_fields SET name = $1, description = $2, required = $3, options = $4::jsonb, issue_type_ids = $5 WHERE id = $6`,
          [
            body.name ?? f.name, body.description ?? f.description, body.required ?? f.required, JSON.stringify(options),
            body.issueTypeIds !== undefined ? await typeIds(f.project_id, body.issueTypeIds) : f.issue_type_ids, f.id,
          ],
        );
      });
      const [fresh] = await db.query(`SELECT * FROM custom_fields WHERE id = $1`, [f.id]);
      return fieldJson(fresh);
    }),
  );

  r.delete(
    '/field/:id',
    h(async (req, res) => {
      const user = req.user!;
      const f = await load(user, String(req.params.id));
      await db.tx(async (q) => {
        await q.query(`DELETE FROM custom_fields WHERE id = $1`, [f.id]);
        // workflow validators that required this field no longer can
        await q.query(`UPDATE transitions SET required_fields = array_remove(required_fields, $1) WHERE project_id = $2`, [cfKey(f.id), f.project_id]);
      });
      res.status(204).end();
      return undefined;
    }),
  );

  return r;
}
