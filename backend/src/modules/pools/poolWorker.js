import { runInTransaction } from '../../config/db.js';
import { notifyTechniciansOfNewPool } from './formingPoolAlerts.service.js';
import { Booking, ServicePool, Notification } from '../../models/index.js';
import {
  findEligibleTechniciansForPool,
  findEligibleTechniciansForBooking,
  assignPoolToTechnician,
} from './poolAssignment.service.js';
import { lockEligiblePools } from './poolLock.service.js';

let workerTimer = null;
let currentSweepPromise = null;

/**
 * Executes a single sweep of expired pools with overlap protection.
 */
export async function runPoolLockSweep(options = {}) {
  if (currentSweepPromise) return currentSweepPromise;
  currentSweepPromise = (async () => {
    try {
      const result = await lockEligiblePools(options);
      if (result.processedCount > 0) {
        console.log(
          `[PoolWorker] Sweep completed: ${result.processedCount} evaluated, ${result.lockedCount} locked, ${result.cancelledCount} cancelled.`
        );
      }
      if (options.dispatch) await dispatchWaitingJobs();
      return result;
    } catch (err) {
      console.error('[PoolWorker] Error during automatic pool lock sweep:', err.message);
      return { error: err.message };
    } finally {
      currentSweepPromise = null;
    }
  })();

  return await currentSweepPromise;
}

/**
 * Starts the autonomous pool locking background worker.
 * Runs an immediate sweep on startup to catch missed intervals, then runs periodically.
 *
 * @param {Object} [options]
 * @param {number} [options.intervalMs] - Check interval in milliseconds (default 30,000ms = 30s)
 */
export function startPoolWorker({ intervalMs = 30000 } = {}) {
  if (workerTimer) {
    return workerTimer;
  }

  console.log(`[PoolWorker] Starting autonomous pool locking worker (interval: ${intervalMs}ms)`);

  // Initial immediate sweep on startup (handles server restarts and missed intervals)
  runPoolLockSweep({ dispatch: true }).catch((err) => {
    console.error('[PoolWorker] Initial startup sweep error:', err.message);
  });

  // Schedule recurring checks
  workerTimer = setInterval(() => {
    runPoolLockSweep({ dispatch: true }).catch((err) => {
      console.error('[PoolWorker] Scheduled sweep error:', err.message);
    });
  }, intervalMs);

  // Do not block Node event loop if process is exiting
  if (typeof workerTimer.unref === 'function') {
    workerTimer.unref();
  }

  return workerTimer;
}

/**
 * Stops the autonomous pool locking background worker cleanly (for tests or graceful shutdown).
 */
export async function stopPoolWorker() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
  if (currentSweepPromise) {
    await currentSweepPromise;
  }
  console.log('[PoolWorker] Stopped autonomous pool locking worker.');
}

/**
 * Returns true if the worker timer is currently scheduled.
 */
export function isPoolWorkerActive() {
  return workerTimer !== null;
}


export async function dispatchWaitingJobs(now = new Date()) {
  const forming = ServicePool.find({
    status: 'forming', formingAlertsSent: { $ne: true }, lockCutoffTime: { $gt: now },
  }).populate('serviceCategoryId', 'name').cursor();
  for await (const pool of forming) {
    if (pool.serviceCategoryId) {
      await runInTransaction(session => notifyTechniciansOfNewPool(pool, pool.specificService || pool.serviceCategoryId.name, session),
        { requireTransaction: true });
    }
  }
  const pools = ServicePool.find({
    status: 'locked', assignedTechnicianId: null, 'aggregateTimeWindow.end': { $gt: now },
  }).sort({ 'aggregateTimeWindow.start': 1 }).select('_id reservedTechnicianId').lean().cursor();
  const bookings = Booking.find({
    bookingMode: 'individual', poolId: null, technicianId: null,
    status: { $in: ['pending', 'confirmed'] }, 'timeWindow.end': { $gt: now },
  }).sort({ 'timeWindow.start': 1 }).select('_id').lean().cursor();
  for (const [jobs, candidates] of [
    [pools, findEligibleTechniciansForPool],
    [bookings, findEligibleTechniciansForBooking],
  ]) {
    for await (const job of jobs) {
      try {
        if (job.reservedTechnicianId) {
          try {
            await assignPoolToTechnician(job._id, job.reservedTechnicianId, { requireOpen: true });
            continue;
          } catch (error) {
            if (!error.statusCode || error.statusCode >= 500) throw error;
            await ServicePool.updateOne({ _id: job._id, status: 'locked', assignedTechnicianId: null,
              reservedTechnicianId: job.reservedTechnicianId },
            { $set: { reservedTechnicianId: null, reservedAt: null } });
          }
        }
        const { eligibleTechnicians } = await candidates(job._id);
        for (const tech of eligibleTechnicians) {
          await Notification.updateOne({ userId: tech.technicianId, relatedEntityId: job._id, type: 'opportunity' }, {
            $setOnInsert: { role: 'technician', title: 'Service available',
              message: 'A job matching your services is ready. Open available work to claim it.' },
          }, { upsert: true });
        }
      } catch (err) {
        // Assignment rechecks availability and ownership inside its transaction.
        // Another worker or an administrator can win the same job.
        if (err.statusCode !== 409) console.warn('[Dispatch]', job._id, err.message);
      }
    }
  }
}
