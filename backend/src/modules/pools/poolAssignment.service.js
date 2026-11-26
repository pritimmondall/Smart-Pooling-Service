import { planVisitSchedule, applyVisitSchedule } from '../routing/visitSchedule.service.js';
import mongoose from 'mongoose';
import {
  ServiceCategory,
  ServicePool,
  Booking,
  TechnicianProfile,
  User,
  Notification,
} from '../../models/index.js';
import { runInTransaction } from '../../config/db.js';
import { haversineDistanceKm } from '../../utils/geo.js';
import { AppError } from '../../utils/appError.js';
import { recalculateTechnicianAvailability } from '../technicians/technicianAvailability.service.js';

/**
 * Checks whether two time windows strictly overlap.
 */
export function doTimeWindowsOverlap(windowA, windowB) {
  if (!windowA?.start || !windowA?.end || !windowB?.start || !windowB?.end) return false;
  const startA = new Date(windowA.start).getTime();
  const endA = new Date(windowA.end).getTime();
  const startB = new Date(windowB.start).getTime();
  const endB = new Date(windowB.end).getTime();

  return Math.max(startA, startB) < Math.min(endA, endB);
}

export function withinServiceHours(window, hours) {
  if (!hours) return false;
  // Technician working schedules are local wall-clock times in the Indian service area.
  const local = value => new Date(new Date(value).getTime() + 330 * 60000);
  const start = local(window.start);
  const end = local(window.end);
  const minutes = date => date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const clock = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  return start.toISOString().slice(0, 10) === end.toISOString().slice(0, 10) &&
    hours.daysOfWeek.includes(start.getUTCDay()) && minutes(start) >= clock(hours.start) && minutes(end) <= clock(hours.end);
}

/**
 * Evaluates technician eligibility for a locked service pool.
 *
 * Checks:
 * 1. User is active (user.isActive === true)
 * 2. Technician profile is approved (approvalStatus === 'approved')
 * 3. Technician availability status (availabilityStatus === 'available')
 * 4. Required skill / category (serviceCategories contains pool.serviceCategoryId)
 * 5. Travel distance for display and ranking
 * 6. Workload & capacity (active assigned/accepted/in_progress count < maxPoolCapacity)
 * 7. Scheduling conflicts (no overlapping active pools or individual bookings)
 *
 * @param {Object} profile - TechnicianProfile document (populated with userId)
 * @param {Object} pool - ServicePool document
 * @param {Object} [options]
 * @param {mongoose.ClientSession} [options.session]
 * @returns {Promise<{ isEligible: boolean, reasons: string[], distanceKm: number, currentWorkload: number }>}
 */
