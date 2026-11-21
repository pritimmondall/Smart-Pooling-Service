import { Booking, ServicePool, TechnicianProfile } from '../../models/index.js';
import { evaluateTechnicianEligibility, evaluateBookingEligibility, assignPoolToTechnician, assignBookingToTechnician, reserveFormingPoolForTechnician } from '../pools/poolAssignment.service.js';
import { sendSuccess } from '../../utils/response.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { AppError } from '../../utils/appError.js';

export const listOpportunities = asyncHandler(async (req, res) => {
  const profile = await TechnicianProfile.findOne({ userId: req.user._id }).populate('userId', 'isActive');
  if (!profile || profile.approvalStatus !== 'approved') {
    return sendSuccess(res, { data: [] });
  }
  const category = { $in: profile.serviceCategories };
  const future = { $gt: new Date() };
  const forming = await ServicePool.find({
    status: 'forming', assignedTechnicianId: null, reservedTechnicianId: { $in: [null, req.user._id] },
    serviceCategoryId: category, lockCutoffTime: future, 'aggregateTimeWindow.end': future,
  }).select('specificService serviceCategoryId pricing.memberCount pricing.poolTotal pricing.finalPricePerMember maxCapacity lockCutoffTime aggregateTimeWindow centroidLocation reservedTechnicianId rejectedTechnicians')
    .populate('serviceCategoryId', 'name').sort({ createdAt: 1 }).lean();
  const formingPools = [];
  for (const pool of forming) {
    const reservedByMe = String(pool.reservedTechnicianId || '') === String(req.user._id);
    const eligibility = reservedByMe || profile.availabilityStatus !== 'available' ? null :
      await evaluateTechnicianEligibility(profile, pool);
    formingPools.push({
      id: pool._id, name: pool.specificService || pool.serviceCategoryId.name, members: pool.pricing.memberCount,
      visitWindow: pool.aggregateTimeWindow, pricePerVisit: pool.pricing.finalPricePerMember,
      total: pool.pricing.poolTotal, capacity: pool.maxCapacity, closesAt: pool.lockCutoffTime,
      reservedByMe, canReserve: !reservedByMe && Boolean(eligibility?.isEligible),
      unavailableReason: eligibility?.reasons?.[0] || (profile.availabilityStatus !== 'available' ? 'Set your status to available to reserve a pool.' : null),
    });
  }
  if (profile.availabilityStatus !== 'available') return sendSuccess(res, { data: [], meta: { formingPools } });
  const [pools, bookings] = await Promise.all([
    ServicePool.find({ status: 'locked', assignedTechnicianId: null, reservedTechnicianId: { $in: [null, req.user._id] }, serviceCategoryId: category, 'aggregateTimeWindow.end': future }).populate('serviceCategoryId', 'name'),
    Booking.find({ status: { $in: ['pending', 'confirmed'] }, bookingMode: 'individual', technicianId: null, serviceCategoryId: category, 'timeWindow.end': future }).populate('serviceCategoryId', 'name'),
  ]);
  const items = [];
  for (const [kind, jobs, evaluate] of [['pool', pools, evaluateTechnicianEligibility], ['individual', bookings, evaluateBookingEligibility]]) {
    for (const job of jobs) {
      const result = await evaluate(profile, job);
      if (!result.isEligible) continue;
      items.push({ id: job._id, kind, name: job.specificService || job.serviceCategoryId.name,
        createdAt: job.createdAt, distanceKm: result.distanceKm, start: (job.aggregateTimeWindow || job.timeWindow).start,
        members: job.pricing?.memberCount || 1, total: job.pricing?.poolTotal ?? job.estimatedPrice });
    }
  }
  return sendSuccess(res, { data: items.sort((a,b) => a.createdAt - b.createdAt), meta: { formingPools } });
});

export const claimOpportunity = asyncHandler(async (req, res) => {
  const kind = req.body.kind;
  if (!['individual','pool'].includes(kind)) throw new AppError(400, 'Invalid job type.', 'INVALID_JOB_TYPE');
  if (kind === 'pool') {
    const pool = await ServicePool.findById(req.params.id).select('status');
    if (pool?.status === 'forming') {
      await reserveFormingPoolForTechnician(req.params.id, req.user._id);
      return sendSuccess(res, { data: { id: req.params.id, reserved: true } });
    }
  }
  const assign = kind === 'pool' ? assignPoolToTechnician : assignBookingToTechnician;
  await assign(req.params.id, req.user._id, { requireOpen: true });
  return sendSuccess(res, { data: { id: req.params.id } });
});
