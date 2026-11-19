import { asyncHandler } from '../../utils/asyncHandler.js';
import { sendSuccess } from '../../utils/response.js';
import { parseGeoInput } from '../../utils/geo.js';
import {
  getActiveTechnicianWorkload,
  getActiveJobDetails,
} from './technicianWorkload.service.js';
import {
  recordTechnicianLocation,
  getLatestTechnicianLocation,
} from './technicianLocation.service.js';
import {
  getTechnicianActiveRoutes,
  getTechnicianJobRoute,
} from './technicianRoute.service.js';

/**
 * Lists all currently assigned active service pools and standalone bookings
 * for the authenticated technician.
 */
export const getMyActiveWorkload = asyncHandler(async (req, res) => {
  const result = await getActiveTechnicianWorkload(req.user._id, req.query);
  return sendSuccess(res, {
    data: result.jobs,
    meta: result.meta,
  });
});

/**
 * Retrieves full operational details for a specific active job assigned to the technician.
 */
export const getMyActiveWorkloadById = asyncHandler(async (req, res) => {
  const { jobId } = req.params;
  const job = await getActiveJobDetails(req.user._id, jobId);
  return sendSuccess(res, { data: job });
});

/**
 * Records a real-time GPS location update for the authenticated technician.
 */
export const updateMyTechnicianLocation = asyncHandler(async (req, res) => {
  const locationData = await recordTechnicianLocation(req.user._id, req.body);
  return sendSuccess(res, {
    message: 'Location updated successfully.',
    data: locationData,
  });
});

/**
 * Retrieves the latest recorded location for the authenticated technician.
 */
export const getMyTechnicianLocation = asyncHandler(async (req, res) => {
  const location = await getLatestTechnicianLocation(req.user._id);
  return sendSuccess(res, { data: location });
});

/**
 * Retrieves route summaries for all active jobs assigned to the authenticated technician.
 */
export const getMyAssignedRoutes = asyncHandler(async (req, res) => {
  const routes = await getTechnicianActiveRoutes(req.user._id);
  return sendSuccess(res, { data: routes });
});

/**
 * Retrieves detailed route stops and directions for a specific assigned job.
 */
export const getMyAssignedRouteById = asyncHandler(async (req, res) => {
  const { jobId } = req.params;
  let overrideLocation = null;
  if (req.query.lat && req.query.lng) {
    overrideLocation = parseGeoInput({ lat: req.query.lat, lng: req.query.lng });
  }

  const route = await getTechnicianJobRoute(req.user._id, jobId, { overrideLocation });
  return sendSuccess(res, { data: route });
});
