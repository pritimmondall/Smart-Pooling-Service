import { createHash, createHmac } from 'node:crypto';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/appError.js';
import { findCompatiblePools } from '../pools/matching.service.js';
import { calculatePoolPricing, shiftedFare, SHIFT_BONUS_PERCENTAGE } from '../pools/pricing.service.js';

function fingerprint(criteria) {
  return createHash('sha256').update(JSON.stringify([String(criteria.customerId), String(criteria.serviceCategoryId),
    criteria.specificService, criteria.location.coordinates, +criteria.timeWindow.start, +criteria.timeWindow.end,
    criteria.replaceBookingId || null])).digest('hex');
}
const signingKey = () => createHmac('sha256', env.jwtSecret).update('SmartPool visit quote v1').digest();

export function readVisitQuote(token, criteria) {
  try {
    const claims = jwt.verify(token, signingKey(), { algorithms: ['HS256'], audience: 'visit', ignoreExpiration: true });
    if (claims.request === fingerprint(criteria)) return claims;
  } catch { /* Invalid or mismatched requests must be quoted again. */ }
  throw new AppError(409, 'Review a new quote for these visit details.', 'QUOTE_CHANGED');
}

export async function visitQuote(criteria, category, candidates) {
  const originals = candidates || await findCompatiblePools(criteria);
  const [original] = originals;
  const price = candidate => calculatePoolPricing({ basePrice: category.baseIndividualPrice,
    memberCount: (candidate?.activeMembersCount || 0) + 1 });
  const pricing = price(original);
  const shifts = await findCompatiblePools({ ...criteria, allowShift: true, excludePoolIds: originals.map(m => m.pool._id) });
  let shiftOffer = null;
  for (const candidate of shifts) {
    const { payable, creditPaise } = shiftedFare(price(candidate), SHIFT_BONUS_PERCENTAGE);
    if (payable >= pricing.finalPricePerMember) continue;
    shiftOffer = { poolId: String(candidate.pool._id), timeWindow: candidate.offeredWindow, price: payable, creditPaise,
      savings: (pricing.basePricePaise - Math.round(payable * 100)) / 100 };
    break;
  }
  const exp = Math.floor(Date.now() / 1000) + 5 * 60;
  const quoteToken = jwt.sign({ request: fingerprint(criteria), bookingId: new mongoose.Types.ObjectId().toString(),
    originalPool: original ? String(original.pool._id) : null, price: pricing.finalPricePerMember,
    shiftOffer, exp, duration: category.estimatedDurationMins }, signingKey(), { algorithm: 'HS256', audience: 'visit' });
  return { quoteToken, expiresAt: new Date(exp * 1000), timeWindow: criteria.timeWindow, estimatedDurationMins: category.estimatedDurationMins,
    finalPricePerMember: pricing.finalPricePerMember, memberCount: pricing.memberCount,
    totalSavingsPerMember: pricing.totalSavingsPerMember, shiftOffer };
}

export function sameOffer(a, b) {
  return a && b && String(a.poolId) === String(b.poolId) && a.price === b.price &&
    +new Date(a.timeWindow?.start) === +new Date(b.timeWindow?.start) &&
    +new Date(a.timeWindow?.end) === +new Date(b.timeWindow?.end);
}
