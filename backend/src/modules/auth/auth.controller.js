import mongoose from 'mongoose';
import { User, TechnicianProfile, ServiceCategory, ServiceZone } from '../../models/index.js';
import { runInTransaction } from '../../config/db.js';
import { AppError } from '../../utils/appError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { parseGeoInput } from '../../utils/geo.js';
import { signAuthToken } from '../../middleware/auth.js';
import { sendSuccess } from '../../utils/response.js';

const SELF_REGISTER_ROLES = new Set(['customer', 'technician']);

/**
 * Registers a new customer or technician account.
 * Admin self-registration is explicitly blocked to maintain RBAC separation.
 */
export const register = asyncHandler(async (req, res) => {
  const {
    name,
    email,
    phone,
    password,
    role = 'customer',
    baseLocation,
    addressText,
    serviceCategories,
    zoneId,
    serviceRadiusKm,
    maxPoolCapacity,
  } = req.body || {};

  if (!SELF_REGISTER_ROLES.has(role)) {
    throw new AppError(
      403,
      'Self-registration is restricted to customer and technician roles.',
      'FORBIDDEN_ROLE'
    );
  }

  if (!password || String(password).length < 6) {
    throw new AppError(400, 'Password must be at least 6 characters long.', 'VALIDATION_ERROR');
  }

  const normalizedEmail = String(email || '').trim().toLowerCase();
  const existing = await User.findOne({ email: normalizedEmail });
  if (existing) {
    throw new AppError(409, 'An account with this email already exists.', 'DUPLICATE_EMAIL');
  }

  let parsedLocation = null;
  let validatedZoneId = null;

  if (role === 'technician') {
    parsedLocation = parseGeoInput(baseLocation);

    if (Array.isArray(serviceCategories) && serviceCategories.length > 0) {
      const activeCount = await ServiceCategory.countDocuments({
        _id: { $in: serviceCategories },
        isActive: true,
      });
      if (activeCount !== serviceCategories.length) {
        throw new AppError(400, 'One or more service categories are invalid or inactive.', 'INVALID_CATEGORY');
      }
    }

    if (zoneId !== undefined && zoneId !== null) {
      if (!mongoose.isValidObjectId(zoneId)) {
        throw new AppError(400, 'Invalid zoneId format.', 'INVALID_ID');
      }
      const zone = await ServiceZone.findOne({ _id: zoneId, isActive: true });
      if (!zone) {
        throw new AppError(404, 'Active service zone not found.', 'ZONE_NOT_FOUND');
      }
      validatedZoneId = zone._id;
    }
  }

  const created = await runInTransaction(
    async (session) => {
      const sessionOpts = session ? { session } : undefined;
      const [user] = await User.create(
        [
          {
            name,
            email: normalizedEmail,
            phone,
            passwordHash: password,
            role,
          },
        ],
        sessionOpts
      );

      let technicianProfile = null;
      if (role === 'technician') {
        [technicianProfile] = await TechnicianProfile.create(
          [
            {
              userId: user._id,
              baseLocation: parsedLocation,
              addressText,
              zoneId: validatedZoneId,
              serviceCategories: serviceCategories || [],
              ...(serviceRadiusKm !== undefined ? { serviceRadiusKm } : {}),
              ...(maxPoolCapacity !== undefined ? { maxPoolCapacity } : {}),
              approvalStatus: 'approved',
              availabilityStatus: 'offline',
            },
          ],
          sessionOpts
        );
      }

      return { user, technicianProfile };
    },
    { requireTransaction: false }
  );

  const token = signAuthToken(created.user);

  return sendSuccess(res, {
    statusCode: 201,
    message: 'Registration successful.',
    data: {
      token,
      user: created.user.toJSON(),
      ...(created.technicianProfile ? { technicianProfile: created.technicianProfile } : {}),
    },
  });
});

/**
 * Authenticates an existing user and issues a JWT token.
 */
export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    throw new AppError(400, 'Email and password are required.', 'VALIDATION_ERROR');
  }

  const user = await User.findOne({ email: String(email).trim().toLowerCase() }).select('+passwordHash');
  if (!user || !(await user.comparePassword(String(password)))) {
    throw new AppError(401, 'Invalid email or password.', 'INVALID_CREDENTIALS');
  }

  if (!user.isActive) {
    throw new AppError(403, 'Account is deactivated.', 'ACCOUNT_INACTIVE');
  }

  const token = signAuthToken(user);

  return sendSuccess(res, {
    message: 'Login successful.',
    data: {
      token,
      user: user.toJSON(),
    },
  });
});

/**
 * Returns the authenticated user's profile (plus technician profile if applicable).
 */
export const getMe = asyncHandler(async (req, res) => {
  let technicianProfile = null;
  if (req.user.role === 'technician') {
    technicianProfile = await TechnicianProfile.findOne({ userId: req.user._id })
      .populate('serviceCategories', 'name slug baseIndividualPrice estimatedDurationMins')
      .populate('zoneId', 'name code city');
  }

  return sendSuccess(res, {
    data: {
      user: req.user,
      ...(technicianProfile ? { technicianProfile } : {}),
    },
  });
});
