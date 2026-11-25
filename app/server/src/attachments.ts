/**
 * Attachments (Phase 3). Bytes are stored on disk under ATTACHMENTS_DIR with random keys; the DB keeps
 * metadata and a SHA-256. Downloads are authenticated and served defensively: only a short allowlist of
 * raster image types is ever shown inline, everything else is forced to download, and every response is
 * sandboxed + nosniff so an uploaded HTML/SVG file cannot run script on the app's origin.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import express, { Router } from 'express';
import type { Db } from './db.js';
import type { AuthUser } from './auth.js';
import { h, bad, notFound, forbidden } from './http.js';
import { roleIn, userRef } from './access.js';
import { can } from './permissions.js';

export const MAX_ATTACHMENT_BYTES = Number(process.env.MAX_ATTACHMENT_MB ?? 10) * 1024 * 1024;
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export class FileStore {
  constructor(public dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  async put(buf: Buffer) {
    const key = randomUUID();
    await writeFile(join(this.dir, key), buf, { flag: 'wx' });
    return key;
  }
  read(key: string) {
    if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error('bad storage key');
    return readFile(join(this.dir, key));
  }
  async remove(keys: string[]) {
    await Promise.all(keys.filter((k) => /^[0-9a-f-]{36}$/.test(k)).map((k) => unlink(join(this.dir, k)).catch(() => {})));
  }
}

/** Keep only a plain base name: no paths, control characters or reserved characters; bounded length. */
export function cleanFilename(raw: string | undefined) {
  let name = '';
  try { name = decodeURIComponent(raw ?? ''); } catch { name = raw ?? ''; }
  name = name.split(/[\\/]/).pop() ?? '';
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/^\.+/, '').trim().slice(0, 200);
  return name || 'file';
}

const attachmentJson = (a: any) => ({
  id: String(a.id),
  filename: a.filename,
  mimeType: a.mime_type,
  size: Number(a.size),
  created: a.created_at,
  author: userRef(a.author_id, a.display_name, null, a.avatar_color),
  content: `/api/attachment/${a.id}/content`,
  isImage: INLINE_TYPES.has(a.mime_type),
});

export async function attachmentsFor(db: Db, issueId: number) {
  const rows = await db.query(
    `SELECT a.*, u.display_name, u.avatar_color FROM attachments a JOIN users u ON u.id = a.author_id
     WHERE a.issue_id = $1 ORDER BY a.created_at DESC, a.id DESC`,
    [issueId],
  );
  return rows.map(attachmentJson);
}

async function issueAccess(db: Db, user: AuthUser, where: string, param: unknown) {
  const [i] = await db.query(`SELECT i.id, i.key, i.project_id FROM issues i WHERE i.tenant_id = $1 AND ${where}`, [user.tenantId, param]);
  if (!i) throw notFound('Issue');
  const role = await roleIn(db, user, i.project_id);
  if (!can(role, 'BROWSE_PROJECTS', user.isSiteAdmin)) throw notFound('Issue');
  return { issue: i, role };
}

export function attachmentRoutes(db: Db, store: FileStore) {
  const r = Router();

  /**
   * Upload one file as the raw request body (header X-File-Name carries the URI-encoded name).
   * Jira uses multipart; a raw body keeps the server dependency-free and streams the same bytes.
   */
  r.post(
    '/issue/:key/attachments',
    express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES }),
    h(async (req, res) => {
      const user = req.user!;
      const { issue, role } = await issueAccess(db, user, 'upper(i.key) = upper($2)', String(req.params.key));
      if (!can(role, 'CREATE_ATTACHMENTS', user.isSiteAdmin)) throw forbidden('CREATE_ATTACHMENTS');
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!buf.length) throw bad('Empty file');
      const filename = cleanFilename(req.header('x-file-name'));
      const mime = (req.header('content-type') ?? 'application/octet-stream').split(';')[0].trim().toLowerCase().slice(0, 100) || 'application/octet-stream';
      const key = await store.put(buf);
      try {
        const [a] = await db.query(
          `INSERT INTO attachments (issue_id, author_id, filename, mime_type, size, sha256, storage_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [issue.id, user.id, filename, mime, buf.length, createHash('sha256').update(buf).digest('hex'), key],
        );
        await db.query(`INSERT INTO changelog (issue_id, actor_id, field, to_value, to_string) VALUES ($1,$2,'Attachment',$3,$4)`, [
          issue.id, user.id, a.id, filename,
        ]);
        await db.query(`UPDATE issues SET updated_at = now() WHERE id = $1`, [issue.id]);
        res.status(201);
        return [attachmentJson({ ...a, display_name: user.displayName, avatar_color: user.avatarColor })];
      } catch (e) {
        await store.remove([key]);
        throw e;
      }
    }),
  );

  r.get(
    '/attachment/:id/content',
    h(async (req, res) => {
      const user = req.user!;
      const [a] = await db.query(`SELECT * FROM attachments WHERE id = $1`, [Number(req.params.id)]);
      if (!a) throw notFound('Attachment');
      await issueAccess(db, user, 'i.id = $2', a.issue_id);
      const buf = await store.read(a.storage_key);
      const inline = INLINE_TYPES.has(a.mime_type) && req.query.download !== 'true';
      res.setHeader('Content-Type', inline ? a.mime_type : 'application/octet-stream');
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.end(buf);
      return undefined;
    }),
  );

  r.delete(
    '/attachment/:id',
    h(async (req, res) => {
      const user = req.user!;
      const [a] = await db.query(`SELECT * FROM attachments WHERE id = $1`, [Number(req.params.id)]);
      if (!a) throw notFound('Attachment');
      const { role } = await issueAccess(db, user, 'i.id = $2', a.issue_id);
      const perm = a.author_id === user.id ? 'DELETE_OWN_ATTACHMENTS' : 'DELETE_ALL_ATTACHMENTS';
      if (!can(role, perm, user.isSiteAdmin)) throw forbidden(perm);
      await db.query(`DELETE FROM attachments WHERE id = $1`, [a.id]);
      await db.query(`INSERT INTO changelog (issue_id, actor_id, field, from_value, from_string) VALUES ($1,$2,'Attachment',$3,$4)`, [
        a.issue_id, user.id, a.id, a.filename,
      ]);
      await store.remove([a.storage_key]);
      res.status(204).end();
      return undefined;
    }),
  );

  return r;
}
