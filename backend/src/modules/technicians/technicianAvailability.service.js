import { TechnicianProfile, ServicePool, Booking, User } from '../../models/index.js';

/**
 * Centralized Technician Availability & Workload Recalculation Service.
 *
 * Re-evaluates all active commitments (both pools and individual bookings)
 * and updates the technician's availability status and activeWorkload count
 * atomically within the active database session.
 *
 * Rules:
 * 1. If technician user is inactive or profile is not approved, availability cannot be 'available'.
 * 2. If technician has ANY job with status 'in_progress' (either pool or standalone booking),
 *    the technician is actively performing on-site service -> status MUST be 'busy'.
 * 3. If no jobs are in progress:
 *    - Count total active commitments (assigned, accepted, in_progress).
 *    - Update profile.activeWorkload = totalActiveCount.
 *    - If totalActiveCount >= profile.maxPoolCapacity:
 *      Technician is at maximum workload capacity -> status MUST be 'busy' (preventing further assignments).
 *    - If totalActiveCount < profile.maxPoolCapacity:
 *      If the technician was 'busy' due to an active job or capacity, restore to 'available'.
 *      If the technician had explicitly set their status to 'offline' or 'unavailable', preserve that choice.
 *
 * @param {string|import('mongoose').Types.ObjectId} technicianUserId
 * @param {Object} [options]
 * @param {import('mongoose').ClientSession} [options.session]
 * @returns {Promise<import('../../models/TechnicianProfile.js').TechnicianProfile>}
 */
export async function recalculateTechnicianAvailability(technicianUserId, { session = null } = {}) {
  const profile = await TechnicianProfile.findOne({ userId: technicianUserId }).session(session);
  if (!profile) return null;

  const user = await User.findById(technicianUserId, 'isActive').session(session);
  const isUserActive = user ? user.isActive : true;

  if (!isUserActive || profile.approvalStatus !== 'approved') {
    if (profile.availabilityStatus === 'available') {
      profile.availabilityStatus = 'offline';
      await profile.save({ session });
    }
    return profile;
  }

  // Count active commitments
  const activeStatusFilter = { $in: ['assigned', 'accepted', 'arrived', 'in_progress'] };
  const onSiteStatusFilter = { $in: ['arrived', 'in_progress'] };

  const [inProgressPools, inProgressBookings, activePools, activeBookings] = await Promise.all([
    ServicePool.countDocuments(
      { assignedTechnicianId: technicianUserId, status: onSiteStatusFilter },
      { session }
    ),
    Booking.countDocuments(
      { technicianId: technicianUserId, poolId: null, status: onSiteStatusFilter },
      { session }
    ),
    ServicePool.countDocuments(
      { assignedTechnicianId: technicianUserId, status: activeStatusFilter },
      { session }
    ),
    Booking.countDocuments(
      { technicianId: technicianUserId, poolId: null, status: activeStatusFilter },
      { session }
    ),
  ]);

  const totalInProgress = inProgressPools + inProgressBookings;
  const totalWorkload = activePools + activeBookings;

  profile.activeWorkload = totalWorkload;

  if (totalInProgress > 0) {
    // Actively on-site working
    profile.availabilityStatus = 'busy';
  } else if (totalWorkload >= (profile.maxPoolCapacity || 4)) {
    // Saturated workload
    profile.availabilityStatus = 'busy';
  } else {
    // Under capacity with no job in-progress
    // If technician was busy (e.g. from completed/cancelled job or previous capacity limit), restore to available
    if (profile.availabilityStatus === 'busy') {
      profile.availabilityStatus = 'available';
    }
    // If offline or unavailable was explicitly chosen by technician, preserve it
  }

  await profile.save({ session });
  return profile;
}
