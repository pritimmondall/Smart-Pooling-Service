import { executionMembers } from './executionMembers.js';
import { planSharedGeometry } from '../routing/customerRoute.service.js';
import { runInTransaction } from '../../config/db.js';
import mongoose from 'mongoose';
import { TechnicianProfile, ServicePool, Booking } from '../../models/index.js';
import { AppError } from '../../utils/appError.js';
import { optimizePoolRoute } from '../routing/routeOptimization.service.js';
import { ACTIVE_JOB_STATUSES } from './technicianWorkload.service.js';
import { STALE_LOCATION_THRESHOLD_SECONDS } from './technicianLocation.service.js';

/**
 * Resolves the route origin and freshness metadata.
 *
 * @param {Object} profile
 * @param {Object|null} [overrideLocation=null]
 * @returns {{ origin: Object, originSource: 'override'|'live_gps'|'base_location', isOriginStale: boolean, originLastUpdatedAt: string|null }}
 */
export function resolveRouteOrigin(profile, overrideLocation = null) {
  if (overrideLocation) {
    return {
      origin: overrideLocation,
      originSource: 'override',
      isOriginStale: false,
      originLastUpdatedAt: null,
    };
  }

  if (profile?.currentLocation && profile?.lastLocationUpdate) {
    const recordedAt = new Date(profile.lastLocationUpdate);
    if (!Number.isNaN(recordedAt.getTime())) {
      const ageSeconds = Math.max(0, Math.round((Date.now() - recordedAt.getTime()) / 1000));
      return {
        origin: profile.currentLocation,
        originSource: 'live_gps',
        isOriginStale: ageSeconds > STALE_LOCATION_THRESHOLD_SECONDS,
        originLastUpdatedAt: recordedAt.toISOString(),
      };
    }
  }

  return {
    origin: profile?.baseLocation || null,
    originSource: 'base_location',
    isOriginStale: false,
    originLastUpdatedAt: null,
  };
}

/**
 * Retrieves route summaries for all currently active jobs assigned to the technician.
 *
 * @param {string|mongoose.Types.ObjectId} technicianUserId
 * @returns {Promise<Array<Object>>}
 */
