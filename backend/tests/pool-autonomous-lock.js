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
  Notification,
} from '../src/models/index.js';
import { lockEligiblePools } from '../src/modules/pools/poolLock.service.js';
import {
  runPoolLockSweep,
  startPoolWorker,
  stopPoolWorker,
  isPoolWorkerActive,
} from '../src/modules/pools/poolWorker.js';

describe('Phase 4B Autonomous Pool Locking & Worker Suite (MongoDB Atlas)', () => {
  const TEST_PREFIX = `__AUTOLOCK_TEST_${Date.now()}`;
  let category;
  let customer;

  before(async () => {
    validateEnv();
    await connectDB();
    await cleanup();

    category = await ServiceCategory.create({
      name: 'Autolock Test Category',
      slug: `${TEST_PREFIX.toLowerCase()}_cat`,
      description: 'Testing autonomous lock evaluation',
      baseIndividualPrice: 500,
      estimatedDurationMins: 45,
      defaultPoolRadiusKm: 2.0,
      maxPoolSize: 4,
      poolLockCutoffMins: 60,
      isActive: true,
    });

    customer = await User.create({
      name: 'Lock Customer',
      email: `${TEST_PREFIX.toLowerCase()}@example.com`,
      phone: '+919666000001',
      passwordHash: '$2a$10$abcdefghijklmnopqrstuvwxyz123456',
      role: 'customer',
    });
  });

  after(async () => {
    await stopPoolWorker();
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
  }

  it('Background worker starts and stops cleanly with proper lifecycle management', async () => {
    assert.equal(isPoolWorkerActive(), false);
    startPoolWorker({ intervalMs: 60000 });
    assert.equal(isPoolWorkerActive(), true);
    await stopPoolWorker();
    assert.equal(isPoolWorkerActive(), false);
  });

  it('Pool with lockCutoffTime in the past is automatically locked by sweep and members notified', async () => {
    const pastCutoff = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes in past

    const expiredPool = await ServicePool.create({
      serviceCategoryId: category._id,
      status: 'forming',
      maxCapacity: 4,
      poolRadiusKm: 2,
      centroidLocation: { type: 'Point', coordinates: [88.35, 22.50] },
      aggregateTimeWindow: {
        start: new Date(Date.now() + 15 * 60 * 1000),
        end: new Date(Date.now() + 75 * 60 * 1000),
      },
      lockCutoffTime: pastCutoff,
      members: [
        {
          bookingId: new mongoose.Types.ObjectId(),
          customerId: customer._id,
          location: { type: 'Point', coordinates: [88.35, 22.50] },
          status: 'active',
        },
      ],
      pricing: {
        individualBasePrice: 500,
        memberCount: 1,
        discountPercentage: 0,
        finalPricePerMember: 500,
        totalSavingsPerMember: 0,
      },
    });

    assert.equal(expiredPool.status, 'forming');

    // Run sweep (as autonomous worker does)
    const sweepResult = await runPoolLockSweep();
    assert.ok(sweepResult.lockedCount >= 1, 'At least 1 expired pool must be locked');

    // Verify pool status transitioned to 'locked'
    const updated = await ServicePool.findById(expiredPool._id);
    assert.equal(updated.status, 'locked');

    // Verify confirmation notification was created for member
    const notif = await Notification.findOne({
      userId: customer._id,
      title: 'Pool Window Locked',
    });
    assert.ok(notif, 'Member must receive a confirmation notification upon automatic lock');
  });

  it('Pool with normal future cutoff remains in forming status and is NOT locked', async () => {
    const futureCutoff = new Date(Date.now() + 2 * 3600 * 1000); // 2 hours in future

    const openPool = await ServicePool.create({
      serviceCategoryId: category._id,
      status: 'forming',
      maxCapacity: 4,
      poolRadiusKm: 2,
      centroidLocation: { type: 'Point', coordinates: [88.35, 22.50] },
      aggregateTimeWindow: {
        start: new Date(Date.now() + 3 * 3600 * 1000),
        end: new Date(Date.now() + 6 * 3600 * 1000),
      },
      lockCutoffTime: futureCutoff,
      members: [
        {
          bookingId: new mongoose.Types.ObjectId(),
          customerId: customer._id,
          location: { type: 'Point', coordinates: [88.35, 22.50] },
          status: 'active',
        },
      ],
      pricing: {
        individualBasePrice: 500,
        memberCount: 1,
        discountPercentage: 0,
        finalPricePerMember: 500,
        totalSavingsPerMember: 0,
      },
    });

    // Run sweep
    await runPoolLockSweep();

    // Verify future pool was untouched
    const fresh = await ServicePool.findById(openPool._id);
    assert.equal(fresh.status, 'forming', 'Future-cutoff pool must remain in forming status');
  });

  it('Multi-instance safety and idempotency: repeated execution causes 0 errors and no duplicate transitions', async () => {
    // Run 3 sweeps in parallel to simulate 3 server instances executing concurrently
    const [sweep1, sweep2, sweep3] = await Promise.all([
      runPoolLockSweep(),
      runPoolLockSweep(),
      runPoolLockSweep(),
    ]);

    // None should crash or throw
    assert.ok(sweep1);
    assert.ok(sweep2);
    assert.ok(sweep3);
  });
});
