import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { connectDB, disconnectDB } from '../src/config/db.js';
import {
  User,
  ServiceCategory,
  Booking,
  ServicePool,
  PoolMembership,
} from '../src/models/index.js';
import { matchAndAssignBooking } from '../src/modules/pools/matching.service.js';

describe('Phase 4B Concurrent Compatible Pool Creation Suite', () => {
  const TEST_PREFIX = `__CONCURR_CREATE_${Date.now()}`;
  let category;
  let customers = [];
  let database;
  let round = 0;

  before(async () => {
    database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await connectDB(database.getUri());
  });

  beforeEach(async () => {
    round++;
    customers = [];

    category = await ServiceCategory.create({
      name: 'Concurrent Creation Category',
      slug: `${TEST_PREFIX.toLowerCase()}_cat_${round}`,
      description: 'Testing race conditions when 0 pools exist initially',
      baseIndividualPrice: 600,
      estimatedDurationMins: 45,
      defaultPoolRadiusKm: 2.0,
      maxPoolSize: 4,
      poolLockCutoffMins: 60,
      isActive: true,
    });

    for (let i = 1; i <= 4; i++) {
      const u = await User.create({
        name: `Race Customer ${i}`,
        email: `${TEST_PREFIX.toLowerCase()}_${round}_u${i}@example.com`,
        phone: `+9197770${round}${String(i).padStart(4, '0')}`,
        passwordHash: '$2a$10$abcdefghijklmnopqrstuvwxyz123456',
        role: 'customer',
      });
      customers.push(u);
    }
  });

  after(async () => {
    await disconnectDB();
    await database?.stop();
  });

  async function createCompatibleBookings() {
    // Create 3 compatible bookings nearby (within 160 m) with identical time window
    const startTime = new Date(Date.now() + 24 * 3600 * 1000);
    const endTime = new Date(Date.now() + 27 * 3600 * 1000);

    const bookingPromises = [customers[0], customers[1], customers[2]].map((cust, idx) =>
      Booking.create({
        customerId: cust._id,
        serviceCategoryId: category._id,
        location: {
          type: 'Point',
          coordinates: [88.3531 + idx * 0.0005, 22.5015 + idx * 0.0005],
        },
        addressText: `Simultaneous Address ${idx + 1}, Kolkata`,
        timeWindow: { start: startTime, end: endTime },
        bookingMode: 'pool',
        status: 'pending',
        estimatedPrice: category.baseIndividualPrice,
        notes: `${TEST_PREFIX} Simultaneous Booking ${idx + 1}`,
      })
    );

    return Promise.all(bookingPromises);
  }

  it('Start with 0 pools: Simultaneous compatible requests from 3 customers create EXACTLY 1 shared pool, NOT multiple duplicate pools', async () => {
    // Verify 0 pools exist initially for this category
    const initialPoolCount = await ServicePool.countDocuments({ serviceCategoryId: category._id });
    assert.equal(initialPoolCount, 0, 'Must start with 0 pools');

    const createdBookings = await createCompatibleBookings();
    assert.equal(createdBookings.length, 3);

    // Fire matchAndAssignBooking for ALL 3 bookings simultaneously in parallel!
    const results = await Promise.all(
      createdBookings.map((b) => matchAndAssignBooking(b._id))
    );

    assert.equal(results.length, 3);

    // CRITICAL ASSERTION: Exactly 1 pool must have been created in the database for this category!
    const pools = await ServicePool.find({ serviceCategoryId: category._id });
    assert.equal(
      pools.length,
      1,
      `Expected exactly 1 shared pool to be created, but found ${pools.length} duplicate pools!`
    );

    const sharedPool = pools[0];
    const activeMembers = sharedPool.members.filter((m) => m.status === 'active');
    assert.equal(activeMembers.length, 3, 'Shared pool must contain all 3 concurrent bookings');

    // Verify all 3 bookings are linked to this SAME shared pool
    const reloadedBookings = await Booking.find({
      _id: { $in: createdBookings.map((b) => b._id) },
    });
    for (const b of reloadedBookings) {
      assert.equal(
        String(b.poolId),
        String(sharedPool._id),
        'Every booking must reference the single shared pool'
      );
      assert.equal(
        b.estimatedPrice,
        510, // 600 - 15% (3 members) = 510
        'Every booking price must be updated to the 3-member tier price (₹510)'
      );
    }

    // Verify database-level membership uniqueness
    const memberships = await PoolMembership.find({
      bookingId: { $in: createdBookings.map((b) => b._id) },
      status: 'active',
    });
    assert.equal(memberships.length, 3, 'Exactly 3 active memberships must exist');
    const uniqueBookings = new Set(memberships.map((m) => String(m.bookingId)));
    assert.equal(uniqueBookings.size, 3, 'No booking may belong to more than 1 active pool');
  });

  it('Two concurrent requests attempting to fill the last available slot (capacity = 4) cannot exceed capacity', async () => {
    const initialBookings = await createCompatibleBookings();
    for (const booking of initialBookings) await matchAndAssignBooking(booking._id);
    const pool = await ServicePool.findOne({ serviceCategoryId: category._id });
    assert.equal(pool.members.filter((m) => m.status === 'active').length, 3);
    assert.equal(pool.maxCapacity, 4);

    // Create 2 additional customers (Customer 4 and an extra Customer 5)
    const extraCustomer = await User.create({
      name: 'Extra Race Customer',
      email: `${TEST_PREFIX.toLowerCase()}_extra@example.com`,
      phone: '+919777999999',
      passwordHash: '$2a$10$abcdefghijklmnopqrstuvwxyz123456',
      role: 'customer',
    });

    const startTime = new Date(Date.now() + 24 * 3600 * 1000);
    const endTime = new Date(Date.now() + 27 * 3600 * 1000);

    const booking4 = await Booking.create({
      customerId: customers[3]._id,
      serviceCategoryId: category._id,
      location: { type: 'Point', coordinates: [88.3533, 22.5017] },
      addressText: 'Contender 1 Address',
      timeWindow: { start: startTime, end: endTime },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: 600,
      notes: `${TEST_PREFIX} Contender 1`,
    });

    const booking5 = await Booking.create({
      customerId: extraCustomer._id,
      serviceCategoryId: category._id,
      location: { type: 'Point', coordinates: [88.3534, 22.5018] },
      addressText: 'Contender 2 Address',
      timeWindow: { start: startTime, end: endTime },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: 600,
      notes: `${TEST_PREFIX} Contender 2`,
    });

    // Fire both matchAndAssignBooking calls concurrently to race for the 1 remaining slot
    const contenders = await Promise.all([
      matchAndAssignBooking(booking4._id),
      matchAndAssignBooking(booking5._id),
    ]);

    // Inspect the original pool
    const originalPoolAfter = await ServicePool.findById(pool._id);
    const activeInOrig = originalPoolAfter.members.filter((m) => m.status === 'active');

    // CAPACITY CEILING ASSERTION: Must NOT exceed maxCapacity 4
    assert.equal(
      activeInOrig.length,
      4,
      `Original pool capacity must equal exactly 4 (found: ${activeInOrig.length})`
    );
    assert.equal(originalPoolAfter.status, 'locked', 'Pool must auto-lock upon reaching capacity 4');

    // The other request must have cleanly formed or joined a new pool
    const allPools = await ServicePool.find({ serviceCategoryId: category._id });
    assert.equal(allPools.length, 2, 'Total pools should now be 2');

    assert.equal(contenders.filter(result => result.pool.id === pool.id).length, 1);
  });
});
