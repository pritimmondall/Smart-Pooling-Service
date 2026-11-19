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
  Notification,
} from '../src/models/index.js';
import {
  matchAndAssignBooking,
  removeBookingFromPool,
} from '../src/modules/pools/matching.service.js';
import { lockEligiblePools } from '../src/modules/pools/poolLock.service.js';

describe('Phase 4 Real Database Pool & Matching Integration Tests', () => {
  const TEST_PREFIX = `__POOL_TEST_${Date.now()}`;
  let category1;
  let category2;
  let userA, userB, userC, userD, userE, userFar;

  before(async () => {
    validateEnv();
    await connectDB();
    await cleanup();

    // Create test categories
    category1 = await ServiceCategory.create({
      name: 'AC Repair Test',
      slug: `${TEST_PREFIX.toLowerCase()}_ac_repair`,
      description: 'Testing pool matching',
      baseIndividualPrice: 600,
      estimatedDurationMins: 60,
      defaultPoolRadiusKm: 2.0,
      maxPoolSize: 4,
      poolLockCutoffMins: 60,
      isActive: true,
    });

    category2 = await ServiceCategory.create({
      name: 'Plumbing Test',
      slug: `${TEST_PREFIX.toLowerCase()}_plumbing`,
      description: 'Testing category isolation',
      baseIndividualPrice: 400,
      estimatedDurationMins: 45,
      defaultPoolRadiusKm: 2.0,
      maxPoolSize: 4,
      poolLockCutoffMins: 60,
      isActive: true,
    });

    // Create test customers
    const createCustomer = (name, index) =>
      User.create({
        name,
        email: `${TEST_PREFIX.toLowerCase()}_user${index}@example.com`,
        phone: `+91983000${String(index).padStart(4, '0')}`,
        passwordHash: 'hashed_password_dummy',
        role: 'customer',
      });

    userA = await createCustomer('Anil Roy', 1);
    userB = await createCustomer('Bidisha Sen', 2);
    userC = await createCustomer('Chandan Das', 3);
    userD = await createCustomer('Deepa Guha', 4);
    userE = await createCustomer('Esha Paul', 5);
    userFar = await createCustomer('Farhan Ali', 6);
  });

  after(async () => {
    await cleanup();
    await disconnectDB();
  });

  async function cleanup() {
    await User.deleteMany({ email: { $regex: new RegExp(TEST_PREFIX, 'i') } });
    await ServiceCategory.deleteMany({ slug: { $regex: new RegExp(TEST_PREFIX, 'i') } });
    await Booking.deleteMany({ notes: { $regex: new RegExp(TEST_PREFIX, 'i') } });
    await ServicePool.deleteMany({
      serviceCategoryId: { $in: [category1?._id, category2?._id].filter(Boolean) },
    });
    await PoolMembership.deleteMany({
      customerId: {
        $in: [userA?._id, userB?._id, userC?._id, userD?._id, userE?._id, userFar?._id].filter(
          Boolean
        ),
      },
    });
  }

  it('Customer A creates pool booking -> creates forming pool with 1 member at base price', async () => {
    const bookingA = await Booking.create({
      customerId: userA._id,
      serviceCategoryId: category1._id,
      location: { type: 'Point', coordinates: [88.3531, 22.5015] },
      addressText: 'Lake Gardens, Kolkata',
      timeWindow: {
        start: new Date(Date.now() + 24 * 3600 * 1000), // Tomorrow
        end: new Date(Date.now() + 27 * 3600 * 1000),   // Tomorrow + 3h
      },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: category1.baseIndividualPrice,
      notes: `${TEST_PREFIX} Booking A`,
    });

    const result = await matchAndAssignBooking(bookingA._id);
    assert.equal(result.mode, 'created');
    assert.ok(result.pool);
    assert.equal(result.pool.status, 'forming');
    assert.equal(result.pool.members.length, 1);
    assert.equal(result.pool.pricing.memberCount, 1);
    assert.equal(result.pool.pricing.discountPercentage, 0);
    assert.equal(result.pool.pricing.finalPricePerMember, 600);

    const freshBookingA = await Booking.findById(bookingA._id);
    assert.equal(String(freshBookingA.poolId), String(result.pool._id));
    assert.equal(freshBookingA.estimatedPrice, 600);

    const membership = await PoolMembership.findOne({ bookingId: bookingA._id });
    assert.ok(membership);
    assert.equal(membership.status, 'active');
  });

  it('Customer B (nearby & overlapping window) joins existing pool -> 2 members, 10% discount', async () => {
    // 300m away, overlapping time window
    const bookingB = await Booking.create({
      customerId: userB._id,
      serviceCategoryId: category1._id,
      location: { type: 'Point', coordinates: [88.3540, 22.5020] },
      addressText: 'Jodhpur Park, Kolkata',
      timeWindow: {
        start: new Date(Date.now() + 25 * 3600 * 1000), // Overlaps
        end: new Date(Date.now() + 28 * 3600 * 1000),
      },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: category1.baseIndividualPrice,
      notes: `${TEST_PREFIX} Booking B`,
    });

    const result = await matchAndAssignBooking(bookingB._id);
    assert.equal(result.mode, 'joined');
    assert.equal(result.pool.members.filter((m) => m.status === 'active').length, 2);
    assert.equal(result.pool.pricing.memberCount, 2);
    assert.equal(result.pool.pricing.discountPercentage, 10);
    assert.equal(result.pool.pricing.finalPricePerMember, 540); // 600 - 10% = 540
    assert.equal(result.pool.pricing.totalSavingsPerMember, 60);

    // Verify both bookings were updated to the pooled discount price
    const [freshA, freshB] = await Promise.all([
      Booking.findOne({ notes: `${TEST_PREFIX} Booking A` }),
      Booking.findById(bookingB._id),
    ]);
    assert.equal(freshA.estimatedPrice, 540);
    assert.equal(freshB.estimatedPrice, 540);
    assert.equal(String(freshA.poolId), String(freshB.poolId));
  });

  it('Customer Far (over 10 km away) is rejected by proximity rule -> creates separate pool', async () => {
    const bookingFar = await Booking.create({
      customerId: userFar._id,
      serviceCategoryId: category1._id,
      location: { type: 'Point', coordinates: [88.4300, 22.5800] }, // Salt Lake (~12km away)
      addressText: 'Sector V, Salt Lake, Kolkata',
      timeWindow: {
        start: new Date(Date.now() + 25 * 3600 * 1000),
        end: new Date(Date.now() + 28 * 3600 * 1000),
      },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: category1.baseIndividualPrice,
      notes: `${TEST_PREFIX} Booking Far`,
    });

    const result = await matchAndAssignBooking(bookingFar._id);
    assert.equal(result.mode, 'created', 'Must create a new pool due to distance violation');

    const bookingA = await Booking.findOne({ notes: `${TEST_PREFIX} Booking A` });
    assert.notEqual(String(result.pool._id), String(bookingA.poolId));
  });

  it('Customer with non-overlapping time window is rejected -> creates separate pool', async () => {
    const bookingDisjoint = await Booking.create({
      customerId: userC._id,
      serviceCategoryId: category1._id,
      location: { type: 'Point', coordinates: [88.3535, 22.5018] }, // Nearby
      addressText: 'Southern Avenue, Kolkata',
      timeWindow: {
        start: new Date(Date.now() + 48 * 3600 * 1000), // Day after tomorrow (disjoint)
        end: new Date(Date.now() + 51 * 3600 * 1000),
      },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: category1.baseIndividualPrice,
      notes: `${TEST_PREFIX} Booking Disjoint`,
    });

    const result = await matchAndAssignBooking(bookingDisjoint._id);
    assert.equal(result.mode, 'created', 'Must create a new pool due to time non-overlap');
  });

  it('Customer with different service category is isolated into its own pool', async () => {
    const bookingOtherCat = await Booking.create({
      customerId: userD._id,
      serviceCategoryId: category2._id, // Plumbing
      location: { type: 'Point', coordinates: [88.3533, 22.5016] }, // Nearby
      addressText: 'Lake Gardens, Kolkata',
      timeWindow: {
        start: new Date(Date.now() + 25 * 3600 * 1000),
        end: new Date(Date.now() + 28 * 3600 * 1000),
      },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: category2.baseIndividualPrice,
      notes: `${TEST_PREFIX} Booking Other Cat`,
    });

    const result = await matchAndAssignBooking(bookingOtherCat._id);
    assert.equal(result.mode, 'created');
    assert.equal(String(result.pool.serviceCategoryId), String(category2._id));
  });

  it('Pool capacity ceiling: 4th member fills pool and auto-locks; 5th member creates new pool', async () => {
    const bookingA = await Booking.findOne({ notes: `${TEST_PREFIX} Booking A` });
    const poolId = bookingA.poolId;

    // Add 3rd member
    const booking3 = await Booking.create({
      customerId: userC._id,
      serviceCategoryId: category1._id,
      location: { type: 'Point', coordinates: [88.3532, 22.5017] },
      addressText: 'Lake Gardens 3, Kolkata',
      timeWindow: {
        start: new Date(Date.now() + 25 * 3600 * 1000),
        end: new Date(Date.now() + 27 * 3600 * 1000),
      },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: category1.baseIndividualPrice,
      notes: `${TEST_PREFIX} Booking 3`,
    });
    const res3 = await matchAndAssignBooking(booking3._id);
    assert.equal(res3.mode, 'joined');
    assert.equal(String(res3.pool._id), String(poolId));
    assert.equal(res3.pool.pricing.memberCount, 3);
    assert.equal(res3.pool.pricing.discountPercentage, 15);
    assert.equal(res3.pool.pricing.finalPricePerMember, 510);

    // Add 4th member (hits maxCapacity 4)
    const booking4 = await Booking.create({
      customerId: userD._id,
      serviceCategoryId: category1._id,
      location: { type: 'Point', coordinates: [88.3536, 22.5019] },
      addressText: 'Lake Gardens 4, Kolkata',
      timeWindow: {
        start: new Date(Date.now() + 25 * 3600 * 1000),
        end: new Date(Date.now() + 27 * 3600 * 1000),
      },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: category1.baseIndividualPrice,
      notes: `${TEST_PREFIX} Booking 4`,
    });
    const res4 = await matchAndAssignBooking(booking4._id);
    assert.equal(res4.mode, 'joined');
    assert.equal(String(res4.pool._id), String(poolId));
    assert.equal(res4.pool.members.filter((m) => m.status === 'active').length, 4);
    assert.equal(res4.pool.pricing.memberCount, 4);
    assert.equal(res4.pool.pricing.discountPercentage, 20);
    assert.equal(res4.pool.pricing.finalPricePerMember, 480);
    assert.equal(res4.pool.status, 'locked', 'Pool must auto-lock upon reaching maxCapacity');

    // Attempt 5th member in the same area and window: cannot join locked/full pool!
    const booking5 = await Booking.create({
      customerId: userE._id,
      serviceCategoryId: category1._id,
      location: { type: 'Point', coordinates: [88.3534, 22.5018] },
      addressText: 'Lake Gardens 5, Kolkata',
      timeWindow: {
        start: new Date(Date.now() + 25 * 3600 * 1000),
        end: new Date(Date.now() + 27 * 3600 * 1000),
      },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: category1.baseIndividualPrice,
      notes: `${TEST_PREFIX} Booking 5`,
    });
    const res5 = await matchAndAssignBooking(booking5._id);
    assert.equal(res5.mode, 'created', '5th booking must create a new pool because Pool 1 is full');
    assert.notEqual(String(res5.pool._id), String(poolId));
  });

  it('Individual-mode booking is excluded from pooling', async () => {
    const bookingIndiv = await Booking.create({
      customerId: userA._id,
      serviceCategoryId: category1._id,
      location: { type: 'Point', coordinates: [88.3531, 22.5015] },
      addressText: 'Solo House',
      timeWindow: {
        start: new Date(Date.now() + 25 * 3600 * 1000),
        end: new Date(Date.now() + 27 * 3600 * 1000),
      },
      bookingMode: 'individual',
      status: 'pending',
      estimatedPrice: category1.baseIndividualPrice,
      notes: `${TEST_PREFIX} Individual`,
    });

    const result = await matchAndAssignBooking(bookingIndiv._id);
    assert.equal(result.mode, 'individual');
    assert.equal(result.pool, null);

    const fresh = await Booking.findById(bookingIndiv._id);
    assert.equal(fresh.poolId, null);
    assert.equal(fresh.estimatedPrice, category1.baseIndividualPrice);
  });

  it('Cancellation removes member and recalculates remaining pool members and pricing', async () => {
    const booking4 = await Booking.findOne({ notes: `${TEST_PREFIX} Booking 4` });
    const poolBefore = await ServicePool.findById(booking4.poolId);
    assert.equal(poolBefore.members.filter((m) => m.status === 'active').length, 4);

    // Cancel booking 4
    await removeBookingFromPool(booking4._id);

    const poolAfter = await ServicePool.findById(poolBefore._id);
    const activeRemaining = poolAfter.members.filter((m) => m.status === 'active');
    assert.equal(activeRemaining.length, 3);
    assert.equal(poolAfter.pricing.memberCount, 3);
    assert.equal(poolAfter.pricing.discountPercentage, 15);
    assert.equal(poolAfter.pricing.finalPricePerMember, 510);

    // Remaining active bookings must have updated price
    const bookingA = await Booking.findOne({ notes: `${TEST_PREFIX} Booking A` });
    assert.equal(bookingA.estimatedPrice, 510);

    // Membership for booking 4 marked cancelled
    const mem4 = await PoolMembership.findOne({ bookingId: booking4._id });
    assert.equal(mem4.status, 'cancelled');
  });

  it('Idempotent pool locking evaluates expired pools and locks them cleanly', async () => {
    // Create an expired forming pool
    const expiredCutoff = new Date(Date.now() - 5 * 60 * 1000); // 5 mins in past
    const poolExpired = await ServicePool.create({
      serviceCategoryId: category1._id,
      status: 'forming',
      maxCapacity: 4,
      poolRadiusKm: 2,
      centroidLocation: { type: 'Point', coordinates: [88.35, 22.50] },
      aggregateTimeWindow: {
        start: new Date(Date.now() + 10 * 60 * 1000),
        end: new Date(Date.now() + 120 * 60 * 1000),
      },
      lockCutoffTime: expiredCutoff,
      members: [
        {
          bookingId: new mongoose.Types.ObjectId(),
          customerId: userA._id,
          location: { type: 'Point', coordinates: [88.35, 22.50] },
          status: 'active',
        },
        {
          bookingId: new mongoose.Types.ObjectId(),
          customerId: userB._id,
          location: { type: 'Point', coordinates: [88.35, 22.50] },
          status: 'active',
        },
      ],
      pricing: {
        individualBasePrice: 600,
        memberCount: 2,
        discountPercentage: 10,
        finalPricePerMember: 540,
        totalSavingsPerMember: 60,
      },
    });

    const lockResult = await lockEligiblePools();
    assert.ok(lockResult.lockedCount >= 1);

    const freshPool = await ServicePool.findById(poolExpired._id);
    assert.equal(freshPool.status, 'locked');

    // Run lockEligiblePools a second time (verifies idempotency)
    const secondRun = await lockEligiblePools();
    const freshAgain = await ServicePool.findById(poolExpired._id);
    assert.equal(freshAgain.status, 'locked');
  });
});
