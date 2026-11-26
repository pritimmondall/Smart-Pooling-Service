import { planSharedGeometry } from '../routing/customerRoute.service.js';
import { ServicePool } from '../../models/index.js';
import { env } from '../../config/env.js';
import { optimizePoolRoute } from '../routing/routeOptimization.service.js';
import { resolveRouteOrigin } from '../technicians/technicianRoute.service.js';

import { allocateSavings } from './pricing.service.js';
export { allocateSavings };

export async function planAssignedPool(id, profile) {
  const pool = await ServicePool.findOne({ _id: id, status: 'assigned', assignedTechnicianId: profile.userId })
    .populate('serviceCategoryId', 'estimatedDurationMins')
    .populate('members.bookingId', 'location timeWindow').lean();
  if (!pool || pool.automaticDispatch) return null;
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
  const locations = new Map(members.map(m => [String(m.bookingId._id), m.bookingId.location.coordinates]));
  const sharedGeometry = await planSharedGeometry(route.stops.map(s => locations.get(String(s.bookingId))), route.provider, pool.sharedGeometry);
  return {
    sharedGeometry, provider: route.provider, savedMeters, costPerKm: env.travelCostPerKm,
    routeOrder: route.stops.map(({ bookingId, sequenceIndex, estimatedArrival, estimatedServiceStart, estimatedServiceEnd }) =>
      ({ bookingId, sequenceIndex, estimatedArrival, estimatedServiceStart, estimatedServiceEnd })),
    stops: allocateSavings(savedMeters, env.travelCostPerKm, route.stops),
  };
}
