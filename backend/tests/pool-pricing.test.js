import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toPaise,
  toRupees,
  validateDiscountTiers,
  getDiscountPercentage,
  calculatePoolPricing,
  DEFAULT_DISCOUNT_TIERS,
  MAX_DISCOUNT_PERCENTAGE,
} from '../src/modules/pools/pricing.service.js';

describe('Phase 4 Dynamic Pricing Engine Suite', () => {
  it('converts correctly between rupees and integer paise', () => {
    assert.equal(toPaise(600), 60000);
    assert.equal(toPaise(599.5), 59950);
    assert.equal(toPaise(0), 0);
    assert.throws(() => toPaise(-50), /cannot be negative/);
    assert.throws(() => toPaise('invalid'), /Invalid monetary amount/);

    assert.equal(toRupees(60000), 600);
    assert.equal(toRupees(59950), 599.5);
    assert.equal(toRupees(53910), 539.1);
    assert.equal(toRupees(0), 0);
    assert.throws(() => toRupees(-100), /cannot be negative/);
    assert.throws(() => toRupees(123.45), /must be a safe integer/);
  });

  it('validates discount tier configurations strictly', () => {
    // Valid tiers
    assert.equal(validateDiscountTiers(DEFAULT_DISCOUNT_TIERS), true);

    // Rejects non-array
    assert.throws(() => validateDiscountTiers('invalid'), /must be a non-empty array/);

    // Rejects empty array
    assert.throws(() => validateDiscountTiers([]), /must be a non-empty array/);

    // Rejects negative members
    assert.throws(
      () => validateDiscountTiers([{ minMembers: -1, discountPercentage: 10 }]),
      /positive integer/
    );

    // Rejects duplicate minMembers
    assert.throws(
      () =>
        validateDiscountTiers([
          { minMembers: 2, discountPercentage: 10 },
          { minMembers: 2, discountPercentage: 15 },
        ]),
      /Duplicate tier minMembers/
    );

    // Rejects excessive percentage > maxCap
    assert.throws(
      () => validateDiscountTiers([{ minMembers: 2, discountPercentage: 45 }], 30),
      /exceeds maximum allowed cap/
    );

    // Rejects non-monotonic tiers (higher count having lower discount)
    assert.throws(
      () =>
        validateDiscountTiers([
          { minMembers: 2, discountPercentage: 20 },
          { minMembers: 3, discountPercentage: 10 },
        ]),
      /must be monotonic/
    );
  });

  it('returns 0% discount for a 1-member pool', () => {
    const discount = getDiscountPercentage(1);
    assert.equal(discount, 0);

    const pricing = calculatePoolPricing({ basePrice: 600, memberCount: 1 });
    assert.equal(pricing.individualBasePrice, 600);
    assert.equal(pricing.basePricePaise, 60000);
    assert.equal(pricing.memberCount, 1);
    assert.equal(pricing.discountPercentage, 0);
    assert.equal(pricing.finalPricePerMember, 600);
    assert.equal(pricing.finalPricePaise, 60000);
    assert.equal(pricing.totalSavingsPerMember, 0);
    assert.equal(pricing.totalSavingsPaise, 0);
    assert.equal(pricing.poolTotal, 600);
    assert.equal(pricing.poolTotalPaise, 60000);
    assert.equal(pricing.currency, 'INR');
    assert.equal(pricing.precisionUnit, 'paise');
  });

  it('calculates 10% discount for a 2-member pool with exact integer paise precision', () => {
    const discount = getDiscountPercentage(2);
    assert.equal(discount, 10);

    const pricing = calculatePoolPricing({ basePrice: 500, memberCount: 2 });
    assert.equal(pricing.individualBasePrice, 500);
    assert.equal(pricing.basePricePaise, 50000);
    assert.equal(pricing.memberCount, 2);
    assert.equal(pricing.discountPercentage, 10);
    assert.equal(pricing.finalPricePerMember, 450);
    assert.equal(pricing.finalPricePaise, 45000);
    assert.equal(pricing.totalSavingsPerMember, 50);
    assert.equal(pricing.totalSavingsPaise, 5000);
    assert.equal(pricing.poolTotal, 900);
    assert.equal(pricing.poolTotalPaise, 90000);
  });

  it('calculates higher membership tiers (3, 4, 5 members)', () => {
    // 3 members: 15%
    const pricing3 = calculatePoolPricing({ basePrice: 1000, memberCount: 3 });
    assert.equal(pricing3.discountPercentage, 15);
    assert.equal(pricing3.finalPricePerMember, 850);
    assert.equal(pricing3.finalPricePaise, 85000);
    assert.equal(pricing3.totalSavingsPerMember, 150);
    assert.equal(pricing3.poolTotal, 2550);

    // 4 members: 20%
    const pricing4 = calculatePoolPricing({ basePrice: 1000, memberCount: 4 });
    assert.equal(pricing4.discountPercentage, 20);
    assert.equal(pricing4.finalPricePerMember, 800);
    assert.equal(pricing4.finalPricePaise, 80000);
    assert.equal(pricing4.totalSavingsPerMember, 200);
    assert.equal(pricing4.poolTotal, 3200);

    // 5 members: 25%
    const pricing5 = calculatePoolPricing({ basePrice: 1000, memberCount: 5 });
    assert.equal(pricing5.discountPercentage, 25);
    assert.equal(pricing5.finalPricePerMember, 750);
    assert.equal(pricing5.finalPricePaise, 75000);
    assert.equal(pricing5.totalSavingsPerMember, 250);
    assert.equal(pricing5.poolTotal, 3750);
  });

  it('enforces maximum discount cap even if custom tier exceeds policy limit', () => {
    const aggressiveTiers = [
      { minMembers: 1, discountPercentage: 0 },
      { minMembers: 2, discountPercentage: 50 }, // Exceeds default 30% cap
    ];

    const discount = getDiscountPercentage(2, aggressiveTiers, 30);
    assert.equal(discount, 30, 'Discount must be capped at 30% maximum ceiling');

    const pricing = calculatePoolPricing({
      basePrice: 1000,
      memberCount: 2,
      customTiers: aggressiveTiers,
      maxCap: 30,
    });
    assert.equal(pricing.discountPercentage, 30);
    assert.equal(pricing.finalPricePerMember, 700);
    assert.equal(pricing.finalPricePaise, 70000);
  });

  it('guarantees prices never become negative', () => {
    const pricingZero = calculatePoolPricing({ basePrice: 0, memberCount: 4 });
    assert.equal(pricingZero.finalPricePerMember, 0);
    assert.equal(pricingZero.finalPricePaise, 0);
    assert.equal(pricingZero.totalSavingsPerMember, 0);

    assert.throws(() => calculatePoolPricing({ basePrice: -200, memberCount: 2 }), /Invalid base price/);
  });

  it('eliminates floating point precision errors with exact integer paise calculations', () => {
    // 599 * 0.90 = 539.10 (53910 paise)
    const pricing = calculatePoolPricing({ basePrice: 599, memberCount: 2 });
    assert.equal(pricing.basePricePaise, 59900);
    assert.equal(pricing.finalPricePaise, 53910);
    assert.equal(pricing.finalPricePerMember, 539.1);
    assert.equal(pricing.totalSavingsPaise, 5990);
    assert.equal(pricing.totalSavingsPerMember, 59.9);

    // 799 * 0.85 = 679.15 (67915 paise)
    const pricing3 = calculatePoolPricing({ basePrice: 799, memberCount: 3 });
    assert.equal(pricing3.basePricePaise, 79900);
    assert.equal(pricing3.finalPricePaise, 67915);
    assert.equal(pricing3.finalPricePerMember, 679.15);
    assert.equal(pricing3.totalSavingsPaise, 11985);
    assert.equal(pricing3.totalSavingsPerMember, 119.85);
  });

  it('handles cancellation to 0 members gracefully', () => {
    const pricing = calculatePoolPricing({ basePrice: 500, memberCount: 0 });
    assert.equal(pricing.memberCount, 0);
    assert.equal(pricing.discountPercentage, 0);
    assert.equal(pricing.finalPricePerMember, 500);
    assert.equal(pricing.finalPricePaise, 50000);
    assert.equal(pricing.totalSavingsPerMember, 0);
    assert.equal(pricing.poolTotal, 0);
  });
});
