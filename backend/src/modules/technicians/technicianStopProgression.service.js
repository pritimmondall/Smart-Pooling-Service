import { removeBookingFromPool } from '../pools/matching.service.js';
import { executionMembers } from './executionMembers.js';
import mongoose from 'mongoose';
import {
  ServicePool,
  Booking,
  TechnicianProfile,
  Notification,
  User,
} from '../../models/index.js';
import { AppError } from '../../utils/appError.js';
import { runInTransaction } from '../../config/db.js';
import { parseGeoInput } from '../../utils/geo.js';
import { recalculateTechnicianAvailability } from './technicianAvailability.service.js';
import { getTechnicianJobRoute } from './technicianRoute.service.js';

export const VALID_STOP_TARGET_STATUSES = ['on_the_way', 'arrived', 'in_progress', 'completed', 'cancelled'];

/**
 * Calculates stop progression metrics for a pooled or individual job.
 *
 * @param {Object} job ServicePool or Booking document/object
 * @param {Array<Object>} stops Ordered list of stops
 * @returns {Object} progression metadata
 */
export function calculateProgression(job, stops = []) {
  const totalStops = stops.length;
  const completedStops = stops.filter((s) => s.status === 'completed').length;
  const cancelledStops = stops.filter((s) => s.status === 'cancelled').length;
  const inProgressStops = stops.filter((s) => s.status === 'in_progress').length;
  const arrivedStops = stops.filter((s) => s.status === 'arrived').length;
  const remainingStops = stops.filter((s) => !['completed', 'cancelled'].includes(s.status)).length;

  // Next eligible stop is the first stop in sequence that is not in a terminal state
  const nextEligibleStop = stops.find((s) => !['completed', 'cancelled'].includes(s.status)) || null;

  // Active stop is either currently in progress, arrived, or the next eligible stop
  const currentActiveStop =
    stops.find((s) => s.status === 'in_progress') ||
    stops.find((s) => s.status === 'arrived') ||
    nextEligibleStop ||
    null;

  return {
    totalStops,
    completedStops,
    cancelledStops,
    inProgressStops,
    arrivedStops,
    remainingStops,
    currentStopId: currentActiveStop?.bookingId || null,
    nextEligibleStopId: nextEligibleStop?.bookingId || null,
    isJobCompleted: totalStops > 0 && remainingStops === 0 && completedStops > 0,
    isJobCancelled: totalStops > 0 && remainingStops === 0 && completedStops === 0,
  };
}

/**
 * Retrieves all sequenced stops and progression status for an assigned job.
 *
 * @param {string|mongoose.Types.ObjectId} technicianUserId
 * @param {string|mongoose.Types.ObjectId} jobId
 * @returns {Promise<Object>}
 */
