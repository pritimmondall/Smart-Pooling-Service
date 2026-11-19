import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { validateEnv } from '../src/config/env.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import {
  User,
  ServiceCategory,
  Booking,
  ServicePool,
  PoolMembership,
} from '../src/models/index.js';
import { matchAndAssignBooking } from '../src/modules/pools/matching.service.js';

describe('Phase 4B Transaction Failure and Rollback Suite (MongoDB Atlas)', () => {
  const TEST_PREFIX = `__ROLLBACK_TEST_${Date.now()}`;
  let category;
  let user1, user2;

  before(async () => {
    validateEnv();
    await connectDB();
    await cleanup();

    category = await ServiceCategory.create({
      name: 'Rollback Test Category',
      slug: `${TEST_PREFIX.toLowerCase()}_cat`,
      description: 'Testing ACID rollback integrity',
      baseIndividualPrice: 500,
      estimatedDurationMins: 45,
      defaultPoolRadiusKm: 2.0,
      maxPoolSize: 4,
      poolLockCutoffMins: 60,
      isActive: true,
    });

    user1 = await User.create({
      name: 'Rollback User 1',
      email: `${TEST_PREFIX.toLowerCase()}@example.com`,
      phone: '+919900010001',
      passwordHash: '$2a$10$abcdefghijklmnopqrstuvwxyz123456',
      role: 'customer',
    });

    user2 = await User.create({
      name: 'Rollback User 2',
      email: `${TEST_PREFIX.toLowerCase()}_u2@example.com`,
      phone: '+919900010002',
      passwordHash: '$2a$10$abcdefghijklmnopqrstuvwxyz123456',
      role: 'customer',
    });
  });

  after(async () => {
    await cleanup();
    await disconnectDB();
  });

  async function cleanup() {
    await User.deleteMany({ email: { $regex: new RegExp(TEST_PREFIX, 'i') } });
    await ServiceCategory.deleteMany({ slug: { $regex: new RegExp(TEST_PREFIX, 'i') } });
    await Booking.deleteMany({ notes: { $regex: new RegExp(TEST_PREFIX, 'i') } });
    if (category) {
      await ServicePool.deleteMany({ serviceCategoryId: category._id });
    }
    await PoolMembership.deleteMany({
      customerId: { $in: [user1?._id, user2?._id].filter(Boolean) },
    });
  }

  it('Stage 1 Failure: Rollback after updating ServicePool member list leaves 0 partial records', async () => {
    // 1. Seed initial pool with User 1
    const seedBooking = await Booking.create({
      customerId: user1._id,
      serviceCategoryId: category._id,
      location: { type: 'Point', coordinates: [88.3531, 22.5015] },
      addressText: 'Lake Gardens, Kolkata',
      timeWindow: {
        start: new Date(Date.now() + 24 * 3600 * 1000),
        end: new Date(Date.now() + 27 * 3600 * 1000),
      },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: 500,
      notes: `${TEST_PREFIX} Seed`,
    });
    const seedResult = await matchAndAssignBooking(seedBooking._id);
    const initialPoolId = seedResult.pool._id;

    // Verify initial pool has 1 member
    const poolBefore = await ServicePool.findById(initialPoolId);
    assert.equal(poolBefore.members.length, 1);

    // 2. User 2 creates booking and joins, but failure injected AFTER pool update
    const targetBooking = await Booking.create({
      customerId: user2._id,
      serviceCategoryId: category._id,
      location: { type: 'Point', coordinates: [88.3535, 22.5018] },
      addressText: 'Lake Gardens 2, Kolkata',
      timeWindow: {
        start: new Date(Date.now() + 25 * 3600 * 1000),
        end: new Date(Date.now() + 28 * 3600 * 1000),
      },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: 500,
      notes: `${TEST_PREFIX} Stage 1 Target`,
    });

    await assert.rejects(
      () =>
        matchAndAssignBooking(targetBooking._id, {
          injectFailureAt: 'after_pool_update',
        }),
      /Simulated failure after_pool_update/
    );

    // 3. Inspect post-rollback state: must be 100% clean
    const poolAfter = await ServicePool.findById(initialPoolId);
    assert.equal(poolAfter.members.length, 1, 'Pool members must remain at 1 after rollback');
    assert.equal(poolAfter.pricing.memberCount, 1, 'Pool pricing memberCount must remain 1');

    const membership = await PoolMembership.findOne({ bookingId: targetBooking._id });
    assert.equal(membership, null, 'No PoolMembership record must exist for aborted booking');

    const freshBooking = await Booking.findById(targetBooking._id);
    assert.equal(freshBooking.poolId, null, 'Booking.poolId must remain null');
    assert.equal(freshBooking.estimatedPrice, 500, 'Booking price must remain base price');
  });

  it('Stage 2 Failure: Rollback after creating PoolMembership cleans up membership & pool state', async () => {
    const targetBooking = await Booking.create({
      customerId: user2._id,
      serviceCategoryId: category._id,
      location: { type: 'Point', coordinates: [88.3535, 22.5018] },
      addressText: 'Lake Gardens 2, Kolkata',
      timeWindow: {
        start: new Date(Date.now() + 25 * 3600 * 1000),
        end: new Date(Date.now() + 28 * 3600 * 1000),
      },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: 500,
      notes: `${TEST_PREFIX} Stage 2 Target`,
    });

    await assert.rejects(
      () =>
        matchAndAssignBooking(targetBooking._id, {
          injectFailureAt: 'after_membership_create',
        }),
      /Simulated failure after_membership_create/
    );

    const membership = await PoolMembership.findOne({ bookingId: targetBooking._id });
    assert.equal(membership, null, 'PoolMembership created inside transaction must be rolled back');

    const pools = await ServicePool.find({ serviceCategoryId: category._id });
    const poolWithMember = pools.find((p) =>
      p.members.some((m) => String(m.bookingId) === String(targetBooking._id))
    );
    assert.equal(poolWithMember, undefined, 'No pool may contain the aborted booking in its members array');
  });

  it('Stage 3 Failure: Rollback after updating Booking leaves consistent pricing and references', async () => {
    const targetBooking = await Booking.create({
      customerId: user2._id,
      serviceCategoryId: category._id,
      location: { type: 'Point', coordinates: [88.3535, 22.5018] },
      addressText: 'Lake Gardens 2, Kolkata',
      timeWindow: {
        start: new Date(Date.now() + 25 * 3600 * 1000),
        end: new Date(Date.now() + 28 * 3600 * 1000),
      },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: 500,
      notes: `${TEST_PREFIX} Stage 3 Target`,
    });

    await assert.rejects(
      () =>
        matchAndAssignBooking(targetBooking._id, {
          injectFailureAt: 'after_booking_update',
        }),
      /Simulated failure after_booking_update/
    );

    const freshBooking = await Booking.findById(targetBooking._id);
    assert.equal(freshBooking.poolId, null, 'Booking.poolId must be rolled back to null');
    assert.equal(freshBooking.estimatedPrice, 500, 'Booking price must be rolled back to base price');
  });

  it('Stage 4 Failure: Rollback during pricing recalculation prevents inconsistent ledger', async () => {
    const targetBooking = await Booking.create({
      customerId: user2._id,
      serviceCategoryId: category._id,
      location: { type: 'Point', coordinates: [88.3535, 22.5018] },
      addressText: 'Lake Gardens 2, Kolkata',
      timeWindow: {
        start: new Date(Date.now() + 25 * 3600 * 1000),
        end: new Date(Date.now() + 28 * 3600 * 1000),
      },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: 500,
      notes: `${TEST_PREFIX} Stage 4 Target`,
    });

    await assert.rejects(
      () =>
        matchAndAssignBooking(targetBooking._id, {
          injectFailureAt: 'during_pricing_recalc',
        }),
      /Simulated failure during_pricing_recalc/
    );

    const freshBooking = await Booking.findById(targetBooking._id);
    assert.equal(freshBooking.poolId, null);
    const membership = await PoolMembership.findOne({ bookingId: targetBooking._id });
    assert.equal(membership, null);
  });
});
