import { verifyApiKey, checkPublicApiRateLimit, hasReadAccess, hasWriteAccess } from '../services/apiKeys.service.js';
import { AppError, accessDenied } from '../utils/AppError.js';
import { env } from '../config/env.js';

function extractKey(req) {
  const header = req.headers['x-api-key'];
  if (header) return String(header).trim();
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

/**
 * Gate for /api/public/v1/* — a completely separate identity from the app's
 * own session auth (requireAuth/optionalAuth). No cookie/bearer session
 * token is involved; the only credential is the X-Api-Key header, issued
 * and scoped from the API Access admin screen (routes/apiKeys.routes.js).
 *
 * `domain` is one of apiKeys.service.js's API_DOMAINS. Pass `{ write: true }`
 * for a mutating route — the key then needs `<domain>:write` or `all:write`,
 * not just read access, and req.actsAsEmail is set to the real LMS user the
 * key writes as (see apiKeys.service.js's header comment for why writes are
 * "acts as a real person", not an ambient API-key identity).
 */
export function requirePublicApiKey(domain, { write = false } = {}) {
  return async (req, res, next) => {
    try {
      if (!env.enablePublicApi) {
        return next(new AppError('The public API is currently disabled.', 503));
      }
      const raw = extractKey(req);
      if (!raw) {
        return next(new AppError('Missing API key. Pass it in the X-Api-Key header.', 401));
      }
      const key = await verifyApiKey(raw);
      if (!key) {
        return next(new AppError('Invalid or revoked API key.', 401));
      }
      const allowed = write ? hasWriteAccess(key.scopes, domain) : hasReadAccess(key.scopes, domain);
      if (!allowed) {
        return next(accessDenied(
          write
            ? `This API key does not have write access to the "${domain}" data domain.`
            : `This API key does not have access to the "${domain}" data domain.`
        ));
      }
      if (!checkPublicApiRateLimit(key.id)) {
        return next(new AppError('Rate limit exceeded (120 requests/minute per key). Try again shortly.', 429));
      }
      req.apiKey = key;
      if (write) req.actsAsEmail = key.actsAsEmail;
      next();
    } catch (e) {
      next(e);
    }
  };
}
