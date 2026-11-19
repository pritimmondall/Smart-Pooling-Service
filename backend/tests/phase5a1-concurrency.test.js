import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import { connectDB, disconnectDB } from '../src/config/db.js';
import {
  User,
  ServiceCategory,
  ServiceZone,
  TechnicianProfile,
  ServicePool,
  Booking,
} from '../src/models/index.js';
import { toGeoJSONPoint } from '../src/utils/geo.js';
import { assignPoolToTechnician } from '../src/modules/pools/poolAssignment.service.js';

describe('Phase 5A.1 Technician-Level Concurrency & Workload Protection Suite', () => {
  let replSet;
  let category;
  let zone;
  let techUser, techProfile;

  before(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = replSet.getUri();
    process.env.MONGODB_URI = uri;

    await connectDB(uri);

    // 1. Service Category
    category = await ServiceCategory.create({
      name: 'Electrical Diagnostics',
      slug: `electrical_${Date.now()}`,
      description: 'Electrical repair and diagnostic service',
      baseIndividualPrice: 500,
      estimatedDurationMins: 45,
      defaultPoolRadiusKm: 5.0,
      maxPoolSize: 4,
      poolLockCutoffMins: 60,
    });

    // 2. Zone
    zone = await ServiceZone.create({
      name: 'South Kolkata Zone',
      code: `SKOL_${Date.now()}`,
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

    // 3. Technician with strictly capacity = 1
    techUser = await User.create({
      name: 'Devjit Bose',
      email: `tech_concurrent_${Date.now()}@test.local`,
      phone: '+91-9831110001',
      passwordHash: 'ValidPass123!',
      role: 'technician',
      isActive: true,
    });

    techProfile = await TechnicianProfile.create({
      userId: techUser._id,
      serviceCategories: [category._id],
      zoneId: zone._id,
      baseLocation: toGeoJSONPoint(22.51, 88.36),
      addressText: 'Jadavpur, Kolkata',
      serviceRadiusKm: 10,
      maxPoolCapacity: 1, // STRICT LIMIT: Only 1 pool allowed
      activeWorkload: 0,
      availabilityStatus: 'available',
      approvalStatus: 'approved',
    });
  });

  after(async () => {
    await disconnectDB();
    if (replSet) {
      await replSet.stop();
    }
  });

  it('serializes concurrent assignment of 2 different pools: exactly 1 succeeds, workload limit is strictly preserved', async () => {
    // Pool 1: Morning window (tomorrow 09:00 - 12:00)
    const pool1 = await ServicePool.create({
      serviceCategoryId: category._id,
      zoneId: zone._id,
      status: 'locked',
      maxCapacity: 4,
      poolRadiusKm: 3.0,
      centroidLocation: toGeoJSONPoint(22.515, 88.365),
      aggregateTimeWindow: {
        start: new Date(Date.now() + 86400000),
        end: new Date(Date.now() + 86400000 + 3 * 3600000),
      },
      lockCutoffTime: new Date(Date.now() - 60000),
      members: [],
    });

    // Pool 2: Afternoon window (tomorrow 14:00 - 17:00, non-overlapping with Pool 1)
    const pool2 = await ServicePool.create({
      serviceCategoryId: category._id,
      zoneId: zone._id,
      status: 'locked',
      maxCapacity: 4,
      poolRadiusKm: 3.0,
      centroidLocation: toGeoJSONPoint(22.518, 88.368),
      aggregateTimeWindow: {
        start: new Date(Date.now() + 86400000 + 5 * 3600000),
        end: new Date(Date.now() + 86400000 + 8 * 3600000),
      },
      lockCutoffTime: new Date(Date.now() - 60000),
      members: [],
    });

    // Fire assignment of both pools simultaneously
    const results = await Promise.allSettled([
      assignPoolToTechnician(pool1._id, techUser._id),
      assignPoolToTechnician(pool2._id, techUser._id),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly 1 must succeed, exactly 1 must fail due to workload capacity limit
    assert.equal(fulfilled.length, 1, 'Exactly one pool assignment must succeed');
    assert.equal(rejected.length, 1, 'Compromising assignment must fail');

    // The winning pool is assigned
    const winningPoolId = fulfilled[0].value._id;
    const losingPoolId = String(winningPoolId) === String(pool1._id) ? pool2._id : pool1._id;

    const winningPoolDoc = await ServicePool.findById(winningPoolId);
    assert.equal(winningPoolDoc.status, 'assigned');
    assert.equal(String(winningPoolDoc.assignedTechnicianId), String(techUser._id));

    // The losing pool must remain in locked state with assignedTechnicianId = null (transaction rollback)
    const losingPoolDoc = await ServicePool.findById(losingPoolId);
    assert.equal(losingPoolDoc.status, 'locked');
    assert.equal(losingPoolDoc.assignedTechnicianId, null);

    // Verify error reason mentions workload capacity reached
    const rejectError = rejected[0].reason;
    assert.equal(rejectError.statusCode, 409);
    assert.ok(
      rejectError.message.includes('workload capacity reached'),
      `Expected workload capacity message, got: ${rejectError.message}`
    );

    // Verify technician profile workload and availability
    const updatedProfile = await TechnicianProfile.findOne({ userId: techUser._id });
    assert.equal(updatedProfile.activeWorkload, 1, 'Active workload must be exactly 1');
    assert.equal(updatedProfile.availabilityStatus, 'busy', 'Technician at max capacity must be marked busy');
  });

  it('detects scheduling conflicts concurrently and prevents overlapping assignments', async () => {
    // Increase capacity to 3 so capacity is not the reason
    await TechnicianProfile.updateOne({ userId: techUser._id }, { $set: { maxPoolCapacity: 3, availabilityStatus: 'available' } });

    // Pool A: 10:00 - 13:00
    const poolA = await ServicePool.create({
      serviceCategoryId: category._id,
      zoneId: zone._id,
      status: 'locked',
      maxCapacity: 4,
      poolRadiusKm: 3.0,
      centroidLocation: toGeoJSONPoint(22.515, 88.365),
      aggregateTimeWindow: {
        start: new Date(Date.now() + 172800000), // In 2 days
        end: new Date(Date.now() + 172800000 + 3 * 3600000),
      },
      lockCutoffTime: new Date(Date.now() - 60000),
      members: [],
    });

    // Pool B: 11:00 - 14:00 (overlaps with Pool A by 2 hours)
    const poolB = await ServicePool.create({
      serviceCategoryId: category._id,
      zoneId: zone._id,
      status: 'locked',
      maxCapacity: 4,
      poolRadiusKm: 3.0,
      centroidLocation: toGeoJSONPoint(22.520, 88.370),
      aggregateTimeWindow: {
        start: new Date(Date.now() + 172800000 + 3600000), // In 2 days + 1 hr
        end: new Date(Date.now() + 172800000 + 4 * 3600000),
      },
      lockCutoffTime: new Date(Date.now() - 60000),
      members: [],
    });

    // Fire assignment of both overlapping pools simultaneously
    const results = await Promise.allSettled([
      assignPoolToTechnician(poolA._id, techUser._id),
      assignPoolToTechnician(poolB._id, techUser._id),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'Only one overlapping pool can be assigned');
    assert.equal(rejected.length, 1, 'Second pool must fail due to scheduling conflict');

    const rejectErr = rejected[0].reason;
    assert.equal(rejectErr.statusCode, 409);
    assert.ok(
      rejectErr.message.includes('Scheduling conflict'),
      `Expected scheduling conflict, got: ${rejectErr.message}`
    );
  });

  it('guarantees rollback restores all affected documents if an assignment is aborted', async () => {
    // Create a pool
    const poolRollback = await ServicePool.create({
      serviceCategoryId: category._id,
      zoneId: zone._id,
      status: 'locked',
      maxCapacity: 4,
      poolRadiusKm: 3.0,
      centroidLocation: toGeoJSONPoint(22.515, 88.365),
      aggregateTimeWindow: {
        start: new Date(Date.now() + 259200000), // In 3 days
        end: new Date(Date.now() + 259200000 + 3 * 3600000),
      },
      lockCutoffTime: new Date(Date.now() - 60000),
      members: [],
    });

    // Make technician inactive in User collection
    await User.updateOne({ _id: techUser._id }, { $set: { isActive: false } });

    await assert.rejects(
      async () => {
        await assignPoolToTechnician(poolRollback._id, techUser._id);
      },
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.ok(err.message.includes('inactive'));
        return true;
      }
    );

    // Verify pool document was rolled back intact
    const afterAbort = await ServicePool.findById(poolRollback._id);
    assert.equal(afterAbort.status, 'locked');
    assert.equal(afterAbort.assignedTechnicianId, null);

    // Restore technician active status
    await User.updateOne({ _id: techUser._id }, { $set: { isActive: true } });
  });
});
