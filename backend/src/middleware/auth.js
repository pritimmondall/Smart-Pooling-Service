import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AppError } from '../utils/appError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { User } from '../models/User.js';

/**
 * Signs an HS256 JWT access token for an authenticated user.
 */
export function signAuthToken(user) {
  if (!env.jwtSecret) {
    throw new AppError(500, 'JWT signing secret is not configured.', 'AUTH_CONFIG_ERROR');
  }
  return jwt.sign(
    {
      sub: String(user._id),
      role: user.role,
    },
    env.jwtSecret,
    {
      algorithm: 'HS256',
      expiresIn: env.jwtExpiresIn,
    }
  );
}

/**
 * Creates authentication middleware with an optional userLoader override for isolated unit tests.
 */
export function createAuthMiddleware(userLoader = (id) => User.findById(id).select('-passwordHash')) {
  return asyncHandler(async (req, _res, next) => {
    if (!env.jwtSecret) {
      throw new AppError(500, 'JWT verification secret is not configured.', 'AUTH_CONFIG_ERROR');
    }

    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      throw new AppError(401, 'Authorization Bearer token is required.', 'AUTH_REQUIRED');
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      throw new AppError(401, 'Authorization token is empty.', 'AUTH_REQUIRED');
    }

    const decoded = jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'] });
    const user = await userLoader(decoded.sub);

    if (!user) {
      throw new AppError(401, 'Authenticated user no longer exists.', 'AUTH_USER_NOT_FOUND');
    }
    if (!user.isActive) {
      throw new AppError(403, 'Account is deactivated.', 'ACCOUNT_INACTIVE');
    }

    req.user = user;
    next();
  });
}

export const protect = createAuthMiddleware();

/**
 * Restricts route access to explicit user roles (customer, technician, admin).
 */
export function authorizeRoles(...allowedRoles) {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new AppError(401, 'Authentication required.', 'AUTH_REQUIRED'));
    }
    if (!allowedRoles.includes(req.user.role)) {
      return next(
        new AppError(
          403,
          `Role "${req.user.role}" is not permitted to access this resource.`,
          'FORBIDDEN_ROLE'
        )
      );
    }
    return next();
  };
}
