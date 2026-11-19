import { Router } from 'express';
import {
  getMyUserProfile,
  updateMyUserProfile,
  listUsersAdmin,
  updateUserActiveStatus,
} from './user.controller.js';
import { protect, authorizeRoles } from '../../middleware/auth.js';
import { validateObjectIdParam } from '../../middleware/validate.js';

const router = Router();

router.use(protect);

router.get('/me', getMyUserProfile);
router.patch('/me', updateMyUserProfile);

router.get('/', authorizeRoles('admin'), listUsersAdmin);
router.patch('/:id/status', authorizeRoles('admin'), validateObjectIdParam('id'), updateUserActiveStatus);

export default router;