export async function evaluateTechnicianEligibility(profile, pool, { session = null, now = new Date() } = {}) {
  const reasons = [];
  let user = profile.userId || {};

  // 1. User active check (handle unpopulated profile.userId gracefully)
  let isUserActive = user.isActive;
  if (isUserActive === undefined && (profile.userId?._id || mongoose.isValidObjectId(profile.userId))) {
    const fetchedUser = await User.findById(profile.userId?._id || profile.userId, 'isActive').session(session);
    isUserActive = fetchedUser?.isActive ?? false;
  }

  if (!isUserActive) {
    reasons.push('Technician user account is inactive.');
  }

  // 2. Approval status
  if (profile.approvalStatus !== 'approved') {
    reasons.push(`Technician profile is not approved (current approval: "${profile.approvalStatus}").`);
  }

  // 3. Availability status
  if (profile.availabilityStatus !== 'available') {
    reasons.push(`Technician is not available (current status: "${profile.availabilityStatus}").`);
  }

  // 4. Service category / skills match
  const profileCatIds = (profile.serviceCategories || []).map((c) => String(c._id || c));
  const poolCatId = String(pool.serviceCategoryId?._id || pool.serviceCategoryId);
  if (!profileCatIds.includes(poolCatId)) {
    reasons.push('Technician does not possess the required service category skill.');
  }

  const distanceKm = profile.baseLocation && pool.centroidLocation
    ? haversineDistanceKm(profile.baseLocation, pool.centroidLocation)
    : Infinity;

  const radius = profile.serviceRadiusKm ?? 10;
  if (distanceKm > radius || (pool.members || []).some(member => member.status === 'active' && member.location &&
      haversineDistanceKm(profile.baseLocation, member.location) > radius)) {
    reasons.push(`Pool is outside your ${radius} km service radius.`);
  }

  // 6. Workload & Capacity check
  const activeStatusFilter = { $in: ['assigned', 'accepted', 'arrived', 'in_progress'] };

  const [activePoolsCount, activeBookingsCount] = await Promise.all([
    ServicePool.countDocuments({
      _id: { $ne: pool._id },
      $or: [
        { assignedTechnicianId: user._id || profile.userId, status: activeStatusFilter },
        { reservedTechnicianId: user._id || profile.userId, status: 'forming' },
      ],
    }, { session }),
    Booking.countDocuments(
      {
        technicianId: user._id || profile.userId,
        status: activeStatusFilter,
        poolId: null, // Only count standalone bookings
      },
      { session }
    ),
  ]);

  const currentWorkload = activePoolsCount + activeBookingsCount;
  const capacityLimit = profile.maxPoolCapacity || 4;

  if (currentWorkload >= capacityLimit) {
    reasons.push(
      `Technician workload capacity reached (${currentWorkload}/${capacityLimit} active assignments).`
    );
  }

  // 7. Scheduling conflicts check
  const targetWindow = pool.aggregateTimeWindow;
  if (!pool.automaticDispatch && targetWindow?.start && targetWindow?.end) {
    // Check assigned pools
    const activeAssignedPools = await ServicePool.find(
      {
        _id: { $ne: pool._id },
        $or: [
          { assignedTechnicianId: user._id || profile.userId, status: activeStatusFilter },
          { reservedTechnicianId: user._id || profile.userId, status: 'forming' },
        ],
      },
      'aggregateTimeWindow',
      { session }
    ).lean();

    for (const p of activeAssignedPools) {
      if (doTimeWindowsOverlap(targetWindow, p.aggregateTimeWindow)) {
        reasons.push(
          `Scheduling conflict with active pool ${p._id} (${new Date(p.aggregateTimeWindow.start).toISOString()} - ${new Date(p.aggregateTimeWindow.end).toISOString()}).`
        );
        break;
      }
    }

    // Check assigned individual bookings
    const activeAssignedBookings = await Booking.find(
      {
        technicianId: user._id || profile.userId,
        status: activeStatusFilter,
        poolId: null,
      },
      'timeWindow',
      { session }
    ).lean();

    for (const b of activeAssignedBookings) {
      if (doTimeWindowsOverlap(targetWindow, b.timeWindow)) {
        reasons.push(
          `Scheduling conflict with individual booking ${b._id} (${new Date(b.timeWindow.start).toISOString()} - ${new Date(b.timeWindow.end).toISOString()}).`
        );
        break;
      }
    }
  }

  // 8. Rejection history check
  const technicianUserId = String(user._id || profile.userId?._id || profile.userId || '');
  const rejectedUserIds = (pool?.rejectedTechnicians || []).map((t) => String(t?._id || t));
  if (technicianUserId && rejectedUserIds.includes(technicianUserId)) {
    reasons.push('Technician previously rejected this service pool.');
  }

  let plan;
  if (pool.automaticDispatch && !reasons.length) {
    const category = await ServiceCategory.findById(poolCatId).session(session);
    plan = category && await planVisitSchedule(pool, { profile, category, session, now });
    if (!plan) reasons.push('No verified route fits the service windows and existing appointments.');
  }

  return {
    plan, isEligible: reasons.length === 0,
    reasons,
    distanceKm: Number.isFinite(distanceKm) ? (pool.automaticDispatch ? distanceKm : Number(distanceKm.toFixed(2))) : 0,
    currentWorkload,
  };
}

/**
 * Finds all eligible technicians for a locked service pool, ranked by proximity and rating.
 *
 * @param {string|mongoose.Types.ObjectId} poolId
 * @returns {Promise<Array<Object>>}
 */
