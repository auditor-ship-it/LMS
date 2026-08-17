import express from 'express';
import cors from 'cors';
import { notFoundHandler, errorHandler } from './middlewares/errorHandler.js';
import { responseCache } from './middlewares/responseCache.middleware.js';
import { requestLogger } from './middlewares/requestLogger.middleware.js';
import { optionalAuth } from './middlewares/auth.middleware.js';

import authRoutes from './routes/auth.routes.js';
import rolesRoutes from './routes/roles.routes.js';
import uploadRoutes from './routes/upload.routes.js';
import verifyRoutes from './routes/verify.routes.js';
import approveRoutes from './routes/approve.routes.js';
import expiryRoutes from './routes/expiry.routes.js';
import offLeaseRoutes from './routes/offlease.routes.js';
import tasksRoutes from './routes/tasks.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';

/**
 * Lease Management's own, standalone backend — a narrower copy of the
 * original shared backend/src/app.js carrying only the route modules
 * lease-management's frontend actually calls (auth, roles, uploads, verify,
 * approve, expiry, offlease, tasks, plus the Deployed Summary slice of
 * dashboard). No Collections/Receivables/report-suite/dispute/etc. routes
 * here — see the split-into-three-apps plan.
 */
export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '25mb' })); // generous limit: base64 file uploads pass through JSON bodies

  // First in the chain — establishes the per-request logging context every
  // downstream Mongo/Sheets access reports into (see requestContext.js).
  app.use(requestLogger);

  /* Unauthenticated on purpose, and deliberately says WHICH build is running.
     A deploy that ships the frontend but leaves the old Node process up is
     invisible from outside: the UI is new, the API is old, and the only
     symptoms are wrong numbers and 404s on routes that plainly exist in the
     repo. Diagnosing that took a full investigation; `curl /api/health` should
     answer it in one line.

     Commit comes from the environment (set it in the deploy script, e.g.
     GIT_COMMIT=$(git rev-parse --short HEAD)) — not shelled out to git here,
     which would be a process spawn per request and wrong anyway if the
     checkout moves on without a restart. `startedAt` needs no configuration
     and is the decisive one: a process older than your last deploy did not
     pick it up. */
  const STARTED_AT = new Date().toISOString();
  app.get('/api/health', (req, res) => res.json({
    ok: true,
    service: 'lease-management-backend',
    commit: process.env.GIT_COMMIT || 'unset',
    startedAt: STARTED_AT,
    uptimeSeconds: Math.round(process.uptime())
  }));

  // Resolves req.user (if a valid session token is present) for every request,
  // then serves/populates the per-user response cache + global quota-lockout
  // guard below — see responseCache.middleware.js. Each route's own
  // requireAuth still rejects genuinely unauthenticated requests.
  app.use(optionalAuth);
  app.use(responseCache);

  app.use('/api/auth', authRoutes);
  app.use('/api/roles', rolesRoutes);
  app.use('/api/uploads', uploadRoutes);
  app.use('/api/verify', verifyRoutes);
  app.use('/api/approve', approveRoutes);
  app.use('/api/expiry', expiryRoutes);
  app.use('/api/offlease', offLeaseRoutes);
  app.use('/api/tasks', tasksRoutes);
  app.use('/api/dashboard', dashboardRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
