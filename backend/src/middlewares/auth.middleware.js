import { empSession } from '../services/auth.service.js';

/**
 * Resolves the Bearer token (equivalent of the `tok` argument threaded through
 * nearly every original Apps Script function) into req.user. Unlike the
 * original's getCurrentUser(), which silently falls back to "unknown" (Apps
 * Script's own signed-in user, unavailable in Node), a missing/invalid token
 * here is a hard 401 — there is no other identity source in this stack.
 */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : (req.body?.token || req.query?.token || '');
  const sess = token ? empSession(token) : null;
  if (!sess) {
    return res.status(401).json({ error: 'Not authenticated. Please log in again.' });
  }
  req.user = { ...sess, email: String(sess.email).trim().toLowerCase(), token };
  next();
}

/** For endpoints the original left open to any signed-in caller with a token, no permission check. */
export function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : (req.body?.token || req.query?.token || '');
  const sess = token ? empSession(token) : null;
  req.user = sess ? { ...sess, email: String(sess.email).trim().toLowerCase(), token } : null;
  next();
}