export async function findEligibleTechniciansForPool(poolId, { now = new Date() } = {}) {
  const pool = await ServicePool.findById(poolId)
    .populate('serviceCategoryId', 'name slug baseIndividualPrice')
    .populate('zoneId', 'name code city');

  if (!pool) {
    throw new AppError(404, 'Service pool not found.', 'POOL_NOT_FOUND');
  }

  const rejectedUserIds = (pool.rejectedTechnicians || []).map((t) => t?._id || t);

  // Fetch approved technicians with active user accounts, excluding technicians who previously rejected this pool
  const query = {
    approvalStatus: 'approved',
    availabilityStatus: 'available',
  };
  if (rejectedUserIds.length > 0) {
    query.userId = { $nin: rejectedUserIds };
  }

  const profiles = await TechnicianProfile.find(query)
    .populate('userId', 'name email phone isActive')
    .populate('serviceCategories', 'name slug')
    .populate('zoneId', 'name code city');

  const candidates = [];

  for (const profile of profiles) {
    const evaluation = await evaluateTechnicianEligibility(profile, pool, { now });
    candidates.push({
      technicianId: profile.userId?._id,
      name: profile.userId?.name,
      email: profile.userId?.email,
      phone: profile.userId?.phone,
      extraTravelMs: evaluation.plan?.extraTravel,
      profileId: profile._id,
      ratingAvg: profile.ratingAvg,
      jobsCompleted: profile.jobsCompleted,
      isEligible: evaluation.isEligible,
      ineligibilityReasons: evaluation.reasons,
      distanceKm: evaluation.distanceKm,
      currentWorkload: evaluation.currentWorkload,
      maxPoolCapacity: profile.maxPoolCapacity,
    });
  }

  // Sort eligible candidates first, then closest distance, then highest rating
  candidates.sort((a, b) => {
    if (a.isEligible !== b.isEligible) {
      return a.isEligible ? -1 : 1;
    }
    if (pool.automaticDispatch && a.isEligible && a.extraTravelMs !== b.extraTravelMs) return a.extraTravelMs - b.extraTravelMs;
    if (a.distanceKm !== b.distanceKm) {
      return a.distanceKm - b.distanceKm;
    }
    return (b.ratingAvg || 0) - (a.ratingAvg || 0);
  });

  return {
    poolId: pool._id,
    serviceCategory: pool.serviceCategoryId,
    aggregateTimeWindow: pool.aggregateTimeWindow,
    centroidLocation: pool.centroidLocation,
    eligibleCount: candidates.filter((c) => c.isEligible).length,
    eligibleTechnicians: candidates.filter((c) => c.isEligible),
    candidates,
  };
}

/**
 * Evaluates technician eligibility for an individual booking.
 */
