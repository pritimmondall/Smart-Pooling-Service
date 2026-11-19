/**
 * Operational application error with HTTP status code and optional machine-readable code/details.
 */
export class AppError extends Error {
  constructor(statusCode, message, code = 'APP_ERROR', details = undefined) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace?.(this, this.constructor);
  }
}
