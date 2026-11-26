/**
 * Working in bulk (Phase 4): bulk change, CSV export, CSV import.
 * Every item goes through the same operations as the single-issue API (permissions, validators, History,
 * notifications, automation), so bulk can never do something a person couldn't do one item at a time.
 */
import express, { Router } from 'express';
import { z } from 'zod';
import type { Db } from './db.js';
import type { AuthUser } from './auth.js';
import { h, bad } from './http.js';
import { projectByKey, requirePerm } from './access.js';
import { parse, compile, FROM } from './jql.js';
import { createIssue, deleteIssue, editField, moveToStatus, SELECT_FROM, issueJson } from './issues.js';
import { cfKey, display, fieldsOf, jqlCtx, normalise, type CfRow } from './customfields.js';
import { adfToText } from './adf.js';
import type { FileStore } from './attachments.js';

export const MAX_BULK = 100;
const MAX_EXPORT = 1000;
const MAX_IMPORT_ROWS = 500;

// ------------------------------------------------------------------ CSV helpers

/** RFC 4180 parser: quoted fields, doubled quotes, CRLF/LF, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

/** Quote a cell; neutralise spreadsheet formulas (CSV injection) by prefixing a single quote. */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ------------------------------------------------------------------ column model (export + search columns)

const BUILTIN_COLUMNS: Record<string, { label: string; get: (i: any) => unknown }> = {
  key: { label: 'Key', get: (i) => i.key },
  summary: { label: 'Summary', get: (i) => i.fields.summary },
  issuetype: { label: 'Work type', get: (i) => i.fields.issuetype.name },
  status: { label: 'Status', get: (i) => i.fields.status.name },
  priority: { label: 'Priority', get: (i) => i.fields.priority?.name },
  assignee: { label: 'Assignee', get: (i) => i.fields.assignee?.displayName },
  reporter: { label: 'Reporter', get: (i) => i.fields.reporter?.displayName },
  labels: { label: 'Labels', get: (i) => i.fields.labels.join(' ') },
  fixVersions: { label: 'Fix versions', get: (i) => (i.fields.fixVersions ?? []).map((v: any) => v.name).join(', ') },
  components: { label: 'Components', get: (i) => (i.fields.components ?? []).map((c: any) => c.name).join(', ') },
  parent: { label: 'Parent', get: (i) => i.fields.parent?.key },
  sprint: { label: 'Sprint', get: (i) => i.fields.sprint?.name },
  storypoints: { label: 'Story points', get: (i) => i.fields.storypoints },
  duedate: { label: 'Due date', get: (i) => i.fields.duedate },
  startdate: { label: 'Start date', get: (i) => i.fields.startdate },
  resolution: { label: 'Resolution', get: (i) => i.fields.resolution?.name ?? 'Unresolved' },
  created: { label: 'Created', get: (i) => i.fields.created && new Date(i.fields.created).toISOString() },
  updated: { label: 'Updated', get: (i) => i.fields.updated && new Date(i.fields.updated).toISOString() },
  description: { label: 'Description', get: (i) => adfToText(i.fields.description) },
  project: { label: 'Space', get: (i) => i.fields.project.key },
};
export const DEFAULT_COLUMNS = ['key', 'summary', 'issuetype', 'status', 'priority', 'assignee', 'updated'];

/** Run JQL for a user (viewer permissions) and return raw rows + Jira-shaped issues. */
async function searchRows(db: Db, user: AuthUser, jql: string, limit: number) {
  const params: unknown[] = [];
  const { where, order } = compile(parse(jql), await jqlCtx(db, user), params);
  const rows = await db.query(`${SELECT_FROM} WHERE ${where} ORDER BY ${order} LIMIT ${limit}`, params);
  const [{ total }] = await db.query(`SELECT count(*)::int AS total ${FROM} WHERE ${where}`, params);
  return { rows, total };
}