export async function evaluateBookingEligibility(profile, booking, { session = null } = {}) {
  const reasons = [];
  const user = profile.userId || {};

  if ((booking.rejectedTechnicians || []).some(id => String(id) === String(user._id || user))) {
    reasons.push('Technician previously rejected this booking.');
  }

  // 1. User active check
  if (!user.isActive) {
    reasons.push('Technician user account is inactive.');
  }

  // 2. Approval status
  if (profile.approvalStatus !== 'approved') {
    reasons.push(`Technician profile is not approved (current approval: "${profile.approvalStatus}").`);
  }

  // 3. Availability status
  if (profile.availabilityStatus !== 'available') {
    reasons.push(`Technician is not available (current status: "${profile.availabilityStatus}").`);
  }

  // 4. Service category / skills match
  const profileCatIds = (profile.serviceCategories || []).map((c) => String(c._id || c));
  const bookingCatId = String(booking.serviceCategoryId?._id || booking.serviceCategoryId);
  if (!profileCatIds.includes(bookingCatId)) {
    reasons.push('Technician does not possess the required service category skill.');
  }

  // 5. Geographic coverage
  let distanceKm = Infinity;
  let hasGeoCoverage = false;

  if (profile.zoneId && booking.zoneId && String(profile.zoneId._id || profile.zoneId) === String(booking.zoneId._id || booking.zoneId)) {
    hasGeoCoverage = true;
  }

  if (profile.baseLocation && booking.location) {
    distanceKm = haversineDistanceKm(profile.baseLocation, booking.location);
    const radius = profile.serviceRadiusKm || 10;
    if (distanceKm <= radius) {
      hasGeoCoverage = true;
    }
  }

  if (!hasGeoCoverage || distanceKm > profile.serviceRadiusKm) {
    reasons.push(
      `Booking location is outside technician's coverage area (${distanceKm.toFixed(1)} km > ${profile.serviceRadiusKm} km radius).`
    );
  }

  // 6. Workload & Capacity check
  const activeStatusFilter = { $in: ['assigned', 'accepted', 'arrived', 'in_progress'] };

  const [activePoolsCount, activeBookingsCount] = await Promise.all([
    ServicePool.countDocuments(
      {
        assignedTechnicianId: user._id || profile.userId,
        status: activeStatusFilter,
      },
      { session }
    ),
    Booking.countDocuments(
      {
        technicianId: user._id || profile.userId,
        status: activeStatusFilter,
        poolId: null,
      },
      { session }
    ),
  ]);

  const currentWorkload = activePoolsCount + activeBookingsCount;
  const capacityLimit = profile.maxPoolCapacity || 4;

  if (currentWorkload >= capacityLimit) {
    reasons.push(
      `Technician workload capacity reached (${currentWorkload}/${capacityLimit} active assignments).`
    );
  }

  // 7. Scheduling conflicts check
  const targetWindow = booking.timeWindow;
  if (targetWindow?.start && targetWindow?.end) {
    const activeAssignedPools = await ServicePool.find(
      {
        assignedTechnicianId: user._id || profile.userId,
        status: activeStatusFilter,
      },
      'aggregateTimeWindow',
      { session }
    ).lean();

    for (const p of activeAssignedPools) {
      if (doTimeWindowsOverlap(targetWindow, p.aggregateTimeWindow)) {
        reasons.push(
          `Scheduling conflict with active pool ${p._id} (${new Date(p.aggregateTimeWindow.start).toISOString()} - ${new Date(p.aggregateTimeWindow.end).toISOString()}).`
        );
        break;
      }
    }

    const activeAssignedBookings = await Booking.find(
      {
        technicianId: user._id || profile.userId,
        status: activeStatusFilter,
        poolId: null,
        _id: { $ne: booking._id },
      },
      'timeWindow',
      { session }
    ).lean();

    for (const b of activeAssignedBookings) {
      if (doTimeWindowsOverlap(targetWindow, b.timeWindow)) {
        reasons.push(
          `Scheduling conflict with individual booking ${b._id} (${new Date(b.timeWindow.start).toISOString()} - ${new Date(b.timeWindow.end).toISOString()}).`
        );
        break;
      }
    }
  }

  return {
    isEligible: reasons.length === 0,
    reasons,
    distanceKm: Number.isFinite(distanceKm) ? Number(distanceKm.toFixed(2)) : 0,
    currentWorkload,
  };
}

/**
 * Finds all eligible technicians for an individual booking, ranked by proximity and rating.
 *
 * @param {string|mongoose.Types.ObjectId} bookingId
 * @returns {Promise<Object>}
 */
export async function findEligibleTechniciansForBooking(bookingId) {
  const booking = await Booking.findById(bookingId)
    .populate('serviceCategoryId', 'name slug baseIndividualPrice estimatedDurationMins')
    .populate('zoneId', 'name code city');

  if (!booking) {
    throw new AppError(404, 'Booking not found.', 'BOOKING_NOT_FOUND');
  }

  if (booking.poolId) {
    throw new AppError(409, 'This booking is part of a service pool. Retrieve eligible technicians for the pool instead.', 'BOOKING_IN_POOL');
  }

  const profiles = await TechnicianProfile.find({
    approvalStatus: 'approved',
    availabilityStatus: 'available',
  })
    .populate('userId', 'name email phone isActive')
    .populate('serviceCategories', 'name slug')
    .populate('zoneId', 'name code city');

  const candidates = [];

  for (const profile of profiles) {
    const evaluation = await evaluateBookingEligibility(profile, booking);
    candidates.push({
      technicianId: profile.userId?._id,
      name: profile.userId?.name,
      email: profile.userId?.email,
      phone: profile.userId?.phone,
      profileId: profile._id,
      ratingAvg: profile.ratingAvg,
      jobsCompleted: profile.jobsCompleted,
      isEligible: evaluation.isEligible,
      ineligibilityReasons: evaluation.reasons,
      distanceKm: evaluation.distanceKm,
      currentWorkload: evaluation.currentWorkload,
      maxPoolCapacity: profile.maxPoolCapacity,
    });
  }

  candidates.sort((a, b) => {
    if (a.isEligible !== b.isEligible) {
      return a.isEligible ? -1 : 1;
    }
    if (a.distanceKm !== b.distanceKm) {
      return a.distanceKm - b.distanceKm;
    }
    return (b.ratingAvg || 0) - (a.ratingAvg || 0);
  });

  return {
    bookingId: booking._id,
    serviceCategory: booking.serviceCategoryId,
    timeWindow: booking.timeWindow,
    location: booking.location,
    addressText: booking.addressText,
    eligibleCount: candidates.filter((c) => c.isEligible).length,
    eligibleTechnicians: candidates.filter((c) => c.isEligible),
    candidates,
  };
}

