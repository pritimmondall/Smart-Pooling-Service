import { ServicePool, Notification } from '../../models/index.js';
import { runInTransaction } from '../../config/db.js';

/**
 * Idempotently and safely evaluates and locks all forming pools whose lock cutoff time has expired.
 * Multi-instance safe: Uses atomic conditional updates inside a transaction to guarantee that
 * multiple server instances cannot double-lock or duplicate notifications.
 *
 * Includes an automated recovery pass to guarantee that any locked pool whose notification dispatch
 * was previously interrupted (e.g. process failure/restart) is recovered and notifications delivered
 * without emitting duplicates.
 *
 * @param {Object} [options]
 * @param {Date} [options.now] - Current time override for deterministic testing
 * @param {boolean} [options.simulateFailureBeforeNotifications] - Test hook to simulate crash before notifications
 * @returns {Promise<{ processedCount: number, lockedCount: number, cancelledCount: number, recoveredCount: number }>}
 */
export async function lockEligiblePools({
  now = new Date(),
  simulateFailureBeforeNotifications = false,
} = {}) {
  // 1. Query all forming pools whose lockCutoffTime has passed
  const expiredPools = await ServicePool.find({
    status: 'forming',
    lockCutoffTime: { $lte: now },
  });

  let lockedCount = 0;
  let cancelledCount = 0;
  let recoveredCount = 0;

  for (const pool of expiredPools) {
    await runInTransaction(
      async (session) => {
        // Inspect current active members count
        const activeCount = pool.members.filter((m) => m.status === 'active').length;
        const targetStatus = activeCount === 0 ? 'cancelled' : 'locked';

        // Atomic conditional transition: Only succeeds if status is still 'forming' and cutoff <= now
        const lockedPool = await ServicePool.findOneAndUpdate(
          {
            _id: pool._id,
            status: 'forming',
            lockCutoffTime: { $lte: now },
          },
          {
            $set: {
              status: targetStatus,
              notificationsDispatched: targetStatus === 'cancelled' ? true : false,
            },
            $inc: { version: 1 },
          },
          { new: true, session }
        );

        if (!lockedPool) {
          // Another concurrent worker instance already transitioned this pool
          return;
        }

        if (targetStatus === 'cancelled') {
          cancelledCount += 1;
        } else {
          lockedCount += 1;

          if (simulateFailureBeforeNotifications) {
            throw new Error('Simulated process failure before notification delivery');
          }

          await dispatchPoolLockNotifications(lockedPool, session);
          await ServicePool.findByIdAndUpdate(
            lockedPool._id,
            { $set: { notificationsDispatched: true } },
            { session }
          );
        }
      },
      { requireTransaction: true }
    );
  }

  // 2. Recovery Pass: Identify any locked pools where notifications were not completed
  const unnotifiedLockedPools = await ServicePool.find({
    status: 'locked',
    notificationsDispatched: { $ne: true },
  });

  for (const pool of unnotifiedLockedPools) {
    await runInTransaction(
      async (session) => {
        const freshPool = await ServicePool.findById(pool._id).session(session);
        if (!freshPool || freshPool.status !== 'locked' || freshPool.notificationsDispatched === true) {
          return;
        }

        await dispatchPoolLockNotifications(freshPool, session);
        freshPool.notificationsDispatched = true;
        await freshPool.save({ session });
        recoveredCount += 1;
      },
      { requireTransaction: true }
    );
  }

  return {
    processedCount: expiredPools.length,
    lockedCount,
    cancelledCount,
    recoveredCount,
  };
}

/**
 * Dispatches lock confirmation notifications to active pool members with idempotency checks
 * to guarantee that duplicate notifications are never emitted across retries or recovery passes.
 */
async function dispatchPoolLockNotifications(pool, session) {
  const activeMembers = pool.members.filter((m) => m.status === 'active');
  const isMultiMember = activeMembers.length > 1;

  for (const member of activeMembers) {
    const title = isMultiMember ? 'Service Pool Locked & Confirmed' : 'Pool Window Locked';

    // Idempotency check: verify notification has not already been created
    const existingNotif = await Notification.findOne({
      userId: member.customerId,
      relatedEntityId: member.bookingId,
      title,
    }).session(session);

    if (!existingNotif) {
      await Notification.create(
        [
          {
            userId: member.customerId,
            role: 'customer',
            title,
            message: isMultiMember
              ? `Great news! Your service pool is locked with ${activeMembers.length} members. Your pooled discount is confirmed at ${pool.pricing.discountPercentage}% (₹${pool.pricing.finalPricePerMember}).`
              : `Your service pool window has closed. As the sole member, your service will proceed at the standard rate.`,
            type: 'booking',
            relatedEntityId: member.bookingId,
          },
        ],
        { session }
      );
    }
  }
}
