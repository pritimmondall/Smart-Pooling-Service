import { pathToFileURL } from 'node:url';
import { Booking, ServicePool } from '../models/index.js';
import { connectDB, disconnectDB } from '../config/db.js';

// Populate additive fields only. Concurrent bookings already carrying a promise
// retain it. Each update is independently repeatable after an interrupted run.
export async function backfillHomeVisits() {
  const bookings = await Booking.updateMany({
    automaticDispatch: true, status: { $nin: ['cancelled', 'completed'] },
    $or: [{ confirmedMaxFare: null }, { dispatchDueAt: null }],
  }, [{ $set: {
    confirmedMaxFare: { $ifNull: ['$confirmedMaxFare', '$estimatedPrice'] },
    dispatchDueAt: { $ifNull: ['$dispatchDueAt', { $add: ['$createdAt', 300000] }] },
  } }], { timestamps: false });
  const pools = await ServicePool.updateMany({
    automaticDispatch: true, acceptingVisits: null, status: { $nin: ['cancelled', 'completed'] },
  }, [{ $set: { acceptingVisits: { $lt: [
    { $size: { $filter: { input: '$members', as: 'member', cond: { $eq: ['$$member.status', 'active'] } } } },
    '$maxCapacity',
  ] } } }], { timestamps: false });
  return { bookings: bookings.modifiedCount, pools: pools.modifiedCount };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await connectDB();
    console.log('Home visit backfill', await backfillHomeVisits());
  } finally { await disconnectDB(); }
}