/**
 * Reserves a forming pool for a technician while customers can still join it.
 */
export async function reserveFormingPoolForTechnician(poolId, technicianUserId) {
  if (!mongoose.isValidObjectId(poolId) || !mongoose.isValidObjectId(technicianUserId)) {
    throw new AppError(400, 'Invalid pool or technician ID.', 'INVALID_ID');
  }
  return runInTransaction(async session => {
    const pool = await ServicePool.findById(poolId).session(session);
    if (!pool || pool.status !== 'forming' || pool.lockCutoffTime <= new Date() || pool.aggregateTimeWindow.end <= new Date()) {
      throw new AppError(409, 'This pool is no longer open for reservation.', 'POOL_UNAVAILABLE');
    }
    if (String(pool.reservedTechnicianId || '') === String(technicianUserId)) return pool;
    if (pool.reservedTechnicianId) throw new AppError(409, 'Another technician reserved this pool.', 'POOL_ALREADY_RESERVED');

    const profile = await TechnicianProfile.findOneAndUpdate(
      { userId: technicianUserId }, { $inc: { version: 1 } }, { session, new: true }
    ).populate('userId', 'name email phone isActive');
    if (!profile) throw new AppError(404, 'Technician profile not found.', 'TECH_PROFILE_NOT_FOUND');
    const evaluation = await evaluateTechnicianEligibility(profile, pool, { session });
    if (!evaluation.isEligible) {
      throw new AppError(409, `Technician is not eligible for this pool: ${evaluation.reasons.join(' ')}`,
        'TECHNICIAN_NOT_ELIGIBLE', evaluation.reasons);
    }
    const reserved = await ServicePool.findOneAndUpdate({
      _id: poolId, status: 'forming', reservedTechnicianId: null, lockCutoffTime: { $gt: new Date() },
    }, { $set: { reservedTechnicianId: technicianUserId, reservedAt: new Date() }, $inc: { version: 1 } },
    { new: true, session });
    if (!reserved) throw new AppError(409, 'Another technician reserved this pool first.', 'POOL_ALREADY_RESERVED');
    await Notification.create([{ userId: technicianUserId, role: 'technician', type: 'dispatch',
      title: 'Pool Reserved', message: 'You reserved this pool. Customers can join until it fills or the joining window closes.',
      relatedEntityId: pool._id }], { session });
    return reserved;
  }, { requireTransaction: true });
}

/**
 * Assigns a locked service pool to an eligible technician with atomic concurrency protection.
 *
 * Prevents:
 * - Assigning non-locked pools
 * - Assigning already assigned pools
 * - Assigning to ineligible / unapproved / unavailable technicians
 * - Assigning with scheduling conflicts
 * - Race condition duplicate assignments
 *
 * @param {string|mongoose.Types.ObjectId} poolId
 * @param {string|mongoose.Types.ObjectId} technicianUserId
 * @returns {Promise<Object>}
 */
