import { ServicePool } from '../../models/index.js';
import { env } from '../../config/env.js';
import { optimizePoolRoute } from '../routing/routeOptimization.service.js';
import { resolveRouteOrigin } from '../technicians/technicianRoute.service.js';

// Allocate whole paise deterministically, including any remainder.
function portion(total, count, index) {
  return Math.floor(total / count) + (index < total % count ? 1 : 0);
}

export function allocateSavings(savedMeters, costPerKm, stops) {
  const total = Math.round(Math.max(0, savedMeters) * costPerKm / 10);
  const customer = Math.floor(total / 2);
  const technician = Math.floor(total / 4);
  const platform = total - customer - technician;
  return stops.map((stop, i) => ({
    bookingId: stop.bookingId, sequenceIndex: stop.sequenceIndex,
    customerPaise: portion(customer, stops.length, i),
    technicianPaise: portion(technician, stops.length, i),
    platformPaise: portion(platform, stops.length, i),
  }));
}

export async function planAssignedPool(id, profile) {
  const pool = await ServicePool.findOne({ _id: id, status: 'assigned', assignedTechnicianId: profile.userId })
    .populate('serviceCategoryId', 'estimatedDurationMins')
    .populate('members.bookingId', 'location timeWindow').lean();
  if (!pool) return null;
  const members = pool.members.filter(member => member.status === 'active');
  const { origin } = resolveRouteOrigin(profile);
  if (!origin || !members.length || members.some(member => !member.bookingId?.location)) return null;
  const route = await optimizePoolRoute({
    preserveOrder: Boolean(pool.poolScope),
    technicianStartLocation: origin, departureTime: pool.aggregateTimeWindow.start,
    stops: members.map(({ bookingId: booking }) => ({
      bookingId: booking._id, location: booking.location, timeWindow: booking.timeWindow,
      estimatedDurationMins: pool.serviceCategoryId?.estimatedDurationMins,
    })),
  });
  if (!route.roadDistanceCalculated) return null;
  const savedMeters = Math.max(0, route.separateDispatchMeters - route.totalTravelDistance.meters);
  return {
    provider: route.provider, savedMeters, costPerKm: env.travelCostPerKm,
    stops: allocateSavings(savedMeters, env.travelCostPerKm, route.stops),
  };
}