export async function getTechnicianActiveRoutes(technicianUserId) {
  if (!mongoose.isValidObjectId(technicianUserId)) {
    throw new AppError(400, 'Invalid technician ID format.', 'INVALID_ID');
  }

  const userObjectId = new mongoose.Types.ObjectId(technicianUserId);

  const profile = await TechnicianProfile.findOne({ userId: userObjectId }).lean();
  if (!profile) {
    throw new AppError(404, 'Technician profile not found.', 'TECH_PROFILE_NOT_FOUND');
  }

  const {
    origin: originLocation,
    originSource,
    isOriginStale,
    originLastUpdatedAt,
  } = resolveRouteOrigin(profile);

  // 1. Fetch active ServicePools
  const pools = await ServicePool.find({
    assignedTechnicianId: userObjectId,
    status: { $in: ACTIVE_JOB_STATUSES },
  })
    .populate('serviceCategoryId', 'name slug baseIndividualPrice estimatedDurationMins')
    .populate('zoneId', 'name code city')
    .populate('members.customerId', 'name phone')
    .populate('members.bookingId', 'addressText location timeWindow status poolId stopSequence')
    .sort({ 'aggregateTimeWindow.start': 1 })
    .lean();

  // 2. Fetch active standalone bookings
  const bookings = await Booking.find({
    technicianId: userObjectId,
    poolId: null,
    status: { $in: ACTIVE_JOB_STATUSES },
  })
    .populate('customerId', 'name phone')
    .populate('serviceCategoryId', 'name slug baseIndividualPrice estimatedDurationMins')
    .populate('zoneId', 'name code city')
    .sort({ 'timeWindow.start': 1 })
    .lean();

  // Format pool routes
  const poolRoutes = pools.map((pool) => {
    // Only include active members with unfinished bookings as route stops
    const members = executionMembers(pool);
    const activeMembers = members.filter(m => m.status === 'active' && m.bookingId && !['completed', 'cancelled'].includes(m.bookingId.status));

    // Create a map of saved routeOrder if present
    const orderMap = new Map();
    if (Array.isArray(pool.routeOrder)) {
      for (const ro of pool.routeOrder) {
        orderMap.set(String(ro.bookingId), ro);
      }
    }

    // Sequence stops: prefer saved routeOrder sequenceIndex, then stopSequence on booking, then joinedAt order
    const stops = activeMembers
      .map(m => {
        const b = m.bookingId || {};
        const c = m.customerId || {};
        const savedOrder = orderMap.get(String(b._id || m.bookingId));
        const sequenceIndex = savedOrder?.sequenceIndex ?? (b.stopSequence > 0 ? b.stopSequence : members.indexOf(m) + 1);

        return {
          sequenceIndex,
          bookingId: b._id || m.bookingId,
          customer: {
            _id: c._id || m.customerId,
            name: c.name || 'Customer',
            phone: c.phone || 'N/A',
          },
          addressText: b.addressText || m.addressText,
          location: b.location || m.location,
          timeWindow: b.timeWindow || pool.aggregateTimeWindow,
          status: b.status || m.status,
          estimatedArrival: savedOrder?.estimatedArrival || null,
          estimatedServiceStart: savedOrder?.estimatedServiceStart || null,
          estimatedServiceEnd: savedOrder?.estimatedServiceEnd || null,
        };
      })
      .sort((a, b) => a.sequenceIndex - b.sequenceIndex);

    return {
      jobId: pool._id,
      jobType: 'pool',
      status: pool.status,
      serviceCategory: pool.serviceCategoryId,
      zone: pool.zoneId,
      timeWindow: pool.aggregateTimeWindow,
      origin: originLocation,
      originSource,
      isOriginStale,
      originLastUpdatedAt,
      totalStops: stops.length,
      stops,
      routeOrderPersisted: (pool.routeOrder || []).length > 0,
    };
  });

  // Format standalone booking routes
  const bookingRoutes = bookings.map((booking) => ({
    jobId: booking._id,
    jobType: 'individual',
    status: booking.status,
    serviceCategory: booking.serviceCategoryId,
    zone: booking.zoneId,
    timeWindow: booking.timeWindow,
    origin: originLocation,
    originSource,
    isOriginStale,
    originLastUpdatedAt,
    totalStops: 1,
    stops: [
      {
        sequenceIndex: 1,
        bookingId: booking._id,
        customer: {
          _id: booking.customerId?._id || booking.customerId,
          name: booking.customerId?.name || 'Customer',
          phone: booking.customerId?.phone || 'N/A',
        },
        addressText: booking.addressText,
        location: booking.location,
        timeWindow: booking.timeWindow,
        status: booking.status,
        estimatedArrival: null,
        estimatedServiceStart: null,
        estimatedServiceEnd: null,
      },
    ],
    routeOrderPersisted: false,
  }));

  return [...poolRoutes, ...bookingRoutes];
}

/**
 * Retrieves detailed route information for a single assigned job.
 * Validates ownership and applies IDOR protection (returns 404 if not found).
 *
 * @param {string|mongoose.Types.ObjectId} technicianUserId
 * @param {string|mongoose.Types.ObjectId} jobId
 * @param {Object} [options]
 * @param {Object} [options.overrideLocation] Optional coordinates from query params
 * @returns {Promise<Object>}
 */