export async function getJobStops(technicianUserId, jobId) {
  if (!mongoose.isValidObjectId(technicianUserId)) {
    throw new AppError(400, 'Invalid technician ID format.', 'INVALID_ID');
  }
  if (!mongoose.isValidObjectId(jobId)) {
    throw new AppError(400, 'Invalid job ID format.', 'INVALID_ID');
  }

  const userObjectId = new mongoose.Types.ObjectId(technicianUserId);
  const jobObjectId = new mongoose.Types.ObjectId(jobId);

  // 1. Try finding as a ServicePool
  const pool = await ServicePool.findById(jobObjectId)
    .populate('serviceCategoryId', 'name slug estimatedDurationMins')
    .populate('zoneId', 'name code city')
    .populate('members.customerId', 'name email phone')
    .populate('members.bookingId', 'addressText location timeWindow status poolId stopSequence departedAt arrivedAt startedAt completedAt cancelledAt rejectionReason')
    .lean();

  if (pool) {
    if (String(pool.assignedTechnicianId) !== String(userObjectId)) {
      throw new AppError(403, 'You do not have permission to view stops for this job.', 'FORBIDDEN_JOB_ACCESS');
    }

    const orderMap = new Map();
    if (Array.isArray(pool.routeOrder)) {
      for (const ro of pool.routeOrder) {
        orderMap.set(String(ro.bookingId), ro);
      }
    }

    const activeMembers = executionMembers(pool);
    const stops = activeMembers
      .map((m, idx) => {
        const b = m.bookingId || {};
        const c = m.customerId || {};
        const savedOrder = orderMap.get(String(b._id || m.bookingId));
        const sequenceIndex = savedOrder?.sequenceIndex ?? (b.stopSequence > 0 ? b.stopSequence : idx + 1);

        return {
          bookingId: b._id || m.bookingId,
          sequenceIndex,
          status: b.status || m.status,
          addressText: b.addressText || m.addressText,
          location: b.location || m.location,
          timeWindow: b.timeWindow || pool.aggregateTimeWindow,
          customer: {
            _id: c._id || m.customerId,
            name: c.name || 'Customer',
            phone: c.phone || 'N/A',
            email: c.email || 'N/A',
          },
          departedAt: b.departedAt,
          arrivedAt: b.arrivedAt || null,
          startedAt: b.startedAt || null,
          completedAt: b.completedAt || null,
          cancelledAt: b.cancelledAt || null,
          rejectionReason: b.rejectionReason || null,
          estimatedArrival: savedOrder?.estimatedArrival || null,
          estimatedServiceStart: savedOrder?.estimatedServiceStart || null,
          estimatedServiceEnd: savedOrder?.estimatedServiceEnd || null,
        };
      })
      .sort((a, b) => a.sequenceIndex - b.sequenceIndex);

    const progression = calculateProgression(pool, stops);

    // Annotate each stop with isNextEligible flag
    const annotatedStops = stops.map((s) => ({
      ...s,
      isNextEligible: Boolean(progression.nextEligibleStopId && String(s.bookingId) === String(progression.nextEligibleStopId)),
    }));

    return {
      jobId: pool._id,
      jobType: 'pool',
      jobStatus: pool.status,
      serviceCategory: pool.serviceCategoryId,
      zone: pool.zoneId,
      timeWindow: pool.aggregateTimeWindow,
      stops: annotatedStops,
      progression,
    };
  }

  // 2. Try finding as an individual Booking
  const booking = await Booking.findById(jobObjectId)
    .populate('serviceCategoryId', 'name slug estimatedDurationMins')
    .populate('zoneId', 'name code city')
    .populate('customerId', 'name email phone')
    .lean();

  if (booking) {
    if (String(booking.technicianId) !== String(userObjectId)) {
      throw new AppError(403, 'You do not have permission to view stops for this job.', 'FORBIDDEN_JOB_ACCESS');
    }

    const isTerminal = ['completed', 'cancelled'].includes(booking.status);
    const stop = {
      bookingId: booking._id,
      sequenceIndex: 1,
      status: booking.status,
      addressText: booking.addressText,
      location: booking.location,
      timeWindow: booking.timeWindow,
      customer: {
        _id: booking.customerId?._id || booking.customerId,
        name: booking.customerId?.name || 'Customer',
        phone: booking.customerId?.phone || 'N/A',
        email: booking.customerId?.email || 'N/A',
      },
      arrivedAt: booking.arrivedAt || null,
      startedAt: booking.startedAt || null,
      completedAt: booking.completedAt || null,
      cancelledAt: booking.cancelledAt || null,
      rejectionReason: booking.rejectionReason || null,
      isNextEligible: !isTerminal,
    };

    const progression = calculateProgression(booking, [stop]);

    return {
      jobId: booking._id,
      jobType: 'individual',
      jobStatus: booking.status,
      serviceCategory: booking.serviceCategoryId,
      zone: booking.zoneId,
      timeWindow: booking.timeWindow,
      stops: [stop],
      progression,
    };
  }

  throw new AppError(404, 'Assigned job not found.', 'JOB_NOT_FOUND');
}

/**
 * Executes a transactional stop-level status transition.
 *
 * Supported target statuses:
 * - 'arrived'
 * - 'in_progress'
 * - 'completed'
 * - 'cancelled'
 *
 * Enforces:
 * 1. Authenticated technician identity and job assignment.
 * 2. Stop belongs to job (rejects INVALID_STOP_RELATIONSHIP).
 * 3. Strict sequential progression (cannot start stop N while stop N-1 is incomplete).
 * 4. State machine constraints (start requires arrival, complete requires start, cannot cancel completed).
 * 5. Atomic multi-document updates in a MongoDB transaction.
 * 6. Non-redundant, atomic notifications emitted only upon commit.
 * 7. Post-commit non-fatal route recalculation.
 *
 * @param {string|mongoose.Types.ObjectId} technicianUserId
 * @param {string|mongoose.Types.ObjectId} jobId
 * @param {string|mongoose.Types.ObjectId} stopId
 * @param {string} targetStatus
 * @param {Object} [options]
 * @param {string} [options.reason]
 * @param {number} [options.latitude]
 * @param {number} [options.longitude]
 * @returns {Promise<Object>}
 */
