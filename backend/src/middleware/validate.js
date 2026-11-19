import mongoose from 'mongoose';
import { AppError } from '../utils/appError.js';

/**
 * Validates that a route parameter is a valid MongoDB ObjectId before hitting controllers.
 */
export function validateObjectIdParam(paramName = 'id') {
  return (req, _res, next) => {
    const value = req.params?.[paramName];
    if (!mongoose.isValidObjectId(value)) {
      return next(new AppError(400, `Invalid ObjectId format for parameter "${paramName}".`, 'INVALID_ID'));
    }
    return next();
  };
}

/**
 * Ensures required top-level body fields are present and non-empty strings/values.
 */
export function requireBodyFields(...fields) {
  return (req, _res, next) => {
    const body = req.body || {};
    const missing = fields.filter((field) => {
      const val = body[field];
      return val === undefined || val === null || (typeof val === 'string' && val.trim() === '');
    });

    if (missing.length > 0) {
      return next(
        new AppError(
          400,
          `Missing required field(s): ${missing.join(', ')}.`,
          'VALIDATION_ERROR',
          missing.map((field) => ({ field, message: `${field} is required.` }))
        )
      );
    }
    return next();
  };
}
