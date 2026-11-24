import { notifyTechniciansOfNewPool } from './formingPoolAlerts.service.js';
import {
  Booking,
  ServiceCategory,
  ServicePool,
  PoolMembership,
  PoolClusterLock,
  User,
  Notification,
} from '../../models/index.js';
import { runInTransaction } from '../../config/db.js';
import { haversineDistanceKm, toGeoJSONPoint } from '../../utils/geo.js';
import { calculatePoolPricing } from './pricing.service.js';
import { AppError } from '../../utils/appError.js';

import { poolScopes } from './poolOptions.js';

const POOL_RADIUS_KM = 0.2;
const EARTH_RADIUS_KM = 6371;

function effectiveCutoff(ownerCutoff, start, leadTimeMs) {
  return ownerCutoff ? new Date(Math.min(ownerCutoff.getTime(), start.getTime())) : new Date(start.getTime() - leadTimeMs);
}

/**
 * Computes geographic centroid ([longitude, latitude]) of an array of GeoJSON Points.
 */
export function computeCentroid(points) {
  if (!Array.isArray(points) || points.length === 0) {
    throw new Error('At least one GeoJSON point is required to compute centroid.');
  }

  let totalLng = 0;
  let totalLat = 0;

  for (const pt of points) {
    const coords = pt.coordinates || pt;
    totalLng += coords[0];
    totalLat += coords[1];
  }

  return toGeoJSONPoint(totalLat / points.length, totalLng / points.length);
}

/**
 * Computes the strict intersection of two time windows.
 * Returns { start, end } if valid (start < end), or null if they do not overlap.
 */
export function computeIntervalIntersection(windowA, windowB) {
  const startA = new Date(windowA.start).getTime();
  const endA = new Date(windowA.end).getTime();
  const startB = new Date(windowB.start).getTime();
  const endB = new Date(windowB.end).getTime();

  const overlapStart = Math.max(startA, startB);
  const overlapEnd = Math.min(endA, endB);

  if (overlapStart >= overlapEnd) {
    return null;
  }

  return {
    start: new Date(overlapStart),
    end: new Date(overlapEnd),
  };
}

/**
 * Deterministic multi-factor scoring function for ranking compatible candidate pools.
 * Weights:
 * - 0.45: Geographic proximity (closer to centroid = higher score)
 * - 0.35: Overlap duration ratio (longer shared intersection = higher score)
 * - 0.20: Capacity fulfillment (fuller pool = faster locking & higher discount)
 */
export function calculateMatchingScore({
  distanceKm,
  poolRadiusKm,
  overlapDurationMs,
  bookingDurationMs,
  currentMembers,
  maxCapacity,
}) {
  const proximityScore = Math.max(0, 1 - distanceKm / Math.max(poolRadiusKm, 0.1));
  const overlapRatio = Math.min(1, overlapDurationMs / Math.max(bookingDurationMs, 1));
  const capacityScore = Math.min(1, currentMembers / Math.max(maxCapacity, 1));

  const totalScore = 0.45 * proximityScore + 0.35 * overlapRatio + 0.20 * capacityScore;
  return Number(totalScore.toFixed(4));
}

/**
 * Generates a deterministic cluster lock key for category and temporal grouping.
 *
 * Serialization Strategy:
 * Rather than partitioning continuous geographic space with an arbitrary discrete grid
 * (which causes the "border problem" where two compatible customers 20 meters apart on
 * opposite sides of a grid boundary receive different lock keys and race to create duplicate pools),
 * initial pool creation is serialized per (serviceCategoryId, dateKey).
 *
 * This mathematically guarantees:
 * 1. Zero duplicate pools for compatible requests, regardless of coordinate borders.
 * 2. When compatible concurrent requests arrive at 0 pools, one creates the pool, and
 *    competing requests retry, discover the newly committed pool via findCompatiblePools(), and join it.
 * 3. Incompatible requests (> poolRadiusKm) retry, discover the existing pool is out of range,
 *    and safely create their own separate pool.
 */
export function getClusterLockKey(booking) {
  const catId = String(booking.serviceCategoryId);
  const dateStr = new Date(booking.timeWindow.start).toISOString().split('T')[0];
  return `${catId}_${dateStr}`;
}

