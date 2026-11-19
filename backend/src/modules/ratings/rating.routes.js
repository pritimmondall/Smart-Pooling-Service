import { Router } from 'express';
import {
  createRatingHandler,
  getMySubmittedRatingsHandler,
  getTechnicianRatingsHandler,
  getTechnicianRatingSummaryHandler,
  getBookingRatingHandler,
} from './rating.controller.js';
import { protect, authorizeRoles } from '../../middleware/auth.js';
import { validateObjectIdParam, requireBodyFields } from '../../middleware/validate.js';

const router = Router();

router.use(protect);

// Customer rating creation and history
router.post(
  '/',
  authorizeRoles('customer'),
  requireBodyFields('bookingId', 'rating'),
  createRatingHandler
);
router.get('/my', authorizeRoles('customer'), getMySubmittedRatingsHandler);
router.get('/', authorizeRoles('customer'), getMySubmittedRatingsHandler);

// Booking specific rating
router.get(
  '/bookings/:id',
  validateObjectIdParam('id'),
  getBookingRatingHandler
);

// Technician rating discovery
router.get(
  '/technicians/:id',
  validateObjectIdParam('id'),
  getTechnicianRatingsHandler
);
router.get(
  '/technicians/:id/summary',
  validateObjectIdParam('id'),
  getTechnicianRatingSummaryHandler
);

export default router;
