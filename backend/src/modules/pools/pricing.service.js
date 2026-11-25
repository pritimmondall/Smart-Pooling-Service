/**
 * Dynamic Pricing Service for Service Pools
 *
 * Currency Precision Architecture:
 * All internal pricing, discount, and savings calculations are executed strictly in
 * Integer Paise (1 INR = 100 Paise).
 * Operating on integer units completely eliminates IEEE-754 floating-point drift
 * (e.g. 0.1 + 0.2 = 0.30000000000000004), ensuring exact non-negative balances
 * and exact penny-level accounting.
 */

export const DEFAULT_DISCOUNT_TIERS = [
  { minMembers: 1, discountPercentage: 0 },
  { minMembers: 2, discountPercentage: 10 },
  { minMembers: 3, discountPercentage: 15 },
  { minMembers: 4, discountPercentage: 20 },
  { minMembers: 5, discountPercentage: 25 },
  ...[6, 7, 8, 9, 10].map(minMembers => ({ minMembers, discountPercentage: 20 + minMembers })),
];

export const MAX_DISCOUNT_PERCENTAGE = 30;
export const MAX_SAFE_RUPEES = 10_000_000; // ₹10,000,000 (1 Crore INR)
export const MAX_SAFE_PAISE = MAX_SAFE_RUPEES * 100; // 1,000,000,000 paise

/**
 * Converts INR (rupees) to exact integer paise.
 * Rejects negative, fractional, NaN, non-finite, or excessively large amounts.
 *
 * @param {number|string} rupees
 * @returns {number} Integer paise (e.g. 599.50 -> 59950)
 */
export function toPaise(rupees) {
  const num = Number(rupees);
  if (!Number.isFinite(num) || Number.isNaN(num)) {
    throw new Error(`Invalid monetary amount: expected finite number, got ${typeof rupees}: ${rupees}`);
  }
  if (num < 0) {
    throw new Error(`Monetary amount cannot be negative: ${rupees}`);
  }
  if (num > MAX_SAFE_RUPEES) {
    throw new Error(`Monetary amount exceeds safe maximum of ₹${MAX_SAFE_RUPEES}: ${rupees}`);
  }
  const paise = Math.round(num * 100);
  if (!Number.isSafeInteger(paise)) {
    throw new Error(`Paise value must be a safe integer: ${paise}`);
  }
  return paise;
}

/**
 * Converts integer paise to INR (rupees) with 2 decimal precision.
 * Enforces safe integer validation and non-negativity.
 *
 * @param {number} paise
 * @returns {number} Rupee value with decimal precision
 */
export function toRupees(paise) {
  const num = Number(paise);
  if (!Number.isFinite(num) || Number.isNaN(num)) {
    throw new Error(`Invalid paise amount: expected finite number, got ${typeof paise}: ${paise}`);
  }
  if (num < 0) {
    throw new Error(`Paise amount cannot be negative: ${paise}`);
  }
  if (!Number.isSafeInteger(num)) {
    throw new Error(`Paise amount must be a safe integer (got fractional or non-integer: ${paise})`);
  }
  if (num > MAX_SAFE_PAISE) {
    throw new Error(`Paise amount exceeds safe maximum of ${MAX_SAFE_PAISE} paise: ${paise}`);
  }
  return Number((num / 100).toFixed(2));
}

/**
 * Validates a discount tier configuration.
 *
 * @param {Array<{minMembers: number, discountPercentage: number}>} tiers
 * @param {number} [maxCap]
 * @throws {Error} If tier schema, ordering, or percentage bounds are violated
 */
export function validateDiscountTiers(tiers, maxCap = MAX_DISCOUNT_PERCENTAGE) {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new Error('Discount tiers must be a non-empty array.');
  }

  const seenMembers = new Set();

  for (const tier of tiers) {
    if (typeof tier !== 'object' || tier === null) {
      throw new Error('Each discount tier must be an object.');
    }
    const { minMembers, discountPercentage } = tier;

    if (!Number.isInteger(minMembers) || minMembers < 1) {
      throw new Error(`minMembers must be a positive integer >= 1 (got: ${minMembers}).`);
    }
    if (seenMembers.has(minMembers)) {
      throw new Error(`Duplicate tier minMembers: ${minMembers}.`);
    }
    seenMembers.add(minMembers);

    if (
      typeof discountPercentage !== 'number' ||
      !Number.isInteger(discountPercentage) ||
      discountPercentage < 0 ||
      discountPercentage > 100
    ) {
      throw new Error(
        `discountPercentage must be an integer between 0 and 100 (got: ${discountPercentage}).`
      );
    }
    if (discountPercentage > maxCap) {
      throw new Error(
        `discountPercentage (${discountPercentage}%) exceeds maximum allowed cap of ${maxCap}%.`
      );
    }
  }

  // Verify monotonicity (higher members should yield equal or higher discounts)
  const sorted = [...tiers].sort((a, b) => a.minMembers - b.minMembers);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].discountPercentage < sorted[i - 1].discountPercentage) {
      throw new Error(
        `Discount tiers must be monotonic: ${sorted[i].minMembers} members has lower discount (${sorted[i].discountPercentage}%) than ${sorted[i - 1].minMembers} members (${sorted[i - 1].discountPercentage}%).`
      );
    }
  }

  return true;
}

/**
 * Returns the configured discount percentage for a given count of active pool members.
 *
 * @param {number} memberCount - Number of active confirmed members in the pool
 * @param {Array<{minMembers: number, discountPercentage: number}>} [tiers] - Configurable tiers
 * @param {number} [maxCap] - Maximum discount ceiling allowed
 * @returns {number} Integer discount percentage (e.g. 15 for 15%)
 */
