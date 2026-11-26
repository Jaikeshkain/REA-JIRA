import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Db } from './db.js';
import { authMiddleware, authRoutes } from './auth.js';
import { issueRoutes } from './issues.js';
import { projectRoutes } from './projects.js';
import { sprintRoutes } from './sprints.js';
import { linkRoutes } from './links.js';
import { attachmentRoutes, FileStore } from './attachments.js';
import { errorHandler } from './http.js';
import { filterRoutes } from './filters.js';
import { dashboardRoutes } from './dashboards.js';
import { customFieldRoutes } from './customfields.js';
import { workflowRoutes } from './workflow.js';
import { notificationRoutes } from './notifications.js';
import { automationRoutes } from './automation.js';
import { bulkRoutes } from './bulk.js';
import { Hub, changeTracker, setHub } from './realtime.js';
import { schedulerRoutes } from './scheduler.js';
import { oidcConfigFromEnv, oidcRoutes, type OidcConfig } from './oidc.js';
import { auditRoutes, auditTrail } from './audit.js';
import { webhookRoutes } from './webhooks.js';
import { versionRoutes } from './versions.js';
import { logChange, loadIssue } from './issues.js';
import { worklogRoutes } from './timetracking.js';
import { securityRoutes } from './security.js';
import { voteRoutes } from './votes.js';

const here = dirname(fileURLToPath(import.meta.url));

export function buildApp(db: Db, opts: { attachmentsDir?: string; oidc?: OidcConfig | null } = {}) {
  const store = new FileStore(opts.attachmentsDir || process.env.ATTACHMENTS_DIR || join(here, '..', 'data', 'attachments'));
  const app = express();
  app.disable('x-powered-by');
  const json = express.json({ limit: '1mb' });
  // uploads carry raw file bytes (any content type, including application/json) — never JSON-parse them
  app.use((req, res, next) => (/\/attachments$|\/import$/.test(req.path) ? next() : json(req, res, next)));
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/api/auth/oidc', oidcRoutes(db, opts.oidc === undefined ? oidcConfigFromEnv() : opts.oidc));
  app.use('/api/auth', authRoutes(db));
  // real-time: one SSE stream per tab; change events published after successful writes
  const hub = new Hub(db);
  setHub(hub);
  app.locals.hub = hub;
  app.get('/api/events', authMiddleware(db), hub.open);
  app.use(
    '/api',
    authMiddleware(db),
    changeTracker(db, hub),
    auditTrail(db),
    projectRoutes(db),
    issueRoutes(db, store),
    sprintRoutes(db),
    linkRoutes(db),
    attachmentRoutes(db, store),
    filterRoutes(db),
    dashboardRoutes(db),
    customFieldRoutes(db),
    workflowRoutes(db),
    notificationRoutes(db),
    automationRoutes(db),
    bulkRoutes(db, store),
    schedulerRoutes(db),
    auditRoutes(db),
    webhookRoutes(db),
    versionRoutes(db, logChange),
    worklogRoutes(db, loadIssue, logChange),
    securityRoutes(db),
    voteRoutes(db, loadIssue, logChange),
  );
  app.use('/api', (_req, res) => {
    res.status(404).json({ errorMessages: ['Not found'] });
  });
  app.use(errorHandler);
  return app;
}
