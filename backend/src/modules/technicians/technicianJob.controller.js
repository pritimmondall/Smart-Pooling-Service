import { wakeVisitDispatch } from '../pools/poolWorker.js';
import { planVisitSchedule, applyVisitSchedule } from '../routing/visitSchedule.service.js';
import mongoose from 'mongoose';
import {
  User,
  ServicePool,
  Booking,
  TechnicianProfile,
  Notification,
  VALID_STATUS_TRANSITIONS,
} from '../../models/index.js';
import { AppError } from '../../utils/appError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { parsePagination } from '../../utils/pagination.js';
import { sendSuccess } from '../../utils/response.js';
import { runInTransaction } from '../../config/db.js';
import { planAssignedPool } from '../pools/routeSavings.service.js';
import { parseGeoInput } from '../../utils/geo.js';
import { recalculateTechnicianAvailability } from './technicianAvailability.service.js';
import { getTechnicianJobRoute } from './technicianRoute.service.js';

/**
 * Lists all assigned jobs (both pooled and individual) for the authenticated technician.
 */
export const getMyAssignedJobs = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const statusFilter = req.query.status;
  const typeFilter = req.query.type; // 'pool' | 'individual'

  const poolQuery = {
    assignedTechnicianId: req.user._id,
  };
  const bookingQuery = {
    technicianId: req.user._id,
    poolId: null, // Only individual bookings here
  };

  const [pools, bookings] = await Promise.all([
    ServicePool.find(poolQuery).populate('serviceCategoryId', 'name slug baseIndividualPrice estimatedDurationMins')
      .populate('zoneId', 'name code city').lean(),
    Booking.find(bookingQuery).populate('customerId', 'name email phone')
      .populate('serviceCategoryId', 'name slug baseIndividualPrice estimatedDurationMins').populate('zoneId', 'name code city').lean(),
  ]);

  // Format pooled jobs
  const formattedPools = pools.map((p) => {
    const activeMembers = (p.members || []).filter((m) => m.status === 'active');
    return {
      _id: p._id,
      jobType: 'pool',
      status: p.status,
      automaticDispatch: p.automaticDispatch, poolScope: p.poolScope,
      specificService: p.specificService,
      serviceCategory: p.serviceCategoryId,
      zone: p.zoneId,
      timeWindow: p.aggregateTimeWindow,
      centroidLocation: p.centroidLocation,
      memberCount: activeMembers.length,
      maxCapacity: p.maxCapacity,
      pricing: p.pricing,
      assignedAt: p.assignedAt,
      acceptedAt: p.acceptedAt,
      startedAt: p.startedAt,
      completedAt: p.completedAt,
      createdAt: p.createdAt,
    };
  });

  // Format individual jobs
  const formattedBookings = bookings.map((b) => ({
    _id: b._id,
    jobType: 'individual',
    status: b.status,
    specificService: b.specificService,
      serviceCategory: b.serviceCategoryId,
    zone: b.zoneId,
    customer: b.customerId,
    addressText: b.addressText,
    location: b.location,
    timeWindow: b.timeWindow,
    estimatedPrice: b.estimatedPrice,
    notes: b.notes,
    assignedAt: b.assignedAt,
    acceptedAt: b.acceptedAt,
    startedAt: b.startedAt,
    completedAt: b.completedAt,
    createdAt: b.createdAt,
  }));

  const allJobs = [...formattedPools, ...formattedBookings].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  const counts = { all: allJobs.length };
  for (const job of allJobs) counts[job.status] = (counts[job.status] || 0) + 1;
  const query = String(req.query.q || '').trim().toLowerCase();
  const matches = allJobs.filter(job => (!typeFilter || job.jobType === typeFilter) &&
    (!statusFilter || job.status === statusFilter) && (!query || [job._id, job.specificService, job.serviceCategory?.name,
      job.zone?.name, job.customer?.name, job.customer?.phone, job.addressText].some(value => String(value || '').toLowerCase().includes(query))));
  const total = matches.length;
  const paginated = matches.slice(skip, skip + limit);

  return sendSuccess(res, {
    data: paginated,
    meta: {
      counts,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1,
      },
    },
  });
});

/**
 * Fetches a single assigned pooled job or individual booking by ID.
 * Returns UNMASKED customer contact details (name, phone, address, coordinates)
 * strictly necessary for technician field execution.
 */