export function getDiscountPercentage(
  memberCount,
  tiers = DEFAULT_DISCOUNT_TIERS,
  maxCap = MAX_DISCOUNT_PERCENTAGE
) {
  if (typeof memberCount !== 'number' || memberCount <= 0) {
    return 0;
  }

  // Sort descending by minMembers to match highest applicable tier
  const sortedTiers = [...tiers].sort((a, b) => b.minMembers - a.minMembers);
  const matched = sortedTiers.find((tier) => memberCount >= tier.minMembers);

  const rawDiscount = matched ? matched.discountPercentage : 0;
  return Math.min(Math.max(0, Math.floor(rawDiscount)), maxCap);
}

/**
 * Calculates deterministic pricing snapshot for a service pool strictly in Integer Paise.
 *
 * @param {Object} params
 * @param {number} params.basePrice - Individual base price in INR from ServiceCategory
 * @param {number} params.memberCount - Number of active members
 * @param {Array} [params.customTiers] - Optional custom discount tiers
 * @param {number} [params.maxCap] - Optional maximum discount percentage
 * @returns {Object} Structured pricing calculation snapshot with rupee and paise metrics
 */
export function calculatePoolPricing({
  basePrice,
  memberCount,
  customTiers = DEFAULT_DISCOUNT_TIERS,
  maxCap = MAX_DISCOUNT_PERCENTAGE,
}) {
  if (typeof basePrice !== 'number' || !Number.isFinite(basePrice) || basePrice < 0) {
    throw new Error(`Invalid base price: expected non-negative finite number, got ${basePrice}`);
  }
  if (basePrice > MAX_SAFE_RUPEES) {
    throw new Error(`Base price exceeds maximum safe ceiling of ₹${MAX_SAFE_RUPEES}: ${basePrice}`);
  }

  const numMembers = Number(memberCount);
  if (!Number.isFinite(numMembers) || numMembers < 0) {
    throw new Error(`Invalid member count: expected non-negative finite number, got ${memberCount}`);
  }

  const basePricePaise = toPaise(basePrice);
  const safeMemberCount = Math.floor(numMembers);

  if (safeMemberCount === 0 || basePricePaise === 0) {
    return {
      individualBasePrice: toRupees(basePricePaise),
      basePricePaise,
      memberCount: safeMemberCount,
      discountPercentage: 0,
      finalPricePerMember: toRupees(basePricePaise),
      finalPricePaise: basePricePaise,
      totalSavingsPerMember: 0,
      totalSavingsPaise: 0,
      poolTotal: 0,
      poolTotalPaise: 0,
      currency: 'INR',
      precisionUnit: 'paise',
      calculatedAt: new Date().toISOString(),
    };
  }

  const discountPercentage = getDiscountPercentage(safeMemberCount, customTiers, maxCap);

  // Exact Integer Paise discount:
  const discountPaise = Math.floor((basePricePaise * discountPercentage) / 100);

  // Exact payable price per member in paise (guaranteed >= 0)
  const finalPricePaise = Math.max(0, basePricePaise - discountPaise);

  // Exact savings per member in paise
  const totalSavingsPaise = Math.max(0, basePricePaise - finalPricePaise);

  // Exact total pool revenue in paise
  const poolTotalPaise = finalPricePaise * safeMemberCount;

  // Invariant assertions
  if (
    !Number.isSafeInteger(basePricePaise) ||
    !Number.isSafeInteger(finalPricePaise) ||
    !Number.isSafeInteger(totalSavingsPaise) ||
    !Number.isSafeInteger(poolTotalPaise)
  ) {
    throw new Error('Pricing calculation produced non-safe integer paise values.');
  }

  if (finalPricePaise + totalSavingsPaise !== basePricePaise) {
    throw new Error(
      `Pricing invariant violation: finalPricePaise (${finalPricePaise}) + totalSavingsPaise (${totalSavingsPaise}) !== basePricePaise (${basePricePaise})`
    );
  }

  if (poolTotalPaise !== finalPricePaise * safeMemberCount) {
    throw new Error(
      `Pricing invariant violation: poolTotalPaise (${poolTotalPaise}) !== finalPricePaise (${finalPricePaise}) * safeMemberCount (${safeMemberCount})`
    );
  }

  return {
    individualBasePrice: toRupees(basePricePaise),
    basePricePaise,
    memberCount: safeMemberCount,
    discountPercentage,
    finalPricePerMember: toRupees(finalPricePaise),
    finalPricePaise,
    totalSavingsPerMember: toRupees(totalSavingsPaise),
    totalSavingsPaise,
    poolTotal: toRupees(poolTotalPaise),
    poolTotalPaise,
    currency: 'INR',
    precisionUnit: 'paise',
    calculatedAt: new Date().toISOString(),
  };
}

export const SHIFT_BONUS_PERCENTAGE = 5;

// Apply an accepted flexibility bonus to the base fare, within the existing discount cap.
export function shiftedFare(pricing, bonusPercentage = 0) {
  const totalPercent = Math.min(MAX_DISCOUNT_PERCENTAGE, pricing.discountPercentage + bonusPercentage);
  const payablePaise = pricing.basePricePaise - Math.floor(pricing.basePricePaise * totalPercent / 100);
  return { payable: toRupees(payablePaise), creditPaise: pricing.finalPricePaise - payablePaise };
}
