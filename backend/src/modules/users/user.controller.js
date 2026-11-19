import { parseGeoInput } from '../../utils/geo.js';
import { User, USER_ROLES } from '../../models/index.js';
import { AppError } from '../../utils/appError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { parsePagination } from '../../utils/pagination.js';
import { sendSuccess } from '../../utils/response.js';

/**
 * Returns the authenticated user's profile.
 */
export const getMyUserProfile = asyncHandler(async (req, res) => {
  return sendSuccess(res, { data: req.user });
});

/**
 * Updates editable contact fields (name, phone) for the authenticated user.
 */
export const updateMyUserProfile = asyncHandler(async (req, res) => {
  const { name, phone } = req.body || {};
  const updates = {};

  if (req.user.role === 'customer' && req.body.poolAlertLocation !== undefined) {
    updates.poolAlertLocation = parseGeoInput(req.body.poolAlertLocation);
  }
  if (name !== undefined) updates.name = name;
  if (phone !== undefined) updates.phone = phone;

  if (Object.keys(updates).length === 0) {
    throw new AppError(400, 'Provide at least one field to update (name or phone).', 'VALIDATION_ERROR');
  }

  const updatedUser = await User.findByIdAndUpdate(req.user._id, updates, {
    new: true,
    runValidators: true,
  });

  if (!updatedUser) {
    throw new AppError(404, 'User not found.', 'USER_NOT_FOUND');
  }

  return sendSuccess(res, {
    message: 'Profile updated successfully.',
    data: updatedUser.toJSON(),
  });
});

/**
 * Lists users with optional role filter and pagination (Admin only).
 */
export const listUsersAdmin = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};

  if (req.query.role !== undefined) {
    if (!USER_ROLES.includes(req.query.role)) {
      throw new AppError(400, `role filter must be one of: ${USER_ROLES.join(', ')}.`, 'VALIDATION_ERROR');
    }
    filter.role = req.query.role;
  }

  const [items, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    User.countDocuments(filter),
  ]);

  return sendSuccess(res, {
    data: items,
    meta: { pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
  });
});

/**
 * Activates or deactivates a user account (Admin only).
 */
export const updateUserActiveStatus = asyncHandler(async (req, res) => {
  const { isActive } = req.body || {};
  if (typeof isActive !== 'boolean') {
    throw new AppError(400, 'isActive must be a boolean.', 'VALIDATION_ERROR');
  }

  if (String(req.params.id) === String(req.user._id) && !isActive) {
    throw new AppError(400, 'Admins cannot deactivate their own active session account.', 'INVALID_OPERATION');
  }

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { isActive },
    { new: true, runValidators: true }
  );

  if (!user) {
    throw new AppError(404, 'User not found.', 'USER_NOT_FOUND');
  }

  return sendSuccess(res, {
    message: `User account ${isActive ? 'activated' : 'deactivated'}.`,
    data: user.toJSON(),
  });
});
