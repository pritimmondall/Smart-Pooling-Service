import { asyncHandler } from '../../utils/asyncHandler.js';
import { sendSuccess } from '../../utils/response.js';
import {
  getJobStops,
  transitionStopStatus,
} from './technicianStopProgression.service.js';

/**
 * Retrieves all sequenced stops and progression status for an assigned job.
 */
export const getMyJobStops = asyncHandler(async (req, res) => {
  const { jobId } = req.params;
  const result = await getJobStops(req.user._id, jobId);
  return sendSuccess(res, { data: result });
});

/**
 * Records technician arrival at a specific stop.
 */
export const arriveAtStop = asyncHandler(async (req, res) => {
  const { jobId, stopId } = req.params;
  const { latitude, longitude } = req.body || {};
  const result = await transitionStopStatus(req.user._id, jobId, stopId, 'arrived', {
    latitude,
    longitude,
  });
  return sendSuccess(res, {
    message: 'Technician arrival recorded at stop.',
    data: result,
  });
});

/**
 * Starts service work at a specific stop (requires arrival).
 */
export const startStopService = asyncHandler(async (req, res) => {
  const { jobId, stopId } = req.params;
  const result = await transitionStopStatus(req.user._id, jobId, stopId, 'in_progress');
  return sendSuccess(res, {
    message: 'Service work started at stop.',
    data: result,
  });
});

/**
 * Completes service work at a specific stop (requires in_progress).
 */
export const completeStopService = asyncHandler(async (req, res) => {
  const { jobId, stopId } = req.params;
  const result = await transitionStopStatus(req.user._id, jobId, stopId, 'completed');
  return sendSuccess(res, {
    message: 'Service work completed at stop.',
    data: result,
  });
});

/**
 * Cancels or marks failed a specific stop.
 */
export const cancelStopService = asyncHandler(async (req, res) => {
  const { jobId, stopId } = req.params;
  const { reason } = req.body || {};
  const result = await transitionStopStatus(req.user._id, jobId, stopId, 'cancelled', { reason });
  return sendSuccess(res, {
    message: 'Service stop cancelled.',
    data: result,
  });
});

/**
 * Unified stop status transition endpoint.
 */
export const updateStopStatus = asyncHandler(async (req, res) => {
  const { jobId, stopId } = req.params;
  const { status, reason, latitude, longitude } = req.body || {};
  const result = await transitionStopStatus(req.user._id, jobId, stopId, status, {
    reason,
    latitude,
    longitude,
  });
  return sendSuccess(res, {
    message: `Stop status updated to "${status}".`,
    data: result,
  });
});
