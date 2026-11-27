/** Owner portal database: an embedded PostgreSQL (PGlite) kept next to your private key, outside the repository. */
import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

export interface PDb {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS owners (
  id SERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, owner_id INT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY, company TEXT NOT NULL, contact_name TEXT NOT NULL DEFAULT '', contact_email TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '', archived BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS installations (
  id SERIAL PRIMARY KEY, customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  install_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, install_id)
);
CREATE TABLE IF NOT EXISTS licenses (
  id SERIAL PRIMARY KEY, lid TEXT NOT NULL UNIQUE, customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  install TEXT NOT NULL, seats INT NOT NULL, issued TIMESTAMPTZ NOT NULL, expires TIMESTAMPTZ NOT NULL, key TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '', created_by INT REFERENCES owners(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ, sent_to TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), owner_name TEXT, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT ''
);
`;

export async function openPortalDb(dir: string): Promise<PDb> {
  if (dir !== 'memory://') mkdirSync(dir, { recursive: true });
  const lite = new PGlite(dir);
  for (const stmt of SCHEMA.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) await lite.query(stmt);
  return {
    query: async (s, p) => (await lite.query(s, p)).rows as any[],
    close: () => lite.close(),
  };
}