/**
 * Finds all compatible open pools for a new booking request.
 */
export async function findCompatiblePools({
  serviceCategoryId,
  location,
  timeWindow,
  customerId,
  targetPoolId, specificService, buildingKey,
  session = null,
}) {
  const now = new Date();
  const category = await ServiceCategory.findById(serviceCategoryId).session(session);
  if (!category) {
    throw new AppError(404, 'Service category not found.', 'CATEGORY_NOT_FOUND');
  }

  const radiusKm = POOL_RADIUS_KM;
  const radiusInRadians = (targetPoolId ? 1 : radiusKm) / EARTH_RADIUS_KM;
  const bookingDurationMs = new Date(timeWindow.end).getTime() - new Date(timeWindow.start).getTime();

  // Query forming pools whose cutoff has not expired and centroid is within radius
  const query = ServicePool.find({
    ...(targetPoolId ? { _id: targetPoolId } : { poolScope: null }),
    serviceCategoryId: category._id,
    status: 'forming',
    lockCutoffTime: { $gt: now },
    centroidLocation: {
      $geoWithin: {
        $centerSphere: [location.coordinates, radiusInRadians],
      },
    },
  });

  if (session) {
    query.session(session);
  }

  const candidatePools = await query.exec();
  const compatiblePools = [];

  for (const pool of candidatePools) {
    const radiusKm = pool.poolScope ? poolScopes[pool.poolScope].radiusKm : POOL_RADIUS_KM;
    if ((pool.specificService || '') !== (specificService || '')) continue;
    if (pool.poolScope === 'building' && (!buildingKey || buildingKey !== pool.buildingKey)) continue;
    const activeMembers = pool.members.filter((m) => m.status === 'active');

    if (customerId && activeMembers.some(m => String(m.customerId) === String(customerId))) continue;

    // 1. Capacity check
    if (activeMembers.length >= pool.maxCapacity) {
      continue;
    }

    // 2. Time-window strict interval intersection
    const intersection = computeIntervalIntersection(pool.aggregateTimeWindow, timeWindow);
    if (!intersection) {
      continue;
    }

    // Minimum required duration check (pool intersection must comfortably accommodate service duration)
    const overlapDurationMs = intersection.end.getTime() - intersection.start.getTime();
    const minRequiredMs = (category.estimatedDurationMins || 30) * 60 * 1000;
    if (overlapDurationMs < minRequiredMs) {
      continue;
    }

    // 3. Pairwise clique proximity: booking must be within radius of every existing member
    let allMembersWithinRadius = true;
    for (const member of activeMembers) {
      const distToMember = haversineDistanceKm(location, member.location);
      if (distToMember > radiusKm) {
        allMembersWithinRadius = false;
        break;
      }
    }
    if (!allMembersWithinRadius) {
      continue;
    }

    // 4. Distance to current pool centroid
    const distToCentroid = haversineDistanceKm(location, pool.centroidLocation);

    // 5. Compute deterministic score
    const score = calculateMatchingScore({
      distanceKm: distToCentroid,
      poolRadiusKm: radiusKm,
      overlapDurationMs,
      bookingDurationMs,
      currentMembers: activeMembers.length,
      maxCapacity: pool.maxCapacity,
    });

    compatiblePools.push({
      pool,
      score,
      distanceKm: distToCentroid,
      newIntersection: intersection,
      activeMembersCount: activeMembers.length,
    });
  }

  // Deterministic sorting: highest score first; break ties by earliest createdAt
  compatiblePools.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return new Date(a.pool.createdAt).getTime() - new Date(b.pool.createdAt).getTime();
  });

  return compatiblePools;
}

