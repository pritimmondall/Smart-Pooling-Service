import mongoose from 'mongoose';
import { ServicePool } from '../../models/index.js';
import { AppError } from '../../utils/appError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { sendSuccess } from '../../utils/response.js';
import { lockEligiblePools } from './poolLock.service.js';
import {
  findEligibleTechniciansForPool,
  assignPoolToTechnician,
} from './poolAssignment.service.js';

function customerPool(pool) {
  const { _id, status, pricing, members, maxCapacity, poolRadiusKm, aggregateTimeWindow,
    lockCutoffTime, serviceCategoryId, zoneId, createdAt } = pool.toObject();
  return { _id, status, pricing, members, maxCapacity, poolRadiusKm, aggregateTimeWindow,
    lockCutoffTime, serviceCategoryId, zoneId, createdAt };
}

/**
 * Masks sensitive personal identifying information (PII) of co-pool members.
 */
function maskMemberForCustomer(member, currentUserId) {
  const isSelf = String(member.customerId?._id || member.customerId) === String(currentUserId);
  const user = member.customerId || {};
  const rawName = user.name || 'Neighbor';

  if (isSelf) {
    return {
      _id: member._id,
      bookingId: member.bookingId,
      customerId: user._id || user,
      displayName: rawName,
      isCurrentUser: true,
      addressText: member.addressText,
      location: member.location,
      joinedAt: member.joinedAt,
      status: member.status,
    };
  }

  // Mask other customers: "Pritam M."
  const nameParts = rawName.trim().split(/\s+/);
  const firstName = nameParts[0] || 'Neighbor';
  const lastInitial = nameParts[1] ? ` ${nameParts[1][0].toUpperCase()}.` : '';
  const maskedName = `${firstName}${lastInitial}`;

  return {
    _id: member._id,
    displayName: maskedName,
    isCurrentUser: false,
    approximateAddress: 'Nearby area',
    joinedAt: member.joinedAt,
    status: member.status,
  };
}

/**
 * Returns active pools where the authenticated customer has an active booking.
 */
export const getMyPools = asyncHandler(async (req, res) => {
  const pools = await ServicePool.find({
    members: { $elemMatch: { customerId: req.user._id, status: 'active' } },
    status: { $in: ['forming', 'locked', 'assigned', 'accepted', 'in_progress'] },
  })
    .populate('serviceCategoryId', 'name slug baseIndividualPrice estimatedDurationMins defaultPoolRadiusKm maxPoolSize poolLockCutoffMins')
    .populate('zoneId', 'name code city')
    .sort({ createdAt: -1 });

  const sanitized = pools.map((pool) => {
    const poolObj = customerPool(pool);
    poolObj.members = poolObj.members
      .filter((m) => m.status === 'active')
      .map((m) => maskMemberForCustomer(m, req.user._id));
    return poolObj;
  });

  return sendSuccess(res, { data: sanitized });
});

/**
 * Fetches a single pool by ID with strict access control and privacy masking.
 */
export const getPoolById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(400, 'Invalid pool ID format.', 'INVALID_ID');
  }

  const pool = await ServicePool.findById(id)
    .populate('serviceCategoryId', 'name slug baseIndividualPrice estimatedDurationMins defaultPoolRadiusKm maxPoolSize poolLockCutoffMins')
    .populate('zoneId', 'name code city')
    .populate('members.customerId', 'name');

  if (!pool) {
    throw new AppError(404, 'Service pool not found.', 'POOL_NOT_FOUND');
  }

  const isMember = pool.members.some(
    (m) => String(m.customerId?._id || m.customerId) === String(req.user._id) && m.status === 'active'
  );
  const isAdmin = req.user.role === 'admin';

  if (!isMember && !isAdmin) {
    throw new AppError(403, 'You do not have permission to view this service pool.', 'FORBIDDEN_POOL_ACCESS');
  }

  const poolObj = isAdmin ? pool.toObject() : customerPool(pool);

  if (!isAdmin) {
    poolObj.members = poolObj.members
      .filter((m) => m.status === 'active')
      .map((m) => maskMemberForCustomer(m, req.user._id));
  }

  return sendSuccess(res, { data: poolObj });
});

/**
 * Idempotently evaluates and locks eligible pools (Admin or automated trigger).
 */
export const triggerPoolLockEvaluation = asyncHandler(async (req, res) => {
  const result = await lockEligiblePools();
  return sendSuccess(res, {
    message: 'Pool lock evaluation completed.',
    data: result,
  });
});

/**
 * Lists eligible technicians for a locked service pool (Admin only).
 */
export const getEligibleTechniciansForPoolHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await findEligibleTechniciansForPool(id);
  return sendSuccess(res, { data: result });
});

/**
 * Assigns a locked service pool to an eligible technician (Admin only).
 */
export const assignPoolHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { technicianId } = req.body || {};
  if (!technicianId) {
    throw new AppError(400, 'technicianId is required in request body.', 'VALIDATION_ERROR');
  }

  const assignedPool = await assignPoolToTechnician(id, technicianId);
  return sendSuccess(res, {
    message: 'Service pool assigned to technician.',
    data: assignedPool,
  });
});
