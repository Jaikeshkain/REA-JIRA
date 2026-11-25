import express from 'express';
import type { Db } from './db.js';
import { authMiddleware, authRoutes } from './auth.js';
import { issueRoutes } from './issues.js';
import { projectRoutes } from './projects.js';
import { sprintRoutes } from './sprints.js';
import { errorHandler } from './http.js';

export function buildApp(db: Db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/api/auth', authRoutes(db));
  app.use('/api', authMiddleware(db), projectRoutes(db), issueRoutes(db), sprintRoutes(db));
  app.use('/api', (_req, res) => {
    res.status(404).json({ errorMessages: ['Not found'] });
  });
  app.use(errorHandler);
  return app;
}
