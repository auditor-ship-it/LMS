import { empSession } from '../services/auth.service.js';

/**
 * Resolves the Bearer token (equivalent of the `tok` argument threaded through
 * nearly every original Apps Script function) into req.user. Unlike the
 * original's getCurrentUser(), which silently falls back to "unknown" (Apps
 * Script's own signed-in user, unavailable in Node), a missing/invalid token
 * here is a hard 401 — there is no other identity source in this stack.
 *
 * Both functions below are async (empSession() now reads Mongo, not an
 * in-process cache) and explicitly try/catch their own body — Express 4
 * doesn't forward a rejected async middleware to the error handler on its
 * own, so an uncaught Mongo hiccup here would otherwise hang the request
 * instead of failing it. Any lookup error is treated as "not authenticated."
 */
export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : (req.body?.token || req.query?.token || '');
    const sess = token ? await empSession(token) : null;
    if (!sess) {
      return res.status(401).json({ error: 'Not authenticated. Please log in again.' });
    }
    req.user = { ...sess, email: String(sess.email).trim().toLowerCase(), token };
    next();
  } catch (e) {
    next(e);
  }
}

/** For endpoints the original left open to any signed-in caller with a token, no permission check. */
export async function optionalAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : (req.body?.token || req.query?.token || '');
    const sess = token ? await empSession(token) : null;
    req.user = sess ? { ...sess, email: String(sess.email).trim().toLowerCase(), token } : null;
    next();
  } catch (e) {
    next(e);
  }
}
