import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Minimal adapter so the same SQL runs on embedded PGlite (dev) or a real Postgres (DATABASE_URL). */
export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  tx<T>(fn: (q: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));

export async function openDb(opts: { dataDir?: string; url?: string } = {}): Promise<Db> {
  const url = opts.url ?? process.env.DATABASE_URL;
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
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = opts.dataDir ?? process.env.PGLITE_DIR ?? join(here, '..', 'data', 'pglite');
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
}
