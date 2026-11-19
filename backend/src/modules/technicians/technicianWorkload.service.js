import mongoose from 'mongoose';
import { ServicePool, Booking } from '../../models/index.js';
import { AppError } from '../../utils/appError.js';
import { parsePagination } from '../../utils/pagination.js';

export const ACTIVE_JOB_STATUSES = ['assigned', 'accepted', 'arrived', 'in_progress'];

/**
 * Normalizes a ServicePool document into a consistent active workload job object.
 */
function normalizePoolJob(pool) {
  const activeMembers = (pool.members || [])
    .filter((m) => m.status === 'active')
    .map((m) => {
      const b = m.bookingId || {};
      const c = m.customerId || {};
      return {
        bookingId: b._id || m.bookingId,
        customer: {
          _id: c._id || m.customerId,
          name: c.name || 'Customer',
          phone: c.phone || 'N/A',
        },
        addressText: b.addressText || m.addressText,
        location: b.location || m.location,
        timeWindow: b.timeWindow || pool.aggregateTimeWindow,
        status: b.status || m.status,
        stopSequence: b.stopSequence ?? 0,
        joinedAt: m.joinedAt,
      };
    });

  return {
    _id: pool._id,
    jobType: 'pool',
    status: pool.status,
    serviceCategory: pool.serviceCategoryId,
    zone: pool.zoneId,
    timeWindow: pool.aggregateTimeWindow,
    assignedAt: pool.assignedAt,
    acceptedAt: pool.acceptedAt,
    startedAt: pool.startedAt,
    createdAt: pool.createdAt,
    pool: {
      maxCapacity: pool.maxCapacity,
      memberCount: activeMembers.length,
      poolRadiusKm: pool.poolRadiusKm,
      centroidLocation: pool.centroidLocation,
      pricing: pool.pricing,
      routeOrder: pool.routeOrder || [],
      members: activeMembers,
    },
  };
}

/**
 * Normalizes an individual Booking document into a consistent active workload job object.
 */
function normalizeIndividualJob(booking) {
  return {
    _id: booking._id,
    jobType: 'individual',
    status: booking.status,
    serviceCategory: booking.serviceCategoryId,
    zone: booking.zoneId,
    timeWindow: booking.timeWindow,
    assignedAt: booking.assignedAt,
    acceptedAt: booking.acceptedAt,
    startedAt: booking.startedAt,
    createdAt: booking.createdAt,
    customer: {
      _id: booking.customerId?._id || booking.customerId,
      name: booking.customerId?.name || 'Customer',
      phone: booking.customerId?.phone || 'N/A',
    },
    addressText: booking.addressText,
    location: booking.location,
    estimatedPrice: booking.estimatedPrice,
    notes: booking.notes,
  };
}

/**
 * Retrieves all currently assigned active service pools and standalone bookings
 * for the authenticated technician.
 *
 * Enforces:
 * 1. Strict technician ownership filter on both models.
 * 2. Exclusion of pooled member bookings from standalone results (poolId: null).
 * 3. Exclusion of unassigned, completed, cancelled, and rejected jobs.
 * 4. Normalization of job representations for frontend consistency.
 * 5. Deterministic sorting and optional pagination.
 *
 * @param {string|mongoose.Types.ObjectId} technicianUserId
 * @param {Object} [queryParams]
 * @returns {Promise<Object>}
 */
export async function getActiveTechnicianWorkload(technicianUserId, queryParams = {}) {
  if (!mongoose.isValidObjectId(technicianUserId)) {
    throw new AppError(400, 'Invalid technician ID format.', 'INVALID_ID');
  }

  const userObjectId = new mongoose.Types.ObjectId(technicianUserId);
  const { page, limit, skip } = parsePagination(queryParams);

  const [pools, individualBookings] = await Promise.all([
    ServicePool.find({
      assignedTechnicianId: userObjectId,
      status: { $in: ACTIVE_JOB_STATUSES },
    })
      .populate('serviceCategoryId', 'name slug baseIndividualPrice estimatedDurationMins')
      .populate('zoneId', 'name code city')
      .populate('members.customerId', 'name phone')
      .populate('members.bookingId', 'addressText location notes timeWindow status stopSequence')
      .sort({ createdAt: -1 })
      .lean(),
    Booking.find({
      technicianId: userObjectId,
      poolId: null,
      status: { $in: ACTIVE_JOB_STATUSES },
    })
      .populate('customerId', 'name phone')
      .populate('serviceCategoryId', 'name slug baseIndividualPrice estimatedDurationMins')
      .populate('zoneId', 'name code city')
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  const formattedPools = pools.map(normalizePoolJob);
  const formattedBookings = individualBookings.map(normalizeIndividualJob);

  // Combine and sort chronologically by createdAt (newest first)
  const allActiveJobs = [...formattedPools, ...formattedBookings].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  const total = allActiveJobs.length;
  const paginatedJobs = allActiveJobs.slice(skip, skip + limit);

  // Calculate detailed summary counts
  const counts = {
    totalActive: total,
    pools: formattedPools.length,
    individual: formattedBookings.length,
    assigned: allActiveJobs.filter((j) => j.status === 'assigned').length,
    accepted: allActiveJobs.filter((j) => j.status === 'accepted').length,
    arrived: allActiveJobs.filter((j) => j.status === 'arrived').length,
    inProgress: allActiveJobs.filter((j) => j.status === 'in_progress').length,
  };

  return {
    jobs: paginatedJobs,
    meta: {
      counts,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1,
      },
    },
  };
}

/**
 * Retrieves full operational details for a single assigned active job.
 * Protects against IDOR by strictly filtering on ownership and returning 404
 * if the job does not exist or does not belong to the technician.
 *
 * @param {string|mongoose.Types.ObjectId} technicianUserId
 * @param {string|mongoose.Types.ObjectId} jobId
 * @returns {Promise<Object>}
 */
export async function getActiveJobDetails(technicianUserId, jobId) {
  if (!mongoose.isValidObjectId(technicianUserId)) {
    throw new AppError(400, 'Invalid technician ID format.', 'INVALID_ID');
  }
  if (!mongoose.isValidObjectId(jobId)) {
    throw new AppError(400, 'Invalid job ID format.', 'INVALID_ID');
  }

  const userObjectId = new mongoose.Types.ObjectId(technicianUserId);
  const jobObjectId = new mongoose.Types.ObjectId(jobId);

  // 1. Try finding an active ServicePool
  const pool = await ServicePool.findOne({
    _id: jobObjectId,
    assignedTechnicianId: userObjectId,
    status: { $in: ACTIVE_JOB_STATUSES },
  })
    .populate('serviceCategoryId', 'name slug baseIndividualPrice estimatedDurationMins')
    .populate('zoneId', 'name code city')
    .populate('members.customerId', 'name phone')
    .populate('members.bookingId', 'addressText location notes timeWindow status stopSequence')
    .lean();

  if (pool) {
    return normalizePoolJob(pool);
  }

  // 2. Try finding an active individual Booking
  const booking = await Booking.findOne({
    _id: jobObjectId,
    technicianId: userObjectId,
    poolId: null,
    status: { $in: ACTIVE_JOB_STATUSES },
  })
    .populate('customerId', 'name phone')
    .populate('serviceCategoryId', 'name slug baseIndividualPrice estimatedDurationMins')
    .populate('zoneId', 'name code city')
    .lean();

  if (booking) {
    return normalizeIndividualJob(booking);
  }

  // If not found in active pools or active individual bookings for this technician,
  // return 404 to avoid leaking whether the job exists for another technician
  throw new AppError(404, 'Active job not found.', 'JOB_NOT_FOUND');
}