export async function transitionStopStatus(
  technicianUserId,
  jobId,
  stopId,
  targetStatus,
  options = {}
) {
  if (!mongoose.isValidObjectId(technicianUserId)) {
    throw new AppError(400, 'Invalid technician ID format.', 'INVALID_ID');
  }
  if (!mongoose.isValidObjectId(jobId)) {
    throw new AppError(400, 'Invalid job ID format.', 'INVALID_ID');
  }
  if (!mongoose.isValidObjectId(stopId)) {
    throw new AppError(400, 'Invalid stop ID format.', 'INVALID_ID');
  }

  if (!VALID_STOP_TARGET_STATUSES.includes(targetStatus)) {
    throw new AppError(
      400,
      `targetStatus must be one of: ${VALID_STOP_TARGET_STATUSES.join(', ')}.`,
      'VALIDATION_ERROR'
    );
  }

  const userObjectId = new mongoose.Types.ObjectId(technicianUserId);
  const jobObjectId = new mongoose.Types.ObjectId(jobId);
  const stopObjectId = new mongoose.Types.ObjectId(stopId);

  let arrivalLocation = null;
  if (options.latitude !== undefined && options.longitude !== undefined) {
    arrivalLocation = parseGeoInput({ lat: options.latitude, lng: options.longitude });
  }

  // 1. Transactional State Transition
  const transitionResult = await runInTransaction(
    async (session) => {
      const now = new Date();

      // Fetch technician profile and user for notifications
      const techUser = await User.findById(userObjectId).session(session);
      const technicianName = techUser?.name || 'Assigned Technician';

      // Determine whether job is a ServicePool or an individual Booking
      const pool = await ServicePool.findById(jobObjectId).session(session);

      if (pool) {
        // --- POOLED JOB PROGRESSION ---
        if (String(pool.assignedTechnicianId) !== String(userObjectId)) {
          throw new AppError(403, 'You do not have permission to modify stops for this job.', 'FORBIDDEN_JOB_ACCESS');
        }

        // Verify stop belongs to this pool first
        const memberEntry = (pool.members || []).find(
          (m) => String(m.bookingId) === String(stopObjectId)
        );
        if (!memberEntry) {
          throw new AppError(
            400,
            `Stop ID "${stopId}" does not belong to pool job "${jobId}".`,
            'INVALID_STOP_RELATIONSHIP'
          );
        }

        // Job eligibility check
        if (pool.status === 'assigned') {
          throw new AppError(
            409,
            'Cannot service stops on a job that has not been accepted. Please accept the job assignment first.',
            'INVALID_STATUS_TRANSITION'
          );
        }
        if (pool.status === 'completed') {
          throw new AppError(409, 'Cannot modify stops on an already completed job.', 'INVALID_STATUS_TRANSITION');
        }
        if (pool.status === 'cancelled') {
          throw new AppError(409, 'Cannot modify stops on a cancelled job.', 'INVALID_STATUS_TRANSITION');
        }
        if (!['accepted', 'in_progress'].includes(pool.status)) {
          throw new AppError(
            409,
            `Cannot modify stops: job status is "${pool.status}". Must be "accepted" or "in_progress".`,
            'INVALID_STATUS_TRANSITION'
          );
        }

        // Fetch all member bookings to evaluate ordering and progression
        const historicalIds = pool.members.map((m) => m.bookingId);
        const allBookings = await Booking.find({ _id: { $in: historicalIds } }).session(session);
        const bookingMap = new Map();
        for (const b of allBookings) {
          bookingMap.set(String(b._id), b);
        }

        // Determine stop sequence ordering
        const orderMap = new Map();
        if (Array.isArray(pool.routeOrder)) {
          for (const ro of pool.routeOrder) {
            orderMap.set(String(ro.bookingId), ro.sequenceIndex);
          }
        }

        const members = executionMembers(pool, bookingMap);
        const memberBookingIds = members.map(m => m.bookingId);
        const sortedStops = members
          .map((m, idx) => {
            const b = bookingMap.get(String(m.bookingId));
            const seq = orderMap.get(String(m.bookingId)) ?? (b?.stopSequence > 0 ? b.stopSequence : idx + 1);
            return {
              bookingId: m.bookingId,
              sequenceIndex: seq,
              status: b?.status || m.status,
              booking: b,
            };
          })
          .sort((a, b) => a.sequenceIndex - b.sequenceIndex);

        const targetStopIndex = sortedStops.findIndex((s) => String(s.bookingId) === String(stopObjectId));
        if (targetStopIndex === -1) {
          throw new AppError(400, 'Stop not found in sorted pool stops.', 'INVALID_STOP_RELATIONSHIP');
        }

        const targetStopItem = sortedStops[targetStopIndex];
        const targetBooking = targetStopItem.booking;
        if (!targetBooking) {
          throw new AppError(404, 'Stop booking document not found.', 'STOP_NOT_FOUND');
        }

        const currentStatus = targetBooking.status;

        // --- ENFORCE SEQUENTIAL PROGRESSION ---
        // For transitions that activate or begin a stop ('arrived', 'in_progress'),
        // all earlier stops in the sequence MUST be in a terminal state ('completed' or 'cancelled')
        if (['on_the_way', 'arrived', 'in_progress'].includes(targetStatus)) {
          const earlierIncomplete = sortedStops
            .slice(0, targetStopIndex)
            .find((s) => !['completed', 'cancelled'].includes(s.status));

          if (earlierIncomplete) {
            throw new AppError(
              409,
              `Cannot progress to stop #${targetStopItem.sequenceIndex} while mandatory earlier stop #${earlierIncomplete.sequenceIndex} remains incomplete (current status: "${earlierIncomplete.status}").`,
              'INVALID_SEQUENCE_PROGRESSION'
            );
          }
        }

        // --- ENFORCE STATE MACHINE TRANSITIONS ---
        let conditionalFilter = null;
        let updateSet = null;
        let notificationPayload = null;

        if (targetStatus === 'on_the_way') {
          if (!pool.automaticDispatch || currentStatus !== 'accepted') {
            throw new AppError(409, 'Only an accepted home visit can be marked on the way.', 'INVALID_STATUS_TRANSITION');
          }
          if (targetBooking.departedAt) return { jobId, stop: targetBooking };
          conditionalFilter = { _id: stopObjectId, status: 'accepted', departedAt: null };
          updateSet = { departedAt: now };
          pool.version += 1;
          notificationPayload = { userId: targetBooking.customerId, role: 'customer', type: 'execution',
            relatedEntityId: targetBooking._id, title: 'Technician on the way', message: technicianName + ' is on the way to your home.' };
        } else if (targetStatus === 'arrived') {
          if (currentStatus === 'arrived') {
            throw new AppError(409, 'Stop is already marked as arrived.', 'INVALID_STATUS_TRANSITION');
          }
          if (currentStatus === 'in_progress') {
            throw new AppError(409, 'Service is already in progress for this stop.', 'INVALID_STATUS_TRANSITION');
          }
          if (currentStatus === 'completed') {
            throw new AppError(409, 'Cannot arrive at an already completed stop.', 'INVALID_STATUS_TRANSITION');
          }
          if (currentStatus === 'cancelled') {
            throw new AppError(409, 'Cannot arrive at a cancelled stop.', 'INVALID_STATUS_TRANSITION');
          }
          if (!['accepted', 'confirmed', 'assigned'].includes(currentStatus)) {
            throw new AppError(
              409,
              `Cannot mark arrived: current stop status is "${currentStatus}". Must be "accepted".`,
              'INVALID_STATUS_TRANSITION'
            );
          }

          conditionalFilter = {
            _id: stopObjectId,
            status: { $in: ['accepted', 'confirmed', 'assigned'] },
            version: targetBooking.version ?? 0,
          };
          updateSet = {
            status: 'arrived',
            arrivedAt: now,
            ...(arrivalLocation ? { arrivalLocation } : {}),
          };
          notificationPayload = {
            userId: targetBooking.customerId,
            role: 'customer',
            title: 'Technician Arrived',
            message: `Technician ${technicianName} has arrived at your location for your service.`,
            type: 'execution',
            relatedEntityId: targetBooking._id,
          };
        } else if (targetStatus === 'in_progress') {
          if (currentStatus === 'in_progress') {
            throw new AppError(409, 'Service is already in progress for this stop.', 'INVALID_STATUS_TRANSITION');
          }
          if (currentStatus === 'completed') {
            throw new AppError(409, 'Stop is already completed.', 'INVALID_STATUS_TRANSITION');
          }
          if (currentStatus === 'cancelled') {
            throw new AppError(409, 'Cannot start service on a cancelled stop.', 'INVALID_STATUS_TRANSITION');
          }
          if (currentStatus !== 'arrived') {
            throw new AppError(
              409,
              `Cannot start service before arrival: current stop status is "${currentStatus}" (must be "arrived").`,
              'INVALID_STATUS_TRANSITION'
            );
          }

          conditionalFilter = {
            _id: stopObjectId,
            status: 'arrived',
            version: targetBooking.version ?? 0,
          };
          updateSet = {
            status: 'in_progress',
            startedAt: now,
          };
          notificationPayload = {
            userId: targetBooking.customerId,
            role: 'customer',
            title: 'Service Started',
            message: `Technician ${technicianName} has started servicing your request.`,
            type: 'execution',
            relatedEntityId: targetBooking._id,
          };
        } else if (targetStatus === 'completed') {
          if (currentStatus === 'completed') {
            throw new AppError(409, 'Stop is already completed.', 'INVALID_STATUS_TRANSITION');
          }
          if (currentStatus === 'cancelled') {
            throw new AppError(409, 'Cannot complete a cancelled stop.', 'INVALID_STATUS_TRANSITION');
          }
          if (currentStatus !== 'in_progress') {
            throw new AppError(
              409,
              `Cannot complete stop before it has started: current stop status is "${currentStatus}" (must be "in_progress").`,
              'INVALID_STATUS_TRANSITION'
            );
          }

          conditionalFilter = {
            _id: stopObjectId,
            status: 'in_progress',
            version: targetBooking.version ?? 0,
          };
          updateSet = {
            status: 'completed',
            completedAt: now,
          };
          notificationPayload = {
            userId: targetBooking.customerId,
            role: 'customer',
            title: 'Service Completed',
            message: `Your service stop has been completed by ${technicianName}. Thank you for using SmartPool!`,
            type: 'execution',
            relatedEntityId: targetBooking._id,
          };
        } else if (targetStatus === 'cancelled') {
          if (currentStatus === 'completed') {
            throw new AppError(409, 'Cannot cancel an already completed stop.', 'INVALID_STATUS_TRANSITION');
          }
          if (currentStatus === 'cancelled') {
            throw new AppError(409, 'Stop is already cancelled.', 'INVALID_STATUS_TRANSITION');
          }
          if (!['accepted', 'confirmed', 'assigned', 'arrived', 'in_progress'].includes(currentStatus)) {
            throw new AppError(
              409,
              `Cannot cancel stop in status "${currentStatus}".`,
              'INVALID_STATUS_TRANSITION'
            );
          }

          conditionalFilter = {
            _id: stopObjectId,
            status: { $in: ['accepted', 'confirmed', 'assigned', 'arrived', 'in_progress'] },
            version: targetBooking.version ?? 0,
          };
          updateSet = {
            status: 'cancelled',
            cancelledAt: now,
            rejectionReason: String(options.reason || 'Stop cancelled by technician').trim().slice(0, 500),
          };
          notificationPayload = {
            userId: targetBooking.customerId,
            role: 'customer',
            title: 'Service Stop Cancelled',
            message: `Your service stop was cancelled by technician ${technicianName}. Reason: "${updateSet.rejectionReason}".`,
            type: 'execution',
            relatedEntityId: targetBooking._id,
          };
        }

        // Execute atomic conditional update on Booking
        const updatedBooking = await Booking.findOneAndUpdate(
          conditionalFilter,
          {
            $set: updateSet,
            $inc: { version: 1 },
          },
          { session, new: true }
        );

        if (!updatedBooking) {
          // Concurrent race detected: reload to provide precise error
          const raceCheck = await Booking.findById(stopObjectId).session(session);
          throw new AppError(
            409,
            `Concurrent update conflict on stop: current status is "${raceCheck?.status}".`,
            'INVALID_STATUS_TRANSITION'
          );
        }

        // Serialize changes to the technician's departure and finish times with dispatch
        // and route insertion for their other jobs.
        await TechnicianProfile.updateOne({ userId: userObjectId }, { $inc: { version: 1 } }, { session });

        // Synchronize pool member status if cancelled
        if (targetStatus === 'cancelled') {
          const poolMember = members.find((m) => String(m.bookingId) === String(stopObjectId));
          if (poolMember) {
            poolMember.status = 'cancelled';
          }
        }

        // Synchronize ServicePool.routeOrder actual timestamps if present
        if (Array.isArray(pool.routeOrder)) {
          const routeItem = pool.routeOrder.find((ro) => String(ro.bookingId) === String(stopObjectId));
          if (routeItem) {
            routeItem.status = targetStatus;
            if (targetStatus === 'arrived') routeItem.actualArrival = now;
            if (targetStatus === 'in_progress') routeItem.actualServiceStart = now;
            if (targetStatus === 'completed') routeItem.actualServiceEnd = now;
          }
        }

        // Check if pool job needs to transition to in_progress (e.g. from accepted on first arrival/start)
        const startingPool = pool.status === 'accepted' && ['arrived', 'in_progress'].includes(targetStatus);
        if (startingPool) {
          pool.status = 'in_progress';
          pool.startedAt = pool.startedAt || now;

        }

        // Evaluate parent pool job terminal completion
        // All stops must be in 'completed' or 'cancelled' status
        const refreshedBookings = await Booking.find({ _id: { $in: memberBookingIds } }).session(session);
        const incompleteStops = refreshedBookings.filter((b) => !['completed', 'cancelled'].includes(b.status));
        const completedStops = refreshedBookings.filter((b) => b.status === 'completed');
        const cancelledStops = refreshedBookings.filter((b) => b.status === 'cancelled');

        let isParentPoolFinished = false;

        if (incompleteStops.length === 0 && refreshedBookings.length > 0) {
          isParentPoolFinished = true;
          if (completedStops.length > 0) {
            // At least one stop completed -> pool completed
            pool.status = 'completed';
            pool.completedAt = now;
            await TechnicianProfile.findOneAndUpdate(
              { userId: userObjectId },
              { $inc: { jobsCompleted: 1 } },
              { session }
            );

          } else {
            // All stops were cancelled -> pool cancelled
            pool.status = 'cancelled';
            pool.cancelledAt = now;
            pool.rejectionReason = 'All stops in pool were cancelled.';

          }
        }

        if (pool.automaticDispatch && isParentPoolFinished) pool.acceptingVisits = false;
        await pool.save({ session });
        if (pool.automaticDispatch && targetStatus === 'cancelled') await removeBookingFromPool(stopObjectId, session, false, true);
        if (startingPool || isParentPoolFinished) await recalculateTechnicianAvailability(userObjectId, { session });

        // Atomic notification insertion
        if (notificationPayload) {
          await Notification.create([notificationPayload], { session, ordered: true });
        }

        // Prepare ordered stop progression view
        const finalStops = sortedStops.map((s) => {
          if (String(s.bookingId) === String(stopObjectId)) {
            return {
              ...s,
              status: targetStatus,
              booking: updatedBooking,
            };
          }
          const latest = refreshedBookings.find((b) => String(b._id) === String(s.bookingId));
          return {
            ...s,
            status: latest?.status || s.status,
            booking: latest || s.booking,
          };
        });

        const progression = calculateProgression(pool, finalStops);

        return {
          jobId: pool._id,
          jobType: 'pool',
          jobStatus: pool.status,
          stop: {
            bookingId: updatedBooking._id,
            sequenceIndex: targetStopItem.sequenceIndex,
            status: updatedBooking.status,
            addressText: updatedBooking.addressText,
            arrivedAt: updatedBooking.arrivedAt,
            startedAt: updatedBooking.startedAt,
            completedAt: updatedBooking.completedAt,
            cancelledAt: updatedBooking.cancelledAt,
            rejectionReason: updatedBooking.rejectionReason,
          },
          progression,
          isParentJobFinished: isParentPoolFinished,
        };
      }

      if (targetStatus === 'on_the_way') throw new AppError(409, 'This action requires a home visit.', 'INVALID_STATUS_TRANSITION');

      // --- INDIVIDUAL BOOKING PROGRESSION ---
      const booking = await Booking.findById(jobObjectId).session(session);
      if (booking) {
        if (String(booking.technicianId) !== String(userObjectId)) {
          throw new AppError(403, 'You do not have permission to modify this job.', 'FORBIDDEN_JOB_ACCESS');
        }

        // For individual bookings, the stop ID MUST match the job ID
        if (String(stopObjectId) !== String(jobObjectId)) {
          throw new AppError(
            400,
            `Stop ID "${stopId}" does not belong to individual booking "${jobId}".`,
            'INVALID_STOP_RELATIONSHIP'
          );
        }

        const currentStatus = booking.status;
        let conditionalFilter = null;
        let updateSet = null;
        let notificationPayload = null;

        if (targetStatus === 'arrived') {
          if (currentStatus === 'arrived') {
            throw new AppError(409, 'Stop is already marked as arrived.', 'INVALID_STATUS_TRANSITION');
          }
          if (currentStatus === 'in_progress') {
            throw new AppError(409, 'Service is already in progress for this stop.', 'INVALID_STATUS_TRANSITION');
          }
          if (currentStatus === 'completed') {
            throw new AppError(409, 'Cannot arrive at an already completed stop.', 'INVALID_STATUS_TRANSITION');
          }
          if (currentStatus === 'cancelled') {
            throw new AppError(409, 'Cannot arrive at a cancelled stop.', 'INVALID_STATUS_TRANSITION');
          }
          if (!['accepted', 'confirmed', 'assigned'].includes(currentStatus)) {
            throw new AppError(
              409,
              `Cannot mark arrived: current status is "${currentStatus}". Must be "accepted".`,
              'INVALID_STATUS_TRANSITION'
            );
          }

          conditionalFilter = {
            _id: stopObjectId,
            status: { $in: ['accepted', 'confirmed', 'assigned'] },
            version: booking.version ?? 0,
          };
          updateSet = {
            status: 'arrived',
            arrivedAt: now,
            ...(arrivalLocation ? { arrivalLocation } : {}),
          };
          notificationPayload = {
            userId: booking.customerId,
            role: 'customer',
            title: 'Technician Arrived',
            message: `Technician ${technicianName} has arrived at your location.`,
            type: 'execution',
            relatedEntityId: booking._id,
          };
        } else if (targetStatus === 'in_progress') {
          if (currentStatus === 'in_progress') {
            throw new AppError(409, 'Service is already in progress for this stop.', 'INVALID_STATUS_TRANSITION');
          }
          if (currentStatus === 'completed') {
            throw new AppError(409, 'Stop is already completed.', 'INVALID_STATUS_TRANSITION');
          }
          if (currentStatus === 'cancelled') {
            throw new AppError(409, 'Cannot start service on a cancelled stop.', 'INVALID_STATUS_TRANSITION');
          }
          if (currentStatus !== 'arrived') {
            throw new AppError(
              409,
              `Cannot start service before arrival: current status is "${currentStatus}" (must be "arrived").`,
              'INVALID_STATUS_TRANSITION'
            );
          }

          conditionalFilter = {
            _id: stopObjectId,
            status: 'arrived',
            version: booking.version ?? 0,
          };
          updateSet = {
            status: 'in_progress',
            startedAt: now,
          };
          notificationPayload = {
            userId: booking.customerId,
            role: 'customer',
            title: 'Service Started',
            message: `Technician ${technicianName} has started servicing your booking.`,
            type: 'execution',
            relatedEntityId: booking._id,
          };
        } else if (targetStatus === 'completed') {
          if (currentStatus === 'completed') {
            throw new AppError(409, 'Stop is already completed.', 'INVALID_STATUS_TRANSITION');
          }
          if (currentStatus === 'cancelled') {
            throw new AppError(409, 'Cannot complete a cancelled stop.', 'INVALID_STATUS_TRANSITION');
          }
          if (currentStatus !== 'in_progress') {
            throw new AppError(
              409,
              `Cannot complete stop before it has started: current status is "${currentStatus}" (must be "in_progress").`,
              'INVALID_STATUS_TRANSITION'
            );
          }

          conditionalFilter = {
            _id: stopObjectId,
            status: 'in_progress',
            version: booking.version ?? 0,
          };
          updateSet = {
            status: 'completed',
            completedAt: now,
          };
          notificationPayload = {
            userId: booking.customerId,
            role: 'customer',
            title: 'Service Completed',
            message: `Your service booking has been completed by ${technicianName}.`,
            type: 'execution',
            relatedEntityId: booking._id,
          };
        } else if (targetStatus === 'cancelled') {
          if (currentStatus === 'completed') {
            throw new AppError(409, 'Cannot cancel an already completed stop.', 'INVALID_STATUS_TRANSITION');
          }
          if (currentStatus === 'cancelled') {
            throw new AppError(409, 'Stop is already cancelled.', 'INVALID_STATUS_TRANSITION');
          }

          conditionalFilter = {
            _id: stopObjectId,
            status: { $in: ['accepted', 'confirmed', 'assigned', 'arrived', 'in_progress'] },
            version: booking.version ?? 0,
          };
          updateSet = {
            status: 'cancelled',
            cancelledAt: now,
            rejectionReason: String(options.reason || 'Booking cancelled by technician').trim().slice(0, 500),
          };
          notificationPayload = {
            userId: booking.customerId,
            role: 'customer',
            title: 'Booking Cancelled',
            message: `Your service booking was cancelled by technician ${technicianName}. Reason: "${updateSet.rejectionReason}".`,
            type: 'execution',
            relatedEntityId: booking._id,
          };
        }

        const updatedBooking = await Booking.findOneAndUpdate(
          conditionalFilter,
          {
            $set: updateSet,
            $inc: { version: 1 },
          },
          { session, new: true }
        );

        if (!updatedBooking) {
          const raceCheck = await Booking.findById(stopObjectId).session(session);
          throw new AppError(
            409,
            `Concurrent update conflict on booking: current status is "${raceCheck?.status}".`,
            'INVALID_STATUS_TRANSITION'
          );
        }

        if (targetStatus === 'completed') {
          await TechnicianProfile.findOneAndUpdate(
            { userId: userObjectId },
            { $inc: { jobsCompleted: 1 } },
            { session }
          );
          await recalculateTechnicianAvailability(userObjectId, { session });
        } else if (['arrived', 'in_progress', 'cancelled'].includes(targetStatus)) {
          await recalculateTechnicianAvailability(userObjectId, { session });
        }

        if (notificationPayload) {
          await Notification.create([notificationPayload], { session, ordered: true });
        }

        const stop = {
          bookingId: updatedBooking._id,
          sequenceIndex: 1,
          status: updatedBooking.status,
          addressText: updatedBooking.addressText,
          arrivedAt: updatedBooking.arrivedAt,
          startedAt: updatedBooking.startedAt,
          completedAt: updatedBooking.completedAt,
          cancelledAt: updatedBooking.cancelledAt,
          rejectionReason: updatedBooking.rejectionReason,
        };

        const progression = calculateProgression(updatedBooking, [stop]);

        return {
          jobId: updatedBooking._id,
          jobType: 'individual',
          jobStatus: updatedBooking.status,
          stop,
          progression,
          isParentJobFinished: ['completed', 'cancelled'].includes(updatedBooking.status),
        };
      }

      throw new AppError(404, 'Assigned job not found.', 'JOB_NOT_FOUND');
    },
    { requireTransaction: true }
  );

  // 2. Post-Commit Non-Fatal Route Recalculation
  // Outside transaction: refresh remaining route so client receives up-to-date directions
  // Skip route recalculation if the parent job has reached terminal status
  let refreshedRoute = null;
  if (!transitionResult.isParentJobFinished) {
    try {
      refreshedRoute = await getTechnicianJobRoute(technicianUserId, jobId);
    } catch (routeErr) {
      // Non-fatal warning: route calculation failure must never corrupt the committed state
      console.warn(`[Route Recalculation Warning] Could not refresh route after stop transition: ${routeErr.message}`);
    }
  }

  return {
    ...transitionResult,
    route: refreshedRoute,
  };
}
