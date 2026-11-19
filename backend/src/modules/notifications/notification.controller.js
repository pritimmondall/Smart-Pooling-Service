import { Notification } from '../../models/index.js';
import { AppError } from '../../utils/appError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { parsePagination } from '../../utils/pagination.js';
import { sendSuccess } from '../../utils/response.js';

/**
 * Lists in-app notifications belonging to the authenticated user.
 */
export const getMyNotifications = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = { userId: req.user._id };
  if (req.query.unreadOnly === 'true') filter.isRead = false;

  const [items, total] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Notification.countDocuments(filter),
  ]);

  return sendSuccess(res, {
    data: items,
    meta: { pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
  });
});

/**
 * Marks an in-app notification as read by its owner.
 */
export const markNotificationRead = asyncHandler(async (req, res) => {
  const notification = await Notification.findById(req.params.id);
  if (!notification) {
    throw new AppError(404, 'Notification not found.', 'NOTIFICATION_NOT_FOUND');
  }

  if (String(notification.userId) !== String(req.user._id)) {
    throw new AppError(403, 'You can only update your own notifications.', 'FORBIDDEN_NOTIFICATION_ACCESS');
  }

  notification.isRead = true;
  await notification.save();

  return sendSuccess(res, {
    message: 'Notification marked as read.',
    data: notification,
  });
});