// Retry the entire mutation so booking and membership changes commit together.
export async function runBookingTransaction(work, maxRetries = 3) {
  let attempt = 0;
  while (attempt < maxRetries) {
    attempt++;
    try {
      return await runInTransaction(session => work(session, attempt), { requireTransaction: true });
    } catch (err) {
      const isTransient =
        err?.hasErrorLabel?.('TransientTransactionError') ||
        err?.message?.includes('WriteConflict') ||
        err?.code === 112 ||
        err?.codeName === 'WriteConflict' ||
        err?.code === 11000 ||
        err?.codeName === 'DuplicateKey' ||
        err?.message?.includes('E11000');

      if (isTransient && attempt < maxRetries) {
        // Exponential backoff with jitter (20ms to 80ms)
        const delayMs = Math.min(250, 25 * Math.pow(2, attempt) + Math.floor(Math.random() * 25));
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
}

export async function matchAndAssignBooking(bookingId, options = {}) {
  if (options.session) return matchInSession(bookingId, options.session, options, 1);
  return runBookingTransaction(
    (session, attempt) => matchInSession(bookingId, session, options, attempt),
    options.maxRetries
  );
}

async function matchInSession(bookingId, session, { targetPoolId, injectFailureAt, injectTransientConflictAttempts = 0 }, attempt) {
  if (attempt <= injectTransientConflictAttempts) {
    const conflictErr = new Error('WriteConflict error: simulated transient conflict');
    conflictErr.code = 112;
    conflictErr.codeName = 'WriteConflict';
    conflictErr.errorLabels = ['TransientTransactionError'];
    conflictErr.hasErrorLabel = (lbl) => lbl === 'TransientTransactionError';
    throw conflictErr;
  }

  const booking = await Booking.findById(bookingId).session(session);
  if (!booking) {
    throw new AppError(404, 'Booking not found.', 'BOOKING_NOT_FOUND');
  }

  // Only pool-mode pending bookings with no existing pool qualify
  if (booking.bookingMode !== 'pool') {
    return { booking, pool: null, mode: 'individual' };
  }
  if (booking.status !== 'pending') {
    throw new AppError(400, 'Only pending bookings can join a pool.', 'INVALID_STATUS');
  }

  // Check if already in an active pool
  const existingMembership = await PoolMembership.findOne({
    bookingId: booking._id,
    status: 'active',
  }).session(session);

  if (existingMembership) {
    const pool = await ServicePool.findById(existingMembership.poolId).session(session);
    return { booking, pool, mode: 'existing' };
  }

  const category = await ServiceCategory.findById(booking.serviceCategoryId).session(session);
  if (!category) {
    throw new AppError(404, 'Service category not found.', 'CATEGORY_NOT_FOUND');
  }

  // Search for candidate pools
  const candidates = booking.poolScope && !targetPoolId ? [] : await findCompatiblePools({
    serviceCategoryId: booking.serviceCategoryId,
    location: booking.location,
    customerId: booking.customerId,
    specificService: booking.specificService, buildingKey: booking.buildingKey, targetPoolId,
    timeWindow: booking.timeWindow,
    session,
  });

  let joinedPool = null;

  // Try joining compatible candidates in deterministic order
  for (const candidate of candidates) {
    if (targetPoolId && String(candidate.pool._id) !== String(targetPoolId)) continue;

    // Atomic conditional update to guard against race condition overbooking
    const updatedPool = await ServicePool.findOneAndUpdate(
      {
        _id: candidate.pool._id,
        status: 'forming',
        lockCutoffTime: { $gt: new Date() },
        $expr: {
          $lt: [
            {
              $size: {
                $filter: {
                  input: '$members',
                  as: 'm',
                  cond: { $eq: ['$$m.status', 'active'] },
                },
              },
            },
            '$maxCapacity',
          ],
        },
      },
      {
        $push: {
          members: {
            bookingId: booking._id,
            customerId: booking.customerId,
            location: booking.location,
            addressText: booking.addressText,
            joinedAt: new Date(),
            status: 'active',
          },
        },
        $inc: { version: 1 },
      },
      { new: true, session }
    );

    if (updatedPool) {
      joinedPool = updatedPool;
      break;
    }
  }

  if (joinedPool) {
    // Pool was joined! Recalculate centroid, aggregate window, cutoff, and pricing
    const activeMembers = joinedPool.members.filter((m) => m.status === 'active');
    const memberLocations = activeMembers.map((m) => m.location);
    const newCentroid = computeCentroid(memberLocations);

    // Compute aggregate intersection across all active bookings
    const activeBookingIds = activeMembers.map((m) => m.bookingId);
    const activeBookings = await Booking.find({
      _id: { $in: activeBookingIds },
    }).session(session);

    let aggregateStart = new Date(0);
    let aggregateEnd = new Date(8640000000000000);

    for (const b of activeBookings) {
      const bStart = new Date(b.timeWindow.start).getTime();
      const bEnd = new Date(b.timeWindow.end).getTime();
      if (bStart > aggregateStart.getTime()) aggregateStart = new Date(bStart);
      if (bEnd < aggregateEnd.getTime()) aggregateEnd = new Date(bEnd);
    }

    const lockCutoffMs = (category.poolLockCutoffMins || 60) * 60 * 1000;
    const newLockCutoff = effectiveCutoff(joinedPool.ownerLockCutoffTime, aggregateStart, lockCutoffMs);

    if (injectFailureAt === 'during_pricing_recalc') {
      throw new Error('Simulated failure during_pricing_recalc');
    }

    const newPricing = calculatePoolPricing({
      basePrice: category.baseIndividualPrice,
      memberCount: activeMembers.length,
    });

    joinedPool.centroidLocation = newCentroid;
    joinedPool.aggregateTimeWindow = { start: aggregateStart, end: aggregateEnd };
    joinedPool.lockCutoffTime = newLockCutoff;
    joinedPool.pricing = newPricing;

    // Auto-lock if pool reached maximum capacity
    if (activeMembers.length >= joinedPool.maxCapacity) {
      joinedPool.status = 'locked';
    }

    await joinedPool.save({ session });

    if (injectFailureAt === 'after_pool_update') {
      throw new Error('Simulated failure after_pool_update');
    }

    // Record membership enforcing unique partial index
    await PoolMembership.create(
      [
        {
          bookingId: booking._id,
          poolId: joinedPool._id,
          customerId: booking.customerId,
          status: 'active',
          joinedAt: new Date(),
        },
      ],
      { session }
    );

    if (injectFailureAt === 'after_membership_create') {
      throw new Error('Simulated failure after_membership_create');
    }

    // Update current booking reference and price
    booking.poolId = joinedPool._id;
    booking.estimatedPrice = newPricing.finalPricePerMember;
    await booking.save({ session });

    if (injectFailureAt === 'after_booking_update') {
      throw new Error('Simulated failure after_booking_update');
    }

    // Update estimated price for all other active bookings in this pool
    await Booking.updateMany(
      { poolId: joinedPool._id, status: 'pending' },
      { estimatedPrice: newPricing.finalPricePerMember },
      { session }
    );

    if (joinedPool.status === 'locked') {
      joinedPool = await settleClosingLimits(joinedPool, session);
      const current = await Booking.findById(booking._id).session(session);
      if (current.status === 'cancelled') return { booking: current, pool: null, mode: 'cancelled' };
      booking.estimatedPrice = current.estimatedPrice;
    }

    // Create notification for the customer
    await Notification.create(
      [
        {
          userId: booking.customerId,
          role: 'customer',
          title: 'Joined Service Pool',
          message: `Your pool has ${joinedPool.pricing.memberCount} active members. Your price is ₹${booking.estimatedPrice}.`,
          type: 'booking',
          relatedEntityId: booking._id,
        },
      ],
      { session }
    );

    return { booking, pool: joinedPool, mode: 'joined' };
  }

  if (targetPoolId) {
    throw new AppError(409, 'This pool is no longer available for your booking.', 'POOL_UNAVAILABLE');
  }

  // No compatible pool found: Coordinate creation via cluster lock to prevent duplicate pool creation
  const clusterLockKey = getClusterLockKey(booking);
  await PoolClusterLock.findOneAndUpdate(
    { lockKey: clusterLockKey },
    {
      $set: {
        serviceCategoryId: category._id,
        dateKey: new Date(booking.timeWindow.start).toISOString().split('T')[0],
        lastCreatedAt: new Date(),
      },
    },
    { upsert: true, new: true, session }
  );

  const lockCutoffMs = (category.poolLockCutoffMins || 60) * 60 * 1000;
  const initialCutoff = new Date(
    new Date(booking.timeWindow.start).getTime() - lockCutoffMs
  );

  if (injectFailureAt === 'during_pricing_recalc') {
    throw new Error('Simulated failure during_pricing_recalc');
  }

  const initialPricing = calculatePoolPricing({
    basePrice: category.baseIndividualPrice,
    memberCount: 1,
  });

  const [newPool] = await ServicePool.create(
    [
      {
        serviceCategoryId: category._id,
        zoneId: booking.zoneId || null,
        status: 'forming',
        specificService: booking.specificService, poolScope: booking.poolScope, buildingKey: booking.buildingKey,
        maxCapacity: poolScopes[booking.poolScope]?.capacity || category.maxPoolSize || 4,
        poolRadiusKm: poolScopes[booking.poolScope]?.radiusKm || POOL_RADIUS_KM,
        centroidLocation: booking.location,
        aggregateTimeWindow: {
          start: new Date(booking.timeWindow.start),
          end: new Date(booking.timeWindow.end),
        },
        lockCutoffTime: initialCutoff,
        members: [
          {
            bookingId: booking._id,
            customerId: booking.customerId,
            location: booking.location,
            addressText: booking.addressText,
            joinedAt: new Date(),
            status: 'active',
          },
        ],
        pricing: initialPricing,
        version: 0,
      },
    ],
    { session }
  );

  if (injectFailureAt === 'after_pool_update') {
    throw new Error('Simulated failure after_pool_update');
  }

  // Create membership record
  await PoolMembership.create(
    [
      {
        bookingId: booking._id,
        poolId: newPool._id,
        customerId: booking.customerId,
        status: 'active',
        joinedAt: new Date(),
      },
    ],
    { session }
  );

  if (injectFailureAt === 'after_membership_create') {
    throw new Error('Simulated failure after_membership_create');
  }

  // Link booking to new pool
  booking.poolId = newPool._id;
  booking.estimatedPrice = initialPricing.finalPricePerMember;
  await booking.save({ session });

  if (injectFailureAt === 'after_booking_update') {
    throw new Error('Simulated failure after_booking_update');
  }

  await Notification.create(
    [
      {
        userId: booking.customerId,
        role: 'customer',
        title: 'Service Pool Initiated',
        message: `A new service pool has been created for your request. As nearby neighbors join, your price will automatically decrease.`,
        type: 'booking',
        relatedEntityId: booking._id,
      },
    ],
    { session }
  );

  if (initialCutoff > new Date()) {
    await notifyTechniciansOfNewPool(newPool, booking.specificService || category.name, session);
    const recipients = await User.find({
      _id: { $ne: booking.customerId }, role: 'customer', isActive: true,
      poolAlertLocation: { $geoWithin: { $centerSphere: [booking.location.coordinates, POOL_RADIUS_KM / EARTH_RADIUS_KM] } },
    }).select('_id').session(session).lean();
    if (recipients.length) {
      await Notification.insertMany(recipients.map(({ _id }) => ({
        userId: _id, role: 'customer', type: 'pool', relatedEntityId: newPool._id,
        title: 'New pool within 200 m',
        message: `A neighbor started a ${booking.specificService || category.name} pool near your saved location. Join to share the discount.`,
        invitation: { serviceCategoryId: category._id, start: booking.timeWindow.start, end: booking.timeWindow.end },
      })), { session, ordered: true });
    }
  }

  return { booking, pool: newPool, mode: 'created' };
}

/**
 * Removes a booking from its pool (e.g. upon cancellation or address modification).
 * Handles recalculation of centroid, aggregate time window, cutoff, and pricing.
 */
export async function removeBookingFromPool(bookingId, session = null, settling = false) {
  if (!session) return runBookingTransaction(tx => removeBookingFromPool(bookingId, tx));
  const booking = await Booking.findById(bookingId).session(session);
  if (!booking || !booking.poolId) {
    return null;
  }

  const pool = await ServicePool.findById(booking.poolId).session(session);
  if (!pool) {
    booking.poolId = null;
    await booking.save({ session });
    return null;
  }

  // Mark PoolMembership record cancelled
  await PoolMembership.updateMany(
    { bookingId: booking._id, poolId: pool._id, status: 'active' },
    { status: 'cancelled' },
    { session }
  );

  // Update embedded member record
  const memberEntry = pool.members.find(
    (m) => String(m.bookingId) === String(booking._id) && m.status === 'active'
  );
  if (memberEntry) {
    memberEntry.status = 'cancelled';
  }

  const remainingActiveMembers = pool.members.filter((m) => m.status === 'active');

  if (remainingActiveMembers.length === 0) {
    // Pool is now empty: mark cancelled
    pool.status = 'cancelled';
    pool.pricing = calculatePoolPricing({
      basePrice: pool.pricing.individualBasePrice || 0,
      memberCount: 0,
    });
    await pool.save({ session });
  } else {
    // Recalculate remaining members
    const category = await ServiceCategory.findById(pool.serviceCategoryId).session(session);
    const basePrice = category ? category.baseIndividualPrice : pool.pricing.individualBasePrice;

    const remainingLocations = remainingActiveMembers.map((m) => m.location);
    pool.centroidLocation = computeCentroid(remainingLocations);

    // Recalculate aggregate time window from remaining bookings
    const remainingBookingIds = remainingActiveMembers.map((m) => m.bookingId);
    const remainingBookings = await Booking.find({
      _id: { $in: remainingBookingIds },
    }).session(session);

    let aggregateStart = new Date(0);
    let aggregateEnd = new Date(8640000000000000);

    for (const b of remainingBookings) {
      const bStart = new Date(b.timeWindow.start).getTime();
      const bEnd = new Date(b.timeWindow.end).getTime();
      if (bStart > aggregateStart.getTime()) aggregateStart = new Date(bStart);
      if (bEnd < aggregateEnd.getTime()) aggregateEnd = new Date(bEnd);
    }

    const lockCutoffMs = ((category?.poolLockCutoffMins) || 60) * 60 * 1000;
    pool.aggregateTimeWindow = { start: aggregateStart, end: aggregateEnd };
    pool.lockCutoffTime = effectiveCutoff(pool.ownerLockCutoffTime, aggregateStart, lockCutoffMs);

    // Recalculate pricing for remaining members
    const newPricing = calculatePoolPricing({
      basePrice,
      memberCount: remainingActiveMembers.length,
    });
    pool.pricing = newPricing;

    // If pool was locked due to capacity and dropped below maxCapacity, reopen if before cutoff
    if (pool.status === 'locked' && remainingActiveMembers.length < pool.maxCapacity && pool.lockCutoffTime > new Date()) {
      pool.status = 'forming';
    }

    await pool.save({ session });

    // Update remaining bookings' estimated prices
    await Booking.updateMany(
      { poolId: pool._id, status: 'pending' },
      { estimatedPrice: newPricing.finalPricePerMember },
      { session }
    );
  }

  booking.poolId = null;
  await booking.save({ session });

  if (!settling && pool.status === 'locked') return settleClosingLimits(pool, session);
  return pool;
}

// Removing one member can raise the price for the remaining members. Recheck until stable.
export async function settleClosingLimits(pool, session) {
  while (pool.status !== 'cancelled') {
    const overLimit = await Booking.findOne({ poolId: pool._id, status: { $in: ['pending', 'confirmed'] },
      closingPriceLimit: { $type: 'number', $lt: pool.pricing.finalPricePerMember } }).session(session);
    if (!overLimit) break;
    pool = await removeBookingFromPool(overLimit._id, session, true);
    await Booking.updateOne({ _id: overLimit._id }, { $set: { status: 'cancelled', cancelledAt: new Date() } }, { session });
    await Notification.create([{ userId: overLimit.customerId, role: 'customer', type: 'booking',
      relatedEntityId: overLimit._id, title: 'Cancelled at your price limit',
      message: `The closing price exceeded your ₹${overLimit.closingPriceLimit} limit. Your visit was cancelled.`,
    }], { session });
  }
  if (pool.status !== 'cancelled' && pool.status !== 'locked') {
    pool.status = 'locked';
    await pool.save({ session });
  }
  return pool;
}
