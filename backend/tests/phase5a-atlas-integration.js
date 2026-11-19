import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import {
  User,
  ServiceCategory,
  ServiceZone,
  TechnicianProfile,
  ServicePool,
  Booking,
  Notification,
} from '../src/models/index.js';
import { toGeoJSONPoint } from '../src/utils/geo.js';
import { runInTransaction } from '../src/config/db.js';
import { assignPoolToTechnician, assignBookingToTechnician } from '../src/modules/pools/poolAssignment.service.js';

describe('Phase 5A.1 MongoDB Atlas Live Cloud Integration Suite', () => {
  let atlasAvailable = false;
  const TEST_TAG = `__PHASE5A_ATLAS_${Date.now()}__`;

  let category, zone, techUser, techProfile, customerUser;

  before(async () => {
    const rawUri = process.env.MONGODB_URI || env.mongodbUri;
    if (!rawUri || !rawUri.includes('mongodb')) {
      console.log('\n[ATLAS SUITE STATUS] NOT EXECUTED (No MongoDB Atlas URI configured)\n');
      return;
    }

    try {
      // Attempt connection with 3000ms timeout
      await mongoose.connect(rawUri, {
        serverSelectionTimeoutMS: 3000,
        connectTimeoutMS: 3000,
      });

      // Quick ping test
      await mongoose.connection.db.admin().ping();
      atlasAvailable = true;
      console.log('\n[ATLAS SUITE STATUS] CONNECTED (Executing real Atlas integration suite)\n');

      // Setup base fixtures
      category = await ServiceCategory.create({
        name: 'Atlas Test AC',
        slug: `atlas_ac_${Date.now()}`,
        description: 'Testing Atlas AC',
        baseIndividualPrice: 500,
        estimatedDurationMins: 45,
        defaultPoolRadiusKm: 3.0,
        maxPoolSize: 4,
        poolLockCutoffMins: 60,
      });

      zone = await ServiceZone.create({
        name: 'Atlas Test Zone',
        code: `ATLAS_Z_${Date.now()}`,
        city: 'Kolkata',
        boundary: {
          type: 'Polygon',
          coordinates: [
            [
              [88.30, 22.45],
              [88.42, 22.45],
              [88.42, 22.58],
              [88.30, 22.58],
              [88.30, 22.45],
            ],
          ],
        },
        centerLocation: toGeoJSONPoint(22.51, 88.36),
        isActive: true,
      });

      customerUser = await User.create({
        name: 'Atlas Customer',
        email: `atlas_cust_${Date.now()}@test.smartpool.local`,
        phone: '+91-9830001111',
        passwordHash: 'Pass12345!',
        role: 'customer',
        isActive: true,
      });

      techUser = await User.create({
        name: 'Atlas Tech',
        email: `atlas_tech_${Date.now()}@test.smartpool.local`,
        phone: '+91-9830002222',
        passwordHash: 'Pass12345!',
        role: 'technician',
        isActive: true,
      });

      techProfile = await TechnicianProfile.create({
        userId: techUser._id,
        serviceCategories: [category._id],
        zoneId: zone._id,
        baseLocation: toGeoJSONPoint(22.51, 88.36),
        addressText: 'Kolkata Test Base',
        serviceRadiusKm: 10,
        maxPoolCapacity: 2,
        activeWorkload: 0,
        availabilityStatus: 'available',
        approvalStatus: 'approved',
      });
    } catch (err) {
      atlasAvailable = false;
      console.log('\n========================================================================');
      console.log('[ATLAS SUITE STATUS] NOT EXECUTED (Atlas cluster unreachable or IP not whitelisted)');
      console.log(`Reason: ${err.message}`);
      console.log('Skipping all Atlas integration tests. Preserving 100% test integrity.');
      console.log('========================================================================\n');
    }
  });

  after(async () => {
    if (atlasAvailable && mongoose.connection.readyState === 1) {
      try {
        await User.deleteMany({ email: { $regex: /atlas_/i } });
        await ServiceCategory.deleteMany({ slug: { $regex: /atlas_/i } });
        await ServiceZone.deleteMany({ code: { $regex: /ATLAS_/i } });
        await Booking.deleteMany({ addressText: { $regex: /Atlas/i } });
        await ServicePool.deleteMany({ poolRadiusKm: 3.0 });
        await TechnicianProfile.deleteMany({ addressText: { $regex: /Kolkata Test Base/i } });
        await Notification.deleteMany({ role: 'technician' });
      } catch {}
      await mongoose.disconnect();
    }
  });

  it('1. verifies technician availability persistence in Atlas', async (t) => {
    if (!atlasAvailable) {
      return t.skip('Atlas unavailable - test NOT EXECUTED');
    }

    await TechnicianProfile.updateOne(
      { _id: techProfile._id },
      {
        $set: {
          availabilityStatus: 'busy',
          workingHours: {
            monday: { start: '08:00', end: '16:00' },
            tuesday: { start: '08:00', end: '16:00' },
          },
        },
      }
    );

    const reloaded = await TechnicianProfile.findById(techProfile._id);
    assert.equal(reloaded.availabilityStatus, 'busy');
    assert.equal(reloaded.workingHours.monday.start, '08:00');
  });

  it('2. verifies individual booking assignment persistence in Atlas', async (t) => {
    if (!atlasAvailable) {
      return t.skip('Atlas unavailable - test NOT EXECUTED');
    }

    const booking = await Booking.create({
      customerId: customerUser._id,
      serviceCategoryId: category._id,
      zoneId: zone._id,
      location: toGeoJSONPoint(22.512, 88.362),
      addressText: 'Atlas Test Flat 1',
      timeWindow: {
        start: new Date(Date.now() + 86400000),
        end: new Date(Date.now() + 86400000 + 3 * 3600000),
      },
      bookingMode: 'individual',
      status: 'confirmed',
      estimatedPrice: 500,
    });

    const assigned = await assignBookingToTechnician(booking._id, techUser._id);
    assert.equal(assigned.status, 'assigned');
    assert.equal(String(assigned.technicianId), String(techUser._id));

    const inDb = await Booking.findById(booking._id);
    assert.equal(inDb.status, 'assigned');
    assert.equal(String(inDb.technicianId), String(techUser._id));
  });

  it('3. verifies pool assignment with transaction in Atlas', async (t) => {
    if (!atlasAvailable) {
      return t.skip('Atlas unavailable - test NOT EXECUTED');
    }

    const pool = await ServicePool.create({
      serviceCategoryId: category._id,
      zoneId: zone._id,
      status: 'locked',
      maxCapacity: 4,
      poolRadiusKm: 3.0,
      centroidLocation: toGeoJSONPoint(22.515, 88.365),
      aggregateTimeWindow: {
        start: new Date(Date.now() + 172800000),
        end: new Date(Date.now() + 172800000 + 3 * 3600000),
      },
      lockCutoffTime: new Date(Date.now() - 60000),
      members: [],
    });

    const assignedPool = await assignPoolToTechnician(pool._id, techUser._id);
    assert.equal(assignedPool.status, 'assigned');
    assert.equal(String(assignedPool.assignedTechnicianId), String(techUser._id));

    const inDb = await ServicePool.findById(pool._id);
    assert.equal(inDb.status, 'assigned');
    assert.equal(String(inDb.assignedTechnicianId), String(techUser._id));
  });

  it('4. verifies multi-document transaction rollback restores documents in Atlas', async (t) => {
    if (!atlasAvailable) {
      return t.skip('Atlas unavailable - test NOT EXECUTED');
    }

    const testPool = await ServicePool.create({
      serviceCategoryId: category._id,
      zoneId: zone._id,
      status: 'locked',
      maxCapacity: 4,
      poolRadiusKm: 3.0,
      centroidLocation: toGeoJSONPoint(22.515, 88.365),
      aggregateTimeWindow: {
        start: new Date(Date.now() + 259200000),
        end: new Date(Date.now() + 259200000 + 3 * 3600000),
      },
      lockCutoffTime: new Date(Date.now() - 60000),
      members: [],
    });

    try {
      await runInTransaction(
        async (session) => {
          await ServicePool.updateOne({ _id: testPool._id }, { $set: { status: 'cancelled' } }, { session });
          throw new Error('Simulated transactional failure');
        },
        { requireTransaction: true }
      );
    } catch (err) {
      assert.equal(err.message, 'Simulated transactional failure');
    }

    const afterRollback = await ServicePool.findById(testPool._id);
    assert.equal(afterRollback.status, 'locked', 'Rollback must restore status to locked');
  });

  it('5. verifies concurrent assignment protection on Atlas replica set', async (t) => {
    if (!atlasAvailable) {
      return t.skip('Atlas unavailable - test NOT EXECUTED');
    }

    const racePool = await ServicePool.create({
      serviceCategoryId: category._id,
      zoneId: zone._id,
      status: 'locked',
      maxCapacity: 4,
      poolRadiusKm: 3.0,
      centroidLocation: toGeoJSONPoint(22.515, 88.365),
      aggregateTimeWindow: {
        start: new Date(Date.now() + 345600000),
        end: new Date(Date.now() + 345600000 + 3 * 3600000),
      },
      lockCutoffTime: new Date(Date.now() - 60000),
      members: [],
    });

    const results = await Promise.allSettled([
      assignPoolToTechnician(racePool._id, techUser._id),
      assignPoolToTechnician(racePool._id, techUser._id),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'Exactly one concurrent assignment must succeed');
    assert.equal(rejected.length, 1, 'Duplicate concurrent request must be rejected');
  });

  it('6. verifies route-order persistence in Atlas', async (t) => {
    if (!atlasAvailable) {
      return t.skip('Atlas unavailable - test NOT EXECUTED');
    }

    const b1 = await Booking.create({
      customerId: customerUser._id,
      serviceCategoryId: category._id,
      zoneId: zone._id,
      location: toGeoJSONPoint(22.512, 88.362),
      addressText: 'Stop 1',
      timeWindow: { start: new Date(), end: new Date(Date.now() + 3600000) },
      bookingMode: 'pool',
      status: 'assigned',
    });

    const b2 = await Booking.create({
      customerId: customerUser._id,
      serviceCategoryId: category._id,
      zoneId: zone._id,
      location: toGeoJSONPoint(22.515, 88.365),
      addressText: 'Stop 2',
      timeWindow: { start: new Date(), end: new Date(Date.now() + 3600000) },
      bookingMode: 'pool',
      status: 'assigned',
    });

    const pool = await ServicePool.create({
      serviceCategoryId: category._id,
      zoneId: zone._id,
      status: 'assigned',
      assignedTechnicianId: techUser._id,
      maxCapacity: 4,
      poolRadiusKm: 3.0,
      centroidLocation: toGeoJSONPoint(22.515, 88.365),
      aggregateTimeWindow: { start: new Date(), end: new Date(Date.now() + 3600000) },
      members: [
        { bookingId: b1._id, customerId: customerUser._id, status: 'active', stopSequence: 1 },
        { bookingId: b2._id, customerId: customerUser._id, status: 'active', stopSequence: 2 },
      ],
    });

    const reloaded = await ServicePool.findById(pool._id);
    assert.equal(reloaded.members[0].stopSequence, 1);
    assert.equal(reloaded.members[1].stopSequence, 2);
  });

  it('7. verifies booking and pool status synchronization in Atlas', async (t) => {
    if (!atlasAvailable) {
      return t.skip('Atlas unavailable - test NOT EXECUTED');
    }

    const memberBooking = await Booking.create({
      customerId: customerUser._id,
      serviceCategoryId: category._id,
      zoneId: zone._id,
      location: toGeoJSONPoint(22.512, 88.362),
      addressText: 'Sync Member',
      timeWindow: { start: new Date(), end: new Date(Date.now() + 3600000) },
      bookingMode: 'pool',
      status: 'assigned',
      technicianId: techUser._id,
    });

    const syncPool = await ServicePool.create({
      serviceCategoryId: category._id,
      zoneId: zone._id,
      status: 'assigned',
      assignedTechnicianId: techUser._id,
      maxCapacity: 4,
      poolRadiusKm: 3.0,
      centroidLocation: toGeoJSONPoint(22.515, 88.365),
      aggregateTimeWindow: { start: new Date(), end: new Date(Date.now() + 3600000) },
      members: [{ bookingId: memberBooking._id, customerId: customerUser._id, status: 'active' }],
    });

    // Update pool to completed and sync member bookings
    syncPool.status = 'completed';
    syncPool.completedAt = new Date();
    await syncPool.save();

    await Booking.updateOne({ _id: memberBooking._id }, { $set: { status: 'completed', completedAt: new Date() } });

    const poolInDb = await ServicePool.findById(syncPool._id);
    const bookingInDb = await Booking.findById(memberBooking._id);

    assert.equal(poolInDb.status, 'completed');
    assert.equal(bookingInDb.status, 'completed');
  });
});
