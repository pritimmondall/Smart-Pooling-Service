import mongoose from 'mongoose';
import { Rating, Booking, TechnicianProfile, Notification, User } from '../../models/index.js';
import { AppError } from '../../utils/appError.js';
import { runInTransaction } from '../../config/db.js';

/**
 * Masks customer name for privacy in public or technician-facing rating feeds (e.g., "Pritam Mondal" -> "Pritam M.").
 *
 * @param {string} rawName
 * @returns {string}
 */
export function maskCustomerName(rawName) {
  if (!rawName || typeof rawName !== 'string') return 'Customer';
  const nameParts = rawName.trim().split(/\s+/);
  const firstName = nameParts[0] || 'Customer';
  const lastInitial = nameParts[1] ? ` ${nameParts[1][0].toUpperCase()}.` : '';
  return `${firstName}${lastInitial}`;
}

/**
 * Submits a rating for a completed booking.
 *
 * Rules:
 * 1. Only the authenticated customer who owns the booking may submit a rating.
 * 2. The booking must have status 'completed'.
 * 3. The booking must have an assigned technician.
 * 4. Only one rating per booking is allowed (enforced logically and via unique index).
 * 5. Rating must be an integer between 1 and 5.
 * 6. Optional comment must not exceed 500 characters.
 * 7. Rating insertion, TechnicianProfile aggregate update, and notification are executed
 *    atomically within a multi-document ACID transaction.
 *
 * @param {string|mongoose.Types.ObjectId} customerUserId
 * @param {Object} input
 * @param {string|mongoose.Types.ObjectId} input.bookingId
 * @param {number} input.rating
 * @param {string} [input.comment]
 * @returns {Promise<Object>}
 */
export async function createRating(customerUserId, { bookingId, rating, comment = '' }) {
  if (!mongoose.isValidObjectId(customerUserId)) {
    throw new AppError(400, 'Invalid customer ID format.', 'INVALID_ID');
  }
  if (!mongoose.isValidObjectId(bookingId)) {
    throw new AppError(400, 'Invalid booking ID format.', 'INVALID_ID');
  }

  // Validate rating
  const numericRating = Number(rating);
  if (
    rating === undefined ||
    rating === null ||
    Number.isNaN(numericRating) ||
    !Number.isInteger(numericRating) ||
    numericRating < 1 ||
    numericRating > 5
  ) {
    throw new AppError(400, 'Rating must be an integer between 1 and 5.', 'VALIDATION_ERROR');
  }

  // Validate comment
  if (comment !== undefined && comment !== null && typeof comment !== 'string') {
    throw new AppError(400, 'Comment must be a text string.', 'VALIDATION_ERROR');
  }
  const cleanComment = (comment || '').trim();
  if (cleanComment.length > 500) {
    throw new AppError(400, 'Comment cannot exceed 500 characters.', 'VALIDATION_ERROR');
  }

  const customerObjectId = new mongoose.Types.ObjectId(customerUserId);
  const bookingObjectId = new mongoose.Types.ObjectId(bookingId);

  try {
    const result = await runInTransaction(
      async (session) => {
        // 1. Fetch booking document
        const booking = await Booking.findById(bookingObjectId).session(session);
        if (!booking) {
          throw new AppError(404, 'Booking not found.', 'BOOKING_NOT_FOUND');
        }

        // 2. Ownership verification: only the booking owner may rate
        if (String(booking.customerId) !== String(customerObjectId)) {
          throw new AppError(403, 'You do not have permission to rate this booking.', 'FORBIDDEN_BOOKING_ACCESS');
        }

        // 3. Status verification: booking must be completed
        if (booking.status !== 'completed') {
          throw new AppError(
            409,
            `Only completed bookings can be rated. Current status is "${booking.status}".`,
            'INVALID_BOOKING_STATUS'
          );
        }

        // 4. Assigned technician verification
        if (!booking.technicianId) {
          throw new AppError(
            400,
            'Cannot rate a booking that was not serviced by an assigned technician.',
            'NO_ASSIGNED_TECHNICIAN'
          );
        }

        const technicianObjectId = booking.technicianId;

        // 5. Pre-check for duplicate rating
        const existingRating = await Rating.findOne({ bookingId: bookingObjectId }).session(session);
        if (existingRating) {
          throw new AppError(409, 'This booking has already been rated.', 'DUPLICATE_RATING');
        }

        // 6. Create Rating document
        const [newRating] = await Rating.create(
          [
            {
              bookingId: bookingObjectId,
              customerId: customerObjectId,
              technicianId: technicianObjectId,
              rating: numericRating,
              comment: cleanComment,
            },
          ],
          { session }
        );

        // 7. Atomically recalculate TechnicianProfile aggregates
        const aggResults = await Rating.aggregate([
          { $match: { technicianId: technicianObjectId } },
          {
            $group: {
              _id: null,
              totalRatings: { $sum: 1 },
              avgRating: { $avg: '$rating' },
            },
          },
        ]).session(session);

        const ratingCount = aggResults[0]?.totalRatings || 1;
        const ratingAvg = Number((aggResults[0]?.avgRating || numericRating).toFixed(2));

        await TechnicianProfile.findOneAndUpdate(
          { userId: technicianObjectId },
          {
            $set: {
              ratingAvg,
              ratingCount,
            },
          },
          { session }
        );

        // 8. Dispatch in-app notification to technician
        await Notification.create(
          [
            {
              userId: technicianObjectId,
              role: 'technician',
              title: 'New Customer Rating',
              message: `A customer has rated your completed service ${numericRating} star${numericRating > 1 ? 's' : ''}${cleanComment ? `: "${cleanComment.slice(0, 50)}"` : '.'}`,
              type: 'booking',
              relatedEntityId: bookingObjectId,
            },
          ],
          { session, ordered: true }
        );

        return {
          rating: newRating,
          technicianSummary: {
            technicianId: technicianObjectId,
            ratingAvg,
            ratingCount,
          },
        };
      },
      { requireTransaction: true }
    );

    return result;
  } catch (err) {
    // Translate MongoDB unique index duplicate key error to controlled 409
    if (err.code === 11000 || err.name === 'MongoServerError' && err.message?.includes('duplicate key')) {
      throw new AppError(409, 'This booking has already been rated.', 'DUPLICATE_RATING');
    }
    throw err;
  }
}

