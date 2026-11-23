import { PoolWatch } from '../../models/PoolWatch.js';
import { Notification, ServiceCategory } from '../../models/index.js';
import { runInTransaction } from '../../config/db.js';
import { findCompatiblePools } from './matching.service.js';
import { calculatePoolPricing } from './pricing.service.js';

export async function notifyMatchingWatches(now = new Date()) {
  for await (const watch of PoolWatch.find({ end: { $gt: now } }).lean().cursor()) {
    const category = await ServiceCategory.findOne({ _id: watch.serviceCategoryId, isActive: true }).lean();
    if (!category) continue;
    const start = new Date(Math.max(+watch.start, +now));
    const candidates = await findCompatiblePools({ ...watch, timeWindow: { start, end: watch.end } });
    for (const candidate of candidates) {
      const { finalPricePerMember } = calculatePoolPricing({ basePrice: category.baseIndividualPrice, memberCount: candidate.activeMembersCount + 1 });
      if (finalPricePerMember > watch.maxPrice) continue;
      await runInTransaction(async session => {
        const claimed = await PoolWatch.deleteOne({ _id: watch._id }, { session });
        if (!claimed.deletedCount) return;
        const [lng, lat] = watch.location.coordinates;
        await Notification.create([{
          userId: watch.customerId, role: 'customer', type: 'pool', relatedEntityId: candidate.pool._id,
          title: 'Your price watch found a pool',
          message: `${watch.specificService} is available at ₹${finalPricePerMember} if you join. Review the current offer.`,
          invitation: { serviceCategoryId: category._id, start, end: watch.end, lat, lng, fromWatch: true },
        }], { session });
      }, { requireTransaction: true });
      break;
    }
  }
}
