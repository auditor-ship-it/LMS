import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';
import { runInRequestContext, getRequestContext } from '../utils/requestContext.js';

/** Route-prefix -> human page name, for the "[PAGE] X — Source: ..." lines.
 *  Add an entry here as each domain migrates so its logs read as a page name
 *  instead of a raw path — purely cosmetic, doesn't affect behavior. */
const PAGE_NAMES = {
  '/api/dashboard': 'Dashboard',
  '/api/tasks': 'My Task',
  '/api/roles': 'Roles & Access',
  '/api/auth': 'Login / Auth',
  '/api/verify': 'Verify Lease',
  '/api/approve': 'Approve Lease',
  '/api/expiry': 'Lease Expiry',
  '/api/offlease': 'Off-Lease Tracking',
  '/api/billing': 'Billing Sales',
  '/api/receivables': 'Receivables',
  '/api/transport': 'Transport',
  '/api/disputes': 'Dispute Approval',
  '/api/pending-billing': 'Pending Billing'
};

function pageNameFor(path) {
  const prefix = Object.keys(PAGE_NAMES).find((p) => path.startsWith(p));
  return prefix ? PAGE_NAMES[prefix] : null;
}

function describe(sources) {
  if (!sources || sources.size === 0) return 'none';
  return [...sources].map((s) => (s === 'mongo' ? 'MongoDB' : 'Google Sheets')).join(' + ');
}

/**
 * First middleware in the chain (see app.js). Wraps the rest of the request
 * in an AsyncLocalStorage context so deep, un-threaded calls into
 * mongo/Sheets code can record which datastore they touched — that's what
 * makes the "[API] Source: ..." / "[PAGE] ... Source: ..." lines below
 * truthful rather than guessed from the route.
 */
export function requestLogger(req, res, next) {
  const requestId = crypto.randomBytes(4).toString('hex');
  const start = process.hrtime.bigint();
  const page = pageNameFor(req.path);

  runInRequestContext({ requestId, method: req.method, path: req.path }, () => {
    const ctx = getRequestContext();
    logger.info(`[API] ${req.method} ${req.originalUrl}`);
    if (page) logger.info(`[PAGE] ${page} opened — fetching data`);

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const source = describe(ctx?.sources);
      logger.info(`[API] Source: ${source} | Response Time: ${durationMs.toFixed(1)}ms | Status: ${res.statusCode}`);
      if (page) logger.info(`[PAGE] ${page} — Source: ${source}`);
      if (res.statusCode >= 500) {
        logger.error(`[API ERROR] ${req.method} ${req.originalUrl} -> ${res.statusCode}`);
      }
    });

    next();
  });
}
