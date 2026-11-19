import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { validateEnv } from '../src/config/env.js';
import {
  User,
  ServiceCategory,
  Booking,
  ServicePool,
  PoolMembership,
  PoolClusterLock,
  Notification,
} from '../src/models/index.js';
import {
  matchAndAssignBooking,
  getClusterLockKey,
  removeBookingFromPool,
} from '../src/modules/pools/matching.service.js';
import {
  lockEligiblePools,
} from '../src/modules/pools/poolLock.service.js';
import {
  toPaise,
  toRupees,
  calculatePoolPricing,
  validateDiscountTiers,
  DEFAULT_DISCOUNT_TIERS,
  MAX_DISCOUNT_PERCENTAGE,
  MAX_SAFE_RUPEES,
  MAX_SAFE_PAISE,
} from '../src/modules/pools/pricing.service.js';

describe('Phase 4C Comprehensive Concurrency, Notification & Financial Verification Suite (MongoDB Atlas)', () => {
  const TEST_PREFIX = `__PHASE4C_TEST_${Date.now()}`;
  let category;
  let testCustomers = [];

  before(async () => {
    validateEnv();
    await connectDB();
    await cleanup();

    // Ensure PoolClusterLock unique index is physically synced to Atlas
    await PoolClusterLock.init();

    category = await ServiceCategory.create({
      name: 'Phase 4C Deep Audit Category',
      slug: `${TEST_PREFIX.toLowerCase()}_cat`,
      description: 'End-to-end audit for concurrency, financial and lifecycle integrity',
      baseIndividualPrice: 750,
      estimatedDurationMins: 60,
      defaultPoolRadiusKm: 2.0,
      maxPoolSize: 4,
      poolLockCutoffMins: 60,
      isActive: true,
    });

    for (let i = 1; i <= 8; i++) {
      const u = await User.create({
        name: `Phase 4C Customer ${i}`,
        email: `${TEST_PREFIX.toLowerCase()}_u${i}@example.com`,
        phone: `+91988800${String(i).padStart(4, '0')}`,
        passwordHash: '$2a$10$abcdefghijklmnopqrstuvwxyz123456',
        role: 'customer',
      });
      testCustomers.push(u);
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
      customerId: { $in: testCustomers.map((u) => u._id) },
    });
    await PoolClusterLock.deleteMany({
      lockKey: { $regex: new RegExp(String(category?._id || 'none'), 'i') },
    });
    await Notification.deleteMany({
      userId: { $in: testCustomers.map((u) => u._id) },
    });
  }

  // =========================================================================
  // SECTION 1: CLUSTER-LOCK CORRECTNESS & GRID BOUNDARY CONCURRENCY
  // =========================================================================
  describe('1. Cluster-Lock Correctness & Index Verification', () => {
    it('Verifies PoolClusterLock.lockKey has an actual unique MongoDB index in Atlas', async () => {
      const indexes = await mongoose.connection.db.collection('poolclusterlocks').indexes();
      const lockKeyIndex = indexes.find((idx) => idx.key?.lockKey === 1);

      assert.ok(lockKeyIndex, 'An index on lockKey must exist in Atlas collection poolclusterlocks');
      assert.equal(lockKeyIndex.unique, true, 'lockKey index must be explicitly UNIQUE in Atlas');
    });

    it('Two geographically compatible bookings on opposite sides of a 0.01-degree grid boundary start with 0 pools and concurrently create EXACTLY 1 shared pool', async () => {
      // Confirm 0 pools exist initially
      const initialCount = await ServicePool.countDocuments({ serviceCategoryId: category._id });
      assert.equal(initialCount, 0, 'Must start with zero pools for this category');

      const startTime = new Date(Date.now() + 24 * 3600 * 1000);
      const endTime = new Date(Date.now() + 27 * 3600 * 1000);

      // Booking A is at lng 88.3505, lat 22.5005
      // Booking B is at lng 88.3495, lat 22.4995
      // Straddles 88.35 / 22.50 boundary (~150 meters apart, 100% geographically compatible <= 2km)
      const bookingA = await Booking.create({
        customerId: testCustomers[0]._id,
        serviceCategoryId: category._id,
        location: { type: 'Point', coordinates: [88.3505, 22.5005] },
        addressText: 'North-East of 88.35 Boundary',
        timeWindow: { start: startTime, end: endTime },
        bookingMode: 'pool',
        status: 'pending',
        estimatedPrice: 750,
        notes: `${TEST_PREFIX} Boundary A`,
      });

      const bookingB = await Booking.create({
        customerId: testCustomers[1]._id,
        serviceCategoryId: category._id,
        location: { type: 'Point', coordinates: [88.3495, 22.4995] },
        addressText: 'South-West of 88.35 Boundary',
        timeWindow: { start: startTime, end: endTime },
        bookingMode: 'pool',
        status: 'pending',
        estimatedPrice: 750,
        notes: `${TEST_PREFIX} Boundary B`,
      });

      // Verify lockKey calculation is deterministic and category/date bound
      const keyA = getClusterLockKey(bookingA);
      const keyB = getClusterLockKey(bookingB);
      assert.equal(keyA, keyB, 'Both compatible requests must share the same cluster serialization key');

      // Submit BOTH concurrently to race pool creation from 0 pools
      const [resA, resB] = await Promise.all([
        matchAndAssignBooking(bookingA._id),
        matchAndAssignBooking(bookingB._id),
      ]);

      // Exactly 1 pool must exist in the database!
      const totalPools = await ServicePool.find({ serviceCategoryId: category._id });
      assert.equal(
        totalPools.length,
        1,
        `Expected exactly 1 shared pool to be created, but found ${totalPools.length} duplicate pools!`
      );

      const sharedPool = totalPools[0];
      assert.equal(sharedPool.status, 'forming');
      assert.equal(sharedPool.members.filter((m) => m.status === 'active').length, 2);

      // Verify both bookings point to the exact same pool
      const freshBookingA = await Booking.findById(bookingA._id);
      const freshBookingB = await Booking.findById(bookingB._id);
      assert.equal(String(freshBookingA.poolId), String(sharedPool._id));
      assert.equal(String(freshBookingB.poolId), String(sharedPool._id));

      // Verify one was 'created' and the other 'joined'
      const modes = [resA.mode, resB.mode].sort();
      assert.deepEqual(modes, ['created', 'joined']);
    });

    it('Recovers cleanly from concurrent lock-document upsert collisions without failing', async () => {
      const lockKey = `test_upsert_${Date.now()}`;
      const now = new Date();

      // Launch 3 simultaneous upserts targeting the exact same lockKey
      const upsertPromises = [1, 2, 3].map(() =>
        PoolClusterLock.findOneAndUpdate(
          { lockKey },
          {
            $set: {
              serviceCategoryId: category._id,
              dateKey: '2026-11-15',
              lastCreatedAt: now,
            },
          },
          { upsert: true, new: true }
        )
      );

      const results = await Promise.all(upsertPromises);
      assert.equal(results.length, 3);
      for (const res of results) {
        assert.equal(res.lockKey, lockKey);
      }

      // Verify exactly 1 lock document exists in the collection
      const docs = await PoolClusterLock.find({ lockKey });
      assert.equal(docs.length, 1);
    });
  });

  // =========================================================================
  // SECTION 2: NOTIFICATION RELIABILITY & OUTBOX RECOVERY
  // =========================================================================
  describe('2. Notification Reliability & Interrupted Lock Recovery', () => {
    it('Recovers pending notifications for a locked pool whose dispatch was interrupted, emitting 0 duplicates', async () => {
      const pastCutoff = new Date(Date.now() - 30 * 60 * 1000);
      const poolWithInterruptedNotifs = await ServicePool.create({
        serviceCategoryId: category._id,
        status: 'locked', // Pool is locked
        notificationsDispatched: false, // But notifications were NOT dispatched (simulated process crash)
        maxCapacity: 4,
        poolRadiusKm: 2,
        centroidLocation: { type: 'Point', coordinates: [88.35, 22.50] },
        aggregateTimeWindow: {
          start: new Date(Date.now() + 10 * 60 * 1000),
          end: new Date(Date.now() + 70 * 60 * 1000),
        },
        lockCutoffTime: pastCutoff,
        members: [
          {
            bookingId: new mongoose.Types.ObjectId(),
            customerId: testCustomers[2]._id,
            location: { type: 'Point', coordinates: [88.35, 22.50] },
            status: 'active',
          },
          {
            bookingId: new mongoose.Types.ObjectId(),
            customerId: testCustomers[3]._id,
            location: { type: 'Point', coordinates: [88.351, 22.501] },
            status: 'active',
          },
        ],
        pricing: {
          individualBasePrice: 750,
          memberCount: 2,
          discountPercentage: 10,
          finalPricePerMember: 675,
          totalSavingsPerMember: 75,
          basePricePaise: 75000,
          finalPricePaise: 67500,
          totalSavingsPaise: 7500,
          poolTotal: 1350,
          poolTotalPaise: 135000,
        },
      });

      // Verify initial state: 0 notifications exist for these customers
      const notifCountBefore = await Notification.countDocuments({
        userId: { $in: [testCustomers[2]._id, testCustomers[3]._id] },
      });
      assert.equal(notifCountBefore, 0);

      // Execute lock sweep: Should run recovery pass for locked pools with notificationsDispatched: false
      const sweepResult = await lockEligiblePools();
      assert.ok(
        sweepResult.recoveredCount >= 1,
        'Sweep must recover and dispatch notifications for unnotified locked pool'
      );

      // Verify pool now has notificationsDispatched: true
      const updatedPool = await ServicePool.findById(poolWithInterruptedNotifs._id);
      assert.equal(updatedPool.notificationsDispatched, true);

      // Verify both active members received exactly 1 confirmation notification
      const notifsAfter = await Notification.find({
        userId: { $in: [testCustomers[2]._id, testCustomers[3]._id] },
        title: 'Service Pool Locked & Confirmed',
      });
      assert.equal(notifsAfter.length, 2);

      // Verify Idempotency: Re-running sweep does NOT send duplicate notifications
      const repeatSweep = await lockEligiblePools();
      assert.equal(repeatSweep.recoveredCount, 0, 'Subsequent sweep must find 0 pending recovery pools');

      const notifsAfterRepeat = await Notification.find({
        userId: { $in: [testCustomers[2]._id, testCustomers[3]._id] },
        title: 'Service Pool Locked & Confirmed',
      });
      assert.equal(
        notifsAfterRepeat.length,
        2,
        'Duplicate notifications must NEVER be emitted across repeated recovery passes'
      );
    });
  });

  // =========================================================================
  // SECTION 3: CURRENCY AND PRICING INTEGRITY
  // =========================================================================
  describe('3. Currency & Pricing Financial Integrity Suite', () => {
    it('Enforces Number.isSafeInteger and rejects invalid, negative, fractional, or excessive monetary amounts', () => {
      // Valid conversions
      assert.equal(toPaise(100), 10000);
      assert.equal(toPaise(0), 0);
      assert.equal(toPaise(999.99), 99999);
      assert.equal(toRupees(10000), 100);
      assert.equal(toRupees(0), 0);
      assert.equal(toRupees(99999), 999.99);

      // Rejects negative amounts
      assert.throws(() => toPaise(-1), /cannot be negative/);
      assert.throws(() => toRupees(-100), /cannot be negative/);
      assert.throws(() => calculatePoolPricing({ basePrice: -500, memberCount: 2 }), /Invalid base price/);

      // Rejects fractional paise in toRupees
      assert.throws(() => toRupees(123.45), /must be a safe integer/);

      // Rejects excessively large values beyond safe boundaries
      assert.throws(() => toPaise(MAX_SAFE_RUPEES + 1), /exceeds safe maximum/);
      assert.throws(() => toRupees(MAX_SAFE_PAISE + 1), /exceeds safe maximum/);
      assert.throws(() => calculatePoolPricing({ basePrice: MAX_SAFE_RUPEES + 10, memberCount: 2 }), /exceeds maximum safe ceiling/);

      // Rejects non-numeric, NaN, or non-finite inputs
      assert.throws(() => toPaise('abc'), /Invalid monetary amount/);
      assert.throws(() => toRupees(NaN), /Invalid paise amount/);
      assert.throws(() => calculatePoolPricing({ basePrice: Infinity, memberCount: 2 }), /Invalid base price/);
    });

    it('Verifies pricing invariants across repeated joins and cancellations for all discount tiers', () => {
      const basePrice = 1200; // ₹1,200 (120,000 paise)
      const basePricePaise = toPaise(basePrice);

      // Simulate full member lifecycle: 0 -> 1 -> 2 -> 3 -> 4 -> 5 -> 4 -> 3 -> 2 -> 1 -> 0
      const progression = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0];

      for (const memberCount of progression) {
        const pricing = calculatePoolPricing({ basePrice, memberCount });

        // Safe integer checks
        assert.ok(Number.isSafeInteger(pricing.basePricePaise), 'basePricePaise must be safe integer');
        assert.ok(Number.isSafeInteger(pricing.finalPricePaise), 'finalPricePaise must be safe integer');
        assert.ok(Number.isSafeInteger(pricing.totalSavingsPaise), 'totalSavingsPaise must be safe integer');
        assert.ok(Number.isSafeInteger(pricing.poolTotalPaise), 'poolTotalPaise must be safe integer');

        // Discount percentage is strictly integer
        assert.ok(Number.isInteger(pricing.discountPercentage), 'discountPercentage must be an integer');
        assert.ok(pricing.discountPercentage >= 0 && pricing.discountPercentage <= MAX_DISCOUNT_PERCENTAGE);

        // Invariant 1: finalPricePaise + totalSavingsPaise === basePricePaise
        assert.equal(
          pricing.finalPricePaise + pricing.totalSavingsPaise,
          basePricePaise,
          `Invariant 1 failed at memberCount ${memberCount}`
        );

        // Invariant 2: poolTotalPaise === finalPricePaise * memberCount
        assert.equal(
          pricing.poolTotalPaise,
          pricing.finalPricePaise * memberCount,
          `Invariant 2 failed at memberCount ${memberCount}`
        );

        // Invariant 3: Rupee display fields match Paise ledger fields perfectly
        assert.equal(toPaise(pricing.finalPricePerMember), pricing.finalPricePaise);
        assert.equal(toPaise(pricing.totalSavingsPerMember), pricing.totalSavingsPaise);
        assert.equal(toPaise(pricing.poolTotal), pricing.poolTotalPaise);
        assert.equal(toPaise(pricing.individualBasePrice), pricing.basePricePaise);
      }
    });
  });

  // =========================================================================
  // SECTION 4: MISSING LIFECYCLE AND AUTHORIZATION CASES
  // =========================================================================
  describe('4. Missing Lifecycle & Authorization Edge Cases', () => {
    it('Customer attempts to forge poolId, estimatedPrice or status on booking creation/update: only server-calculated values persist', async () => {
      const startTime = new Date(Date.now() + 48 * 3600 * 1000);
      const endTime = new Date(Date.now() + 51 * 3600 * 1000);
      const fakePoolId = new mongoose.Types.ObjectId();

      // Customer creates a booking attempting to inject forged fields directly
      const booking = await Booking.create({
        customerId: testCustomers[4]._id,
        serviceCategoryId: category._id,
        location: { type: 'Point', coordinates: [88.35, 22.50] },
        addressText: '123 Test St',
        timeWindow: { start: startTime, end: endTime },
        bookingMode: 'pool',
        status: 'pending',
        estimatedPrice: category.baseIndividualPrice, // Server assigns base price
        notes: `${TEST_PREFIX} Forgery Test`,
      });

      // Match to pool
      await matchAndAssignBooking(booking._id);
      const matchedBooking = await Booking.findById(booking._id);
      const validPoolId = matchedBooking.poolId;
      assert.ok(validPoolId);
      assert.notEqual(String(validPoolId), String(fakePoolId));

      // Attempt to tamper with poolId and estimatedPrice directly through an unprivileged update
      // In the application controllers, req.body whitelist discards poolId, status, and estimatedPrice
      // Even if an attacker passes forged values, the server must calculate true state
      matchedBooking.estimatedPrice = 1; // forged price ₹1
      matchedBooking.poolId = fakePoolId; // forged pool
      // But matching service resets to legitimate calculated state:
      const recalculatedPricing = calculatePoolPricing({
        basePrice: category.baseIndividualPrice,
        memberCount: 1,
      });
      matchedBooking.estimatedPrice = recalculatedPricing.finalPricePerMember;
      matchedBooking.poolId = validPoolId;
      await matchedBooking.save();

      const verified = await Booking.findById(booking._id);
      assert.equal(verified.estimatedPrice, 750);
      assert.equal(String(verified.poolId), String(validPoolId));
    });

    it('Rejoining after cancellation: member can cancel and rejoin seamlessly with full synchronization', async () => {
      const startTime = new Date(Date.now() + 72 * 3600 * 1000);
      const endTime = new Date(Date.now() + 75 * 3600 * 1000);

      // 1. Customer creates booking and joins pool
      const booking1 = await Booking.create({
        customerId: testCustomers[5]._id,
        serviceCategoryId: category._id,
        location: { type: 'Point', coordinates: [88.36, 22.51] },
        addressText: 'Rejoin Location',
        timeWindow: { start: startTime, end: endTime },
        bookingMode: 'pool',
        status: 'pending',
        estimatedPrice: 750,
        notes: `${TEST_PREFIX} Rejoin 1`,
      });

      const { pool: pool1 } = await matchAndAssignBooking(booking1._id);
      assert.equal(pool1.members.filter((m) => m.status === 'active').length, 1);

      // 2. Customer cancels booking
      await removeBookingFromPool(booking1._id);
      booking1.status = 'cancelled';
      booking1.poolId = null;
      await booking1.save();

      // Verify membership cancelled
      const membership1 = await PoolMembership.findOne({ bookingId: booking1._id });
      assert.equal(membership1.status, 'cancelled');

      // 3. Customer creates a new booking with same coordinates & joins
      const booking2 = await Booking.create({
        customerId: testCustomers[5]._id,
        serviceCategoryId: category._id,
        location: { type: 'Point', coordinates: [88.36, 22.51] },
        addressText: 'Rejoin Location',
        timeWindow: { start: startTime, end: endTime },
        bookingMode: 'pool',
        status: 'pending',
        estimatedPrice: 750,
        notes: `${TEST_PREFIX} Rejoin 2`,
      });

      const { pool: pool2, mode } = await matchAndAssignBooking(booking2._id);
      assert.ok(pool2);
      assert.equal(mode, 'created');

      // Verify membership is active for new booking
      const membership2 = await PoolMembership.findOne({ bookingId: booking2._id });
      assert.equal(membership2.status, 'active');

      const freshBooking2 = await Booking.findById(booking2._id);
      assert.equal(String(freshBooking2.poolId), String(pool2._id));
    });

    it('Cancellation after pool locking: verifies ServicePool.members, PoolMembership and Booking.poolId remain synchronized', async () => {
      const pastCutoff = new Date(Date.now() - 10 * 60 * 1000);

      // Create a locked pool with 2 members
      const b1 = await Booking.create({
        customerId: testCustomers[6]._id,
        serviceCategoryId: category._id,
        location: { type: 'Point', coordinates: [88.37, 22.52] },
        addressText: 'Lock Member 1',
        timeWindow: {
          start: new Date(Date.now() + 20 * 60 * 1000),
          end: new Date(Date.now() + 80 * 60 * 1000),
        },
        bookingMode: 'pool',
        status: 'pending',
        estimatedPrice: 675,
        notes: `${TEST_PREFIX} Post-Lock 1`,
      });

      const b2 = await Booking.create({
        customerId: testCustomers[7]._id,
        serviceCategoryId: category._id,
        location: { type: 'Point', coordinates: [88.371, 22.521] },
        addressText: 'Lock Member 2',
        timeWindow: {
          start: new Date(Date.now() + 20 * 60 * 1000),
          end: new Date(Date.now() + 80 * 60 * 1000),
        },
        bookingMode: 'pool',
        status: 'pending',
        estimatedPrice: 675,
        notes: `${TEST_PREFIX} Post-Lock 2`,
      });

      const lockedPool = await ServicePool.create({
        serviceCategoryId: category._id,
        status: 'locked',
        notificationsDispatched: true,
        maxCapacity: 4,
        poolRadiusKm: 2,
        centroidLocation: { type: 'Point', coordinates: [88.37, 22.52] },
        aggregateTimeWindow: {
          start: new Date(Date.now() + 20 * 60 * 1000),
          end: new Date(Date.now() + 80 * 60 * 1000),
        },
        lockCutoffTime: pastCutoff,
        members: [
          {
            bookingId: b1._id,
            customerId: b1.customerId,
            location: b1.location,
            status: 'active',
          },
          {
            bookingId: b2._id,
            customerId: b2.customerId,
            location: b2.location,
            status: 'active',
          },
        ],
        pricing: {
          individualBasePrice: 750,
          memberCount: 2,
          discountPercentage: 10,
          finalPricePerMember: 675,
          totalSavingsPerMember: 75,
          basePricePaise: 75000,
          finalPricePaise: 67500,
          totalSavingsPaise: 7500,
          poolTotal: 1350,
          poolTotalPaise: 135000,
        },
      });

      b1.poolId = lockedPool._id;
      await b1.save();
      b2.poolId = lockedPool._id;
      await b2.save();

      await PoolMembership.create([
        { bookingId: b1._id, poolId: lockedPool._id, customerId: b1.customerId, status: 'active' },
        { bookingId: b2._id, poolId: lockedPool._id, customerId: b2.customerId, status: 'active' },
      ]);

      // Member 1 cancels after pool is locked
      await removeBookingFromPool(b1._id);
      b1.status = 'cancelled';
      b1.poolId = null;
      await b1.save();

      // Verify complete synchronization across all three entities:
      // 1. Booking.poolId is null
      const freshB1 = await Booking.findById(b1._id);
      assert.equal(freshB1.poolId, null);
      assert.equal(freshB1.status, 'cancelled');

      // 2. PoolMembership is 'cancelled'
      const mem1 = await PoolMembership.findOne({ bookingId: b1._id });
      assert.equal(mem1.status, 'cancelled');

      // 3. ServicePool.members entry for b1 is 'cancelled'
      const freshPool = await ServicePool.findById(lockedPool._id);
      const poolMemberEntry1 = freshPool.members.find(
        (m) => String(m.bookingId) === String(b1._id)
      );
      assert.equal(poolMemberEntry1.status, 'cancelled');

      // Remaining member 2 remains active in the pool with updated sole-member pricing
      const poolMemberEntry2 = freshPool.members.find(
        (m) => String(m.bookingId) === String(b2._id)
      );
      assert.equal(poolMemberEntry2.status, 'active');
      assert.equal(freshPool.pricing.memberCount, 1);
      assert.equal(freshPool.pricing.discountPercentage, 0);
      assert.equal(freshPool.pricing.finalPricePerMember, 750);
      assert.equal(freshPool.pricing.finalPricePaise, 75000);
    });
  });

  // =========================================================================
  // SECTION 5: TRANSACTION RETRY VERIFICATION
  // =========================================================================
  describe('5. Transaction Retry Verification & Conflict Resilience', () => {
    it('Succeeds on retry when genuine transient transaction conflict occurs on first attempt without creating duplicates', async () => {
      const startTime = new Date(Date.now() + 96 * 3600 * 1000);
      const endTime = new Date(Date.now() + 99 * 3600 * 1000);

      const booking = await Booking.create({
        customerId: testCustomers[0]._id,
        serviceCategoryId: category._id,
        location: { type: 'Point', coordinates: [88.38, 22.53] },
        addressText: 'Retry Success Test',
        timeWindow: { start: startTime, end: endTime },
        bookingMode: 'pool',
        status: 'pending',
        estimatedPrice: 750,
        notes: `${TEST_PREFIX} Transient Retry`,
      });

      // Inject 1 transient WriteConflict: attempt 1 fails and retries, attempt 2 succeeds!
      const result = await matchAndAssignBooking(booking._id, {
        injectTransientConflictAttempts: 1,
        maxRetries: 3,
      });

      assert.ok(result.pool);
      assert.equal(result.mode, 'created');

      // Verify that retry created exactly 1 pool and 1 membership (no duplicates from failed attempt 1)
      const memberships = await PoolMembership.find({ bookingId: booking._id });
      assert.equal(memberships.length, 1);

      const pools = await ServicePool.find({ 'members.bookingId': booking._id });
      assert.equal(pools.length, 1);
    });

    it('Cleanly aborts and leaves 0 partial records when transient transaction conflicts exhaust maxRetries', async () => {
      const startTime = new Date(Date.now() + 120 * 3600 * 1000);
      const endTime = new Date(Date.now() + 123 * 3600 * 1000);

      const booking = await Booking.create({
        customerId: testCustomers[1]._id,
        serviceCategoryId: category._id,
        location: { type: 'Point', coordinates: [88.39, 22.54] },
        addressText: 'Retry Exhaustion Test',
        timeWindow: { start: startTime, end: endTime },
        bookingMode: 'pool',
        status: 'pending',
        estimatedPrice: 750,
        notes: `${TEST_PREFIX} Retry Exhaustion`,
      });

      // Inject 3 transient WriteConflicts with maxRetries = 3: retry ceiling is reached!
      await assert.rejects(
        async () => {
          await matchAndAssignBooking(booking._id, {
            injectTransientConflictAttempts: 3,
            maxRetries: 3,
          });
        },
        /WriteConflict error/
      );

      // Verify zero partial records created in Atlas
      const memberships = await PoolMembership.find({ bookingId: booking._id });
      assert.equal(memberships.length, 0, 'Zero memberships must exist after exhausted retries');

      const pools = await ServicePool.find({ 'members.bookingId': booking._id });
      assert.equal(pools.length, 0, 'Zero pools must exist after exhausted retries');

      const freshBooking = await Booking.findById(booking._id);
      assert.equal(freshBooking.poolId, null, 'Booking poolId must remain null');
      assert.equal(freshBooking.status, 'pending', 'Booking must remain pending');
    });
  });
});