/**
 * Retrieves submitted ratings for the authenticated customer with pagination and sorting.
 *
 * @param {string|mongoose.Types.ObjectId} customerUserId
 * @param {Object} [query]
 * @returns {Promise<Object>}
 */
export async function getCustomerRatings(customerUserId, query = {}) {
  if (!mongoose.isValidObjectId(customerUserId)) {
    throw new AppError(400, 'Invalid customer ID format.', 'INVALID_ID');
  }

  const customerObjectId = new mongoose.Types.ObjectId(customerUserId);
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(query.limit, 10) || 10));
  const skip = (page - 1) * limit;

  const validSortFields = ['createdAt', 'rating'];
  const sortBy = validSortFields.includes(query.sortBy) ? query.sortBy : 'createdAt';
  const sortOrder = String(query.sortOrder).toLowerCase() === 'asc' ? 1 : -1;

  const filter = { customerId: customerObjectId };

  const [total, ratings] = await Promise.all([
    Rating.countDocuments(filter),
    Rating.find(filter)
      .sort({ [sortBy]: sortOrder })
      .skip(skip)
      .limit(limit)
      .populate('technicianId', 'name')
      .populate({
        path: 'bookingId',
        select: 'serviceCategoryId addressText timeWindow estimatedPrice completedAt bookingMode',
        populate: {
          path: 'serviceCategoryId',
          select: 'name code',
        },
      })
      .lean(),
  ]);

  return {
    ratings,
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit) || 1,
    },
  };
}

/**
 * Retrieves ratings received by a technician with pagination, star filtering, and customer privacy masking.
 *
 * @param {string|mongoose.Types.ObjectId} technicianUserId
 * @param {Object} [query]
 * @returns {Promise<Object>}
 */
export async function getTechnicianRatings(technicianUserId, query = {}) {
  if (!mongoose.isValidObjectId(technicianUserId)) {
    throw new AppError(400, 'Invalid technician ID format.', 'INVALID_ID');
  }

  const techObjectId = new mongoose.Types.ObjectId(technicianUserId);
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(query.limit, 10) || 10));
  const skip = (page - 1) * limit;

  const filter = { technicianId: techObjectId };

  if (query.rating) {
    const r = parseInt(query.rating, 10);
    if (!Number.isNaN(r) && r >= 1 && r <= 5) {
      filter.rating = r;
    }
  } else {
    const minRating = parseInt(query.minRating, 10);
    const maxRating = parseInt(query.maxRating, 10);
    if (!Number.isNaN(minRating) || !Number.isNaN(maxRating)) {
      filter.rating = {};
      if (!Number.isNaN(minRating)) filter.rating.$gte = Math.max(1, minRating);
      if (!Number.isNaN(maxRating)) filter.rating.$lte = Math.min(5, maxRating);
    }
  }

  const validSortFields = ['createdAt', 'rating'];
  const sortBy = validSortFields.includes(query.sortBy) ? query.sortBy : 'createdAt';
  const sortOrder = String(query.sortOrder).toLowerCase() === 'asc' ? 1 : -1;

  const [total, rawRatings] = await Promise.all([
    Rating.countDocuments(filter),
    Rating.find(filter)
      .sort({ [sortBy]: sortOrder })
      .skip(skip)
      .limit(limit)
      .populate('customerId', 'name')
      .populate({
        path: 'bookingId',
        select: 'serviceCategoryId completedAt bookingMode',
        populate: {
          path: 'serviceCategoryId',
          select: 'name code',
        },
      })
      .lean(),
  ]);

  // Mask customer names for privacy
  const ratings = rawRatings.map((r) => ({
    _id: r._id,
    bookingId: r.bookingId?._id || r.bookingId,
    serviceCategory: r.bookingId?.serviceCategoryId || null,
    rating: r.rating,
    comment: r.comment || '',
    customer: {
      displayName: maskCustomerName(r.customerId?.name),
    },
    createdAt: r.createdAt,
  }));

  return {
    ratings,
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit) || 1,
    },
  };
}

