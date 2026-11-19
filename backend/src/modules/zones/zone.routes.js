import { Router } from 'express';
import { listActiveZones, getZoneById, createZone, updateZone } from './zone.controller.js';
import { protect, authorizeRoles } from '../../middleware/auth.js';
import { validateObjectIdParam, requireBodyFields } from '../../middleware/validate.js';

const router = Router();

router.get('/', listActiveZones);
router.get('/:id', validateObjectIdParam('id'), getZoneById);

router.post(
  '/',
  protect,
  authorizeRoles('admin'),
  requireBodyFields('name', 'code', 'centerLocation'),
  createZone
);
router.patch('/:id', protect, authorizeRoles('admin'), validateObjectIdParam('id'), updateZone);

export default router;
