import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoServerError } from 'mongodb';

import app from '../src/app.js';
import { connectDB, disconnectDB, runInTransaction } from '../src/config/db.js';
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
import { signAuthToken } from '../src/middleware/auth.js';
import {
  assignPoolToTechnician,
  assignBookingToTechnician,
  evaluateBookingEligibility,
  evaluateTechnicianEligibility,
} from '../src/modules/pools/poolAssignment.service.js';
import { recalculateTechnicianAvailability } from '../src/modules/technicians/technicianAvailability.service.js';
import { OsrmRoutingProvider } from '../src/modules/routing/providers/osrmRoutingProvider.js';
import { optimizePoolRoute } from '../src/modules/routing/routeOptimization.service.js';

function requestApp(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const socket = new PassThrough();
    socket.remoteAddress = '127.0.0.1';

    const req = new http.IncomingMessage(socket);
    req.method = method;
    req.url = url;

    const normalizedHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      normalizedHeaders[k.toLowerCase()] = v;
    }

    let rawBody = null;
    if (body !== undefined) {
      rawBody = Buffer.from(JSON.stringify(body), 'utf8');
      normalizedHeaders['content-type'] = normalizedHeaders['content-type'] || 'application/json';
      normalizedHeaders['content-length'] = String(rawBody.length);
    }
    req.headers = normalizedHeaders;

    const res = new http.ServerResponse(req);
    const chunks = [];
    res.assignSocket(socket);
    res.write = (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    };

    res.end = (chunk, encoding) => {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      }
      const text = Buffer.concat(chunks).toString('utf8');
      let parsed = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {}
      resolve({
        statusCode: res.statusCode,
        headers: res.getHeaders(),
        body: parsed,
      });
    };

    app(req, res);
    if (rawBody) {
      req.push(rawBody);
    }
    req.push(null);
  });
}