/** Custom field values for many issues at once: Map<issueId, Map<fieldId, display string>>. */
export async function customDisplay(db: Db, issueIds: number[], fieldIds: number[]) {
  const out = new Map<number, Map<number, string | null>>();
  if (!issueIds.length || !fieldIds.length) return out;
  const fields = await db.query<CfRow>(`SELECT * FROM custom_fields WHERE id = ANY($1::int[])`, [fieldIds]);
  const vals = await db.query(`SELECT issue_id, field_id, value FROM issue_custom_values WHERE issue_id = ANY($1::int[]) AND field_id = ANY($2::int[])`, [issueIds, fieldIds]);
  const userIds = vals.filter((v) => fields.find((f) => f.id === v.field_id)?.type === 'user').map((v) => Number(v.value));
  const users = new Map<string, string>(
    userIds.length ? (await db.query(`SELECT id, display_name FROM users WHERE id = ANY($1::int[])`, [userIds])).map((u) => [String(u.id), u.display_name]) : [],
  );
  for (const v of vals) {
    const f = fields.find((x) => x.id === v.field_id)!;
    if (!out.has(v.issue_id)) out.set(v.issue_id, new Map());
    out.get(v.issue_id)!.set(v.field_id, display(f, v.value, users));
  }
  return out;
}

// ------------------------------------------------------------------ routes

const BulkInput = z.object({
  keys: z.array(z.string().min(1)).min(1).max(MAX_BULK),
  action: z.discriminatedUnion('type', [
    // statusName lets one bulk move span spaces whose status ids differ
    z.object({ type: z.literal('transition'), statusId: z.union([z.string(), z.number()]).optional(), statusName: z.string().optional() }),
    z.object({ type: z.literal('edit'), field: z.string().min(1), operation: z.enum(['SET', 'ADD', 'REMOVE']).default('SET'), value: z.any() }),
    z.object({ type: z.literal('delete') }),
  ]),
});

