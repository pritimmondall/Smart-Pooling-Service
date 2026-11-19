import { Router } from 'express';
import { getMyNotifications, markNotificationRead } from './notification.controller.js';
import { protect } from '../../middleware/auth.js';
import { validateObjectIdParam } from '../../middleware/validate.js';

const router = Router();

router.use(protect);
router.get('/my', getMyNotifications);
router.patch('/:id/read', validateObjectIdParam('id'), markNotificationRead);

export default router;