export async function getTechnicianJobRoute(technicianUserId, jobId, { overrideLocation, replan = false } = {}) {
  if (!mongoose.isValidObjectId(technicianUserId)) {
    throw new AppError(400, 'Invalid technician ID format.', 'INVALID_ID');
  }
  if (!mongoose.isValidObjectId(jobId)) {
    throw new AppError(400, 'Invalid job ID format.', 'INVALID_ID');
  }

  const userObjectId = new mongoose.Types.ObjectId(technicianUserId);
  const jobObjectId = new mongoose.Types.ObjectId(jobId);

  const profile = await TechnicianProfile.findOne({ userId: userObjectId });
  if (!profile) {
    throw new AppError(404, 'Technician profile not found.', 'TECH_PROFILE_NOT_FOUND');
  }

  const {
    origin: startLocation,
    originSource,
    isOriginStale,
    originLastUpdatedAt,
  } = resolveRouteOrigin(profile, overrideLocation);

  // 1. Try finding as a ServicePool
  const pool = await ServicePool.findOne({
    _id: jobObjectId,
    assignedTechnicianId: userObjectId,
    status: { $in: ACTIVE_JOB_STATUSES },
  })
    .populate('serviceCategoryId', 'name slug baseIndividualPrice estimatedDurationMins')
    .populate('zoneId', 'name code city')
    .populate('members.customerId', 'name phone')
    .populate('members.bookingId', 'addressText location timeWindow notes status poolId stopSequence arrivedAt startedAt completedAt cancelledAt rejectionReason');

  if (pool) {
    // Partition members: only active members with unfinished bookings are eligible for new route optimization
    const members = executionMembers(pool);
    const unfinishedMembers = members.filter(m => m.status === 'active' && m.bookingId && !['completed', 'cancelled'].includes(m.bookingId.status));

    const existingRouteMap = new Map();
    if (Array.isArray(pool.routeOrder)) {
      for (const ro of pool.routeOrder) {
        existingRouteMap.set(String(ro.bookingId), ro.toObject ? ro.toObject() : { ...ro });
      }
    }

    // Retain existing routeOrder items for finished stops (completed or cancelled) without modification
    const unfinishedBookingIdSet = new Set(
      unfinishedMembers.map((m) => String(m.bookingId?._id || m.bookingId))
    );
    const preservedFinishedRouteItems = (pool.routeOrder || [])
      .filter((ro) => !unfinishedBookingIdSet.has(String(ro.bookingId)))
      .map((ro) => (ro.toObject ? ro.toObject() : { ...ro }));

    if (replan && (pool.poolScope || !['accepted', 'in_progress'].includes(pool.status))) {
      throw new AppError(409, 'Only accepted automatic pools can be replanned.', 'REPLAN_UNAVAILABLE');
    }
    const sequence = member => existingRouteMap.get(String(member.bookingId._id))?.sequenceIndex ||
      member.bookingId.stopSequence || members.indexOf(member) + 1;
    unfinishedMembers.sort((a, b) => sequence(a) - sequence(b));
    const slots = unfinishedMembers.map(sequence);

    let optimized;
    if (unfinishedMembers.length === 0) {
      optimized = {
        optimizationStatus: 'no_stops',
        provider: 'none',
        algorithm: 'none',
        roadDistanceCalculated: true,
        totalTravelDistance: { value: 0, unit: 'km', meters: 0 },
        totalTravelTime: { value: 0, unit: 'minutes', seconds: 0 },
        totalServiceDuration: { value: 0, unit: 'minutes' },
        totalTripDuration: { value: 0, unit: 'minutes' },
        departureTime: pool.aggregateTimeWindow?.start?.toISOString() || new Date().toISOString(),
        stops: [],
        schedulingConflicts: [],
        limitations: 'All stops in this service pool have been completed or cancelled.',
      };
    } else {
      const unfinishedStops = unfinishedMembers.map((m) => {
        const b = m.bookingId || {};
        const c = m.customerId || {};
        return {
          bookingId: b._id || m.bookingId,
          customerId: c._id || m.customerId,
          customerName: c.name || 'Customer',
          customerPhone: c.phone || 'N/A',
          addressText: b.addressText || m.addressText,
          location: b.location || m.location,
          timeWindow: b.timeWindow || pool.aggregateTimeWindow,
          estimatedDurationMins: pool.serviceCategoryId?.estimatedDurationMins || 45,
        };
      });

      const current = unfinishedMembers.findIndex(m => ['arrived', 'in_progress'].includes(m.bookingId?.status));
      const departure = replan ? new Date(Math.max(Date.now(), pool.aggregateTimeWindow.start.getTime())) : pool.aggregateTimeWindow.start;
      if (replan && current >= 0 && current + 1 < unfinishedStops.length) {
        const suffix = unfinishedStops.slice(current + 1);
        const planned = await optimizePoolRoute({
          technicianStartLocation: unfinishedStops[current].location, stops: suffix,
          departureTime: new Date(+departure + unfinishedStops[current].estimatedDurationMins * 60000),
        });
        if (!planned.roadDistanceCalculated) throw new AppError(503, 'Routing provider unavailable.', 'REPLAN_UNAVAILABLE');
        const byId = new Map(suffix.map(stop => [String(stop.bookingId), stop]));
        unfinishedStops.splice(current + 1, suffix.length, ...planned.stops.map(stop => byId.get(String(stop.bookingId))));
      }
      optimized = await optimizePoolRoute({
        technicianStartLocation: startLocation,
        preserveOrder: Boolean(pool.poolScope) || current >= 0 || (!replan && pool.status !== 'assigned'),
        stops: unfinishedStops,
        departureTime: departure,
      });

      // Keep terminal visits in their original slots.
      if (optimized.algorithm === 'booking_order' && !pool.poolScope) optimized.algorithm = 'saved_visit_order';
      optimized.stops = optimized.stops.map((s, idx) => ({
        ...s,
        sequenceIndex: slots[idx],
      }));

      // If road network calculation succeeded, merge newly calculated route estimates with existing persisted execution state
      if (replan && !optimized.roadDistanceCalculated) throw new AppError(503, 'Routing provider unavailable.', 'REPLAN_UNAVAILABLE');
      if (replan && optimized.stops.length > 0) {
        const mergedUnfinishedItems = optimized.stops.map((s) => {
          const existing = existingRouteMap.get(String(s.bookingId));
          return {
            bookingId: s.bookingId,
            sequenceIndex: s.sequenceIndex,
            estimatedArrival: s.estimatedArrival ? new Date(s.estimatedArrival) : (existing?.estimatedArrival || null),
            estimatedServiceStart: s.estimatedServiceStart ? new Date(s.estimatedServiceStart) : (existing?.estimatedServiceStart || null),
            estimatedServiceEnd: s.estimatedServiceEnd ? new Date(s.estimatedServiceEnd) : (existing?.estimatedServiceEnd || null),
            // Preserve execution history:
            status: existing?.status || null,
            actualArrival: existing?.actualArrival || null,
            actualServiceStart: existing?.actualServiceStart || null,
            actualServiceEnd: existing?.actualServiceEnd || null,
          };
        });

        const mergedRouteOrder = [...preservedFinishedRouteItems, ...mergedUnfinishedItems].sort(
          (a, b) => a.sequenceIndex - b.sequenceIndex
        );

        const locations = new Map(pool.members.filter(m => m.status === 'active' && m.bookingId)
          .map(m => [String(m.bookingId._id), (m.bookingId.location || m.location)?.coordinates]));
        const points = mergedRouteOrder.map(s => locations.get(String(s.bookingId))).filter(Boolean);
        const sharedGeometry = await planSharedGeometry(points, optimized.provider, pool.sharedGeometry);
        await runInTransaction(async session => {
          const update = await ServicePool.updateOne({
            _id: pool._id, assignedTechnicianId: userObjectId, updatedAt: pool.updatedAt, status: pool.status,
          }, { $set: { routeOrder: mergedRouteOrder, sharedGeometry } }, { session });
          if (!update.matchedCount) throw new AppError(409, 'This route changed. Refresh and retry.', 'STALE_ROUTE');
          await Booking.bulkWrite(optimized.stops.map(stop => ({ updateOne: {
            filter: { _id: stop.bookingId }, update: { $set: { stopSequence: stop.sequenceIndex } },
          } })), { session });
        }, { requireTransaction: true });
      }
    }

    return {
      jobId: pool._id,
      jobType: 'pool',
      status: pool.status,
      serviceCategory: pool.serviceCategoryId,
      zone: pool.zoneId,
      timeWindow: pool.aggregateTimeWindow,
      origin: startLocation,
      originSource,
      isOriginStale,
      originLastUpdatedAt,
      ...optimized,
    };
  }

  // 2. Try finding as an individual Booking
  const booking = await Booking.findOne({
    _id: jobObjectId,
    technicianId: userObjectId,
    poolId: null,
    status: { $in: ACTIVE_JOB_STATUSES },
  })
    .populate('customerId', 'name phone')
    .populate('serviceCategoryId', 'name slug baseIndividualPrice estimatedDurationMins')
    .populate('zoneId', 'name code city');

  if (booking) {
    if (replan) throw new AppError(409, 'Individual jobs have one visit.', 'REPLAN_UNAVAILABLE');
    const singleStopRoute = await optimizePoolRoute({
      technicianStartLocation: startLocation,
      stops: [
        {
          bookingId: booking._id,
          customerId: booking.customerId?._id,
          customerName: booking.customerId?.name,
          customerPhone: booking.customerId?.phone,
          addressText: booking.addressText,
          location: booking.location,
          timeWindow: booking.timeWindow,
          estimatedDurationMins: booking.serviceCategoryId?.estimatedDurationMins || 45,
        },
      ],
      departureTime: booking.timeWindow.start,
    });

    return {
      jobId: booking._id,
      jobType: 'individual',
      status: booking.status,
      serviceCategory: booking.serviceCategoryId,
      zone: booking.zoneId,
      timeWindow: booking.timeWindow,
      origin: startLocation,
      originSource,
      isOriginStale,
      originLastUpdatedAt,
      ...singleStopRoute,
    };
  }

  // If neither found, return 404 for IDOR protection
  throw new AppError(404, 'Active job not found.', 'JOB_NOT_FOUND');
}