export const getMyAssignedJobById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(400, 'Invalid job ID format.', 'INVALID_ID');
  }

  // 1. Try finding as a ServicePool
  const pool = await ServicePool.findById(id)
    .populate('serviceCategoryId', 'name slug baseIndividualPrice estimatedDurationMins')
    .populate('zoneId', 'name code city')
    .populate('members.customerId', 'name email phone')
    .populate('members.bookingId', 'addressText location notes timeWindow status estimatedPrice stopSequence');

  if (pool) {
    if (String(pool.assignedTechnicianId) !== String(req.user._id)) {
      throw new AppError(403, 'You do not have permission to view this job.', 'FORBIDDEN_JOB_ACCESS');
    }

    const activeMembers = pool.members
      .filter((m) => m.status === 'active')
      .map((m, idx) => {
        const booking = m.bookingId || {};
        const customer = m.customerId || {};
        return {
          memberIndex: booking.stopSequence || idx + 1,
          earned: booking.status === 'completed' ? booking.estimatedPrice : 0,
          bookingId: booking._id || m.bookingId,
          customer: {
            _id: customer._id,
            name: customer.name || 'Customer',
            email: customer.email,
            phone: customer.phone || 'N/A',
          },
          addressText: booking.addressText || m.addressText,
          location: booking.location || m.location,
          notes: booking.notes || '',
          timeWindow: booking.timeWindow,
          status: booking.status || m.status,
          joinedAt: m.joinedAt,
        };
      });

    return sendSuccess(res, {
      data: {
        _id: pool._id,
        jobType: 'pool',
        status: pool.status,
        specificService: pool.specificService,
      serviceCategory: pool.serviceCategoryId,
        zone: pool.zoneId,
        aggregateTimeWindow: pool.aggregateTimeWindow,
        centroidLocation: pool.centroidLocation,
        memberCount: activeMembers.length,
        maxCapacity: pool.maxCapacity,
        pricing: pool.pricing,
        routeOrder: pool.routeOrder,
        members: activeMembers,
        assignedAt: pool.assignedAt,
        acceptedAt: pool.acceptedAt,
        startedAt: pool.startedAt,
        completedAt: pool.completedAt,
        rejectionReason: pool.rejectionReason,
        createdAt: pool.createdAt,
      },
    });
  }

  // 2. Try finding as an individual Booking
  const booking = await Booking.findById(id)
    .populate('customerId', 'name email phone')
    .populate('serviceCategoryId', 'name slug baseIndividualPrice estimatedDurationMins')
    .populate('zoneId', 'name code city');

  if (booking) {
    if (String(booking.technicianId) !== String(req.user._id)) {
      throw new AppError(403, 'You do not have permission to view this job.', 'FORBIDDEN_JOB_ACCESS');
    }

    return sendSuccess(res, {
      data: {
        _id: booking._id,
        jobType: 'individual',
        status: booking.status,
        specificService: booking.specificService,
      serviceCategory: booking.serviceCategoryId,
        zone: booking.zoneId,
        customer: booking.customerId,
        addressText: booking.addressText,
        location: booking.location,
        timeWindow: booking.timeWindow,
        notes: booking.notes,
        estimatedPrice: booking.estimatedPrice,
        assignedAt: booking.assignedAt,
        acceptedAt: booking.acceptedAt,
        startedAt: booking.startedAt,
        completedAt: booking.completedAt,
        rejectionReason: booking.rejectionReason,
        createdAt: booking.createdAt,
      },
    });
  }

  throw new AppError(404, 'Assigned job not found.', 'JOB_NOT_FOUND');
});

/**
 * Accepts an assigned job (pool or individual booking).
 * Transitions status: assigned -> accepted.
 */
