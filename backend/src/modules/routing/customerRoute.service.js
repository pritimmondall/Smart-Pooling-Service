import { Booking } from '../../models/index.js';
import { getDefaultRoutingProvider } from './routingProvider.factory.js';

// Shared waypoints represent the centres of ~100 m cells. Neither another home's
// pin nor the technician's origin is sent to the shared-geometry endpoint.
function areaCentre(point) {
  return point.map(value => Number(((Math.floor(value * 1000) + 0.5) / 1000).toFixed(4)));
}

export async function planSharedGeometry(orderedLocations, providerName, previous) {
  const points = orderedLocations.map(areaCentre).filter((point, i, all) =>
    i === 0 || point[0] !== all[i - 1][0] || point[1] !== all[i - 1][1]);
  const key = JSON.stringify([providerName, points]);
  if (previous?.key === key) return previous;
  const provider = getDefaultRoutingProvider();
  let line = [];
  if (points.length > 1 && providerName === 'osrm' && provider.getOverview) {
    try { line = await provider.getOverview(points); }
    catch { /* The saved sequence is still usable without a road line. */ }
  }
  return { key, line };
}

export async function customerVisitRoute(pool, ownBooking) {
  if (!pool || !['accepted', 'in_progress', 'completed'].includes(pool.status)) return null;
  const members = pool.members.filter(member => member.status === 'active');
  const bookings = await Booking.find({ _id: { $in: members.map(m => m.bookingId) } }, 'location status stopSequence').lean();
  const byId = new Map(bookings.map(b => [String(b._id), b]));
  const plan = new Map(pool.routeOrder.map(stop => [String(stop.bookingId), stop]));
  const stops = pool.members.flatMap((member, index) => {
    const id = String(member.bookingId);
    const booking = byId.get(id);
    if (member.status !== 'active' || !booking?.location?.coordinates) return [];
    const yours = id === String(ownBooking);
    return [{ number: plan.get(id)?.sequenceIndex ?? (booking.stopSequence || index + 1),
      yours, status: booking.status, point: yours ? booking.location.coordinates : areaCentre(booking.location.coordinates) }];
  }).sort((a,b) => a.number - b.number);
  if (!stops.some(stop => stop.yours)) return null;
  return { stops, line: pool.sharedGeometry?.line || [],
    ordering: pool.poolScope ? 'Booking order' : plan.size ? 'Optimised visit order' : 'Scheduled visit order' };
}
