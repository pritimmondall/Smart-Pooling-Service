import { AppError } from '../utils/appError.js';
import { env } from '../config/env.js';

/**
 * Fallback 404 handler for unmatched API routes.
 */
export function notFoundHandler(req, _res, next) {
  next(new AppError(404, `Route not found: ${req.method} ${req.originalUrl}`, 'ROUTE_NOT_FOUND'));
}

/**
 * Global Express error-handling middleware translating operational, Mongoose, and JWT errors to consistent JSON.
 */
export function errorHandler(err, _req, res, _next) {
  let statusCode = err.statusCode || 500;
  let code = err.code || 'INTERNAL_ERROR';
  let message = err.message || 'Internal server error';
  let details = err.details;

  if (err.name === 'ValidationError') {
    statusCode = 400;
    code = 'VALIDATION_ERROR';
    message = 'Validation failed.';
    details = Object.values(err.errors || {}).map((e) => ({
      field: e.path,
      message: e.message,
    }));
  } else if (err.name === 'CastError') {
    statusCode = 400;
    code = 'INVALID_ID';
    message = `Invalid identifier format for field "${err.path}".`;
  } else if (err.code === 11000) {
    statusCode = 409;
    code = 'DUPLICATE_KEY';
    const dupFields = Object.keys(err.keyPattern || {});
    message = `Duplicate value for unique field(s): ${dupFields.join(', ') || 'unknown'}.`;
  } else if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    statusCode = 401;
    code = 'AUTH_TOKEN_INVALID';
    message = err.name === 'TokenExpiredError' ? 'Authentication token expired.' : 'Invalid authentication token.';
  } else if (err.name === 'VersionError') {
    statusCode = 409;
    code = 'CONCURRENCY_CONFLICT';
    message = 'Document was modified concurrently; please retry.';
  }

  const payload = {
    success: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };

  if (env.nodeEnv === 'development' && statusCode >= 500) {
    payload.error.stack = err.stack;
  }

  res.status(statusCode).json(payload);
}
