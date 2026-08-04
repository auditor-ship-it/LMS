import { logger } from '../utils/logger.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
}

/** Detects a real Google Sheets/Drive API rate-limit error bubbling up from
 *  googleapis (gaxios throws with `.code`/`.response.status` 429, or a 403
 *  whose message mentions "Quota exceeded" for the older quota-error shape). */
export function isGoogleQuotaError(err) {
  const status = err?.code || err?.response?.status;
  const message = String(err?.message || err?.response?.data?.error?.message || '');
  return status === 429 || /quota exceeded/i.test(message);
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  let message = err.message || 'Internal server error';
  let status = err.status || 500;

  if (!err.status) {
    // Same classification the original relied on by string-matching thrown
    // Error messages (e.g. checkActionPermission throws "ACCESS_DENIED: ...").
    if (/^ACCESS_DENIED/.test(message)) status = 403;
    else if (/not found/i.test(message)) status = 404;
    else if (isGoogleQuotaError(err)) {
      status = 429;
      message = 'Google Sheets API rate limit was hit. Please wait a few minutes before trying again.';
    }
  }

  if (status >= 500) {
    logger.error(`[ERROR] ${req.method} ${req.originalUrl} -> ${status}`);
    logger.error(`[API ERROR] Stack trace:`, err.stack || err);
  } else {
    logger.warn(`[API] ${req.method} ${req.originalUrl} -> ${status}: ${message}`);
  }

  res.status(status).json({ error: message });
}