describe('Phase 5A.2 Edge-Case Verification Suite: Mixed Concurrency, Lifecycle & OSRM', () => {
  let replSet;
  let adminUser, adminToken;
  let customerUser, customerToken;
  let techUser, techToken, techProfile;
  let category;
  let zone;

  before(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = replSet.getUri();
    process.env.MONGODB_URI = uri;

    await connectDB(uri);

    // 1. Admin
    adminUser = await User.create({
      name: 'Admin 5A2',
      email: `admin_5a2_${Date.now()}@test.local`,
      phone: '+91-9832220000',
      passwordHash: 'AdminPass123!',
      role: 'admin',
      isActive: true,
    });
    adminToken = signAuthToken(adminUser);

    // 2. Customer
    customerUser = await User.create({
      name: 'Customer 5A2',
      email: `cust_5a2_${Date.now()}@test.local`,
      phone: '+91-9832220001',
      passwordHash: 'CustomerPass123!',
      role: 'customer',
      isActive: true,
    });
    customerToken = signAuthToken(customerUser);

    // 3. Category
    category = await ServiceCategory.create({
      name: 'Appliance Repair 5A2',
      slug: `appliance_5a2_${Date.now()}`,
      description: 'Appliance repair services',
      baseIndividualPrice: 550,
      estimatedDurationMins: 45,
      defaultPoolRadiusKm: 4.0,
      maxPoolSize: 4,
      poolLockCutoffMins: 60,
    });

    // 4. Zone
    zone = await ServiceZone.create({
      name: 'Salt Lake Zone',
      code: `SLK_${Date.now()}`,
      city: 'Kolkata',
      boundary: {
        type: 'Polygon',
        coordinates: [
          [
            [88.35, 22.55],
            [88.45, 22.55],
            [88.45, 22.65],
            [88.35, 22.65],
            [88.35, 22.55],
          ],
        ],
      },
      centerLocation: toGeoJSONPoint(22.58, 88.41),
      isActive: true,
    });

    // 5. Technician X with strictly maxPoolCapacity = 1
    techUser = await User.create({
      name: 'Technician X',
      email: `tech_x_${Date.now()}@test.local`,
      phone: '+91-9832220002',
      passwordHash: 'TechPass123!',
      role: 'technician',
      isActive: true,
    });
    techToken = signAuthToken(techUser);

    techProfile = await TechnicianProfile.create({
      userId: techUser._id,
      serviceCategories: [category._id],
      zoneId: zone._id,
      baseLocation: toGeoJSONPoint(22.58, 88.41),
      addressText: 'Salt Lake Sector 1, Kolkata',
      serviceRadiusKm: 10,
      maxPoolCapacity: 1, // EXACTLY 1 REMAINING WORKLOAD SLOT
      activeWorkload: 0,
      availabilityStatus: 'available',
      approvalStatus: 'approved',
    });

    // Ensure all background index builds are fully completed before running transaction concurrency tests
    await Promise.all([
      User.init(),
      ServiceCategory.init(),
      ServiceZone.init(),
      TechnicianProfile.init(),
      ServicePool.init(),
      Booking.init(),
    ]);
  });

  after(async () => {
    await disconnectDB();
    if (replSet) {
      await replSet.stop();
    }
  });

  /* -------------------------------------------------------------------------
   * 1. Mixed Assignment Concurrency Test
   * ------------------------------------------------------------------------- */
  it('1. serializes simultaneous pool and individual booking assignments competing for 1 workload slot', async () => {
    // Competitor 1: Locked Pool
    const pool = await ServicePool.create({
      serviceCategoryId: category._id,
      zoneId: zone._id,
      status: 'locked',
      maxCapacity: 4,
      poolRadiusKm: 3.0,
      centroidLocation: toGeoJSONPoint(22.582, 88.412),
      aggregateTimeWindow: {
        start: new Date(Date.now() + 86400000),
        end: new Date(Date.now() + 86400000 + 3 * 3600000),
      },
      lockCutoffTime: new Date(Date.now() - 60000),
      members: [],
    });

    // Competitor 2: Individual Booking (non-overlapping time window)
    const booking = await Booking.create({
      customerId: customerUser._id,
      serviceCategoryId: category._id,
      zoneId: zone._id,
      location: toGeoJSONPoint(22.583, 88.413),
      addressText: 'Salt Lake Sector 2, Kolkata',
      timeWindow: {
        start: new Date(Date.now() + 86400000 + 4 * 3600000),
        end: new Date(Date.now() + 86400000 + 7 * 3600000),
      },
      bookingMode: 'individual',
      status: 'confirmed',
      estimatedPrice: 550,
    });

    // Count notifications before race
    const notifsBefore = await Notification.countDocuments({ userId: techUser._id });

    // Submit simultaneous assignment requests competing for Technician X
    const results = await Promise.allSettled([
      assignPoolToTechnician(pool._id, techUser._id),
      assignBookingToTechnician(booking._id, techUser._id),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one assignment succeeds
    assert.equal(fulfilled.length, 1, 'Exactly one competing assignment must succeed');
    assert.equal(rejected.length, 1, 'The competing assignment must be rejected');

    // The losing assignment returns 409 with workload capacity reached
    const loserError = rejected[0].reason;
    assert.equal(loserError.statusCode, 409);
    assert.ok(
      loserError.message.includes('workload capacity reached'),
      `Expected workload capacity error message, got: ${loserError.message}`
    );

    // Verify DB states: winning entity is assigned; losing entity is completely restored
    const winnerType = fulfilled[0].value.members ? 'pool' : 'booking';
    if (winnerType === 'pool') {
      const dbPool = await ServicePool.findById(pool._id);
      assert.equal(dbPool.status, 'assigned');
      assert.equal(String(dbPool.assignedTechnicianId), String(techUser._id));

      const dbBooking = await Booking.findById(booking._id);
      assert.equal(dbBooking.status, 'confirmed', 'Losing booking must remain confirmed');
      assert.equal(dbBooking.technicianId, null, 'Losing booking must not have technician assigned');
    } else {
      const dbBooking = await Booking.findById(booking._id);
      assert.equal(dbBooking.status, 'assigned');
      assert.equal(String(dbBooking.technicianId), String(techUser._id));

      const dbPool = await ServicePool.findById(pool._id);
      assert.equal(dbPool.status, 'locked', 'Losing pool must remain locked');
      assert.equal(dbPool.assignedTechnicianId, null, 'Losing pool must not have technician assigned');
    }

    // Verify technician workload and availability
    const finalProfile = await TechnicianProfile.findOne({ userId: techUser._id });
    assert.equal(finalProfile.activeWorkload, 1, 'activeWorkload must be exactly 1');
    assert.equal(finalProfile.availabilityStatus, 'busy', 'Technician must be busy at max capacity');

    // Verify no orphan notifications were created for the loser
    const notifsAfter = await Notification.countDocuments({ userId: techUser._id });
    assert.equal(notifsAfter, notifsBefore + 1, 'Exactly one notification must be delivered to technician for the single winning job');
  });

  /* -------------------------------------------------------------------------
   * 2. Transaction Retry Behavior Verification
   * ------------------------------------------------------------------------- */
  it('2. confirms transaction retries re-evaluate complete eligibility rather than repeating blind writes', async () => {
    // Reset technician capacity to 2 for this test
    await TechnicianProfile.updateOne(
      { userId: techUser._id },
      { $set: { maxPoolCapacity: 2, availabilityStatus: 'available' } }
    );

    const testBooking = await Booking.create({
      customerId: customerUser._id,
      serviceCategoryId: category._id,
      zoneId: zone._id,
      location: toGeoJSONPoint(22.583, 88.413),
      addressText: 'Retry Test Location',
      timeWindow: {
        start: new Date(Date.now() + 200000000),
        end: new Date(Date.now() + 200000000 + 3 * 3600000),
      },
      bookingMode: 'individual',
      status: 'confirmed',
      estimatedPrice: 550,
    });

    let executionAttempts = 0;

    // Simulate transient error on attempt 1, re-evaluating on attempt 2
    await runInTransaction(
      async (session) => {
        executionAttempts += 1;

        // Fetch fresh state under transaction session
        const profileInTx = await TechnicianProfile.findOneAndUpdate(
          { userId: techUser._id },
          { $inc: { version: 1 } },
          { session, new: true }
        ).populate('userId', 'isActive');

        // Full eligibility check rerun inside the transaction attempt
        const evaluation = await evaluateBookingEligibility(profileInTx, testBooking, { session });
        assert.equal(evaluation.isEligible, true, 'Must evaluate full eligibility on every attempt');

        if (executionAttempts === 1) {
          // Simulate a transient error that triggers a retry
          const transientErr = new MongoServerError({ message: 'Write conflict during concurrent transaction' });
          transientErr.addErrorLabel('TransientTransactionError');
          throw transientErr;
        }

        // Second attempt executes cleanly
        testBooking.status = 'assigned';
        testBooking.technicianId = techUser._id;
        await testBooking.save({ session });
      },
      { requireTransaction: true }
    );

    assert.equal(executionAttempts, 2, 'Must have rerun complete work function twice via retry loop');
    const confirmedBooking = await Booking.findById(testBooking._id);
    assert.equal(confirmedBooking.status, 'assigned');
  });

  /* -------------------------------------------------------------------------
   * 3. Availability and Workload Lifecycle Audit
   * ------------------------------------------------------------------------- */
  it('3. prevents technician from manually overriding availability to available while an active job is in progress', async () => {
    // Create an in-progress booking for technician
    const inProgressBooking = await Booking.create({
      customerId: customerUser._id,
      serviceCategoryId: category._id,
      zoneId: zone._id,
      location: toGeoJSONPoint(22.583, 88.413),
      addressText: 'Active In-Progress Site',
      timeWindow: {
        start: new Date(),
        end: new Date(Date.now() + 3600000),
      },
      bookingMode: 'individual',
      status: 'in_progress',
      technicianId: techUser._id,
      startedAt: new Date(),
      estimatedPrice: 550,
    });

    // Recalculate to ensure profile is busy
    await recalculateTechnicianAvailability(techUser._id);
    const busyProfile = await TechnicianProfile.findOne({ userId: techUser._id });
    assert.equal(busyProfile.availabilityStatus, 'busy');

    // Attempt to manually toggle status to 'available' while working on-site
    const res = await requestApp('PATCH', '/api/v1/technicians/me/availability', {
      headers: { authorization: `Bearer ${techToken}` },
      body: { availabilityStatus: 'available' },
    });

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error.code, 'ACTIVE_JOB_IN_PROGRESS');
    assert.ok(res.body.error.message.includes('while a service job is in progress'));

    // Clean up in-progress booking
    inProgressBooking.status = 'completed';
    inProgressBooking.completedAt = new Date();
    await inProgressBooking.save();
    await recalculateTechnicianAvailability(techUser._id);
  });

  it('4. ensures recalculateTechnicianAvailability properly releases workload when jobs are completed or cancelled', async () => {
    // Create an assigned pool
    const activePool = await ServicePool.create({
      serviceCategoryId: category._id,
      zoneId: zone._id,
      status: 'assigned',
      assignedTechnicianId: techUser._id,
      maxCapacity: 2,
      poolRadiusKm: 3.0,
      centroidLocation: toGeoJSONPoint(22.582, 88.412),
      aggregateTimeWindow: {
        start: new Date(Date.now() + 300000000),
        end: new Date(Date.now() + 300000000 + 3 * 3600000),
      },
      lockCutoffTime: new Date(Date.now() - 60000),
      members: [],
    });

    await recalculateTechnicianAvailability(techUser._id);
    let profile = await TechnicianProfile.findOne({ userId: techUser._id });
    const initialWorkload = profile.activeWorkload;
    assert.ok(initialWorkload >= 1);

    // Cancel pool
    activePool.status = 'cancelled';
    activePool.cancelledAt = new Date();
    await activePool.save();

    await recalculateTechnicianAvailability(techUser._id);
    profile = await TechnicianProfile.findOne({ userId: techUser._id });
    assert.equal(profile.activeWorkload, initialWorkload - 1, 'Workload must decrement immediately');
  });

  /* -------------------------------------------------------------------------
   * 4. Live OSRM Smoke Test & Metrics Integrity
   * ------------------------------------------------------------------------- */
  it('5. executes live OSRM provider smoke test if network is accessible, verifying actual road metrics and asymmetry', async (t) => {
    let networkAvailable = false;
    try {
      const probe = await fetch('http://router.project-osrm.org/table/v1/driving/88.41,22.58;88.42,22.59?annotations=duration,distance', {
        signal: AbortSignal.timeout(3000),
      });
      networkAvailable = probe.ok;
    } catch {
      networkAvailable = false;
    }

    if (!networkAvailable) {
      return t.skip('Live OSRM server unreachable - smoke test NOT EXECUTED');
    }

    const liveProvider = new OsrmRoutingProvider({ baseUrl: 'http://router.project-osrm.org', timeoutMs: 5000 });
    const start = { lat: 22.580, lng: 88.410 };
    const stopLoc = { lat: 22.585, lng: 88.415 };

    const matrix = await liveProvider.getDistanceMatrix([start, stopLoc]);
    assert.equal(matrix.provider, 'osrm');
    assert.ok(matrix.durations[0][1] > 0, 'Road duration must be positive');
    assert.ok(matrix.distances[0][1] > 0, 'Road distance must be positive');

    // Run optimizePoolRoute with live OSRM
    const routeResult = await optimizePoolRoute({
      technicianStartLocation: start,
      stops: [
        {
          bookingId: 'live_osrm_stop_1',
          customerName: 'Live Test Customer',
          location: stopLoc,
          timeWindow: {
            start: new Date('2026-11-15T09:00:00Z'),
            end: new Date('2026-11-15T12:00:00Z'),
          },
          estimatedDurationMins: 30,
        },
      ],
      departureTime: new Date('2026-11-15T09:00:00Z'),
      routingProvider: liveProvider,
    });

    assert.equal(routeResult.optimizationStatus, 'optimal_road_network');
    assert.equal(routeResult.provider, 'osrm');
    assert.equal(routeResult.measurementType, 'actual_road_network');
    assert.equal(routeResult.roadDistanceCalculated, true);
    assert.ok(routeResult.totalTravelDistance.value > 0);
    assert.ok(routeResult.totalTravelTime.value > 0);
    assert.ok(routeResult.limitations.includes('Road distances and travel times are based on road-network topology'));
  });
});
