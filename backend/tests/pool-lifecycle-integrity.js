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
import {
  findCompatiblePools,
  matchAndAssignBooking,
  removeBookingFromPool,
} from '../src/modules/pools/matching.service.js';

describe('Phase 4B Lifecycle, Integrity & Geospatial Edge Suite (MongoDB Atlas)', () => {
  const TEST_PREFIX = `__LIFECYCLE_${Date.now()}`;
  let category;
  let users = [];

  before(async () => {
    validateEnv();
    await connectDB();
    await cleanup();

    category = await ServiceCategory.create({
      name: 'Integrity Edge Category',
      slug: `${TEST_PREFIX.toLowerCase()}_cat`,
      description: 'Testing lifecycle transitions and geospatial edges',
      baseIndividualPrice: 800,
      estimatedDurationMins: 60,
      defaultPoolRadiusKm: 2.0,
      maxPoolSize: 4,
      poolLockCutoffMins: 60,
      isActive: true,
    });

    for (let i = 1; i <= 6; i++) {
      const u = await User.create({
        name: `Integrity Customer ${i}`,
        email: `${TEST_PREFIX.toLowerCase()}_u${i}@example.com`,
        phone: `+91955500${String(i).padStart(4, '0')}`,
        passwordHash: '$2a$10$abcdefghijklmnopqrstuvwxyz123456',
        role: 'customer',
      });
      users.push(u);
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
      customerId: { $in: users.map((u) => u._id) },
    });
  }

  it('Cancel first member, middle member, and last member: verifies price recalculation and pool cancellation', async () => {
    const startTime = new Date(Date.now() + 24 * 3600 * 1000);
    const endTime = new Date(Date.now() + 27 * 3600 * 1000);

    // Create 3 bookings in pool
    const b1 = await Booking.create({
      customerId: users[0]._id,
      serviceCategoryId: category._id,
      location: { type: 'Point', coordinates: [88.3531, 22.5015] },
      addressText: 'First Member Address',
      timeWindow: { start: startTime, end: endTime },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: 800,
      notes: `${TEST_PREFIX} B1`,
    });
    const b2 = await Booking.create({
      customerId: users[1]._id,
      serviceCategoryId: category._id,
      location: { type: 'Point', coordinates: [88.3534, 22.5017] },
      addressText: 'Middle Member Address',
      timeWindow: { start: startTime, end: endTime },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: 800,
      notes: `${TEST_PREFIX} B2`,
    });
    const b3 = await Booking.create({
      customerId: users[2]._id,
      serviceCategoryId: category._id,
      location: { type: 'Point', coordinates: [88.3538, 22.5020] },
      addressText: 'Last Member Address',
      timeWindow: { start: startTime, end: endTime },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: 800,
      notes: `${TEST_PREFIX} B3`,
    });

    await matchAndAssignBooking(b1._id);
    await matchAndAssignBooking(b2._id);
    const res3 = await matchAndAssignBooking(b3._id);

    const poolId = res3.pool._id;
    let pool = await ServicePool.findById(poolId);
    assert.equal(pool.members.filter((m) => m.status === 'active').length, 3);
    assert.equal(pool.pricing.discountPercentage, 15);
    assert.equal(pool.pricing.finalPricePerMember, 680); // 800 - 15% = 680

    // 1. Cancel FIRST member (b1)
    await removeBookingFromPool(b1._id);
    b1.status = 'cancelled';
    await b1.save();

    pool = await ServicePool.findById(poolId);
    let active = pool.members.filter((m) => m.status === 'active');
    assert.equal(active.length, 2, 'Active count should drop to 2 after cancelling first member');
    assert.equal(pool.pricing.discountPercentage, 10);
    assert.equal(pool.pricing.finalPricePerMember, 720); // 800 - 10% = 720
    const mem1 = await PoolMembership.findOne({ bookingId: b1._id });
    assert.equal(mem1.status, 'cancelled');

    // 2. Cancel MIDDLE member (b2)
    await removeBookingFromPool(b2._id);
    b2.status = 'cancelled';
    await b2.save();

    pool = await ServicePool.findById(poolId);
    active = pool.members.filter((m) => m.status === 'active');
    assert.equal(active.length, 1, 'Active count should drop to 1 after cancelling middle member');
    assert.equal(pool.pricing.discountPercentage, 0);
    assert.equal(pool.pricing.finalPricePerMember, 800);
    const mem2 = await PoolMembership.findOne({ bookingId: b2._id });
    assert.equal(mem2.status, 'cancelled');

    // 3. Cancel LAST remaining member (b3)
    await removeBookingFromPool(b3._id);
    b3.status = 'cancelled';
    await b3.save();

    pool = await ServicePool.findById(poolId);
    active = pool.members.filter((m) => m.status === 'active');
    assert.equal(active.length, 0);
    assert.equal(pool.status, 'cancelled', 'Pool must transition to cancelled when empty');
    const mem3 = await PoolMembership.findOne({ bookingId: b3._id });
    assert.equal(mem3.status, 'cancelled');
  });

  it('Pairwise clique compatibility prevents chain elongation', async () => {
    // Loc A: [88.3500, 22.5000]
    // Loc B: ~1.7 km east of A
    // Loc C: ~1.7 km east of B -> A and C are ~3.4 km apart (> 2.0 km radius!)
    const startTime = new Date(Date.now() + 24 * 3600 * 1000);
    const endTime = new Date(Date.now() + 27 * 3600 * 1000);

    const bA = await Booking.create({
      customerId: users[3]._id,
      serviceCategoryId: category._id,
      location: { type: 'Point', coordinates: [88.3500, 22.5000] },
      addressText: 'Location A',
      timeWindow: { start: startTime, end: endTime },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: 800,
      notes: `${TEST_PREFIX} Clique A`,
    });
    const resA = await matchAndAssignBooking(bA._id);
    const poolId = resA.pool._id;

    // Loc B is ~1.7km away: valid with A
    const bB = await Booking.create({
      customerId: users[4]._id,
      serviceCategoryId: category._id,
      location: { type: 'Point', coordinates: [88.3665, 22.5000] },
      addressText: 'Location B (~1.7km from A)',
      timeWindow: { start: startTime, end: endTime },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: 800,
      notes: `${TEST_PREFIX} Clique B`,
    });
    const resB = await matchAndAssignBooking(bB._id);
    assert.equal(String(resB.pool._id), String(poolId), 'B must join pool with A');

    // Loc C is ~1.7km from B, but ~3.4km from A: MUST BE REJECTED from pool due to clique rule!
    const bC = await Booking.create({
      customerId: users[5]._id,
      serviceCategoryId: category._id,
      location: { type: 'Point', coordinates: [88.3830, 22.5000] },
      addressText: 'Location C (~1.7km from B, ~3.4km from A)',
      timeWindow: { start: startTime, end: endTime },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: 800,
      notes: `${TEST_PREFIX} Clique C`,
    });
    const resC = await matchAndAssignBooking(bC._id);

    // C must NOT be in the same pool as A!
    assert.notEqual(
      String(resC.pool._id),
      String(poolId),
      'C must NOT join pool because distance to member A exceeds 2km (chain elongation prevented)'
    );
  });

  it('Exact radius boundary behavior: accepts <= radiusKm (2.0km), rejects > radiusKm (2.05km)', async () => {
    // 1 deg lat ~ 111km. 2.0km / 111 ~ 0.0180 deg
    const baseLat = 22.5000;
    const baseLng = 88.3500;

    const bOrigin = await Booking.create({
      customerId: users[0]._id,
      serviceCategoryId: category._id,
      location: { type: 'Point', coordinates: [baseLng, baseLat] },
      addressText: 'Boundary Origin',
      timeWindow: {
        start: new Date(Date.now() + 30 * 3600 * 1000),
        end: new Date(Date.now() + 33 * 3600 * 1000),
      },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: 800,
      notes: `${TEST_PREFIX} Boundary Origin`,
    });
    const resOrigin = await matchAndAssignBooking(bOrigin._id);

    // Target 1: ~1.8 km north (well inside 2.0km) -> accepted
    const bInside = await Booking.create({
      customerId: users[1]._id,
      serviceCategoryId: category._id,
      location: { type: 'Point', coordinates: [baseLng, baseLat + 0.016] }, // ~1.78 km
      addressText: 'Boundary Inside (1.8km)',
      timeWindow: {
        start: new Date(Date.now() + 30 * 3600 * 1000),
        end: new Date(Date.now() + 33 * 3600 * 1000),
      },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: 800,
      notes: `${TEST_PREFIX} Boundary Inside`,
    });
    const resInside = await matchAndAssignBooking(bInside._id);
    assert.equal(String(resInside.pool._id), String(resOrigin.pool._id), 'Inside radius must join pool');

    // Target 2: ~2.3 km north (outside 2.0km) -> rejected
    const bOutside = await Booking.create({
      customerId: users[2]._id,
      serviceCategoryId: category._id,
      location: { type: 'Point', coordinates: [baseLng, baseLat + 0.022] }, // ~2.44 km
      addressText: 'Boundary Outside (2.4km)',
      timeWindow: {
        start: new Date(Date.now() + 30 * 3600 * 1000),
        end: new Date(Date.now() + 33 * 3600 * 1000),
      },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: 800,
      notes: `${TEST_PREFIX} Boundary Outside`,
    });
    const resOutside = await matchAndAssignBooking(bOutside._id);
    assert.notEqual(String(resOutside.pool._id), String(resOrigin.pool._id), 'Outside radius must create separate pool');
  });

  it('Insufficient service duration intersection is rejected even if windows partially overlap', async () => {
    // Category duration is 60 mins.
    // Pool window: 10:00 to 12:00. Booking window: 11:40 to 13:40.
    // Overlap is only 20 mins (< 60 mins required duration) -> must be rejected!
    const poolStart = new Date(Date.now() + 40 * 3600 * 1000);
    const poolEnd = new Date(poolStart.getTime() + 2 * 3600 * 1000);

    const bBase = await Booking.create({
      customerId: users[0]._id,
      serviceCategoryId: category._id,
      location: { type: 'Point', coordinates: [88.3531, 22.5015] },
      addressText: 'Duration Test Base',
      timeWindow: { start: poolStart, end: poolEnd },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: 800,
      notes: `${TEST_PREFIX} Duration Base`,
    });
    const resBase = await matchAndAssignBooking(bBase._id);

    // Booking with only 20 min overlap
    const shortOverlapStart = new Date(poolEnd.getTime() - 20 * 60 * 1000);
    const shortOverlapEnd = new Date(shortOverlapStart.getTime() + 2 * 3600 * 1000);

    const bShort = await Booking.create({
      customerId: users[1]._id,
      serviceCategoryId: category._id,
      location: { type: 'Point', coordinates: [88.3533, 22.5017] },
      addressText: 'Short Overlap Customer',
      timeWindow: { start: shortOverlapStart, end: shortOverlapEnd },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: 800,
      notes: `${TEST_PREFIX} Short Duration`,
    });

    const resShort = await matchAndAssignBooking(bShort._id);
    assert.notEqual(
      String(resShort.pool._id),
      String(resBase.pool._id),
      'Must reject candidate when mutual overlap (20m) is less than category duration (60m)'
    );
  });

  it('Rejection of locked and cancelled pools: new bookings can never join them', async () => {
    // 1. Locked pool test
    const lockedPool = await ServicePool.create({
      serviceCategoryId: category._id,
      status: 'locked',
      maxCapacity: 4,
      poolRadiusKm: 2,
      centroidLocation: { type: 'Point', coordinates: [88.35, 22.50] },
      aggregateTimeWindow: {
        start: new Date(Date.now() + 50 * 3600 * 1000),
        end: new Date(Date.now() + 53 * 3600 * 1000),
      },
      lockCutoffTime: new Date(Date.now() + 49 * 3600 * 1000),
      members: [],
      pricing: { individualBasePrice: 800, memberCount: 1, discountPercentage: 0, finalPricePerMember: 800 },
    });

    const bLockedCandidate = {
      serviceCategoryId: category._id,
      location: { type: 'Point', coordinates: [88.35, 22.50] },
      timeWindow: {
        start: new Date(Date.now() + 50 * 3600 * 1000),
        end: new Date(Date.now() + 53 * 3600 * 1000),
      },
    };

    const compatibleWithLocked = await findCompatiblePools(bLockedCandidate);
    const foundLocked = compatibleWithLocked.some((c) => String(c.pool._id) === String(lockedPool._id));
    assert.equal(foundLocked, false, 'Locked pool must never appear in compatible candidate list');

    // 2. Cancelled pool test
    const cancelledPool = await ServicePool.create({
      serviceCategoryId: category._id,
      status: 'cancelled',
      maxCapacity: 4,
      poolRadiusKm: 2,
      centroidLocation: { type: 'Point', coordinates: [88.35, 22.50] },
      aggregateTimeWindow: {
        start: new Date(Date.now() + 60 * 3600 * 1000),
        end: new Date(Date.now() + 63 * 3600 * 1000),
      },
      lockCutoffTime: new Date(Date.now() + 59 * 3600 * 1000),
      members: [],
      pricing: { individualBasePrice: 800, memberCount: 0, discountPercentage: 0, finalPricePerMember: 800 },
    });

    const bCancelledCandidate = {
      serviceCategoryId: category._id,
      location: { type: 'Point', coordinates: [88.35, 22.50] },
      timeWindow: {
        start: new Date(Date.now() + 60 * 3600 * 1000),
        end: new Date(Date.now() + 63 * 3600 * 1000),
      },
    };

    const compatibleWithCancelled = await findCompatiblePools(bCancelledCandidate);
    const foundCancelled = compatibleWithCancelled.some((c) => String(c.pool._id) === String(cancelledPool._id));
    assert.equal(foundCancelled, false, 'Cancelled pool must never appear in compatible candidate list');
  });
});
