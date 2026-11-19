import { Router } from 'express';
import {
  listActiveServices,
  listAllServicesAdmin,
  getServiceById,
  createService,
  updateService,
  deactivateService,
} from './service.controller.js';
import { protect, authorizeRoles } from '../../middleware/auth.js';
import { validateObjectIdParam, requireBodyFields } from '../../middleware/validate.js';

const router = Router();

router.get('/', listActiveServices);
router.get('/admin/all', protect, authorizeRoles('admin'), listAllServicesAdmin);
router.get('/:id', validateObjectIdParam('id'), getServiceById);

router.post(
  '/',
  protect,
  authorizeRoles('admin'),
  requireBodyFields('name', 'baseIndividualPrice', 'estimatedDurationMins'),
  createService
);
router.patch('/:id', protect, authorizeRoles('admin'), validateObjectIdParam('id'), updateService);
router.delete('/:id', protect, authorizeRoles('admin'), validateObjectIdParam('id'), deactivateService);

export default router;