export const acceptAssignedJob = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(400, 'Invalid job ID format.', 'INVALID_ID');
  }

  // Check if technician is approved
  const profile = await TechnicianProfile.findOne({ userId: req.user._id });
  if (!profile || profile.approvalStatus !== 'approved') {
    throw new AppError(403, 'Unapproved technicians cannot accept assignments.', 'TECH_NOT_APPROVED');
  }

  const plan = await planAssignedPool(id, profile);
  const acceptedJob = await runInTransaction(
    async (session) => {
      // 1. Check Pool
      const pool = await ServicePool.findById(id).session(session);
      if (pool) {
        if (String(pool.assignedTechnicianId) !== String(req.user._id)) {
          throw new AppError(403, 'You do not have permission to modify this job.', 'FORBIDDEN_JOB_ACCESS');
        }

        if (pool.status !== 'assigned') {
          throw new AppError(
            409,
            `Cannot accept job: current status is "${pool.status}" (must be "assigned").`,
            'INVALID_STATUS_TRANSITION'
          );
        }

        const planned = plan && pool.members.filter(m => m.status === 'active').length === plan.stops.length
          && plan.stops.every(s => pool.members.some(m => m.status === 'active' && String(m.bookingId) === String(s.bookingId)));
        if (planned) {
          pool.routeOrder = plan.routeOrder;
          pool.sharedGeometry = plan.sharedGeometry;
          for (const stop of plan.stops) {
            await Booking.updateOne({ _id: stop.bookingId }, { $set: {
              stopSequence: stop.sequenceIndex,
              routeSavings: {
                provider: plan.provider, costPerKm: plan.costPerKm, customerPaise: stop.customerPaise,
                technicianPaise: stop.technicianPaise, platformPaise: stop.platformPaise,
              },
            } }, { session });
          }
        }
        if (pool.automaticDispatch && !pool.routeOrder.length) {
          await pool.populate({ path: 'serviceCategoryId', select: 'estimatedDurationMins', options: { session } });
          const schedule = await planVisitSchedule(pool, { category: pool.serviceCategoryId, session });
          if (schedule) await applyVisitSchedule(pool, schedule, session);
        }
        pool.status = 'accepted';
        pool.acceptedAt = new Date();
        await pool.save({ session });

        // Update member bookings
        const activeBookingIds = pool.members.filter((m) => m.status === 'active').map((m) => m.bookingId);
        await Booking.updateMany(
          { _id: { $in: activeBookingIds } },
          { $set: { status: 'accepted', acceptedAt: new Date() } },
          { session }
        );

        // Notify customers
        const customerNotifs = pool.members
          .filter((m) => m.status === 'active')
          .map((m) => ({
            userId: m.customerId,
            role: 'customer',
            title: 'Technician Confirmed',
            message: `Technician ${req.user.name} has accepted and confirmed your pooled service assignment.`,
            type: 'booking',
            relatedEntityId: m.bookingId,
          }));

        if (customerNotifs.length > 0) {
          await Notification.create(customerNotifs, { session, ordered: true });
        }

        // Centralized availability recalculation
        await recalculateTechnicianAvailability(req.user._id, { session });

        return {
          message: 'Pooled job accepted.',
          data: pool,
        };
      }

      // 2. Check Individual Booking
      const booking = await Booking.findById(id).session(session);
      if (booking) {
        if (String(booking.technicianId) !== String(req.user._id)) {
          throw new AppError(403, 'You do not have permission to modify this job.', 'FORBIDDEN_JOB_ACCESS');
        }

        if (booking.status !== 'assigned') {
          throw new AppError(
            409,
            `Cannot accept job: current status is "${booking.status}" (must be "assigned").`,
            'INVALID_STATUS_TRANSITION'
          );
        }

        booking.status = 'accepted';
        booking.acceptedAt = new Date();
        await booking.save({ session });

        await Notification.create(
          [
            {
              userId: booking.customerId,
              role: 'customer',
              title: 'Technician Confirmed',
              message: `Technician ${req.user.name} has accepted and confirmed your booking.`,
              type: 'booking',
              relatedEntityId: booking._id,
            },
          ],
          { session, ordered: true }
        );

        // Centralized availability recalculation
        await recalculateTechnicianAvailability(req.user._id, { session });

        return {
          message: 'Individual booking accepted.',
          data: booking,
        };
      }

      throw new AppError(404, 'Assigned job not found.', 'JOB_NOT_FOUND');
    },
    { requireTransaction: true }
  );

  return sendSuccess(res, acceptedJob);
});

/**
 * Rejects an assigned job before acceptance.
 * Reverts pool status back to "locked" so it can be reassigned.
 */
