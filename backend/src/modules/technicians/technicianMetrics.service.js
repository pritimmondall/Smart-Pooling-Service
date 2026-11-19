import mongoose from 'mongoose';
import { TechnicianProfile, ServicePool, Booking } from '../../models/index.js';
import { AppError } from '../../utils/appError.js';

/**
 * Computes timezone offset in milliseconds for any IANA timezone.
 */
function getTimezoneOffsetMs(date, timeZone) {
  const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tzDate = new Date(date.toLocaleString('en-US', { timeZone }));
  return tzDate.getTime() - utcDate.getTime();
}

/**
 * Computes calendar date boundaries (startOfDay, endOfDay, startOfMonth, endOfMonth)
 * for a given reference date and IANA timezone.
 *
 * Uses inclusive start boundaries ($gte) and exclusive end boundaries ($lt).
 *
 * @param {Date} [now]
 * @param {string} [timeZone]
 * @returns {{ timeZone: string, startOfDay: Date, endOfDay: Date, startOfMonth: Date, endOfMonth: Date }}
 */
export function getDateBoundaries(now = new Date(), timeZone = 'UTC') {
  let validTimeZone = timeZone || 'UTC';
  try {
    Intl.DateTimeFormat(undefined, { timeZone: validTimeZone });
  } catch {
    validTimeZone = 'UTC';
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: validTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [year, month, day] = formatter.format(now).split('-').map(Number);

  function localToUtc(y, m, d, hour = 0, minute = 0, second = 0, ms = 0) {
    const utcGuess = new Date(Date.UTC(y, m - 1, d, hour, minute, second, ms));
    if (validTimeZone === 'UTC') return utcGuess;
    const offsetMs = getTimezoneOffsetMs(utcGuess, validTimeZone);
    return new Date(utcGuess.getTime() - offsetMs);
  }

  const startOfDay = localToUtc(year, month, day, 0, 0, 0, 0);
  const endOfDay = localToUtc(year, month, day + 1, 0, 0, 0, 0);
  const startOfMonth = localToUtc(year, month, 1, 0, 0, 0, 0);
  const endOfMonth = localToUtc(year, month + 1, 1, 0, 0, 0, 0);

  return {
    timeZone: validTimeZone,
    startOfDay,
    endOfDay,
    startOfMonth,
    endOfMonth,
  };
}

/**
 * Aggregates dashboard metrics for an authenticated technician.
 *
 * Enforces:
 * 1. Strict technician ownership filter on all queries (assignedTechnicianId / technicianId).
 * 2. No double-counting: pooled bookings are excluded from individual booking queries (poolId: null).
 * 3. Database-level aggregation via $facet to minimize database roundtrips.
 * 4. Numeric defaults (0) for all empty or unpopulated states.
 * 5. Timezone-aware date boundaries (inclusive start, exclusive end).
 *
 * @param {string|mongoose.Types.ObjectId} technicianUserId
 * @param {Object} [options]
 * @param {string} [options.timeZone]
 * @param {Date} [options.referenceDate]
 * @returns {Promise<Object>}
 */
export async function getTechnicianDashboardMetrics(
  technicianUserId,
  { timeZone = process.env.APP_TIMEZONE || 'UTC', referenceDate = new Date() } = {}
) {
  if (!mongoose.isValidObjectId(technicianUserId)) {
    throw new AppError(400, 'Invalid technician ID format.', 'INVALID_ID');
  }

  const userObjectId = new mongoose.Types.ObjectId(technicianUserId);
  const boundaries = getDateBoundaries(referenceDate, timeZone);
  const { startOfDay, endOfDay, startOfMonth, endOfMonth } = boundaries;

  // Execute profile lookup and both aggregations concurrently
  const [profile, [poolAggResults], [bookingAggResults]] = await Promise.all([
    TechnicianProfile.findOne({ userId: userObjectId }).lean(),
    ServicePool.aggregate([
      { $match: { assignedTechnicianId: userObjectId } },
      {
        $facet: {
          byStatus: [
            { $group: { _id: '$status', count: { $sum: 1 } } },
          ],
          completedToday: [
            {
              $match: {
                status: 'completed',
                completedAt: { $gte: startOfDay, $lt: endOfDay },
              },
            },
            { $count: 'count' },
          ],
          assignedToday: [
            {
              $match: {
                assignedAt: { $gte: startOfDay, $lt: endOfDay },
              },
            },
            { $count: 'count' },
          ],
          completedThisMonth: [
            {
              $match: {
                status: 'completed',
                completedAt: { $gte: startOfMonth, $lt: endOfMonth },
              },
            },
            { $count: 'count' },
          ],
        },
      },
    ]),
    Booking.aggregate([
      { $match: { technicianId: userObjectId, poolId: null } },
      {
        $facet: {
          byStatus: [
            { $group: { _id: '$status', count: { $sum: 1 } } },
          ],
          completedToday: [
            {
              $match: {
                status: 'completed',
                completedAt: { $gte: startOfDay, $lt: endOfDay },
              },
            },
            { $count: 'count' },
          ],
          assignedToday: [
            {
              $match: {
                assignedAt: { $gte: startOfDay, $lt: endOfDay },
              },
            },
            { $count: 'count' },
          ],
          completedThisMonth: [
            {
              $match: {
                status: 'completed',
                completedAt: { $gte: startOfMonth, $lt: endOfMonth },
              },
            },
            { $count: 'count' },
          ],
        },
      },
    ]),
  ]);

  if (!profile) {
    throw new AppError(404, 'Technician profile not found.', 'TECH_PROFILE_NOT_FOUND');
  }

  // Helper to extract status count map
  function mapStatusCounts(byStatusArray = []) {
    const map = {
      assigned: 0,
      accepted: 0,
      arrived: 0,
      in_progress: 0,
      completed: 0,
      cancelled: 0,
    };
    for (const item of byStatusArray) {
      if (item._id && map[item._id] !== undefined) {
        map[item._id] = item.count;
      }
    }
    return map;
  }

  const poolStatus = mapStatusCounts(poolAggResults?.byStatus);
  const bookingStatus = mapStatusCounts(bookingAggResults?.byStatus);

  // Pool breakdown
  const poolActive = poolStatus.assigned + poolStatus.accepted + poolStatus.arrived + poolStatus.in_progress;
  const poolTotal = poolActive + poolStatus.completed + poolStatus.cancelled;

  // Individual booking breakdown
  const bookingActive =
    bookingStatus.assigned +
    bookingStatus.accepted +
    bookingStatus.arrived +
    bookingStatus.in_progress;
  const bookingTotal = bookingActive + bookingStatus.completed + bookingStatus.cancelled;

  // Combined totals
  const totalAssigned = poolTotal + bookingTotal;
  const totalPendingAcceptance = poolStatus.assigned + bookingStatus.assigned;
  const totalAccepted = poolStatus.accepted + bookingStatus.accepted;
  const totalArrived = poolStatus.arrived + bookingStatus.arrived;
  const totalInProgress = poolStatus.in_progress + bookingStatus.in_progress;
  const totalActive = totalPendingAcceptance + totalAccepted + totalArrived + totalInProgress;
  const totalCompleted = poolStatus.completed + bookingStatus.completed;
  const totalCancelled = poolStatus.cancelled + bookingStatus.cancelled;

  // Date metrics
  const poolCompletedToday = poolAggResults?.completedToday?.[0]?.count || 0;
  const bookingCompletedToday = bookingAggResults?.completedToday?.[0]?.count || 0;
  const completedToday = poolCompletedToday + bookingCompletedToday;

  const poolAssignedToday = poolAggResults?.assignedToday?.[0]?.count || 0;
  const bookingAssignedToday = bookingAggResults?.assignedToday?.[0]?.count || 0;
  const assignedToday = poolAssignedToday + bookingAssignedToday;

  const poolCompletedThisMonth = poolAggResults?.completedThisMonth?.[0]?.count || 0;
  const bookingCompletedThisMonth = bookingAggResults?.completedThisMonth?.[0]?.count || 0;
  const completedThisMonth = poolCompletedThisMonth + bookingCompletedThisMonth;

  // Capacity metrics
  const maxPoolCapacity = profile.maxPoolCapacity || 4;
  const activeWorkload = profile.activeWorkload ?? totalActive;
  const availableCapacity = Math.max(0, maxPoolCapacity - activeWorkload);
  const utilizationPercentage = Number(((activeWorkload / maxPoolCapacity) * 100).toFixed(1));

  return {
    technicianId: userObjectId,
    summary: {
      totalAssignedJobs: totalAssigned,
      activeJobs: totalActive,
      completedJobs: totalCompleted,
      cancelledJobs: totalCancelled,
      pendingActionJobs: totalPendingAcceptance,
    },
    jobs: {
      total: totalAssigned,
      active: totalActive,
      pendingAcceptance: totalPendingAcceptance,
      accepted: totalAccepted,
      arrived: totalArrived,
      inProgress: totalInProgress,
      completed: totalCompleted,
      cancelled: totalCancelled,
      breakdown: {
        pools: {
          total: poolTotal,
          active: poolActive,
          pendingAcceptance: poolStatus.assigned,
          accepted: poolStatus.accepted,
          arrived: poolStatus.arrived,
          inProgress: poolStatus.in_progress,
          completed: poolStatus.completed,
          cancelled: poolStatus.cancelled,
        },
        individual: {
          total: bookingTotal,
          active: bookingActive,
          pendingAcceptance: bookingStatus.assigned,
          accepted: bookingStatus.accepted,
          arrived: bookingStatus.arrived,
          inProgress: bookingStatus.in_progress,
          completed: bookingStatus.completed,
          cancelled: bookingStatus.cancelled,
        },
      },
    },
    pools: {
      totalAssigned: poolTotal,
      active: poolActive,
      completed: poolStatus.completed,
      cancelled: poolStatus.cancelled,
    },
    dateMetrics: {
      completedToday,
      assignedToday,
      completedThisMonth,
      breakdownToday: {
        poolsCompleted: poolCompletedToday,
        individualCompleted: bookingCompletedToday,
        poolsAssigned: poolAssignedToday,
        individualAssigned: bookingAssignedToday,
      },
    },
    capacity: {
      maxPoolCapacity,
      activeWorkload,
      availableCapacity,
      utilizationPercentage,
      availabilityStatus: profile.availabilityStatus || 'offline',
      approvalStatus: profile.approvalStatus || 'pending',
    },
    performance: {
      ratingAvg: profile.ratingAvg || 0,
      ratingCount: profile.ratingCount || 0,
      lifetimeJobsCompleted: profile.jobsCompleted || 0,
    },
    period: {
      timeZone: boundaries.timeZone,
      startOfDay: startOfDay.toISOString(),
      endOfDay: endOfDay.toISOString(),
      startOfMonth: startOfMonth.toISOString(),
      endOfMonth: endOfMonth.toISOString(),
      generatedAt: referenceDate.toISOString(),
    },
  };
}