export async function assignPoolToTechnician(poolId, technicianUserId, { requireOpen = false, now = new Date() } = {}) {
  if (!mongoose.isValidObjectId(poolId)) {
    throw new AppError(400, 'Invalid pool ID format.', 'INVALID_ID');
  }
  if (!mongoose.isValidObjectId(technicianUserId)) {
    throw new AppError(400, 'Invalid technician ID format.', 'INVALID_ID');
  }

  return await runInTransaction(
    async (session) => {
      // 1. Fetch pool
      const pool = await ServicePool.findById(poolId).session(session);
      if (!pool) {
        throw new AppError(404, 'Service pool not found.', 'POOL_NOT_FOUND');
      }

      if (requireOpen && pool.aggregateTimeWindow.end <= now) {
        throw new AppError(409, 'This service window has ended.', 'JOB_EXPIRED');
      }
      if (pool.status !== 'locked' && !(pool.automaticDispatch && pool.status === 'forming')) {
        throw new AppError(
          409,
          `Pool cannot be assigned: status is "${pool.status}" (must be "locked").`,
          'INVALID_POOL_STATUS'
        );
      }

      if (pool.assignedTechnicianId) {
        throw new AppError(409, 'This service pool is already assigned to a technician.', 'POOL_ALREADY_ASSIGNED');
      }
      if (pool.reservedTechnicianId && String(pool.reservedTechnicianId) !== String(technicianUserId)) {
        throw new AppError(409, 'This pool is reserved by another technician.', 'POOL_ALREADY_RESERVED');
      }

      // 2. Technician-level concurrency reservation: atomically increment version on TechnicianProfile.
      // This serializes concurrent assignments for the same technician across different pools/bookings.
      const lockedProfile = await TechnicianProfile.findOneAndUpdate(
        { userId: technicianUserId },
        { $inc: { version: 1 } },
        { session, new: true }
      ).populate('userId', 'name email phone isActive');

      if (!lockedProfile) {
        throw new AppError(404, 'Technician profile not found.', 'TECH_PROFILE_NOT_FOUND');
      }

      // 3. Re-evaluate eligibility, availability, workload, and scheduling conflicts under technician write lock
      const evaluation = await evaluateTechnicianEligibility(lockedProfile, pool, { session, now });
      if (!evaluation.isEligible) {
        throw new AppError(
          409,
          `Technician is not eligible for this pool: ${evaluation.reasons.join(' ')}`,
          'TECHNICIAN_NOT_ELIGIBLE',
          evaluation.reasons
        );
      }

      // 4. Atomic conditional assignment update
      // Concurrency protection: guarantees only ONE caller can assign the pool even under concurrent requests
      const assignedPool = await ServicePool.findOneAndUpdate(
        {
          _id: pool._id,
          status: pool.status,
          assignedTechnicianId: null,
          reservedTechnicianId: { $in: [null, technicianUserId] },
        },
        {
          $set: {
            status: 'assigned',
            assignedTechnicianId: lockedProfile.userId._id,
            assignedAt: now,
            reservedTechnicianId: null,
            reservedAt: null,
          },
          $inc: { version: 1 },
        },
        { new: true, session }
      );

      if (!assignedPool) {
        throw new AppError(
          409,
          'Assignment collision: Pool was assigned by another concurrent request.',
          'CONCURRENT_ASSIGNMENT_CONFLICT'
        );
      }

      // 5. Synchronize member bookings
      const activeMemberBookingIds = assignedPool.members
        .filter((m) => m.status === 'active')
        .map((m) => m.bookingId);

      await Booking.updateMany(
        { _id: { $in: activeMemberBookingIds } },
        {
          $set: {
            status: 'assigned',
            technicianId: lockedProfile.userId._id,
            assignedAt: now,
          },
        },
        { session, ordered: true }
      );

      if (evaluation.plan) {
        await applyVisitSchedule(assignedPool, evaluation.plan, session);
        assignedPool.acceptingVisits = activeMemberBookingIds.length < assignedPool.maxCapacity;
        await assignedPool.save({ session });
      }
      // 6. Recalculate technician availability and active workload
      await recalculateTechnicianAvailability(lockedProfile.userId._id, { session });

      // 7. Dispatch notifications
      // Notification to technician
      await Notification.create(
        [
          {
            userId: lockedProfile.userId._id,
            role: 'technician',
            title: 'New Pooled Job Assigned',
            message: `You have been assigned to service pool with ${activeMemberBookingIds.length} stops.`,
            type: 'dispatch',
            relatedEntityId: assignedPool._id,
          },
        ],
        { session, ordered: true }
      );

      // Notifications to customers
      const customerNotifs = assignedPool.members
        .filter((m) => m.status === 'active')
        .map((m) => ({
          userId: m.customerId,
          role: 'customer',
          title: 'Technician Assigned',
          message: `Technician ${lockedProfile.userId.name} has been assigned to your service pool.`,
          type: 'booking',
          relatedEntityId: m.bookingId,
        }));

      if (customerNotifs.length > 0) {
        await Notification.create(customerNotifs, { session, ordered: true });
      }

      return assignedPool;
    },
    { requireTransaction: true }
  );
}

