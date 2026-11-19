import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

import { MongoMemoryReplSet } from 'mongodb-memory-server';

import { connectDB, disconnectDB } from '../src/config/db.js';
import { validateEnv } from '../src/config/env.js';
import { runInTransaction } from '../src/config/db.js';
import {
  User,
  ServiceCategory,
  ServiceZone,
  ServicePool,
  Booking,
  TechnicianProfile,
} from '../src/models/index.js';
import {
  evaluateTechnicianEligibility,
  findEligibleTechniciansForPool,
  assignPoolToTechnician,
} from '../src/modules/pools/poolAssignment.service.js';
import { rejectAssignedJob } from '../src/modules/technicians/technicianJob.controller.js';

describe('Phase 5A.2 Step 1 — Schemas & Rejection History Verification Suite', () => {
  const TEST_PREFIX = `__PHASE5A2_STEP1_${Date.now()}`;
  const validHash = '$2a$10$abcdefghijklmnopqrstuvwxyz123456';

  let testCategory;
  let testZone;
  let adminUser;
  let techUser1;
  let techProfile1;
  let techUser2;
  let techProfile2;
  let replSet;
  let customerUser;

  function invokeController(controllerFn, req) {
    return new Promise((resolve, reject) => {
      const res = {
        statusCode: 200,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          resolve({ statusCode: this.statusCode, payload });
          return this;
        },
      };
      controllerFn(req, res, (err) => {
        if (err) reject(err);
      });
    });
  }

  async function cleanup() {
    await ServicePool.deleteMany({ 'pricing.individualBasePrice': 99999 });
    await Booking.deleteMany({ notes: new RegExp(TEST_PREFIX) });
    await TechnicianProfile.deleteMany({ addressText: new RegExp(TEST_PREFIX) });
    await User.deleteMany({ email: new RegExp(TEST_PREFIX.toLowerCase()) });
    await ServiceCategory.deleteMany({ slug: new RegExp(TEST_PREFIX.toLowerCase()) });
    await ServiceZone.deleteMany({ code: new RegExp(TEST_PREFIX) });
  }

  before(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await connectDB(replSet.getUri());
    await cleanup();

    // 1. Create test category
    testCategory = await ServiceCategory.create({
      name: `${TEST_PREFIX} Category`,
      slug: `${TEST_PREFIX.toLowerCase()}_cat`,
      description: 'Test category for rejection history and schema verification',
      baseIndividualPrice: 500,
      estimatedDurationMins: 45,
      defaultPoolRadiusKm: 5.0,
      maxPoolSize: 4,
      poolLockCutoffMins: 60,
      isActive: true,
    });

    // 2. Create test zone
    testZone = await ServiceZone.create({
      name: `${TEST_PREFIX} Zone`,
      code: `Z_${TEST_PREFIX.slice(-6)}`,
      city: 'Kolkata',
      centerLocation: { type: 'Point', coordinates: [88.3639, 22.5726] },
      radiusKm: 15,
      isActive: true,
    });

    // 3. Create Admin User
    adminUser = await User.create({
      name: 'Test Admin',
      email: `${TEST_PREFIX.toLowerCase()}_admin@example.com`,
      passwordHash: validHash,
      role: 'admin',
      isActive: true,
    });

    // 4. Create Technician 1
    techUser1 = await User.create({
      name: 'Technician One',
      email: `${TEST_PREFIX.toLowerCase()}_tech1@example.com`,
      phone: '+919876543210',
      passwordHash: validHash,
      role: 'technician',
      isActive: true,
    });

    techProfile1 = await TechnicianProfile.create({
      userId: techUser1._id,
      serviceCategories: [testCategory._id],
      zoneId: testZone._id,
      baseLocation: { type: 'Point', coordinates: [88.3639, 22.5726] },
      addressText: `${TEST_PREFIX} Base Location 1`,
      serviceRadiusKm: 10,
      maxPoolCapacity: 4,
      approvalStatus: 'approved',
      availabilityStatus: 'available',
      ratingAvg: 4.8,
      ratingCount: 15,
      jobsCompleted: 20,
    });

    // 5. Create Technician 2
    techUser2 = await User.create({
      name: 'Technician Two',
      email: `${TEST_PREFIX.toLowerCase()}_tech2@example.com`,
      phone: '+919876543211',
      passwordHash: validHash,
      role: 'technician',
      isActive: true,
    });

    techProfile2 = await TechnicianProfile.create({
      userId: techUser2._id,
      serviceCategories: [testCategory._id],
      zoneId: testZone._id,
      baseLocation: { type: 'Point', coordinates: [88.3650, 22.5730] },
      addressText: `${TEST_PREFIX} Base Location 2`,
      serviceRadiusKm: 10,
      maxPoolCapacity: 4,
      approvalStatus: 'approved',
      availabilityStatus: 'available',
      ratingAvg: 4.5,
      ratingCount: 10,
      jobsCompleted: 12,
    });

    // 6. Create Customer User
    customerUser = await User.create({
      name: 'Test Customer',
      email: `${TEST_PREFIX.toLowerCase()}_cust@example.com`,
      phone: '+919876543299',
      passwordHash: validHash,
      role: 'customer',
      isActive: true,
    });
  });

  after(async () => {
    await cleanup();
    await disconnectDB();
    if (replSet) {
      await replSet.stop();
    }
  });

  it('1. TechnicianProfile accepts valid optional currentLocation and lastLocationUpdate', async () => {
    const updateTimestamp = new Date();
    const updatedProfile = await TechnicianProfile.findOneAndUpdate(
      { userId: techUser1._id },
      {
        $set: {
          currentLocation: { type: 'Point', coordinates: [88.3700, 22.5800] },
          lastLocationUpdate: updateTimestamp,
        },
      },
      { new: true, runValidators: true }
    );

    assert.ok(updatedProfile);
    assert.deepEqual(updatedProfile.currentLocation.type, 'Point');
    assert.deepEqual(updatedProfile.currentLocation.coordinates, [88.3700, 22.5800]);
    assert.equal(updatedProfile.lastLocationUpdate.getTime(), updateTimestamp.getTime());
  });

  it('2. Invalid GeoJSON coordinates in currentLocation are strictly rejected', async () => {
    // Latitude > 90
    await assert.rejects(
      async () => {
        await TechnicianProfile.findOneAndUpdate(
          { userId: techUser1._id },
          {
            $set: {
              currentLocation: { type: 'Point', coordinates: [88.3700, 95] },
            },
          },
          { runValidators: true }
        );
      },
      (err) => {
        return err.name === 'ValidationError';
      }
    );

    // Longitude > 180
    await assert.rejects(
      async () => {
        await TechnicianProfile.findOneAndUpdate(
          { userId: techUser1._id },
          {
            $set: {
              currentLocation: { type: 'Point', coordinates: [195, 22.5800] },
            },
          },
          { runValidators: true }
        );
      },
      (err) => {
        return err.name === 'ValidationError';
      }
    );
  });

  it('3. Existing baseLocation behavior remains unchanged and required', async () => {
    // Verifies baseLocation is still required
    const invalidProfile = new TechnicianProfile({
      userId: new mongoose.Types.ObjectId(),
      serviceCategories: [testCategory._id],
    });
    const err = invalidProfile.validateSync();
    assert.ok(err);
    assert.ok(err.errors['baseLocation']);

    // Verifies 2dsphere index on baseLocation is registered
    const indexes = TechnicianProfile.schema.indexes();
    const hasBaseLocation2d = indexes.some(([spec]) => spec.baseLocation === '2dsphere');
    assert.equal(hasBaseLocation2d, true);
  });

  it('4. ServicePool defaults rejection history to an empty array and enforces uniqueness', async () => {
    const pool = await ServicePool.create({
      serviceCategoryId: testCategory._id,
      zoneId: testZone._id,
      status: 'locked',
      maxCapacity: 4,
      poolRadiusKm: 5.0,
      centroidLocation: { type: 'Point', coordinates: [88.3639, 22.5726] },
      aggregateTimeWindow: {
        start: new Date(Date.now() + 3600_000),
        end: new Date(Date.now() + 7200_000),
      },
      lockCutoffTime: new Date(Date.now() + 1800_000),
      pricing: { individualBasePrice: 99999 },
    });

    assert.ok(Array.isArray(pool.rejectedTechnicians));
    assert.equal(pool.rejectedTechnicians.length, 0);
    assert.deepEqual(pool.rejectedTechnicianIds, []);

    // Rejecting manual duplicates via schema validation
    pool.rejectedTechnicians.push(techUser1._id, techUser1._id);
    const validationErr = pool.validateSync();
    assert.ok(validationErr);
    assert.ok(validationErr.errors['rejectedTechnicians']);
  });

  it('5. Rejection records the correct technician User ID in rejection history inside transaction', async () => {
    // Create booking and pool
    const booking = await Booking.create({
      customerId: customerUser._id,
      serviceCategoryId: testCategory._id,
      zoneId: testZone._id,
      status: 'assigned',
      technicianId: techUser1._id,
      location: { type: 'Point', coordinates: [88.3639, 22.5726] },
      addressText: `${TEST_PREFIX} Booking Address`,
      timeWindow: {
        start: new Date(Date.now() + 3600_000),
        end: new Date(Date.now() + 7200_000),
      },
      estimatedPrice: 500,
      notes: `${TEST_PREFIX} Booking`,
    });

    const pool = await ServicePool.create({
      serviceCategoryId: testCategory._id,
      zoneId: testZone._id,
      status: 'assigned',
      assignedTechnicianId: techUser1._id,
      maxCapacity: 4,
      poolRadiusKm: 5.0,
      centroidLocation: { type: 'Point', coordinates: [88.3639, 22.5726] },
      aggregateTimeWindow: {
        start: new Date(Date.now() + 3600_000),
        end: new Date(Date.now() + 7200_000),
      },
      lockCutoffTime: new Date(Date.now() + 1800_000),
      members: [
        {
          bookingId: booking._id,
          customerId: customerUser._id,
          location: { type: 'Point', coordinates: [88.3639, 22.5726] },
          status: 'active',
        },
      ],
      pricing: { individualBasePrice: 99999 },
    });

    // Execute rejection via rejectAssignedJob controller
    const req = {
      params: { id: String(pool._id) },
      body: { reason: 'Schedule conflict in area' },
      user: techUser1,
    };

    const response = await invokeController(rejectAssignedJob, req);

    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.success, true);

    // Verify in database
    const refreshedPool = await ServicePool.findById(pool._id);
    assert.equal(refreshedPool.status, 'locked');
    assert.equal(refreshedPool.assignedTechnicianId, null);
    assert.equal(refreshedPool.rejectionReason, 'Schedule conflict in area');
    assert.equal(refreshedPool.rejectedTechnicians.length, 1);
    assert.equal(String(refreshedPool.rejectedTechnicians[0]), String(techUser1._id));

    // Verify member bookings reverted to confirmed
    const refreshedBooking = await Booking.findById(booking._id);
    assert.equal(refreshedBooking.status, 'confirmed');
    assert.equal(refreshedBooking.technicianId, null);
  });

  it('6. Repeated rejection does not create duplicate entries in rejection history', async () => {
    // Create a pool already rejected by techUser1
    const pool = await ServicePool.create({
      serviceCategoryId: testCategory._id,
      zoneId: testZone._id,
      status: 'assigned',
      assignedTechnicianId: techUser1._id,
      rejectedTechnicians: [techUser1._id],
      maxCapacity: 4,
      poolRadiusKm: 5.0,
      centroidLocation: { type: 'Point', coordinates: [88.3639, 22.5726] },
      aggregateTimeWindow: {
        start: new Date(Date.now() + 10800_000),
        end: new Date(Date.now() + 14400_000),
      },
      lockCutoffTime: new Date(Date.now() + 9000_000),
      pricing: { individualBasePrice: 99999 },
    });

    // Reject again with techUser1
    const req = {
      params: { id: String(pool._id) },
      body: { reason: 'Repeated rejection test' },
      user: techUser1,
    };

    const response = await invokeController(rejectAssignedJob, req);

    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.success, true);

    const refreshedPool = await ServicePool.findById(pool._id);
    // Crucial: length must remain exactly 1, no duplicate entries
    assert.equal(refreshedPool.rejectedTechnicians.length, 1);
    assert.equal(String(refreshedPool.rejectedTechnicians[0]), String(techUser1._id));
  });

  it('7. A rejected technician is excluded from that pool eligibility results and evaluateTechnicianEligibility', async () => {
    // Create a locked pool with techUser1 in rejectedTechnicians
    const pool = await ServicePool.create({
      serviceCategoryId: testCategory._id,
      zoneId: testZone._id,
      status: 'locked',
      rejectedTechnicians: [techUser1._id],
      maxCapacity: 4,
      poolRadiusKm: 5.0,
      centroidLocation: { type: 'Point', coordinates: [88.3639, 22.5726] },
      aggregateTimeWindow: {
        start: new Date(Date.now() + 3600_000),
        end: new Date(Date.now() + 7200_000),
      },
      lockCutoffTime: new Date(Date.now() + 1800_000),
      pricing: { individualBasePrice: 99999 },
    });

    // 1. Check findEligibleTechniciansForPool
    const eligibilityResult = await findEligibleTechniciansForPool(pool._id);
    const candidates = eligibilityResult.candidates;
    const candidateIds = candidates.map((c) => String(c.technicianId));

    // Technician 1 must be completely excluded from candidates
    assert.equal(candidateIds.includes(String(techUser1._id)), false);

    // 2. Check direct evaluateTechnicianEligibility call
    const directEval = await evaluateTechnicianEligibility(techProfile1, pool);
    assert.equal(directEval.isEligible, false);
    assert.ok(
      directEval.reasons.some((r) => r.includes('previously rejected this service pool'))
    );
  });

  it('8. Other technicians remain eligible for the pool', async () => {
    const pool = await ServicePool.create({
      serviceCategoryId: testCategory._id,
      zoneId: testZone._id,
      status: 'locked',
      rejectedTechnicians: [techUser1._id], // Only techUser1 rejected
      maxCapacity: 4,
      poolRadiusKm: 5.0,
      centroidLocation: { type: 'Point', coordinates: [88.3639, 22.5726] },
      aggregateTimeWindow: {
        start: new Date(Date.now() + 3600_000),
        end: new Date(Date.now() + 7200_000),
      },
      lockCutoffTime: new Date(Date.now() + 1800_000),
      pricing: { individualBasePrice: 99999 },
    });

    const eligibilityResult = await findEligibleTechniciansForPool(pool._id);

    // Technician 2 must be found and marked eligible
    const tech2Candidate = eligibilityResult.candidates.find(
      (c) => String(c.technicianId) === String(techUser2._id)
    );
    assert.ok(tech2Candidate, 'Technician 2 should be in candidates list');
    assert.equal(tech2Candidate.isEligible, true);
    assert.equal(eligibilityResult.eligibleCount >= 1, true);
  });

  it('9. The same technician remains eligible for a different pool they have not rejected', async () => {
    // Pool B has NO rejections and a future distinct time window
    const tomorrow = Date.now() + 86400_000;
    const poolB = await ServicePool.create({
      serviceCategoryId: testCategory._id,
      zoneId: testZone._id,
      status: 'locked',
      rejectedTechnicians: [],
      maxCapacity: 4,
      poolRadiusKm: 5.0,
      centroidLocation: { type: 'Point', coordinates: [88.3639, 22.5726] },
      aggregateTimeWindow: {
        start: new Date(tomorrow),
        end: new Date(tomorrow + 3600_000),
      },
      lockCutoffTime: new Date(tomorrow - 3600_000),
      pricing: { individualBasePrice: 99999 },
    });

    const eligibilityResultB = await findEligibleTechniciansForPool(poolB._id);

    // Technician 1 is NOT blacklisted globally and remains eligible for pool B
    const tech1Candidate = eligibilityResultB.candidates.find(
      (c) => String(c.technicianId) === String(techUser1._id)
    );
    const directEvalB = await evaluateTechnicianEligibility(techProfile1, poolB);

    assert.ok(tech1Candidate, 'Technician 1 should be eligible for a different pool');
    assert.equal(tech1Candidate.isEligible, true);
    assert.equal(directEvalB.isEligible, true);
    assert.equal(directEvalB.reasons.length, 0);
  });

  it('10. Transaction failure does not leave partial rejection-history changes', async () => {
    const pool = await ServicePool.create({
      serviceCategoryId: testCategory._id,
      zoneId: testZone._id,
      status: 'assigned',
      assignedTechnicianId: techUser1._id,
      rejectedTechnicians: [],
      maxCapacity: 4,
      poolRadiusKm: 5.0,
      centroidLocation: { type: 'Point', coordinates: [88.3639, 22.5726] },
      aggregateTimeWindow: {
        start: new Date(Date.now() + 3600_000),
        end: new Date(Date.now() + 7200_000),
      },
      lockCutoffTime: new Date(Date.now() + 1800_000),
      pricing: { individualBasePrice: 99999 },
    });

    // Attempt a transaction that modifies pool and rejection history but aborts with error
    await assert.rejects(
      async () => {
        await runInTransaction(
          async (session) => {
            const p = await ServicePool.findById(pool._id).session(session);
            p.status = 'locked';
            p.assignedTechnicianId = null;
            p.rejectedTechnicians.push(techUser1._id);
            await p.save({ session });

            // Simulate mid-transaction critical error
            throw new Error('SIMULATED_TRANSACTION_FAILURE');
          },
          { requireTransaction: true }
        );
      },
      (err) => {
        return err.message === 'SIMULATED_TRANSACTION_FAILURE';
      }
    );

    // Verify rollback in database: status must still be 'assigned', assignedTechnicianId preserved, rejectedTechnicians empty
    const uncommittedPool = await ServicePool.findById(pool._id);
    assert.equal(uncommittedPool.status, 'assigned');
    assert.equal(String(uncommittedPool.assignedTechnicianId), String(techUser1._id));
    assert.deepEqual(uncommittedPool.rejectedTechnicians, []);
  });
});
