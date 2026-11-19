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

describe('Phase 4 Real Database Concurrency & Race Condition Suite', () => {
  const TEST_PREFIX = `__CONCURR_TEST_${Date.now()}`;
  let category;
  let customers = [];

  before(async () => {
    validateEnv();
    await connectDB();
    await cleanup();

    // Category with maxPoolSize = 3
    category = await ServiceCategory.create({
      name: 'Electrician Concurrency Test',
      slug: `${TEST_PREFIX.toLowerCase()}_electrician`,
      description: 'Concurrency stress testing',
      baseIndividualPrice: 500,
      estimatedDurationMins: 60,
      defaultPoolRadiusKm: 2.0,
      maxPoolSize: 3,
      poolLockCutoffMins: 60,
      isActive: true,
    });

    // Create 6 unique customers
    for (let i = 1; i <= 6; i++) {
      const user = await User.create({
        name: `Concurrent User ${i}`,
        email: `${TEST_PREFIX.toLowerCase()}_user${i}@example.com`,
        phone: `+91987654${String(i).padStart(4, '0')}`,
        passwordHash: 'dummy_hash',
        role: 'customer',
      });
      customers.push(user);
    }
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
      customerId: { $in: customers.map((c) => c._id) },
    });
  }

  it('simulates 6 concurrent booking assignments with maxPoolSize = 3 without capacity violation or double membership', async () => {
    // Pre-create 6 pending bookings for the same location and window
    const baseCoords = [88.3531, 22.5015];
    const startTime = new Date(Date.now() + 24 * 3600 * 1000);
    const endTime = new Date(Date.now() + 27 * 3600 * 1000);

    const bookingPromises = customers.map((cust, idx) =>
      Booking.create({
        customerId: cust._id,
        serviceCategoryId: category._id,
        location: {
          type: 'Point',
          // Slight jitter within 100m
          coordinates: [baseCoords[0] + idx * 0.0005, baseCoords[1] + idx * 0.0005],
        },
        addressText: `Simultaneous Address ${idx + 1}, Kolkata`,
        timeWindow: { start: startTime, end: endTime },
        bookingMode: 'pool',
        status: 'pending',
        estimatedPrice: category.baseIndividualPrice,
        notes: `${TEST_PREFIX} Simultaneous ${idx + 1}`,
      })
    );

    const createdBookings = await Promise.all(bookingPromises);
    assert.equal(createdBookings.length, 6);

    // Fire matchAndAssignBooking for ALL 6 bookings simultaneously in parallel!
    const assignmentResults = await Promise.all(
      createdBookings.map((b) => matchAndAssignBooking(b._id))
    );

    assert.equal(assignmentResults.length, 6);

    // 1. Verify every booking has a poolId
    const freshBookings = await Booking.find({
      _id: { $in: createdBookings.map((b) => b._id) },
    });
    for (const b of freshBookings) {
      assert.ok(b.poolId, `Booking ${b._id} must have poolId assigned`);
    }

    // 2. Query all pools formed
    const allPools = await ServicePool.find({ serviceCategoryId: category._id });
    assert.ok(allPools.length >= 2, 'Must create at least 2 pools since 6 requests exceed maxPoolSize 3');

    // 3. Verify NO pool ever exceeded maxPoolSize 3
    for (const pool of allPools) {
      const activeMembers = pool.members.filter((m) => m.status === 'active');
      assert.ok(
        activeMembers.length <= pool.maxCapacity,
        `Pool ${pool._id} has ${activeMembers.length} active members, exceeding maxCapacity ${pool.maxCapacity}`
      );
    }

    // 4. Verify total active members across all pools equals exactly 6
    let totalActiveMembersInPools = 0;
    for (const pool of allPools) {
      totalActiveMembersInPools += pool.members.filter((m) => m.status === 'active').length;
    }
    assert.equal(
      totalActiveMembersInPools,
      6,
      'Every concurrent booking must be accounted for exactly once in the pool member sets'
    );

    // 5. Verify database-level uniqueness in PoolMembership
    const memberships = await PoolMembership.find({
      bookingId: { $in: createdBookings.map((b) => b._id) },
      status: 'active',
    });
    assert.equal(
      memberships.length,
      6,
      'There must be exactly 6 active memberships, one per booking'
    );

    const bookingIdsInMemberships = memberships.map((m) => String(m.bookingId));
    const uniqueBookingIds = new Set(bookingIdsInMemberships);
    assert.equal(
      uniqueBookingIds.size,
      6,
      'No booking may belong to more than one active membership'
    );

    // 6. Verify pricing consistency: each booking price matches its pool finalPricePerMember
    for (const b of freshBookings) {
      const pool = allPools.find((p) => String(p._id) === String(b.poolId));
      assert.ok(pool);
      assert.equal(
        b.estimatedPrice,
        pool.pricing.finalPricePerMember,
        'Booking estimated price must match the pool final price per member'
      );
    }
  });
});