export function bulkRoutes(db: Db, store: FileStore) {
  const r = Router();

  /** Bulk change: same rules as one-at-a-time; each item succeeds or fails on its own. */
  r.post('/bulk', h(async (req) => {
    const user = req.user!;
    const { keys, action } = BulkInput.parse(req.body);
    const results: { key: string; ok: boolean; error?: string }[] = [];
    for (const key of [...new Set(keys.map((k) => k.toUpperCase()))]) {
      try {
        if (action.type === 'transition') {
          let statusId = action.statusId != null ? Number(action.statusId) : NaN;
          if (action.statusName) {
            const [st] = await db.query(
              `SELECT s.id FROM statuses s JOIN issues i ON i.project_id = s.project_id
               WHERE i.tenant_id = $1 AND upper(i.key) = $2 AND lower(s.name) = lower($3)`,
              [user.tenantId, key, action.statusName],
            );
            if (!st) throw new Error(`No status "${action.statusName}" in this work item's space`);
            statusId = st.id;
          }
          if (!Number.isFinite(statusId)) throw new Error('Choose a status');
          await moveToStatus(db, user, key, statusId);
        }
        else if (action.type === 'edit') await editField(db, user, key, action.field, { operation: action.operation, value: action.value });
        else await deleteIssue(db, user, store, key, true);
        results.push({ key, ok: true });
      } catch (e: any) {
        results.push({ key, ok: false, error: e?.message ?? String(e) });
      }
    }
    return { succeeded: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length, results };
  }));

  /** Column catalogue for a user: built-ins + every custom field they can see. */
  r.get('/search/columns', h(async (req) => {
    const user = req.user!;
    const cfs = await db.query(
      `SELECT cf.id, cf.name, p.key AS project_key FROM custom_fields cf JOIN projects p ON p.id = cf.project_id
       WHERE p.tenant_id = $1 AND ($2 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $3))
       ORDER BY lower(cf.name), cf.id`,
      [user.tenantId, user.isSiteAdmin, user.id],
    );
    return {
      defaults: DEFAULT_COLUMNS,
      columns: [
        ...Object.entries(BUILTIN_COLUMNS).map(([id, c]) => ({ id, label: c.label })),
        ...cfs.map((f) => ({ id: cfKey(f.id), label: f.name, space: f.project_key })),
      ],
    };
  }));

  /** Search with chosen columns (custom fields as display strings). Used by the Search page table. */
  r.post('/search/table', h(async (req) => {
    const user = req.user!;
    const body = z.object({ jql: z.string().default(''), columns: z.array(z.string()).max(30).default(DEFAULT_COLUMNS), startAt: z.number().int().min(0).default(0), maxResults: z.number().int().min(1).max(200).default(50) }).parse(req.body ?? {});
    const params: unknown[] = [];
    const { where, order } = compile(parse(body.jql), await jqlCtx(db, user), params);
    const [{ total }] = await db.query(`SELECT count(*)::int AS total ${FROM} WHERE ${where}`, params);
    const rows = await db.query(`${SELECT_FROM} WHERE ${where} ORDER BY ${order} LIMIT ${body.maxResults} OFFSET ${body.startAt}`, params);
    const cfIds = body.columns.map((c) => /^customfield_(\d+)$/.exec(c)?.[1]).filter(Boolean).map(Number);
    const cv = await customDisplay(db, rows.map((x) => x.id), cfIds);
    return {
      total, startAt: body.startAt, maxResults: body.maxResults,
      issues: rows.map((row) => {
        const i = issueJson(row) as any;
        i.custom = Object.fromEntries(cfIds.map((id) => [cfKey(id), cv.get(row.id)?.get(id) ?? null]));
        return i;
      }),
    };
  }));

  /** CSV export of a JQL search (viewer permissions, max 1000 rows). */
  r.get('/search/csv', h(async (req, res) => {
    const user = req.user!;
    const jql = String(req.query.jql ?? '');
    const columns = String(req.query.columns ?? DEFAULT_COLUMNS.join(',')).split(',').map((c) => c.trim()).filter(Boolean).slice(0, 40);
    const { rows, total } = await searchRows(db, user, jql, MAX_EXPORT);
    const cfIds = columns.map((c) => /^customfield_(\d+)$/.exec(c)?.[1]).filter(Boolean).map(Number);
    const cfNames = new Map<number, string>(
      cfIds.length ? (await db.query(`SELECT id, name FROM custom_fields WHERE id = ANY($1::int[])`, [cfIds])).map((f) => [f.id, f.name]) : [],
    );
    const unknown = columns.filter((c) => !BUILTIN_COLUMNS[c] && !/^customfield_\d+$/.test(c));
    if (unknown.length) throw bad(`Unknown column ${unknown[0]}`);
    const cv = await customDisplay(db, rows.map((x) => x.id), cfIds);
    const header = columns.map((c) => (BUILTIN_COLUMNS[c] ? BUILTIN_COLUMNS[c].label : cfNames.get(Number(c.split('_')[1])) ?? c));
    const lines = [header.map(csvCell).join(',')];
    for (const row of rows) {
      const i = issueJson(row);
      lines.push(columns.map((c) => {
        if (BUILTIN_COLUMNS[c]) return csvCell(BUILTIN_COLUMNS[c].get(i));
        return csvCell(cv.get(row.id)?.get(Number(c.split('_')[1])) ?? '');
      }).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tracker-export-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('X-Total-Count', String(total));
    res.setHeader('X-Exported-Count', String(rows.length));
    res.end('﻿' + lines.join('\r\n') + '\r\n');
    return undefined;
  }));

  /**
   * CSV import into a space. Header names map to fields (case-insensitive): Summary (required), Work type/Type,
   * Priority, Assignee (email or name), Reporter, Labels (space/comma separated), Description, Due date, Start date,
   * Story points, Parent (key), Sprint (name), plus any custom field by name. `?dryRun=true` validates only.
   */
  r.post(
    '/project/:key/import',
    express.text({ type: () => true, limit: '2mb' }),
    h(async (req) => {
      const user = req.user!;
      const p = await projectByKey(db, user, String(req.params.key));
      await requirePerm(db, user, p.id, 'CREATE_ISSUES');
      const dryRun = req.query.dryRun === 'true';
      const table = parseCsv(typeof req.body === 'string' ? req.body : '');
      if (table.length < 2) throw bad('The file needs a header row and at least one data row');
      if (table.length - 1 > MAX_IMPORT_ROWS) throw bad(`At most ${MAX_IMPORT_ROWS} rows per import`);
      const header = table[0].map((h) => h.trim());
      const cfs = await fieldsOf(db, p.id);
      const ALIASES: Record<string, string> = {
        summary: 'summary', 'work type': 'type', type: 'type', 'issue type': 'type', priority: 'priority', assignee: 'assignee',
        reporter: 'reporter', labels: 'labels', label: 'labels', description: 'description', 'due date': 'duedate', due: 'duedate',
        'start date': 'startdate', 'story points': 'storypoints', points: 'storypoints', parent: 'parent', 'parent key': 'parent',
        sprint: 'sprint', key: '__ignore', status: '__status',
      };
      const mapping = header.map((h) => {
        const k = h.toLowerCase();
        if (ALIASES[k]) return ALIASES[k];
        const cf = cfs.find((f) => f.name.toLowerCase() === k);
        return cf ? cfKey(cf.id) : null;
      });
      if (!mapping.includes('summary')) throw bad('A "Summary" column is required');
      const ignored = header.filter((_, i) => mapping[i] === null || mapping[i] === '__ignore' || mapping[i] === '__status');

      const people = await db.query(
        `SELECT u.id, lower(u.email) AS email, lower(u.display_name) AS name FROM users u
         WHERE u.tenant_id = $1 AND u.active AND (u.is_site_admin OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = $2 AND pm.user_id = u.id))`,
        [user.tenantId, p.id],
      );
      const sprints = await db.query(`SELECT id, lower(name) AS name FROM sprints WHERE project_id = $1 AND state <> 'closed'`, [p.id]);
      const findUser = (v: string) => people.find((x) => x.email === v.toLowerCase() || x.name === v.toLowerCase());

      const rows: { row: number; ok: boolean; key?: string; errors: string[]; summary: string }[] = [];
      for (let n = 1; n < table.length; n++) {
        const cells = table[n];
        const errors: string[] = [];
        const fields: Record<string, unknown> = { project: { key: p.key }, issuetype: { name: 'Task' } };
        for (const [i, target] of mapping.entries()) {
          const v = (cells[i] ?? '').trim();
          if (!target || target.startsWith('__') || v === '') continue;
          switch (target) {
            case 'summary': fields.summary = v; break;
            case 'type': fields.issuetype = { name: v }; break;
            case 'priority': fields.priority = { name: v }; break;
            case 'description': fields.description = v.replace(/\\n/g, '\n'); break;
            case 'labels': fields.labels = v.split(/[\s,]+/).filter(Boolean); break;
            case 'duedate': case 'startdate':
              if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) errors.push(`${header[i]}: use YYYY-MM-DD`);
              else fields[target] = v;
              break;
            case 'storypoints': {
              const num = Number(v);
              if (!Number.isFinite(num) || num < 0) errors.push(`${header[i]}: not a number`);
              else fields.storypoints = num;
              break;
            }
            case 'parent': fields.parent = { key: v }; break;
            case 'assignee': case 'reporter': {
              const u = findUser(v);
              if (!u) errors.push(`${header[i]}: "${v}" is not a member of ${p.key}`);
              else fields[target] = { accountId: String(u.id) };
              break;
            }
            case 'sprint': {
              const s = sprints.find((x) => x.name === v.toLowerCase());
              if (!s) errors.push(`Sprint: "${v}" is not an open sprint`);
              else fields.sprint = { id: String(s.id) };
              break;
            }
            default: {
              const f = cfs.find((x) => cfKey(x.id) === target)!;
              const raw = f.type === 'multiselect' ? v.split(/\s*[,;]\s*/) : f.type === 'user' ? String(findUser(v)?.id ?? v) : v;
              try { await normalise(db, user.tenantId, f, raw); fields[target] = raw; } catch (e: any) { errors.push(`${f.name}: ${e.message}`); }
            }
          }
        }
        if (!fields.summary) errors.push('Summary is empty');
        const summary = String(fields.summary ?? '');
        if (errors.length) { rows.push({ row: n + 1, ok: false, errors, summary }); continue; }
        if (dryRun) {
          // validate type/priority/parent the same way create would, without writing
          const [t] = await db.query(`SELECT id, hierarchy_level FROM issue_types WHERE project_id = $1 AND lower(name) = lower($2)`, [p.id, (fields.issuetype as any).name]);
          if (!t) errors.push(`Work type "${(fields.issuetype as any).name}" not in ${p.key}`);
          if (fields.priority) {
            const pr = await db.query(`SELECT 1 FROM priorities WHERE lower(name) = lower($1)`, [(fields.priority as any).name]);
            if (!pr.length) errors.push(`Priority "${(fields.priority as any).name}" doesn't exist`);
          }
          if (t?.hierarchy_level === -1 && !fields.parent) errors.push('Subtasks need a Parent');
          rows.push({ row: n + 1, ok: !errors.length, errors, summary });
          continue;
        }
        try {
          const created = await createIssue(db, user, { fields });
          rows.push({ row: n + 1, ok: true, key: created.key, errors: [], summary });
        } catch (e: any) {
          rows.push({ row: n + 1, ok: false, errors: [e?.message ?? String(e)], summary });
        }
      }
      return {
        dryRun,
        mapping: header.map((h, i) => ({ column: h, field: mapping[i] && !mapping[i]!.startsWith('__') ? mapping[i] : null })),
        ignored,
        ok: rows.filter((x) => x.ok).length,
        failed: rows.filter((x) => !x.ok).length,
        rows,
      };
    }),
  );

  return r;
}