/**
 * Assigns an individual booking to an eligible technician with atomic concurrency protection.
 *
 * @param {string|mongoose.Types.ObjectId} bookingId
 * @param {string|mongoose.Types.ObjectId} technicianUserId
 * @returns {Promise<Object>}
 */
export async function assignBookingToTechnician(bookingId, technicianUserId, { requireOpen = false } = {}) {
  if (!mongoose.isValidObjectId(bookingId)) {
    throw new AppError(400, 'Invalid booking ID format.', 'INVALID_ID');
  }
  if (!mongoose.isValidObjectId(technicianUserId)) {
    throw new AppError(400, 'Invalid technician ID format.', 'INVALID_ID');
  }

  return await runInTransaction(
    async (session) => {
      const booking = await Booking.findById(bookingId).session(session);
      if (!booking) {
        throw new AppError(404, 'Booking not found.', 'BOOKING_NOT_FOUND');
      }

      if (booking.poolId) {
        throw new AppError(
          409,
          'This booking is part of a service pool. Assign the pool instead.',
          'BOOKING_IN_POOL'
        );
      }

      if (requireOpen && booking.timeWindow.end <= new Date()) {
        throw new AppError(409, 'This service window has ended.', 'JOB_EXPIRED');
      }
      if (booking.status !== 'pending' && booking.status !== 'confirmed') {
        throw new AppError(
          409,
          `Booking cannot be assigned: status is "${booking.status}".`,
          'INVALID_BOOKING_STATUS'
        );
      }

      if (booking.technicianId) {
        throw new AppError(409, 'This booking is already assigned to a technician.', 'BOOKING_ALREADY_ASSIGNED');
      }

      // 1. Technician-level concurrency reservation: atomically increment version
      const lockedProfile = await TechnicianProfile.findOneAndUpdate(
        { userId: technicianUserId },
        { $inc: { version: 1 } },
        { session, new: true }
      ).populate('userId', 'name email phone isActive');

      if (!lockedProfile) {
        throw new AppError(404, 'Technician profile not found.', 'TECH_PROFILE_NOT_FOUND');
      }

      // 2. Re-evaluate eligibility, availability, workload, and schedule conflicts under technician lock
      const evaluation = await evaluateBookingEligibility(lockedProfile, booking, { session });
      if (!evaluation.isEligible) {
        throw new AppError(
          409,
          `Technician is not eligible for this booking: ${evaluation.reasons.join(' ')}`,
          'TECHNICIAN_NOT_ELIGIBLE',
          evaluation.reasons
        );
      }

      // 3. Atomically assign booking
      const assignedBooking = await Booking.findOneAndUpdate(
        {
          _id: booking._id,
          technicianId: null,
          status: { $in: ['pending', 'confirmed'] },
        },
        {
          $set: {
            status: 'assigned',
            technicianId: lockedProfile.userId._id,
            assignedAt: new Date(),
          },
        },
        { new: true, session }
      );

      if (!assignedBooking) {
        throw new AppError(409, 'Booking assignment conflict.', 'CONCURRENT_ASSIGNMENT_CONFLICT');
      }

      // 4. Recalculate technician availability and active workload
      await recalculateTechnicianAvailability(lockedProfile.userId._id, { session });

      // 5. Dispatch notifications
      await Notification.create(
        [
          {
            userId: lockedProfile.userId._id,
            role: 'technician',
            title: 'New Individual Job Assigned',
            message: `You have been assigned an individual service booking (${booking.addressText}).`,
            type: 'dispatch',
            relatedEntityId: assignedBooking._id,
          },
          {
            userId: booking.customerId,
            role: 'customer',
            title: 'Technician Assigned',
            message: `Technician ${lockedProfile.userId.name} has been assigned to your booking.`,
            type: 'booking',
            relatedEntityId: assignedBooking._id,
          },
        ],
        { session, ordered: true }
      );

      return assignedBooking;
    },
    { requireTransaction: true }
  );
}
