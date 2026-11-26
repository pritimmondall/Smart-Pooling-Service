import { Router } from 'express';
import { protect, authorizeRoles } from '../../middleware/auth.js';
import { requireBodyFields } from '../../middleware/validate.js';
import { AppError } from '../../utils/appError.js';
import { createBooking, quoteBooking } from './booking.controller.js';

const router = Router();
const visitFields = new Set([
  'serviceCategoryId', 'specificService', 'location', 'timeWindow',
  'addressText', 'replaceBookingId', 'quoteToken', 'quotedPrice', 'acceptShift', 'notes',
]);

router.use(protect, authorizeRoles('customer'));
router.use(requireBodyFields('serviceCategoryId', 'specificService', 'location', 'timeWindow'));
router.use((req, res, next) => {
  const unsupported = Object.keys(req.body).find(key => !visitFields.has(key));
  if (unsupported) {
    return next(new AppError(400, `Unsupported home visit field: ${unsupported}`, 'INVALID_VISIT_FIELD'));
  }
  if (req.body.replaceBookingId && !/^[a-f0-9]{24}$/i.test(req.body.replaceBookingId)) {
    return next(new AppError(400, 'Invalid previous booking.', 'INVALID_ID'));
  }
  res.locals.homeVisit = true;
  req.body.automaticDispatch = true;
  next();
});

router.post('/quote', quoteBooking);
router.post('/', requireBodyFields('addressText'), createBooking);

export default router;
