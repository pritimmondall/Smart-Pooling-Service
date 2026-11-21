import mongoose from 'mongoose';
import { ServicePool } from '../../models/index.js';
import { parseGeoInput, haversineDistanceKm } from '../../utils/geo.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { sendSuccess } from '../../utils/response.js';
import { AppError } from '../../utils/appError.js';
import { calculatePoolPricing } from './pricing.service.js';
import { poolScopes } from './poolOptions.js';

export const nearbyPools = asyncHandler(async (req, res) => {
  const { lat, lng, serviceCategoryId, specificService, poolId, radiusKm } = req.query;
  const point = lat !== undefined || lng !== undefined ? parseGeoInput({ lat, lng }) : req.user.poolAlertLocation;
  if (!point) return sendSuccess(res, { data: [], meta: { needsLocation: true } });
  for (const id of [serviceCategoryId, poolId]) {
    if (id !== undefined && !mongoose.isObjectIdOrHexString(id)) throw new AppError(400, 'Invalid search ID.', 'INVALID_ID');
  }
  const radius = radiusKm === undefined ? (serviceCategoryId || poolId ? 1 : 0.2) : Number(radiusKm);
  if (!Number.isFinite(radius) || radius < 0.1 || radius > 1) {
    throw new AppError(400, 'Choose a search range between 100 m and 1 km.', 'INVALID_RADIUS');
  }
  const pools = await ServicePool.find({
    status: 'forming', lockCutoffTime: { $gt: new Date() },
    centroidLocation: { $geoWithin: { $centerSphere: [point.coordinates, radius / 6371] } },
    ...(poolId && { _id: poolId }), ...(serviceCategoryId && { serviceCategoryId }),
    ...(specificService && { specificService }),
  }).populate('serviceCategoryId', 'name baseIndividualPrice isActive').lean();
  const items = [];
  for (const pool of pools) {
    const members = pool.members.filter(m => m.status === 'active');
    if (!pool.serviceCategoryId?.isActive || members.length >= pool.maxCapacity ||
        members.some(m => String(m.customerId) === String(req.user._id))) continue;
    const area = poolScopes[pool.poolScope];
    if (members.some(m => haversineDistanceKm(point, m.location) > (area?.radiusKm || 0.2))) continue;
    items.push({
      id: pool._id, serviceCategoryId: pool.serviceCategoryId._id, name: pool.specificService || pool.serviceCategoryId.name,
      specificService: pool.specificService, scope: pool.poolScope, area: area?.label || '200 m',
      members: members.length, capacity: pool.maxCapacity, start: pool.aggregateTimeWindow.start,
      distanceMeters: Math.round(haversineDistanceKm(point, pool.centroidLocation) * 1000),
      price: calculatePoolPricing({ basePrice: pool.serviceCategoryId.baseIndividualPrice, memberCount: members.length + 1 }).finalPricePerMember,
    });
  }
  return sendSuccess(res, { data: items.sort((a,b) => a.distanceMeters - b.distanceMeters) });
});
