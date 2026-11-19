import { nearbyPools } from './discovery.controller.js';
import { Router } from 'express';
import {
  getMyPools,
  getPoolById,
  triggerPoolLockEvaluation,
  getEligibleTechniciansForPoolHandler,
  assignPoolHandler,
} from './pool.controller.js';
import { protect, authorizeRoles } from '../../middleware/auth.js';
import { validateObjectIdParam, requireBodyFields } from '../../middleware/validate.js';

const router = Router();

router.use(protect);

router.get('/nearby', authorizeRoles('customer'), nearbyPools);
router.get('/my', authorizeRoles('customer', 'admin'), getMyPools);
router.get('/:id', authorizeRoles('customer', 'admin'), validateObjectIdParam('id'), getPoolById);
router.post('/lock-evaluation', authorizeRoles('admin'), triggerPoolLockEvaluation);

// Admin pool assignment routes
router.get(
  '/:id/eligible-technicians',
  authorizeRoles('admin'),
  validateObjectIdParam('id'),
  getEligibleTechniciansForPoolHandler
);
router.post(
  '/:id/assign',
  authorizeRoles('admin'),
  validateObjectIdParam('id'),
  requireBodyFields('technicianId'),
  assignPoolHandler
);

export default router;
