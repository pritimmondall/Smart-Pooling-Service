export function executionMembers(pool, bookings) {
  const visits = new Map();
  for (const member of pool.members) {
    const id = String(member.bookingId?._id || member.bookingId);
    const booking = bookings ? bookings.get(id) : member.bookingId;
    if (member.status === 'active') visits.set(id, member);
    else if (!visits.has(id) && booking?.status === 'cancelled' && (String(booking.poolId) === String(pool._id) || pool.routeOrder?.some(stop => String(stop.bookingId) === id && stop.status === 'cancelled'))) {
      visits.set(id, member);
    }
  }
  return [...visits.values()];
}
