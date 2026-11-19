import {
  createRating,
  getCustomerRatings,
  getTechnicianRatings,
  getTechnicianRatingSummary,
  getBookingRating,
} from './rating.service.js';
import { sendSuccess } from '../../utils/response.js';
import { AppError } from '../../utils/appError.js';

/**
 * Handles customer rating submission for a completed booking.
 * Supports both POST /api/v1/ratings (bookingId in body) and POST /api/v1/bookings/:id/rating (bookingId in params).
 */
export async function createRatingHandler(req, res, next) {
  try {
    const bookingId = req.params.id || req.body.bookingId;
    if (!bookingId) {
      throw new AppError(400, 'bookingId is required.', 'VALIDATION_ERROR');
    }

    const { rating, comment } = req.body;

    const result = await createRating(req.user._id, {
      bookingId,
      rating,
      comment,
    });

    return sendSuccess(res, {
      statusCode: 201,
      message: 'Rating submitted successfully.',
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Handles fetching submitted ratings for the authenticated customer.
 */
export async function getMySubmittedRatingsHandler(req, res, next) {
  try {
    const result = await getCustomerRatings(req.user._id, req.query);

    return sendSuccess(res, {
      message: 'Submitted ratings retrieved successfully.',
      data: result.ratings,
      meta: {
        pagination: result.pagination,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Handles fetching ratings received by a specific technician by User ID.
 */
export async function getTechnicianRatingsHandler(req, res, next) {
  try {
    const technicianUserId = req.params.id;
    const result = await getTechnicianRatings(technicianUserId, req.query);

    return sendSuccess(res, {
      message: 'Technician ratings retrieved successfully.',
      data: result.ratings,
      meta: {
        pagination: result.pagination,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Handles fetching ratings received by the currently authenticated technician.
 */
export async function getMyTechnicianRatingsHandler(req, res, next) {
  try {
    const result = await getTechnicianRatings(req.user._id, req.query);

    return sendSuccess(res, {
      message: 'Your received ratings retrieved successfully.',
      data: result.ratings,
      meta: {
        pagination: result.pagination,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Handles fetching rating summary (average, count, star distribution) for a specific technician.
 */
export async function getTechnicianRatingSummaryHandler(req, res, next) {
  try {
    const technicianUserId = req.params.id;
    const summary = await getTechnicianRatingSummary(technicianUserId);

    return sendSuccess(res, {
      message: 'Technician rating summary retrieved successfully.',
      data: summary,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Handles fetching rating summary for the currently authenticated technician.
 */
export async function getMyTechnicianRatingSummaryHandler(req, res, next) {
  try {
    const summary = await getTechnicianRatingSummary(req.user._id);

    return sendSuccess(res, {
      message: 'Your rating summary retrieved successfully.',
      data: summary,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Handles retrieving the rating for a specific booking.
 */
export async function getBookingRatingHandler(req, res, next) {
  try {
    const bookingId = req.params.id;
    const rating = await getBookingRating(bookingId, req.user._id, req.user.role);

    return sendSuccess(res, {
      message: 'Booking rating retrieved successfully.',
      data: rating,
    });
  } catch (err) {
    next(err);
  }
}
