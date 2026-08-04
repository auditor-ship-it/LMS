/**
 * Error with an HTTP status attached, so services can `throw new AppError(...)`
 * the same way the original threw plain Error()s (e.g. "ACCESS_DENIED: ...",
 * "Sheet not found: ...") and the errorHandler middleware maps it to a status.
 */
export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AppError';
    this.status = status;
  }
}

export function accessDenied(message = 'ACCESS_DENIED: You do not have permission to perform this action.') {
  return new AppError(message, 403);
}

export function notFound(message) {
  return new AppError(message, 404);
}