export const rejectAssignedJob = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { reason = 'Technician unavailable' } = req.body || {};

  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(400, 'Invalid job ID format.', 'INVALID_ID');
  }

  const rejectedJob = await runInTransaction(
    async (session) => {
      // 1. Check Pool
      const pool = await ServicePool.findById(id).session(session);
      if (pool) {
        if (String(pool.assignedTechnicianId) !== String(req.user._id)) {
          throw new AppError(403, 'You do not have permission to modify this job.', 'FORBIDDEN_JOB_ACCESS');
        }

        if (pool.status !== 'assigned' && !(pool.automaticDispatch && pool.status === 'accepted')) {
          throw new AppError(
            409,
            `Cannot reject job: status is "${pool.status}". Only "assigned" jobs can be rejected.`,
            'INVALID_STATUS_TRANSITION'
          );
        }

        pool.status = pool.automaticDispatch ? 'forming' : 'locked';
        if (pool.automaticDispatch) {
          pool.routeOrder = [];
          pool.routeOrigin = undefined;
          pool.routeDeparture = undefined;
          pool.sharedGeometry = undefined;
          pool.assignedAt = null;
          pool.acceptedAt = null;
        }
        pool.assignedTechnicianId = null;
        pool.rejectionReason = String(reason).trim().slice(0, 500);

        // Record technician User ID in rejection history (avoid duplicates)
        if (!Array.isArray(pool.rejectedTechnicians)) {
          pool.rejectedTechnicians = [];
        }
        const technicianUserId = req.user._id;
        const alreadyRecorded = pool.rejectedTechnicians.some(
          (tId) => String(tId?._id || tId) === String(technicianUserId)
        );
        if (!alreadyRecorded) {
          pool.rejectedTechnicians.push(technicianUserId);
        }

        await pool.save({ session });

        // Reset bookings back to confirmed
        const activeBookingIds = pool.members.filter((m) => m.status === 'active').map((m) => m.bookingId);
        await Booking.updateMany(
          { _id: { $in: activeBookingIds } },
          { $set: { status: 'confirmed', technicianId: null, assignedAt: null, acceptedAt: null, waitingSince: null, departedAt: null, stopSequence: 0 } },
          { session }
        );

        // Notify admin for reassignment
        const admins = await User.find({ role: 'admin', isActive: true }, '_id').session(session);
        const adminNotifs = admins.map((a) => ({
          userId: a._id,
          role: 'admin',
          title: 'Pooled Assignment Rejected',
          message: `Technician ${req.user.name} rejected pool ${pool._id}. Reason: "${reason}". Pool is now locked for reassignment.`,
          type: 'dispatch',
          relatedEntityId: pool._id,
        }));

        if (pool.automaticDispatch) {
          adminNotifs.push(...pool.members.filter(m => m.status === 'active').map(m => ({
            userId: m.customerId, role: 'customer', type: 'booking', relatedEntityId: m.bookingId,
            title: 'Finding a replacement technician', message: 'Your technician declined. Dispatch is retrying your confirmed window.',
          })));
        }
        if (adminNotifs.length > 0) {
          await Notification.create(adminNotifs, { session, ordered: true });
        }

        // Centralized availability recalculation
        await recalculateTechnicianAvailability(req.user._id, { session });

        return {
          message: 'Job assignment rejected. Pool returned to locked state for reassignment.',
          data: pool,
        };
      }

      // 2. Check Individual Booking
      const booking = await Booking.findById(id).session(session);
      if (booking) {
        if (String(booking.technicianId) !== String(req.user._id)) {
          throw new AppError(403, 'You do not have permission to modify this job.', 'FORBIDDEN_JOB_ACCESS');
        }

        if (booking.status !== 'assigned') {
          throw new AppError(
            409,
            `Cannot reject job: status is "${booking.status}". Only "assigned" jobs can be rejected.`,
            'INVALID_STATUS_TRANSITION'
          );
        }

        booking.status = 'confirmed';
        booking.technicianId = null;
        booking.rejectedTechnicians.addToSet(req.user._id);
        booking.rejectionReason = String(reason).trim().slice(0, 500);
        await booking.save({ session });

        // Centralized availability recalculation
        await recalculateTechnicianAvailability(req.user._id, { session });

        return {
          message: 'Job assignment rejected. Booking returned to confirmed state.',
          data: booking,
        };
      }

      throw new AppError(404, 'Assigned job not found.', 'JOB_NOT_FOUND');
    },
    { requireTransaction: true }
  );

  if (rejectedJob.data.automaticDispatch) wakeVisitDispatch(rejectedJob.data._id);
  return sendSuccess(res, rejectedJob);
});

/**
 * Updates the execution status of an accepted job.
 * Enforces lifecycle: accepted -> in_progress -> completed.
 *
 * Rejects:
 * - Marking a job completed before it has started.
 * - Out-of-order transitions.
 * - Modifying completed/cancelled jobs.
 * - Changing pricing, membership, or customer information.
 */
