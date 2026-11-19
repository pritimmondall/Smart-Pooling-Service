import { listOpportunities, claimOpportunity } from './opportunities.controller.js';
import { Router } from 'express';
import {
  getMyTechnicianProfile,
  updateMyTechnicianProfile,
  updateMyAvailability,
  getMyTechnicianMetrics,
  getMyEarnings,
  listTechniciansAdmin,
  updateTechnicianApproval,
  updateTechnicianAvailabilityAdmin,
} from './technician.controller.js';
import {
  getMyAssignedJobs,
  getMyAssignedJobById,
  acceptAssignedJob,
  rejectAssignedJob,
  updateAssignedJobStatus,
  getOptimizedRouteForJob,
} from './technicianJob.controller.js';
import {
  getMyJobStops,
  arriveAtStop,
  startStopService,
  completeStopService,
  cancelStopService,
  updateStopStatus,
} from './technicianStopProgression.controller.js';
import {
  getMyActiveWorkload,
  getMyActiveWorkloadById,
  updateMyTechnicianLocation,
  getMyTechnicianLocation,
  getMyAssignedRoutes,
  getMyAssignedRouteById,
} from './technicianWorkload.controller.js';
import {
  getTechnicianRatingsHandler,
  getMyTechnicianRatingsHandler,
  getTechnicianRatingSummaryHandler,
  getMyTechnicianRatingSummaryHandler,
} from '../ratings/rating.controller.js';
import { protect, authorizeRoles } from '../../middleware/auth.js';
import { validateObjectIdParam, requireBodyFields } from '../../middleware/validate.js';

const router = Router();

router.use(protect);

router.get('/me/opportunities', authorizeRoles('technician'), listOpportunities);
router.post('/me/opportunities/:id/claim', authorizeRoles('technician'), validateObjectIdParam('id'), claimOpportunity);

// Technician profile & availability
router.get('/me', authorizeRoles('technician'), getMyTechnicianProfile);
router.get('/me/earnings', authorizeRoles('technician'), getMyEarnings);
router.get('/me/metrics', authorizeRoles('technician'), getMyTechnicianMetrics);
router.get('/dashboard/metrics', authorizeRoles('technician'), getMyTechnicianMetrics);
router.patch('/me/profile', authorizeRoles('technician'), updateMyTechnicianProfile);
router.patch(
  '/me/availability',
  authorizeRoles('technician'),
  requireBodyFields('availabilityStatus'),
  updateMyAvailability
);
router.get('/me/ratings', authorizeRoles('technician'), getMyTechnicianRatingsHandler);
router.get('/me/ratings/summary', authorizeRoles('technician'), getMyTechnicianRatingSummaryHandler);

// Technician active workload
router.get('/me/active-workload', authorizeRoles('technician'), getMyActiveWorkload);
router.get(
  '/me/active-workload/:jobId',
  authorizeRoles('technician'),
  validateObjectIdParam('jobId'),
  getMyActiveWorkloadById
);

// Technician location tracking
router.post(
  '/me/location',
  authorizeRoles('technician'),
  requireBodyFields('latitude', 'longitude'),
  updateMyTechnicianLocation
);
router.get('/me/location', authorizeRoles('technician'), getMyTechnicianLocation);

// Technician route tracking
router.get('/me/routes', authorizeRoles('technician'), getMyAssignedRoutes);
router.get(
  '/me/routes/:jobId',
  authorizeRoles('technician'),
  validateObjectIdParam('jobId'),
  getMyAssignedRouteById
);

// Technician job management & route optimization
router.get('/me/jobs', authorizeRoles('technician'), getMyAssignedJobs);
router.get(
  '/me/jobs/:id',
  authorizeRoles('technician'),
  validateObjectIdParam('id'),
  getMyAssignedJobById
);
router.post(
  '/me/jobs/:id/accept',
  authorizeRoles('technician'),
  validateObjectIdParam('id'),
  acceptAssignedJob
);
router.post(
  '/me/jobs/:id/reject',
  authorizeRoles('technician'),
  validateObjectIdParam('id'),
  rejectAssignedJob
);
router.patch(
  '/me/jobs/:id/status',
  authorizeRoles('technician'),
  validateObjectIdParam('id'),
  requireBodyFields('status'),
  updateAssignedJobStatus
);
router.get(
  '/me/jobs/:id/route',
  authorizeRoles('technician'),
  validateObjectIdParam('id'),
  getOptimizedRouteForJob
);

// Technician stop-level progression endpoints
router.get(
  '/me/jobs/:jobId/stops',
  authorizeRoles('technician'),
  validateObjectIdParam('jobId'),
  getMyJobStops
);
router.post(
  '/me/jobs/:jobId/stops/:stopId/arrive',
  authorizeRoles('technician'),
  validateObjectIdParam('jobId'),
  validateObjectIdParam('stopId'),
  arriveAtStop
);
router.post(
  '/me/jobs/:jobId/stops/:stopId/start',
  authorizeRoles('technician'),
  validateObjectIdParam('jobId'),
  validateObjectIdParam('stopId'),
  startStopService
);
router.post(
  '/me/jobs/:jobId/stops/:stopId/complete',
  authorizeRoles('technician'),
  validateObjectIdParam('jobId'),
  validateObjectIdParam('stopId'),
  completeStopService
);
router.post(
  '/me/jobs/:jobId/stops/:stopId/cancel',
  authorizeRoles('technician'),
  validateObjectIdParam('jobId'),
  validateObjectIdParam('stopId'),
  cancelStopService
);
router.patch(
  '/me/jobs/:jobId/stops/:stopId/status',
  authorizeRoles('technician'),
  validateObjectIdParam('jobId'),
  validateObjectIdParam('stopId'),
  requireBodyFields('status'),
  updateStopStatus
);

// Technician public/authenticated ratings & summary
router.get(
  '/:id/ratings',
  validateObjectIdParam('id'),
  getTechnicianRatingsHandler
);
router.get(
  '/:id/ratings/summary',
  validateObjectIdParam('id'),
  getTechnicianRatingSummaryHandler
);
router.get(
  '/:id/rating-summary',
  validateObjectIdParam('id'),
  getTechnicianRatingSummaryHandler
);

// Admin oversight endpoints
router.get('/', authorizeRoles('admin'), listTechniciansAdmin);
router.patch(
  '/:id/approval',
  authorizeRoles('admin'),
  validateObjectIdParam('id'),
  requireBodyFields('approvalStatus'),
  updateTechnicianApproval
);
router.patch(
  '/:id/availability',
  authorizeRoles('admin'),
  validateObjectIdParam('id'),
  requireBodyFields('availabilityStatus'),
  updateTechnicianAvailabilityAdmin
);

export default router;