/**
 * Computes comprehensive rating summary for a technician, including average, count, and star distribution breakdown.
 *
 * @param {string|mongoose.Types.ObjectId} technicianUserId
 * @returns {Promise<Object>}
 */
export async function getTechnicianRatingSummary(technicianUserId) {
  if (!mongoose.isValidObjectId(technicianUserId)) {
    throw new AppError(400, 'Invalid technician ID format.', 'INVALID_ID');
  }

  const techObjectId = new mongoose.Types.ObjectId(technicianUserId);

  const [profile, breakdownAgg] = await Promise.all([
    TechnicianProfile.findOne({ userId: techObjectId }, 'ratingAvg ratingCount jobsCompleted').lean(),
    Rating.aggregate([
      { $match: { technicianId: techObjectId } },
      {
        $group: {
          _id: '$rating',
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  if (!profile) {
    throw new AppError(404, 'Technician profile not found.', 'TECH_PROFILE_NOT_FOUND');
  }

  const breakdownMap = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const item of breakdownAgg) {
    if (item._id && breakdownMap[item._id] !== undefined) {
      breakdownMap[item._id] = item.count;
    }
  }

  const totalCalculated = Object.values(breakdownMap).reduce((sum, val) => sum + val, 0);

  return {
    technicianId: techObjectId,
    ratingAvg: profile.ratingAvg || 0,
    ratingCount: profile.ratingCount ?? totalCalculated,
    breakdown: {
      5: breakdownMap[5],
      4: breakdownMap[4],
      3: breakdownMap[3],
      2: breakdownMap[2],
      1: breakdownMap[1],
    },
  };
}

/**
 * Retrieves the rating for a specific booking.
 *
 * @param {string|mongoose.Types.ObjectId} bookingId
 * @param {string|mongoose.Types.ObjectId} [requestingUserId]
 * @param {string} [requestingUserRole]
 * @returns {Promise<Object>}
 */
export async function getBookingRating(bookingId, requestingUserId = null, requestingUserRole = null) {
  if (!mongoose.isValidObjectId(bookingId)) {
    throw new AppError(400, 'Invalid booking ID format.', 'INVALID_ID');
  }

  const bookingObjectId = new mongoose.Types.ObjectId(bookingId);
  const rating = await Rating.findOne({ bookingId: bookingObjectId })
    .populate('customerId', 'name')
    .populate('technicianId', 'name')
    .lean();

  if (!rating) {
    throw new AppError(404, 'Rating not found for this booking.', 'RATING_NOT_FOUND');
  }

  // If customer is requesting, ensure ownership
  if (
    requestingUserRole === 'customer' &&
    requestingUserId &&
    String(rating.customerId?._id || rating.customerId) !== String(requestingUserId)
  ) {
    throw new AppError(403, 'You do not have permission to view this rating.', 'FORBIDDEN_BOOKING_ACCESS');
  }

  // If technician is requesting, ensure they are the assigned technician for this rating
  if (
    requestingUserRole === 'technician' &&
    requestingUserId &&
    String(rating.technicianId?._id || rating.technicianId) !== String(requestingUserId)
  ) {
    throw new AppError(403, 'You do not have permission to view this rating.', 'FORBIDDEN_BOOKING_ACCESS');
  }

  // Role validation: if role is neither customer, technician, nor admin, deny access
  if (
    requestingUserRole &&
    !['customer', 'technician', 'admin'].includes(requestingUserRole)
  ) {
    throw new AppError(403, 'You do not have permission to view this rating.', 'FORBIDDEN_ROLE');
  }

  // Mask customer name in technician-facing responses
  if (requestingUserRole === 'technician' && rating.customerId) {
    const rawName = typeof rating.customerId === 'object' ? rating.customerId.name : '';
    const masked = maskCustomerName(rawName);
    return {
      ...rating,
      customerId: {
        ...(typeof rating.customerId === 'object' ? rating.customerId : { _id: rating.customerId }),
        name: masked,
        displayName: masked,
      },
    };
  }

  return rating;
}
