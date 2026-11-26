import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Minimal adapter so the same SQL runs on embedded PGlite (dev) or a real Postgres (DATABASE_URL). */
export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  tx<T>(fn: (q: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  /**
   * LISTEN on a channel (Phase 4, multi-instance). Real Postgres: a dedicated connection that reconnects with backoff;
   * `onReconnect` fires after a gap, when messages may have been missed. Returns an unsubscribe function.
   */
  listen?(channel: string, onMessage: (payload: string) => void, onReconnect?: () => void): Promise<() => Promise<void>>;
  /** Run `fn` only if no other session holds this advisory lock (non-blocking). */
  withLock?<T>(key: number, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }>;
}

const CHANNEL = /^[a-z_][a-z0-9_]{0,62}$/;

const here = dirname(fileURLToPath(import.meta.url));

export async function openDb(opts: { dataDir?: string; url?: string } = {}): Promise<Db> {
  const url = opts.url || process.env.DATABASE_URL;
  let db: Db;
  if (url) {
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({ connectionString: url });
    const wrap = (c: { query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }> }): Db => ({
      query: async (s, p) => (await c.query(s, p as any[])).rows,
      tx: () => { throw new Error('nested tx'); },
      close: async () => {},
    });
    db = {
      ...wrap(pool),
      tx: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const r = await fn(wrap(client));
          await client.query('COMMIT');
          return r;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
      listen: async (channel, onMessage, onReconnect) => {
        if (!CHANNEL.test(channel)) throw new Error('bad channel name');
        let client: InstanceType<typeof pg.Client> | null = null;
        let stopped = false;
        let delay = 1000;
        const connect = async () => {
          const c = new pg.Client({ connectionString: url });
          c.on('notification', (n) => { if (n.channel === channel && n.payload) onMessage(n.payload); });
          c.on('error', (e) => console.warn('realtime listener error:', e.message));
          c.on('end', () => { if (!stopped) setTimeout(reconnect, delay); });
          await c.connect();
          await c.query(`LISTEN ${channel}`);
          client = c;
        };
        const reconnect = async () => {
          if (stopped) return;
          try {
            await connect();
            delay = 1000;
            onReconnect?.();
          } catch {
            delay = Math.min(delay * 2, 30_000);
            setTimeout(reconnect, delay);
          }
        };
        await connect();
        return async () => { stopped = true; await client?.end().catch(() => {}); };
      },
      withLock: async (key, fn) => {
        const client = await pool.connect();
        try {
          const [{ ok }] = (await client.query('SELECT pg_try_advisory_lock($1) AS ok', [key])).rows;
          if (!ok) return { ran: false as const };
          try {
            return { ran: true as const, value: await fn() };
          } finally {
            await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => {});
          }
        } finally {
          client.release();
        }
      },
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = opts.dataDir || process.env.PGLITE_DIR || join(here, '..', 'data', 'pglite');
    if (dir !== 'memory://') mkdirSync(dir, { recursive: true });
    const lite = new PGlite(dir);
    const wrap = (c: { query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }> }): Db => ({
      query: async (s, p) => (await c.query(s, p)).rows,
      tx: () => { throw new Error('nested tx'); },
      close: async () => {},
    });
    db = {
      ...wrap(lite),
      tx: (fn) => lite.transaction((t) => fn(wrap(t))),
      close: () => lite.close(),
      // one embedded database = one process, but the same code paths run (and are tested) here
      listen: async (channel, onMessage) => {
        if (!CHANNEL.test(channel)) throw new Error('bad channel name');
        return lite.listen(channel, onMessage);
      },
      withLock: async (key, fn) => {
        const [{ ok }] = (await lite.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [key])).rows;
        if (!ok) return { ran: false as const };
        try {
          return { ran: true as const, value: await fn() };
        } finally {
          await lite.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => {});
        }
      },
    };
  }
  await migrate(db);
  return db;
}

async function migrate(db: Db) {
  const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
  // Run statements one by one (pg parameterised API doesn't take multi-statement strings).
  for (const stmt of sql.split(/;\s*$/m).map((s) => s.replace(/--.*$/gm, '').trim()).filter(Boolean)) {
    await db.query(stmt);
  }
  await db.query(
    `INSERT INTO priorities (name, position, color) VALUES
      ('Highest',1,'#c9372c'),('High',2,'#e2483d'),('Medium',3,'#e2b203'),('Low',4,'#2898bd'),('Lowest',5,'#1d7afc')
     ON CONFLICT (name) DO NOTHING`,
  );
  await db.query(
    `INSERT INTO link_types (name, outward, inward) VALUES
      ('Blocks','blocks','is blocked by'),('Cloners','clones','is cloned by'),
      ('Duplicate','duplicates','is duplicated by'),('Relates','relates to','relates to')
     ON CONFLICT (name) DO NOTHING`,
  );
}
