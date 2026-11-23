import { Router } from 'express';
import {
  createBooking,
  quoteBooking,
  confirmCompletion,
  getMyBookings,
  getDashboardBooking,
  getBookingById,
  updateMyBooking,
  cancelMyBooking,
  listAllBookingsAdmin,
  assignBookingHandler,
  getEligibleTechniciansForBookingHandler,
} from './booking.controller.js';
import { createRatingHandler, getBookingRatingHandler } from '../ratings/rating.controller.js';
import { protect, authorizeRoles } from '../../middleware/auth.js';
import { validateObjectIdParam, requireBodyFields } from '../../middleware/validate.js';

const router = Router();

router.use(protect);
router.post('/quote', authorizeRoles('customer'), requireBodyFields('serviceCategoryId', 'location', 'timeWindow'), quoteBooking);

router.post(
  '/',
  authorizeRoles('customer'),
  requireBodyFields('serviceCategoryId', 'location', 'addressText'),
  createBooking
);
router.post('/:id/confirm-completion', authorizeRoles('customer'), validateObjectIdParam('id'), confirmCompletion);
router.get('/dashboard', authorizeRoles('customer'), getDashboardBooking);
router.get('/my', authorizeRoles('customer'), getMyBookings);
router.patch('/:id', authorizeRoles('customer'), validateObjectIdParam('id'), updateMyBooking);
router.patch('/:id/cancel', authorizeRoles('customer'), validateObjectIdParam('id'), cancelMyBooking);
router.post(
  '/:id/rating',
  authorizeRoles('customer'),
  validateObjectIdParam('id'),
  requireBodyFields('rating'),
  createRatingHandler
);
router.get('/:id/rating', validateObjectIdParam('id'), getBookingRatingHandler);

router.get('/', authorizeRoles('admin'), listAllBookingsAdmin);
router.get(
  '/:id/eligible-technicians',
  authorizeRoles('admin'),
  validateObjectIdParam('id'),
  getEligibleTechniciansForBookingHandler
);
router.post(
  '/:id/assign',
  authorizeRoles('admin'),
  validateObjectIdParam('id'),
  requireBodyFields('technicianId'),
  assignBookingHandler
);
router.get('/:id', authorizeRoles('customer', 'admin'), validateObjectIdParam('id'), getBookingById);

export default router;
