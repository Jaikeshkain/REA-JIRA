import { openDb } from './db.js';
import { buildApp } from './app.js';
import { seedIfEmpty } from './seed.js';
import { startScheduler } from './scheduler.js';

// API_PORT (not PORT): dev launchers set PORT for the UI server, which would collide with Vite.
const port = Number(process.env.API_PORT || 4000);
// HOST=0.0.0.0 in containers; the default only accepts local connections
const host = process.env.HOST || '127.0.0.1';
const db = await openDb();
await seedIfEmpty(db);
const app = buildApp(db);
const stopScheduler = startScheduler(db); // notification emails, subscriptions, scheduled rules, delivery
const server = app.listen(port, host, () => {
  console.log(`Tracker listening on http://${host}:${port}${process.env.SERVE_CLIENT ? ' (API + web app)' : ''} (${process.env.DATABASE_URL ? 'Postgres' : 'PGlite'})`);
});

const shutdown = async () => {
  stopScheduler();
  (app.locals.hub as { close(): void } | undefined)?.close();
  server.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
