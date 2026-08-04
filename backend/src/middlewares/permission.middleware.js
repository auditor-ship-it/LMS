import { checkActionPermission } from '../services/permissions.service.js';
import { asyncHandler } from './asyncHandler.js';

/** Equivalent of calling checkActionPermission(type, tok) at the top of an Apps Script function. */
export function requirePermission(type) {
  return asyncHandler(async (req, res, next) => {
    await checkActionPermission(type, req.user.email);
    next();
  });
}