export const updateAssignedJobStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};

  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(400, 'Invalid job ID format.', 'INVALID_ID');
  }

  const allowedTargetStatuses = ['in_progress', 'completed', 'cancelled'];
  if (!allowedTargetStatuses.includes(status)) {
    throw new AppError(
      400,
      `status must be one of: ${allowedTargetStatuses.join(', ')}.`,
      'VALIDATION_ERROR'
    );
  }

  const { reason } = req.body || {};

  const updatedJob = await runInTransaction(
    async (session) => {
      // 1. Check Pool
      const pool = await ServicePool.findById(id).session(session);
      if (pool) {
        if (String(pool.assignedTechnicianId) !== String(req.user._id)) {
          throw new AppError(403, 'You do not have permission to modify this job.', 'FORBIDDEN_JOB_ACCESS');
        }

        const currentStatus = pool.status;

        // Pooled jobs cannot be started or completed in bulk via this legacy endpoint.
        // Execution must proceed stop-by-stop through the canonical stop-progression API.
        if (status === 'in_progress' || status === 'completed') {
          throw new AppError(
            409,
            `Pooled service execution cannot be updated in bulk via this endpoint. Please use the canonical stop-level progression API (/api/v1/technicians/me/jobs/${id}/stops/:stopId/...) to progress individual stops.`,
            'POOL_STOP_PROGRESSION_REQUIRED'
          );
        }

        if (status === 'cancelled' && pool.automaticDispatch && currentStatus === 'accepted') {
          throw new AppError(409, 'Decline the assignment so dispatch can find a replacement.', 'DECLINE_ASSIGNMENT');
        }
        if (status === 'cancelled') {
          if (!['accepted', 'in_progress'].includes(currentStatus)) {
            throw new AppError(
              409,
              `Cannot cancel job: Current status is "${currentStatus}". Only accepted or in_progress jobs can be cancelled.`,
              'INVALID_STATUS_TRANSITION'
            );
          }
          pool.status = 'cancelled';
          pool.cancelledAt = new Date();
          pool.rejectionReason = String(reason || 'Job cancelled by technician').trim().slice(0, 500);
          await pool.save({ session });

          // Update member bookings (preserve completed and cancelled bookings)
          const activeBookingIds = pool.members.filter((m) => m.status === 'active').map((m) => m.bookingId);
          await Booking.updateMany(
            { _id: { $in: activeBookingIds }, status: { $nin: ['completed', 'cancelled'] } },
            {
              $set: {
                status: 'cancelled',
                cancelledAt: pool.cancelledAt,
                rejectionReason: pool.rejectionReason,
              },
            },
            { session }
          );

          // Centralized availability recalculation
          await recalculateTechnicianAvailability(req.user._id, { session });

          // Notify only customers whose bookings were actually cancelled (not already completed)
          const cancelledMemberBookings = await Booking.find({
            _id: { $in: activeBookingIds },
            status: 'cancelled',
            cancelledAt: pool.cancelledAt,
          }).session(session);

          const cancelledBookingIdSet = new Set(cancelledMemberBookings.map((b) => String(b._id)));
          const notifs = pool.members
            .filter((m) => cancelledBookingIdSet.has(String(m.bookingId)))
            .map((m) => ({
              userId: m.customerId,
              role: 'customer',
              title: 'Service Pool Cancelled',
              message: `Your service pool was cancelled by technician ${req.user.name}. Reason: "${pool.rejectionReason}".`,
              type: 'execution',
              relatedEntityId: m.bookingId,
            }));
          if (notifs.length > 0) {
            await Notification.create(notifs, { session, ordered: true });
          }
        }

        return {
          message: `Job status updated to "${status}".`,
          data: pool,
        };
      }

      // 2. Check Individual Booking
      const booking = await Booking.findById(id).session(session);
      if (booking) {
        if (String(booking.technicianId) !== String(req.user._id)) {
          throw new AppError(403, 'You do not have permission to modify this job.', 'FORBIDDEN_JOB_ACCESS');
        }

        // Pooled member bookings cannot be updated via this standalone legacy endpoint.
        // Stop progression must use the canonical stop-level progression API.
        if (booking.poolId) {
          throw new AppError(
            409,
            `This booking is part of a service pool. Pooled member bookings cannot be updated via the legacy job status endpoint. Please use the canonical stop-level progression API (/api/v1/technicians/me/jobs/${booking.poolId}/stops/${booking._id}/...) to progress this stop.`,
            'POOL_STOP_PROGRESSION_REQUIRED'
          );
        }

        const currentStatus = booking.status;

        if (status === 'in_progress') {
          if (!['accepted', 'arrived'].includes(currentStatus)) {
            throw new AppError(
              409,
              `Cannot start job: Current status is "${currentStatus}". Must be "accepted" or "arrived" before starting.`,
              'INVALID_STATUS_TRANSITION'
            );
          }
          booking.status = 'in_progress';
          booking.startedAt = new Date();
          await booking.save({ session });

          await recalculateTechnicianAvailability(req.user._id, { session });

          await Notification.create(
            [
              {
                userId: booking.customerId,
                role: 'customer',
                title: 'Service In Progress',
                message: `Technician ${req.user.name} has started work on your service.`,
                type: 'execution',
                relatedEntityId: booking._id,
              },
            ],
            { session, ordered: true }
          );
        } else if (status === 'completed') {
          if (currentStatus !== 'in_progress') {
            throw new AppError(
              409,
              `A job cannot be marked completed before it has started (current status: "${currentStatus}").`,
              'INVALID_STATUS_TRANSITION'
            );
          }
          booking.status = 'completed';
          booking.completedAt = new Date();
          await booking.save({ session });

          await TechnicianProfile.findOneAndUpdate(
            { userId: req.user._id },
            { $inc: { jobsCompleted: 1 } },
            { session }
          );
          await recalculateTechnicianAvailability(req.user._id, { session });

          await Notification.create(
            [
              {
                userId: booking.customerId,
                role: 'customer',
                title: 'Service Completed',
                message: `Your service has been completed by ${req.user.name}.`,
                type: 'execution',
                relatedEntityId: booking._id,
              },
            ],
            { session, ordered: true }
          );
        } else if (status === 'cancelled') {
          if (!['accepted', 'arrived', 'in_progress'].includes(currentStatus)) {
            throw new AppError(
              409,
              `Cannot cancel job: Current status is "${currentStatus}". Only accepted, arrived, or in_progress jobs can be cancelled.`,
              'INVALID_STATUS_TRANSITION'
            );
          }
          booking.status = 'cancelled';
          booking.cancelledAt = new Date();
          booking.rejectionReason = String(reason || 'Job cancelled by technician').trim().slice(0, 500);
          await booking.save({ session });

          await recalculateTechnicianAvailability(req.user._id, { session });

          await Notification.create(
            [
              {
                userId: booking.customerId,
                role: 'customer',
                title: 'Booking Cancelled',
                message: `Your service booking was cancelled by technician ${req.user.name}. Reason: "${booking.rejectionReason}".`,
                type: 'execution',
                relatedEntityId: booking._id,
              },
            ],
            { session, ordered: true }
          );
        }

        return {
          message: `Job status updated to "${status}".`,
          data: booking,
        };
      }

      throw new AppError(404, 'Assigned job not found.', 'JOB_NOT_FOUND');
    },
    { requireTransaction: true }
  );

  return sendSuccess(res, updatedJob);
});

/**
 * Retrieves the optimized road route for an assigned pooled job.
 */
export const getOptimizedRouteForJob = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(400, 'Invalid job ID format.', 'INVALID_ID');
  }

  // Check if job exists and belongs to someone else -> throw 403 FORBIDDEN_JOB_ACCESS
  const [existingPool, existingBooking] = await Promise.all([
    ServicePool.findById(id, 'assignedTechnicianId'),
    Booking.findById(id, 'technicianId'),
  ]);

  if (existingPool && String(existingPool.assignedTechnicianId) !== String(req.user._id)) {
    throw new AppError(403, 'You do not have permission to view this job route.', 'FORBIDDEN_JOB_ACCESS');
  }
  if (existingBooking && String(existingBooking.technicianId) !== String(req.user._id)) {
    throw new AppError(403, 'You do not have permission to view this job route.', 'FORBIDDEN_JOB_ACCESS');
  }

  let overrideLocation = null;
  if (req.query.lat && req.query.lng) {
    overrideLocation = parseGeoInput({ lat: req.query.lat, lng: req.query.lng });
  }

  const route = await getTechnicianJobRoute(req.user._id, id, { overrideLocation, replan: req.method === 'POST' });
  return sendSuccess(res, { data: route });
});
