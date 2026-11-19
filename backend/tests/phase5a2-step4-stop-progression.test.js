import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

import app from '../src/app.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import {
  User,
  ServiceCategory,
  ServiceZone,
  TechnicianProfile,
  ServicePool,
  Booking,
  Notification,
} from '../src/models/index.js';
import { signAuthToken } from '../src/middleware/auth.js';
import { recalculateTechnicianAvailability } from '../src/modules/technicians/technicianAvailability.service.js';

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

describe('Phase 5A Step 4 — Stop-Level Progression & Concurrency Suite', () => {
  let replSet;
  let adminUser, adminToken;
  let customer1, customerToken1;
  let customer2, customerToken2;
  let customer3, customerToken3;
  let techUser1, techToken1, techProfile1;
  let techUser2, techToken2, techProfile2;
  let category, zone;

  const validPasswordHash = '$2a$10$abcdefghijklmnopqrstuvwxyz123456';

  before(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = replSet.getUri();
    process.env.MONGODB_URI = uri;

    await connectDB(uri);

    // Ensure all model indexes are built before executing transactions
    await Promise.all([
      User.init(),
      ServiceCategory.init(),
      ServiceZone.init(),
      TechnicianProfile.init(),
      ServicePool.init(),
      Booking.init(),
      Notification.init(),
    ]);

    // 1. Admin
    adminUser = await User.create({
      name: 'Admin Supervisor',
      email: `admin_${Date.now()}@test.local`,
      passwordHash: validPasswordHash,
      role: 'admin',
      isActive: true,
    });
    adminToken = signAuthToken(adminUser);

    // 2. Customers
    customer1 = await User.create({
      name: 'Customer One',
      email: `cust1_${Date.now()}@test.local`,
      phone: '+91-9876543211',
      passwordHash: validPasswordHash,
      role: 'customer',
      isActive: true,
    });
    customerToken1 = signAuthToken(customer1);

    customer2 = await User.create({
      name: 'Customer Two',
      email: `cust2_${Date.now()}@test.local`,
      phone: '+91-9876543212',
      passwordHash: validPasswordHash,
      role: 'customer',
      isActive: true,
    });
    customerToken2 = signAuthToken(customer2);

    customer3 = await User.create({
      name: 'Customer Three',
      email: `cust3_${Date.now()}@test.local`,
      phone: '+91-9876543213',
      passwordHash: validPasswordHash,
      role: 'customer',
      isActive: true,
    });
    customerToken3 = signAuthToken(customer3);

    // 3. Category & Zone
    category = await ServiceCategory.create({
      name: 'AC Precision Service',
      slug: `ac-service-${Date.now()}`,
      baseIndividualPrice: 800,
      estimatedDurationMins: 45,
      isActive: true,
    });

    zone = await ServiceZone.create({
      name: 'Salt Lake Sector V',
      code: `SLV_${Date.now().toString().slice(-4)}`,
      city: 'Kolkata',
      centerLocation: { type: 'Point', coordinates: [88.41, 22.58] },
      radiusKm: 15,
      isActive: true,
    });

    // 4. Primary Technician 1
    techUser1 = await User.create({
      name: 'Technician Alice',
      email: `tech_alice_${Date.now()}@test.local`,
      phone: '+91-9876543001',
      passwordHash: validPasswordHash,
      role: 'technician',
      isActive: true,
    });
    techToken1 = signAuthToken(techUser1);

    techProfile1 = await TechnicianProfile.create({
      userId: techUser1._id,
      serviceCategories: [category._id],
      zoneId: zone._id,
      baseLocation: { type: 'Point', coordinates: [88.41, 22.58] },
      addressText: 'Salt Lake Central Base',
      serviceRadiusKm: 12,
      maxPoolCapacity: 5,
      activeWorkload: 0,
      approvalStatus: 'approved',
      availabilityStatus: 'available',
    });

    // 5. Secondary Technician 2 (for authorization and ownership isolation)
    techUser2 = await User.create({
      name: 'Technician Bob',
      email: `tech_bob_${Date.now()}@test.local`,
      phone: '+91-9876543002',
      passwordHash: validPasswordHash,
      role: 'technician',
      isActive: true,
    });
    techToken2 = signAuthToken(techUser2);

    techProfile2 = await TechnicianProfile.create({
      userId: techUser2._id,
      serviceCategories: [category._id],
      zoneId: zone._id,
      baseLocation: { type: 'Point', coordinates: [88.35, 22.54] },
      addressText: 'South Base',
      serviceRadiusKm: 10,
      maxPoolCapacity: 4,
      activeWorkload: 0,
      approvalStatus: 'approved',
      availabilityStatus: 'available',
    });
  });

  after(async () => {
    await disconnectDB();
    if (replSet) {
      await replSet.stop();
    }
  });

  describe('1. Authentication, Authorization & Param Validation', () => {
    let dummyJobId;
    let dummyStopId;

    before(() => {
      dummyJobId = new mongoose.Types.ObjectId();
      dummyStopId = new mongoose.Types.ObjectId();
    });

    it('rejects unauthenticated requests to stop endpoints with 401 AUTH_REQUIRED', async () => {
      const endpoints = [
        ['GET', `/api/v1/technicians/me/jobs/${dummyJobId}/stops`],
        ['POST', `/api/v1/technicians/me/jobs/${dummyJobId}/stops/${dummyStopId}/arrive`],
        ['POST', `/api/v1/technicians/me/jobs/${dummyJobId}/stops/${dummyStopId}/start`],
        ['POST', `/api/v1/technicians/me/jobs/${dummyJobId}/stops/${dummyStopId}/complete`],
        ['POST', `/api/v1/technicians/me/jobs/${dummyJobId}/stops/${dummyStopId}/cancel`],
        ['PATCH', `/api/v1/technicians/me/jobs/${dummyJobId}/stops/${dummyStopId}/status`],
      ];

      for (const [method, url] of endpoints) {
        const res = await requestApp(method, url, { body: { status: 'arrived' } });
        assert.equal(res.statusCode, 401);
        assert.equal(res.body.error.code, 'AUTH_REQUIRED');
      }
    });

    it('rejects customer role requests with 403 FORBIDDEN_ROLE', async () => {
      const res = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${dummyJobId}/stops/${dummyStopId}/arrive`,
        { headers: { Authorization: `Bearer ${customerToken1}` } }
      );
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN_ROLE');
    });

    it('rejects admin role requests on technician personal stop endpoints with 403 FORBIDDEN_ROLE', async () => {
      const res = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${dummyJobId}/stops/${dummyStopId}/arrive`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN_ROLE');
    });

    it('rejects malformed ObjectId parameters with 400 INVALID_ID', async () => {
      const res1 = await requestApp(
        'GET',
        '/api/v1/technicians/me/jobs/not-a-valid-id/stops',
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      assert.equal(res1.statusCode, 400);
      assert.equal(res1.body.error.code, 'INVALID_ID');

      const res2 = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${dummyJobId}/stops/bad-stop-id/arrive`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      assert.equal(res2.statusCode, 400);
      assert.equal(res2.body.error.code, 'INVALID_ID');
    });
  });

  describe('2. Stop Lifecycle Progression (Arrival -> Start -> Complete)', () => {
    let pool, booking1, booking2, booking3;

    before(async () => {
      const now = new Date();

      booking1 = await Booking.create({
        customerId: customer1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        location: { type: 'Point', coordinates: [88.41, 22.58] },
        addressText: 'Salt Lake Stop 1',
        timeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 7200000),
        },
        status: 'accepted',
        stopSequence: 1,
        estimatedPrice: 650,
      });

      booking2 = await Booking.create({
        customerId: customer2._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        location: { type: 'Point', coordinates: [88.42, 22.585] },
        addressText: 'Salt Lake Stop 2',
        timeWindow: {
          start: new Date(now.getTime() + 4500000),
          end: new Date(now.getTime() + 8100000),
        },
        status: 'accepted',
        stopSequence: 2,
        estimatedPrice: 650,
      });

      booking3 = await Booking.create({
        customerId: customer3._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        location: { type: 'Point', coordinates: [88.43, 22.59] },
        addressText: 'Salt Lake Stop 3',
        timeWindow: {
          start: new Date(now.getTime() + 5400000),
          end: new Date(now.getTime() + 9000000),
        },
        status: 'accepted',
        stopSequence: 3,
        estimatedPrice: 650,
      });

      pool = await ServicePool.create({
        serviceCategoryId: category._id,
        zoneId: zone._id,
        status: 'accepted',
        assignedTechnicianId: techUser1._id,
        assignedAt: new Date(now.getTime() - 100000),
        acceptedAt: new Date(now.getTime() - 50000),
        maxCapacity: 4,
        poolRadiusKm: 5.0,
        centroidLocation: { type: 'Point', coordinates: [88.42, 22.585] },
        aggregateTimeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 9000000),
        },
        lockCutoffTime: new Date(now.getTime() - 200000),
        members: [
          { bookingId: booking1._id, customerId: customer1._id, location: booking1.location, addressText: booking1.addressText, status: 'active' },
          { bookingId: booking2._id, customerId: customer2._id, location: booking2.location, addressText: booking2.addressText, status: 'active' },
          { bookingId: booking3._id, customerId: customer3._id, location: booking3.location, addressText: booking3.addressText, status: 'active' },
        ],
        routeOrder: [
          { bookingId: booking1._id, sequenceIndex: 1 },
          { bookingId: booking2._id, sequenceIndex: 2 },
          { bookingId: booking3._id, sequenceIndex: 3 },
        ],
      });

      await Booking.updateMany(
        { _id: { $in: [booking1._id, booking2._id, booking3._id] } },
        { $set: { poolId: pool._id } }
      );
    });

    it('retrieves all sequenced stops and progression status via GET /jobs/:jobId/stops', async () => {
      const res = await requestApp('GET', `/api/v1/technicians/me/jobs/${pool._id}/stops`, {
        headers: { Authorization: `Bearer ${techToken1}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      const data = res.body.data;

      assert.equal(data.jobId, String(pool._id));
      assert.equal(data.jobType, 'pool');
      assert.equal(data.stops.length, 3);
      assert.equal(data.progression.totalStops, 3);
      assert.equal(data.progression.completedStops, 0);
      assert.equal(data.progression.remainingStops, 3);
      assert.equal(data.progression.nextEligibleStopId, String(booking1._id));

      // Stop 1 is next eligible; Stop 2 and 3 are not
      assert.equal(data.stops[0].isNextEligible, true);
      assert.equal(data.stops[1].isNextEligible, false);
      assert.equal(data.stops[2].isNextEligible, false);
    });

    it('rejects attempt to start service before arrival (enforces state machine)', async () => {
      const res = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${pool._id}/stops/${booking1._id}/start`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );

      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'INVALID_STATUS_TRANSITION');
      assert.match(res.body.error.message, /before arrival/i);
    });

    it('rejects attempt to complete service before start (enforces state machine)', async () => {
      const res = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${pool._id}/stops/${booking1._id}/complete`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );

      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'INVALID_STATUS_TRANSITION');
      assert.match(res.body.error.message, /before it has started/i);
    });

    it('rejects attempt to progress to Stop 2 while mandatory earlier Stop 1 is incomplete', async () => {
      const res = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${pool._id}/stops/${booking2._id}/arrive`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );

      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'INVALID_SEQUENCE_PROGRESSION');
      assert.match(res.body.error.message, /mandatory earlier stop #1 remains incomplete/i);
    });

    it('records valid arrival at Stop 1 and updates parent pool to in_progress', async () => {
      const res = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${pool._id}/stops/${booking1._id}/arrive`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { latitude: 22.5801, longitude: 88.4102 },
        }
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      const data = res.body.data;

      assert.equal(data.stop.status, 'arrived');
      assert.ok(data.stop.arrivedAt);
      assert.equal(data.jobStatus, 'in_progress');
      assert.equal(data.progression.arrivedStops, 1);

      // Verify DB persistence on Booking
      const b1 = await Booking.findById(booking1._id);
      assert.equal(b1.status, 'arrived');
      assert.ok(b1.arrivedAt);
      assert.deepEqual(b1.arrivalLocation.coordinates, [88.4102, 22.5801]);

      // Verify DB persistence on ServicePool
      const updatedPool = await ServicePool.findById(pool._id);
      assert.equal(updatedPool.status, 'in_progress');
      assert.ok(updatedPool.startedAt);

      // Verify Notification sent to Customer 1 only
      const notif = await Notification.findOne({
        userId: customer1._id,
        relatedEntityId: booking1._id,
        title: 'Technician Arrived',
      });
      assert.ok(notif, 'Customer 1 must receive arrival notification');

      // Customers 2 and 3 must NOT receive arrival notifications for Stop 1
      const notif2 = await Notification.findOne({
        userId: customer2._id,
        title: 'Technician Arrived',
      });
      assert.equal(notif2, null);
    });

    it('rejects duplicate arrival request on Stop 1 with 409 INVALID_STATUS_TRANSITION', async () => {
      const res = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${pool._id}/stops/${booking1._id}/arrive`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );

      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'INVALID_STATUS_TRANSITION');
      assert.match(res.body.error.message, /already marked as arrived/i);
    });

    it('starts service work on Stop 1', async () => {
      const res = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${pool._id}/stops/${booking1._id}/start`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.data.stop.status, 'in_progress');
      assert.ok(res.body.data.stop.startedAt);

      const b1 = await Booking.findById(booking1._id);
      assert.equal(b1.status, 'in_progress');
      assert.ok(b1.startedAt);

      const notif = await Notification.findOne({
        userId: customer1._id,
        relatedEntityId: booking1._id,
        title: 'Service Started',
      });
      assert.ok(notif);
    });

    it('rejects duplicate start request on Stop 1 with 409 INVALID_STATUS_TRANSITION', async () => {
      const res = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${pool._id}/stops/${booking1._id}/start`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );

      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'INVALID_STATUS_TRANSITION');
      assert.match(res.body.error.message, /already in progress/i);
    });

    it('completes service work on Stop 1 and advances next eligible stop to Stop 2', async () => {
      const res = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${pool._id}/stops/${booking1._id}/complete`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.data.stop.status, 'completed');
      assert.ok(res.body.data.stop.completedAt);

      // Parent pool must NOT complete because Stops 2 & 3 remain incomplete!
      assert.equal(res.body.data.jobStatus, 'in_progress');
      assert.equal(res.body.data.progression.completedStops, 1);
      assert.equal(res.body.data.progression.remainingStops, 2);
      assert.equal(res.body.data.progression.nextEligibleStopId, String(booking2._id));
      assert.equal(res.body.data.isParentJobFinished, false);

      const poolCheck = await ServicePool.findById(pool._id);
      assert.equal(poolCheck.status, 'in_progress');
      assert.equal(poolCheck.completedAt, null);

      const notif = await Notification.findOne({
        userId: customer1._id,
        relatedEntityId: booking1._id,
        title: 'Service Completed',
      });
      assert.ok(notif);
    });

    it('rejects duplicate completion request on Stop 1 with 409 INVALID_STATUS_TRANSITION', async () => {
      const res = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${pool._id}/stops/${booking1._id}/complete`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );

      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'INVALID_STATUS_TRANSITION');
      assert.match(res.body.error.message, /already completed/i);
    });

    it('progresses Stop 2 (arrive -> start -> complete) while Stop 3 remains incomplete', async () => {
      // Arrive at Stop 2
      const resArr = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${pool._id}/stops/${booking2._id}/arrive`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      assert.equal(resArr.statusCode, 200);

      // Start Stop 2
      const resStart = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${pool._id}/stops/${booking2._id}/start`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      assert.equal(resStart.statusCode, 200);

      // Complete Stop 2
      const resComp = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${pool._id}/stops/${booking2._id}/complete`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      assert.equal(resComp.statusCode, 200);
      assert.equal(resComp.body.data.progression.completedStops, 2);
      assert.equal(resComp.body.data.progression.remainingStops, 1);
      assert.equal(resComp.body.data.progression.nextEligibleStopId, String(booking3._id));

      // Parent pool still in_progress
      const poolCheck = await ServicePool.findById(pool._id);
      assert.equal(poolCheck.status, 'in_progress');
    });

    it('completes final Stop 3, causing parent pool to reach terminal completed status', async () => {
      const initialJobsCompleted = (await TechnicianProfile.findOne({ userId: techUser1._id })).jobsCompleted || 0;

      // Arrive at Stop 3
      await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${pool._id}/stops/${booking3._id}/arrive`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );

      // Start Stop 3
      await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${pool._id}/stops/${booking3._id}/start`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );

      // Complete Stop 3
      const resComp = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${pool._id}/stops/${booking3._id}/complete`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );

      assert.equal(resComp.statusCode, 200);
      assert.equal(resComp.body.data.stop.status, 'completed');
      assert.equal(resComp.body.data.jobStatus, 'completed');
      assert.equal(resComp.body.data.isParentJobFinished, true);
      assert.equal(resComp.body.data.progression.remainingStops, 0);

      // Verify DB persistence of pool completion
      const completedPool = await ServicePool.findById(pool._id);
      assert.equal(completedPool.status, 'completed');
      assert.ok(completedPool.completedAt);

      // Verify TechnicianProfile jobsCompleted incremented by 1
      const updatedProfile = await TechnicianProfile.findOne({ userId: techUser1._id });
      assert.equal(updatedProfile.jobsCompleted, initialJobsCompleted + 1);
    });

    it('rejects any further status transitions on stops once parent pool is completed', async () => {
      const res = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${pool._id}/stops/${booking1._id}/arrive`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'INVALID_STATUS_TRANSITION');
      assert.match(res.body.error.message, /already completed job/i);
    });
  });

  describe('3. Ownership Isolation & Invalid Stop-Job Relationships', () => {
    let foreignPool, foreignBooking;

    before(async () => {
      const now = new Date();
      foreignBooking = await Booking.create({
        customerId: customer1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        location: { type: 'Point', coordinates: [88.35, 22.54] },
        addressText: 'Tech 2 Foreign Stop',
        timeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 7200000),
        },
        status: 'accepted',
        stopSequence: 1,
        estimatedPrice: 700,
      });

      foreignPool = await ServicePool.create({
        serviceCategoryId: category._id,
        zoneId: zone._id,
        status: 'accepted',
        assignedTechnicianId: techUser2._id,
        assignedAt: new Date(),
        acceptedAt: new Date(),
        maxCapacity: 4,
        poolRadiusKm: 5.0,
        centroidLocation: { type: 'Point', coordinates: [88.35, 22.54] },
        aggregateTimeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 7200000),
        },
        lockCutoffTime: new Date(now.getTime() - 200000),
        members: [
          { bookingId: foreignBooking._id, customerId: customer1._id, location: foreignBooking.location, status: 'active' },
        ],
      });

      await Booking.updateOne({ _id: foreignBooking._id }, { $set: { poolId: foreignPool._id } });
    });

    it('Technician 1 receives 403 FORBIDDEN_JOB_ACCESS when attempting to transition Technician 2 stop', async () => {
      const res = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${foreignPool._id}/stops/${foreignBooking._id}/arrive`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN_JOB_ACCESS');
    });

    it('Technician 1 receives 400 INVALID_STOP_RELATIONSHIP when stop does not belong to the requested job', async () => {
      // Find an active pool belonging to Tech 1
      const activePoolTech1 = await ServicePool.findOne({ assignedTechnicianId: techUser1._id });

      // Pass foreignBooking._id under Tech 1's pool
      const res = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${activePoolTech1._id}/stops/${foreignBooking._id}/arrive`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error.code, 'INVALID_STOP_RELATIONSHIP');
    });
  });

  describe('4. Stop Cancellation & Partial Failure Handling', () => {
    let cancelPool, stopA, stopB, stopC;

    before(async () => {
      const now = new Date();

      stopA = await Booking.create({
        customerId: customer1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        location: { type: 'Point', coordinates: [88.41, 22.58] },
        addressText: 'Cancel Test Stop A',
        timeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 7200000),
        },
        status: 'accepted',
        stopSequence: 1,
        estimatedPrice: 600,
      });

      stopB = await Booking.create({
        customerId: customer2._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        location: { type: 'Point', coordinates: [88.42, 22.58] },
        addressText: 'Cancel Test Stop B',
        timeWindow: {
          start: new Date(now.getTime() + 4500000),
          end: new Date(now.getTime() + 8100000),
        },
        status: 'accepted',
        stopSequence: 2,
        estimatedPrice: 600,
      });

      stopC = await Booking.create({
        customerId: customer3._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        location: { type: 'Point', coordinates: [88.43, 22.58] },
        addressText: 'Cancel Test Stop C',
        timeWindow: {
          start: new Date(now.getTime() + 5400000),
          end: new Date(now.getTime() + 9000000),
        },
        status: 'accepted',
        stopSequence: 3,
        estimatedPrice: 600,
      });

      cancelPool = await ServicePool.create({
        serviceCategoryId: category._id,
        zoneId: zone._id,
        status: 'accepted',
        assignedTechnicianId: techUser1._id,
        assignedAt: new Date(now.getTime() - 100000),
        acceptedAt: new Date(now.getTime() - 50000),
        maxCapacity: 4,
        poolRadiusKm: 5.0,
        centroidLocation: { type: 'Point', coordinates: [88.42, 22.58] },
        aggregateTimeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 9000000),
        },
        lockCutoffTime: new Date(now.getTime() - 200000),
        members: [
          { bookingId: stopA._id, customerId: customer1._id, location: stopA.location, addressText: stopA.addressText, status: 'active' },
          { bookingId: stopB._id, customerId: customer2._id, location: stopB.location, addressText: stopB.addressText, status: 'active' },
          { bookingId: stopC._id, customerId: customer3._id, location: stopC.location, addressText: stopC.addressText, status: 'active' },
        ],
        routeOrder: [
          { bookingId: stopA._id, sequenceIndex: 1 },
          { bookingId: stopB._id, sequenceIndex: 2 },
          { bookingId: stopC._id, sequenceIndex: 3 },
        ],
      });

      await Booking.updateMany(
        { _id: { $in: [stopA._id, stopB._id, stopC._id] } },
        { $set: { poolId: cancelPool._id } }
      );
    });

    it('cancels Stop 1 with a valid reason and records cancellation metadata', async () => {
      const res = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${cancelPool._id}/stops/${stopA._id}/cancel`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { reason: 'Customer was not present at address' },
        }
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      const data = res.body.data;

      assert.equal(data.stop.status, 'cancelled');
      assert.ok(data.stop.cancelledAt);
      assert.equal(data.stop.rejectionReason, 'Customer was not present at address');
      assert.equal(data.progression.cancelledStops, 1);
      assert.equal(data.progression.remainingStops, 2);

      // Next eligible stop progresses to Stop 2!
      assert.equal(data.progression.nextEligibleStopId, String(stopB._id));

      // Parent pool must remain active (in_progress or accepted)
      const p = await ServicePool.findById(cancelPool._id);
      assert.ok(['accepted', 'in_progress'].includes(p.status));

      // Verify Stop A member is marked cancelled in pool
      const memberA = p.members.find((m) => String(m.bookingId) === String(stopA._id));
      assert.equal(memberA.status, 'cancelled');

      // Verify uncancelled stops B and C remain active in pool
      const memberB = p.members.find((m) => String(m.bookingId) === String(stopB._id));
      const memberC = p.members.find((m) => String(m.bookingId) === String(stopC._id));
      assert.equal(memberB.status, 'active');
      assert.equal(memberC.status, 'active');

      // Verify Customer 1 received cancellation notification
      const notif = await Notification.findOne({
        userId: customer1._id,
        relatedEntityId: stopA._id,
        title: 'Service Stop Cancelled',
      });
      assert.ok(notif);
    });

    it('technician can immediately proceed to Stop 2 without being blocked by cancelled Stop 1', async () => {
      // Because Stop 1 is terminal (cancelled), Stop 2 is now the first active stop
      const resArr = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${cancelPool._id}/stops/${stopB._id}/arrive`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      assert.equal(resArr.statusCode, 200);
      assert.equal(resArr.body.data.stop.status, 'arrived');

      const resStart = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${cancelPool._id}/stops/${stopB._id}/start`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      assert.equal(resStart.statusCode, 200);

      const resComp = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${cancelPool._id}/stops/${stopB._id}/complete`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      assert.equal(resComp.statusCode, 200);
      assert.equal(resComp.body.data.stop.status, 'completed');
    });

    it('rejects attempt to cancel an already completed stop with 409 INVALID_STATUS_TRANSITION', async () => {
      const res = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${cancelPool._id}/stops/${stopB._id}/cancel`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { reason: 'Accidental cancellation attempt' },
        }
      );

      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'INVALID_STATUS_TRANSITION');
      assert.match(res.body.error.message, /already completed stop/i);
    });

    it('cancels Stop 3, causing pool with at least one completed stop to reach completed status', async () => {
      const res = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${cancelPool._id}/stops/${stopC._id}/cancel`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { reason: 'Customer requested cancellation' },
        }
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.data.stop.status, 'cancelled');

      // Because Stop B was completed and Stop A & C are cancelled, remainingStops = 0
      // Pool reaches completed status!
      assert.equal(res.body.data.jobStatus, 'completed');
      assert.equal(res.body.data.isParentJobFinished, true);

      const p = await ServicePool.findById(cancelPool._id);
      assert.equal(p.status, 'completed');
    });
  });

  describe('5. Concurrency Control & Atomic Transition Protection', () => {
    let concPool, concStop1, concStop2;

    before(async () => {
      const now = new Date();

      concStop1 = await Booking.create({
        customerId: customer1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        location: { type: 'Point', coordinates: [88.41, 22.58] },
        addressText: 'Concurrency Stop 1',
        timeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 7200000),
        },
        status: 'accepted',
        stopSequence: 1,
        estimatedPrice: 600,
      });

      concStop2 = await Booking.create({
        customerId: customer2._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        location: { type: 'Point', coordinates: [88.42, 22.58] },
        addressText: 'Concurrency Stop 2',
        timeWindow: {
          start: new Date(now.getTime() + 4500000),
          end: new Date(now.getTime() + 8100000),
        },
        status: 'accepted',
        stopSequence: 2,
        estimatedPrice: 600,
      });

      concPool = await ServicePool.create({
        serviceCategoryId: category._id,
        zoneId: zone._id,
        status: 'accepted',
        assignedTechnicianId: techUser1._id,
        assignedAt: new Date(),
        acceptedAt: new Date(),
        maxCapacity: 4,
        poolRadiusKm: 5.0,
        centroidLocation: { type: 'Point', coordinates: [88.41, 22.58] },
        aggregateTimeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 8100000),
        },
        lockCutoffTime: new Date(now.getTime() - 200000),
        members: [
          { bookingId: concStop1._id, customerId: customer1._id, location: concStop1.location, status: 'active' },
          { bookingId: concStop2._id, customerId: customer2._id, location: concStop2.location, status: 'active' },
        ],
        routeOrder: [
          { bookingId: concStop1._id, sequenceIndex: 1 },
          { bookingId: concStop2._id, sequenceIndex: 2 },
        ],
      });

      await Booking.updateMany(
        { _id: { $in: [concStop1._id, concStop2._id] } },
        { $set: { poolId: concPool._id } }
      );
    });

    it('simultaneous concurrent arrival requests on Stop 1: exactly 1 wins (200) and 1 rejected (409)', async () => {
      const [resA, resB] = await Promise.all([
        requestApp(
          'POST',
          `/api/v1/technicians/me/jobs/${concPool._id}/stops/${concStop1._id}/arrive`,
          { headers: { Authorization: `Bearer ${techToken1}` } }
        ),
        requestApp(
          'POST',
          `/api/v1/technicians/me/jobs/${concPool._id}/stops/${concStop1._id}/arrive`,
          { headers: { Authorization: `Bearer ${techToken1}` } }
        ),
      ]);

      const statusCodes = [resA.statusCode, resB.statusCode].sort((a, b) => a - b);
      assert.deepEqual(statusCodes, [200, 409], 'Concurrent arrivals must yield exactly one 200 and one 409');

      // Verify no duplicate notification was created
      const notifCount = await Notification.countDocuments({
        relatedEntityId: concStop1._id,
        title: 'Technician Arrived',
      });
      assert.equal(notifCount, 1, 'Exactly one arrival notification must be emitted');
    });

    it('simultaneous concurrent start requests on Stop 1: exactly 1 wins (200) and 1 rejected (409)', async () => {
      const [resA, resB] = await Promise.all([
        requestApp(
          'POST',
          `/api/v1/technicians/me/jobs/${concPool._id}/stops/${concStop1._id}/start`,
          { headers: { Authorization: `Bearer ${techToken1}` } }
        ),
        requestApp(
          'POST',
          `/api/v1/technicians/me/jobs/${concPool._id}/stops/${concStop1._id}/start`,
          { headers: { Authorization: `Bearer ${techToken1}` } }
        ),
      ]);

      const statusCodes = [resA.statusCode, resB.statusCode].sort((a, b) => a - b);
      assert.deepEqual(statusCodes, [200, 409], 'Concurrent starts must yield exactly one 200 and one 409');

      const notifCount = await Notification.countDocuments({
        relatedEntityId: concStop1._id,
        title: 'Service Started',
      });
      assert.equal(notifCount, 1);
    });

    it('simultaneous completion vs cancellation on Stop 1: exactly 1 wins and state remains consistent', async () => {
      const [resComplete, resCancel] = await Promise.all([
        requestApp(
          'POST',
          `/api/v1/technicians/me/jobs/${concPool._id}/stops/${concStop1._id}/complete`,
          { headers: { Authorization: `Bearer ${techToken1}` } }
        ),
        requestApp(
          'POST',
          `/api/v1/technicians/me/jobs/${concPool._id}/stops/${concStop1._id}/cancel`,
          {
            headers: { Authorization: `Bearer ${techToken1}` },
            body: { reason: 'Concurrent cancellation attempt' },
          }
        ),
      ]);

      const statusCodes = [resComplete.statusCode, resCancel.statusCode].sort((a, b) => a - b);
      assert.deepEqual(statusCodes, [200, 409], 'Conflicting completion/cancellation must yield exactly one 200 and one 409');

      const finalStop = await Booking.findById(concStop1._id);
      assert.ok(['completed', 'cancelled'].includes(finalStop.status));
    });
  });

  describe('6. Individual Standalone Booking Progression', () => {
    let soloBooking;

    before(async () => {
      // Complete any lingering jobs for techUser1 to ensure clean availability baseline
      await ServicePool.updateMany(
        { assignedTechnicianId: techUser1._id, status: { $in: ['assigned', 'accepted', 'in_progress'] } },
        { $set: { status: 'completed', completedAt: new Date() } }
      );
      await Booking.updateMany(
        { technicianId: techUser1._id, status: { $in: ['assigned', 'accepted', 'arrived', 'in_progress'] } },
        { $set: { status: 'completed', completedAt: new Date() } }
      );
      await recalculateTechnicianAvailability(techUser1._id);

      const now = new Date();
      soloBooking = await Booking.create({
        customerId: customer1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        poolId: null, // Standalone
        technicianId: techUser1._id,
        location: { type: 'Point', coordinates: [88.415, 22.582] },
        addressText: 'Standalone Stop Address',
        timeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 7200000),
        },
        status: 'accepted',
        estimatedPrice: 850,
      });
      await recalculateTechnicianAvailability(techUser1._id);
    });

    it('allows stop inspection on individual booking via GET /jobs/:id/stops', async () => {
      const res = await requestApp('GET', `/api/v1/technicians/me/jobs/${soloBooking._id}/stops`, {
        headers: { Authorization: `Bearer ${techToken1}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.data.jobType, 'individual');
      assert.equal(res.body.data.stops.length, 1);
      assert.equal(res.body.data.progression.totalStops, 1);
      assert.equal(res.body.data.stops[0].isNextEligible, true);
    });

    it('executes complete progression for standalone booking: arrive -> start -> complete', async () => {
      // 1. Arrive
      const resArr = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${soloBooking._id}/stops/${soloBooking._id}/arrive`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      assert.equal(resArr.statusCode, 200);
      assert.equal(resArr.body.data.stop.status, 'arrived');

      // F-2 check: Technician availability must become 'busy' upon arrival at standalone booking
      const profileAfterArrive = await TechnicianProfile.findOne({ userId: techUser1._id });
      assert.equal(profileAfterArrive.availabilityStatus, 'busy');

      // 2. Start
      const resStart = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${soloBooking._id}/stops/${soloBooking._id}/start`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      assert.equal(resStart.statusCode, 200);
      assert.equal(resStart.body.data.stop.status, 'in_progress');

      // F-2 check: Technician availability remains 'busy' during active service
      const profileAfterStart = await TechnicianProfile.findOne({ userId: techUser1._id });
      assert.equal(profileAfterStart.availabilityStatus, 'busy');

      // 3. Complete
      const resComp = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${soloBooking._id}/stops/${soloBooking._id}/complete`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      assert.equal(resComp.statusCode, 200);
      assert.equal(resComp.body.data.stop.status, 'completed');
      assert.equal(resComp.body.data.isParentJobFinished, true);

      // Verify Booking status
      const b = await Booking.findById(soloBooking._id);
      assert.equal(b.status, 'completed');
      assert.ok(b.completedAt);

      // F-2 check: Technician availability restored to 'available' after completion
      const profileAfterComp = await TechnicianProfile.findOne({ userId: techUser1._id });
      assert.equal(profileAfterComp.availabilityStatus, 'available');
    });

    it('verifies technician availability is properly restored when an arrived standalone booking is cancelled', async () => {
      const cancelSolo = await Booking.create({
        customerId: customer2._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        poolId: null,
        technicianId: techUser1._id,
        location: { type: 'Point', coordinates: [88.42, 22.58] },
        addressText: 'Cancel Standalone Address',
        timeWindow: {
          start: new Date(Date.now() + 3600000),
          end: new Date(Date.now() + 7200000),
        },
        status: 'accepted',
        estimatedPrice: 700,
      });

      // Arrive -> technician becomes busy
      const resArr = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${cancelSolo._id}/stops/${cancelSolo._id}/arrive`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      assert.equal(resArr.statusCode, 200);

      const profileBusy = await TechnicianProfile.findOne({ userId: techUser1._id });
      assert.equal(profileBusy.availabilityStatus, 'busy');

      // Cancel -> technician restored to available
      const resCancel = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${cancelSolo._id}/stops/${cancelSolo._id}/cancel`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { reason: 'Customer was not available on site' },
        }
      );
      assert.equal(resCancel.statusCode, 200);
      assert.equal(resCancel.body.data.stop.status, 'cancelled');

      const profileRestored = await TechnicianProfile.findOne({ userId: techUser1._id });
      assert.equal(profileRestored.availabilityStatus, 'available');
    });
  });

  describe('7. All-Stops-Cancelled Parent Pool Progression (F-5A)', () => {
    let allCancelPool, stop1, stop2;

    before(async () => {
      const now = new Date();

      stop1 = await Booking.create({
        customerId: customer1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        location: { type: 'Point', coordinates: [88.41, 22.58] },
        addressText: 'All Cancel Stop 1',
        timeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 7200000),
        },
        status: 'accepted',
        stopSequence: 1,
        estimatedPrice: 600,
      });

      stop2 = await Booking.create({
        customerId: customer2._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        location: { type: 'Point', coordinates: [88.42, 22.58] },
        addressText: 'All Cancel Stop 2',
        timeWindow: {
          start: new Date(now.getTime() + 4500000),
          end: new Date(now.getTime() + 8100000),
        },
        status: 'accepted',
        stopSequence: 2,
        estimatedPrice: 600,
      });

      allCancelPool = await ServicePool.create({
        serviceCategoryId: category._id,
        zoneId: zone._id,
        status: 'accepted',
        assignedTechnicianId: techUser1._id,
        assignedAt: new Date(),
        acceptedAt: new Date(),
        maxCapacity: 4,
        poolRadiusKm: 5.0,
        centroidLocation: { type: 'Point', coordinates: [88.415, 22.58] },
        aggregateTimeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 8100000),
        },
        lockCutoffTime: new Date(now.getTime() - 200000),
        members: [
          { bookingId: stop1._id, customerId: customer1._id, location: stop1.location, status: 'active' },
          { bookingId: stop2._id, customerId: customer2._id, location: stop2.location, status: 'active' },
        ],
        routeOrder: [
          { bookingId: stop1._id, sequenceIndex: 1 },
          { bookingId: stop2._id, sequenceIndex: 2 },
        ],
      });

      await Booking.updateMany(
        { _id: { $in: [stop1._id, stop2._id] } },
        { $set: { poolId: allCancelPool._id } }
      );
    });

    it('cancels all stops in pool, verifying parent transitions to cancelled without incrementing jobsCompleted', async () => {
      const initialProfile = await TechnicianProfile.findOne({ userId: techUser1._id });
      const initialCompleted = initialProfile.jobsCompleted || 0;

      // Cancel Stop 1
      const res1 = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${allCancelPool._id}/stops/${stop1._id}/cancel`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { reason: 'Customer 1 cancelled service' },
        }
      );
      assert.equal(res1.statusCode, 200);
      assert.equal(res1.body.data.isParentJobFinished, false);

      // Cancel Stop 2 -> all stops now cancelled
      const res2 = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${allCancelPool._id}/stops/${stop2._id}/cancel`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { reason: 'Customer 2 address inaccessible' },
        }
      );
      assert.equal(res2.statusCode, 200);
      assert.equal(res2.body.data.isParentJobFinished, true);
      assert.equal(res2.body.data.jobStatus, 'cancelled');

      // Verify ServicePool in DB
      const updatedPool = await ServicePool.findById(allCancelPool._id);
      assert.equal(updatedPool.status, 'cancelled');
      assert.ok(updatedPool.cancelledAt);
      assert.equal(updatedPool.completedAt, null);
      assert.equal(updatedPool.rejectionReason, 'All stops in pool were cancelled.');

      // Verify jobsCompleted was NOT incremented
      const finalProfile = await TechnicianProfile.findOne({ userId: techUser1._id });
      assert.equal(finalProfile.jobsCompleted, initialCompleted);

      // Verify no 'Service Completed' notification was emitted for this pool
      const compNotif = await Notification.findOne({
        title: 'Service Completed',
        relatedEntityId: { $in: [stop1._id, stop2._id, allCancelPool._id] },
      });
      assert.equal(compNotif, null);
    });
  });

  describe('8. Generic PATCH Stop Status Endpoint & Sequencing Integrity (F-5B)', () => {
    let patchPool, patchStop1, patchStop2;

    before(async () => {
      const now = new Date();

      patchStop1 = await Booking.create({
        customerId: customer1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        location: { type: 'Point', coordinates: [88.41, 22.58] },
        addressText: 'Patch Stop 1',
        timeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 7200000),
        },
        status: 'accepted',
        stopSequence: 1,
        estimatedPrice: 600,
      });

      patchStop2 = await Booking.create({
        customerId: customer2._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        location: { type: 'Point', coordinates: [88.42, 22.58] },
        addressText: 'Patch Stop 2',
        timeWindow: {
          start: new Date(now.getTime() + 4500000),
          end: new Date(now.getTime() + 8100000),
        },
        status: 'accepted',
        stopSequence: 2,
        estimatedPrice: 600,
      });

      patchPool = await ServicePool.create({
        serviceCategoryId: category._id,
        zoneId: zone._id,
        status: 'accepted',
        assignedTechnicianId: techUser1._id,
        assignedAt: new Date(),
        acceptedAt: new Date(),
        maxCapacity: 4,
        poolRadiusKm: 5.0,
        centroidLocation: { type: 'Point', coordinates: [88.415, 22.58] },
        aggregateTimeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 8100000),
        },
        lockCutoffTime: new Date(now.getTime() - 200000),
        members: [
          { bookingId: patchStop1._id, customerId: customer1._id, location: patchStop1.location, status: 'active' },
          { bookingId: patchStop2._id, customerId: customer2._id, location: patchStop2.location, status: 'active' },
        ],
        routeOrder: [
          { bookingId: patchStop1._id, sequenceIndex: 1 },
          { bookingId: patchStop2._id, sequenceIndex: 2 },
        ],
      });

      await Booking.updateMany(
        { _id: { $in: [patchStop1._id, patchStop2._id] } },
        { $set: { poolId: patchPool._id } }
      );
    });

    it('executes valid arrival via PATCH /me/jobs/:jobId/stops/:stopId/status and verifies DB persistence', async () => {
      const res = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${patchPool._id}/stops/${patchStop1._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'arrived', latitude: 22.58, longitude: 88.41 },
        }
      );
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.data.stop.status, 'arrived');

      const b = await Booking.findById(patchStop1._id);
      assert.equal(b.status, 'arrived');
      assert.ok(b.arrivedAt);
    });

    it('rejects attempt via PATCH to progress to Stop 2 while Stop 1 is in arrived state (enforces sequencing)', async () => {
      const res = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${patchPool._id}/stops/${patchStop2._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'arrived' },
        }
      );
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'INVALID_SEQUENCE_PROGRESSION');
    });

    it('executes valid start and completion on Stop 1 via PATCH /status', async () => {
      // Start Stop 1
      const resStart = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${patchPool._id}/stops/${patchStop1._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'in_progress' },
        }
      );
      assert.equal(resStart.statusCode, 200);
      assert.equal(resStart.body.data.stop.status, 'in_progress');

      // Complete Stop 1
      const resComp = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${patchPool._id}/stops/${patchStop1._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'completed' },
        }
      );
      assert.equal(resComp.statusCode, 200);
      assert.equal(resComp.body.data.stop.status, 'completed');

      const b = await Booking.findById(patchStop1._id);
      assert.equal(b.status, 'completed');
    });

    it('rejects illegal direct jump from accepted to completed on Stop 2 via PATCH', async () => {
      const res = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${patchPool._id}/stops/${patchStop2._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'completed' },
        }
      );
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'INVALID_STATUS_TRANSITION');
    });

    it('rejects illegal direct jump from accepted to in_progress on Stop 2 via PATCH', async () => {
      const res = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${patchPool._id}/stops/${patchStop2._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'in_progress' },
        }
      );
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'INVALID_STATUS_TRANSITION');
    });

    it('rejects attempts to transition already completed Stop 1 via PATCH', async () => {
      const res = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${patchPool._id}/stops/${patchStop1._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'arrived' },
        }
      );
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'INVALID_STATUS_TRANSITION');
    });

    it('rejects unauthorized technician attempting PATCH on another technicians job', async () => {
      const res = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${patchPool._id}/stops/${patchStop2._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken2}` },
          body: { status: 'arrived' },
        }
      );
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN_JOB_ACCESS');
    });
  });

  describe('9. Optimistic Concurrency & Stale Version Rejection (F-4)', () => {
    let occBooking;

    before(async () => {
      occBooking = await Booking.create({
        customerId: customer1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        poolId: null,
        technicianId: techUser1._id,
        location: { type: 'Point', coordinates: [88.41, 22.58] },
        addressText: 'OCC Test Address',
        timeWindow: {
          start: new Date(Date.now() + 3600000),
          end: new Date(Date.now() + 7200000),
        },
        status: 'accepted',
        version: 0,
        estimatedPrice: 750,
      });
    });

    it('increments version counter atomically on each valid transition', async () => {
      // 1. Arrive -> version becomes 1
      const resArr = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${occBooking._id}/stops/${occBooking._id}/arrive`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      assert.equal(resArr.statusCode, 200);

      const b1 = await Booking.findById(occBooking._id);
      assert.equal(b1.version, 1);

      // 2. Start -> version becomes 2
      const resStart = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${occBooking._id}/stops/${occBooking._id}/start`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      assert.equal(resStart.statusCode, 200);

      const b2 = await Booking.findById(occBooking._id);
      assert.equal(b2.version, 2);
    });

    it('rejects stale-version concurrent updates with 409 conflict and preserves state', async () => {
      const staleBooking = await Booking.create({
        customerId: customer1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        poolId: null,
        technicianId: techUser1._id,
        location: { type: 'Point', coordinates: [88.41, 22.58] },
        addressText: 'Stale Version Test Address',
        timeWindow: {
          start: new Date(Date.now() + 3600000),
          end: new Date(Date.now() + 7200000),
        },
        status: 'accepted',
        version: 5,
        estimatedPrice: 750,
      });

      // Concurrent race: both try to transition 'accepted' -> 'arrived'
      const [res1, res2] = await Promise.all([
        requestApp(
          'POST',
          `/api/v1/technicians/me/jobs/${staleBooking._id}/stops/${staleBooking._id}/arrive`,
          { headers: { Authorization: `Bearer ${techToken1}` } }
        ),
        requestApp(
          'POST',
          `/api/v1/technicians/me/jobs/${staleBooking._id}/stops/${staleBooking._id}/arrive`,
          { headers: { Authorization: `Bearer ${techToken1}` } }
        ),
      ]);
      const codes = [res1.statusCode, res2.statusCode].sort((a, b) => a - b);
      assert.deepEqual(codes, [200, 409]);

      // Exactly one atomic version increment occurred (5 -> 6)
      const finalBooking = await Booking.findById(staleBooking._id);
      assert.equal(finalBooking.version, 6);
      assert.equal(finalBooking.status, 'arrived');
    });
  });

  describe('10. Terminal vs Non-Terminal Route Recalculation (F-3)', () => {
    let routePool, rStop1, rStop2;

    before(async () => {
      const now = new Date();

      rStop1 = await Booking.create({
        customerId: customer1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        location: { type: 'Point', coordinates: [88.41, 22.58] },
        addressText: 'Route Recalc Stop 1',
        timeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 7200000),
        },
        status: 'accepted',
        stopSequence: 1,
        estimatedPrice: 600,
      });

      rStop2 = await Booking.create({
        customerId: customer2._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        location: { type: 'Point', coordinates: [88.42, 22.58] },
        addressText: 'Route Recalc Stop 2',
        timeWindow: {
          start: new Date(now.getTime() + 4500000),
          end: new Date(now.getTime() + 8100000),
        },
        status: 'accepted',
        stopSequence: 2,
        estimatedPrice: 600,
      });

      routePool = await ServicePool.create({
        serviceCategoryId: category._id,
        zoneId: zone._id,
        status: 'accepted',
        assignedTechnicianId: techUser1._id,
        assignedAt: new Date(),
        acceptedAt: new Date(),
        maxCapacity: 4,
        poolRadiusKm: 5.0,
        centroidLocation: { type: 'Point', coordinates: [88.415, 22.58] },
        aggregateTimeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 8100000),
        },
        lockCutoffTime: new Date(now.getTime() - 200000),
        members: [
          { bookingId: rStop1._id, customerId: customer1._id, location: rStop1.location, status: 'active' },
          { bookingId: rStop2._id, customerId: customer2._id, location: rStop2.location, status: 'active' },
        ],
        routeOrder: [
          { bookingId: rStop1._id, sequenceIndex: 1 },
          { bookingId: rStop2._id, sequenceIndex: 2 },
        ],
      });

      await Booking.updateMany(
        { _id: { $in: [rStop1._id, rStop2._id] } },
        { $set: { poolId: routePool._id } }
      );
    });

    it('triggers route recalculation on non-terminal transition (Stop 1 arrival)', async () => {
      const res = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${routePool._id}/stops/${rStop1._id}/arrive`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.data.isParentJobFinished, false);
      // Route object is recalculated and provided for active job
      assert.ok(res.body.data.route);
      assert.equal(res.body.data.route.jobId, String(routePool._id));
    });

    it('skips route recalculation on final terminal completion without logging 404 warning', async () => {
      // Start Stop 1
      await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${routePool._id}/stops/${rStop1._id}/start`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      // Complete Stop 1
      await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${routePool._id}/stops/${rStop1._id}/complete`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      // Arrive Stop 2
      await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${routePool._id}/stops/${rStop2._id}/arrive`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      // Start Stop 2
      await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${routePool._id}/stops/${rStop2._id}/start`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );

      // Complete Stop 2 (terminal!)
      const resFinal = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${routePool._id}/stops/${rStop2._id}/complete`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      assert.equal(resFinal.statusCode, 200);
      assert.equal(resFinal.body.data.isParentJobFinished, true);
      // Terminal job route recalculation is skipped: route is null
      assert.equal(resFinal.body.data.route, null);
    });
  });

  describe('11. Route Recalculation & Execution History Preservation (D-2)', () => {
    let d2Pool, d2Stop1, d2Stop2, d2Stop3;

    before(async () => {
      const now = new Date();

      d2Stop1 = await Booking.create({
        customerId: customer1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        location: { type: 'Point', coordinates: [88.36, 22.56] },
        addressText: 'D2 Stop 1 Address',
        timeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 7200000),
        },
        status: 'accepted',
        stopSequence: 1,
        estimatedPrice: 500,
      });

      d2Stop2 = await Booking.create({
        customerId: customer2._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        location: { type: 'Point', coordinates: [88.38, 22.58] },
        addressText: 'D2 Stop 2 Address',
        timeWindow: {
          start: new Date(now.getTime() + 4500000),
          end: new Date(now.getTime() + 8100000),
        },
        status: 'accepted',
        stopSequence: 2,
        estimatedPrice: 600,
      });

      d2Stop3 = await Booking.create({
        customerId: customer3._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        location: { type: 'Point', coordinates: [88.40, 22.60] },
        addressText: 'D2 Stop 3 Address',
        timeWindow: {
          start: new Date(now.getTime() + 5400000),
          end: new Date(now.getTime() + 9000000),
        },
        status: 'accepted',
        stopSequence: 3,
        estimatedPrice: 700,
      });

      d2Pool = await ServicePool.create({
        serviceCategoryId: category._id,
        zoneId: zone._id,
        status: 'accepted',
        assignedTechnicianId: techUser1._id,
        assignedAt: new Date(),
        acceptedAt: new Date(),
        maxCapacity: 4,
        poolRadiusKm: 6.0,
        centroidLocation: { type: 'Point', coordinates: [88.38, 22.58] },
        aggregateTimeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 9000000),
        },
        lockCutoffTime: new Date(now.getTime() - 200000),
        members: [
          { bookingId: d2Stop1._id, customerId: customer1._id, location: d2Stop1.location, status: 'active' },
          { bookingId: d2Stop2._id, customerId: customer2._id, location: d2Stop2.location, status: 'active' },
          { bookingId: d2Stop3._id, customerId: customer3._id, location: d2Stop3.location, status: 'active' },
        ],
        routeOrder: [
          { bookingId: d2Stop1._id, sequenceIndex: 1 },
          { bookingId: d2Stop2._id, sequenceIndex: 2 },
          { bookingId: d2Stop3._id, sequenceIndex: 3 },
        ],
      });

      await Booking.updateMany(
        { _id: { $in: [d2Stop1._id, d2Stop2._id, d2Stop3._id] } },
        { $set: { poolId: d2Pool._id } }
      );
    });

    it('1. Progresses Stop 1 through arrival, start and complete, and verifies route recalculation', async () => {
      // Arrive Stop 1
      const arrRes = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${d2Pool._id}/stops/${d2Stop1._id}/arrive`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      assert.equal(arrRes.statusCode, 200);

      // Start Stop 1
      const startRes = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${d2Pool._id}/stops/${d2Stop1._id}/start`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      assert.equal(startRes.statusCode, 200);

      // Complete Stop 1
      const compRes = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${d2Pool._id}/stops/${d2Stop1._id}/complete`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      assert.equal(compRes.statusCode, 200);
      assert.equal(compRes.body.data.isParentJobFinished, false);

      // Check route provided in response: Stop 1 is completed so it MUST be excluded from unfinished destinations!
      const route = compRes.body.data.route;
      assert.ok(route);
      const stopIds = route.stops.map((s) => String(s.bookingId));
      assert.equal(stopIds.includes(String(d2Stop1._id)), false, 'Completed Stop 1 must be excluded from unfinished route destinations');
      assert.equal(stopIds.includes(String(d2Stop2._id)), true);
      assert.equal(stopIds.includes(String(d2Stop3._id)), true);
    });

    it('2. Verifies completed stop execution timestamps and status survive route recalculation in DB', async () => {
      const poolInDb = await ServicePool.findById(d2Pool._id);
      assert.ok(poolInDb.routeOrder && poolInDb.routeOrder.length === 3);

      const ro1 = poolInDb.routeOrder.find((ro) => String(ro.bookingId) === String(d2Stop1._id));
      assert.ok(ro1, 'Stop 1 must exist in routeOrder');
      assert.equal(ro1.status, 'completed', 'Completed status must be preserved');
      assert.equal(ro1.sequenceIndex, 1, 'Completed stop sequence index must not be reordered');
      assert.ok(ro1.actualArrival, 'actualArrival must survive recalculation');
      assert.ok(ro1.actualServiceStart, 'actualServiceStart must survive recalculation');
      assert.ok(ro1.actualServiceEnd, 'actualServiceEnd must survive recalculation');
    });

    it('3. Cancels Stop 2 and verifies cancelled stop is excluded from route destinations while preserving DB state', async () => {
      const cancelRes = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${d2Pool._id}/stops/${d2Stop2._id}/cancel`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { reason: 'Customer not home' },
        }
      );
      assert.equal(cancelRes.statusCode, 200);

      // Get route via GET /api/v1/technicians/me/routes/:jobId
      const routeRes = await requestApp(
        'GET',
        `/api/v1/technicians/me/routes/${d2Pool._id}`,
        { headers: { Authorization: `Bearer ${techToken1}` } }
      );
      assert.equal(routeRes.statusCode, 200);
      const remainingStops = routeRes.body.data.stops;
      assert.equal(remainingStops.length, 1, 'Only unfinished Stop 3 should remain in active route');
      assert.equal(String(remainingStops[0].bookingId), String(d2Stop3._id));

      // In DB, both Stop 1 and Stop 2 retain their statuses and metadata
      const poolInDb = await ServicePool.findById(d2Pool._id);
      const ro1 = poolInDb.routeOrder.find((ro) => String(ro.bookingId) === String(d2Stop1._id));
      const ro2 = poolInDb.routeOrder.find((ro) => String(ro.bookingId) === String(d2Stop2._id));
      assert.equal(ro1.status, 'completed');
      assert.equal(ro2.status, 'cancelled');
    });

    it('4. Completes final Stop 3 and verifies parent pool route state remains consistent', async () => {
      // Arrive, start, complete Stop 3
      await requestApp('POST', `/api/v1/technicians/me/jobs/${d2Pool._id}/stops/${d2Stop3._id}/arrive`, {
        headers: { Authorization: `Bearer ${techToken1}` },
      });
      await requestApp('POST', `/api/v1/technicians/me/jobs/${d2Pool._id}/stops/${d2Stop3._id}/start`, {
        headers: { Authorization: `Bearer ${techToken1}` },
      });
      const finalRes = await requestApp('POST', `/api/v1/technicians/me/jobs/${d2Pool._id}/stops/${d2Stop3._id}/complete`, {
        headers: { Authorization: `Bearer ${techToken1}` },
      });
      assert.equal(finalRes.statusCode, 200);
      assert.equal(finalRes.body.data.isParentJobFinished, true);

      // Verify all 3 stops in DB have correct final statuses
      const poolInDb = await ServicePool.findById(d2Pool._id);
      assert.equal(poolInDb.status, 'completed');
      assert.equal(poolInDb.routeOrder.length, 3);
      assert.equal(poolInDb.routeOrder[0].status, 'completed');
      assert.equal(poolInDb.routeOrder[1].status, 'cancelled');
      assert.equal(poolInDb.routeOrder[2].status, 'completed');
    });
  });

  describe('12. Legacy Bulk Status Endpoint Lifecycle Corrections (D-4)', () => {
    let bulkPool, bStop1, bStop2, bStop3;

    before(async () => {
      const now = new Date();

      bStop1 = await Booking.create({
        customerId: customer1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        location: { type: 'Point', coordinates: [88.35, 22.55] },
        addressText: 'Bulk Stop 1',
        timeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 7200000),
        },
        status: 'accepted',
        stopSequence: 1,
        estimatedPrice: 500,
      });

      bStop2 = await Booking.create({
        customerId: customer2._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        location: { type: 'Point', coordinates: [88.37, 22.57] },
        addressText: 'Bulk Stop 2',
        timeWindow: {
          start: new Date(now.getTime() + 4500000),
          end: new Date(now.getTime() + 8100000),
        },
        status: 'accepted',
        stopSequence: 2,
        estimatedPrice: 600,
      });

      bStop3 = await Booking.create({
        customerId: customer3._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        location: { type: 'Point', coordinates: [88.39, 22.59] },
        addressText: 'Bulk Stop 3',
        timeWindow: {
          start: new Date(now.getTime() + 5400000),
          end: new Date(now.getTime() + 9000000),
        },
        status: 'accepted',
        stopSequence: 3,
        estimatedPrice: 700,
      });

      bulkPool = await ServicePool.create({
        serviceCategoryId: category._id,
        zoneId: zone._id,
        status: 'in_progress',
        assignedTechnicianId: techUser1._id,
        assignedAt: new Date(),
        acceptedAt: new Date(),
        startedAt: new Date(),
        maxCapacity: 4,
        poolRadiusKm: 6.0,
        centroidLocation: { type: 'Point', coordinates: [88.37, 22.57] },
        aggregateTimeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 9000000),
        },
        lockCutoffTime: new Date(now.getTime() - 200000),
        members: [
          { bookingId: bStop1._id, customerId: customer1._id, location: bStop1.location, status: 'active' },
          { bookingId: bStop2._id, customerId: customer2._id, location: bStop2.location, status: 'active' },
          { bookingId: bStop3._id, customerId: customer3._id, location: bStop3.location, status: 'active' },
        ],
        routeOrder: [
          { bookingId: bStop1._id, sequenceIndex: 1 },
          { bookingId: bStop2._id, sequenceIndex: 2 },
          { bookingId: bStop3._id, sequenceIndex: 3 },
        ],
      });

      await Booking.updateMany(
        { _id: { $in: [bStop1._id, bStop2._id, bStop3._id] } },
        { $set: { poolId: bulkPool._id } }
      );
    });

    it('1. Bulk cancellation of a partially completed pool preserves completed bookings', async () => {
      // Step 1: Complete Stop 1 via stop progression
      await requestApp('POST', `/api/v1/technicians/me/jobs/${bulkPool._id}/stops/${bStop1._id}/arrive`, {
        headers: { Authorization: `Bearer ${techToken1}` },
      });
      await requestApp('POST', `/api/v1/technicians/me/jobs/${bulkPool._id}/stops/${bStop1._id}/start`, {
        headers: { Authorization: `Bearer ${techToken1}` },
      });
      await requestApp('POST', `/api/v1/technicians/me/jobs/${bulkPool._id}/stops/${bStop1._id}/complete`, {
        headers: { Authorization: `Bearer ${techToken1}` },
      });

      // Verify Stop 1 is completed
      const check1 = await Booking.findById(bStop1._id);
      assert.equal(check1.status, 'completed');

      // Step 2: Technician issues bulk pool cancellation via legacy endpoint
      const cancelRes = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${bulkPool._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'cancelled', reason: 'Severe weather condition' },
        }
      );
      assert.equal(cancelRes.statusCode, 200);

      // Verify Stop 1 was NOT overwritten and remains completed!
      const postCancel1 = await Booking.findById(bStop1._id);
      assert.equal(postCancel1.status, 'completed', 'Completed Stop 1 must not be overwritten to cancelled');

      // Verify remaining active bookings (Stop 2 and Stop 3) were properly cancelled
      const postCancel2 = await Booking.findById(bStop2._id);
      assert.equal(postCancel2.status, 'cancelled');
      assert.equal(postCancel2.rejectionReason, 'Severe weather condition');

      const postCancel3 = await Booking.findById(bStop3._id);
      assert.equal(postCancel3.status, 'cancelled');
      assert.equal(postCancel3.rejectionReason, 'Severe weather condition');
    });

    it('2. Arrived standalone booking can start successfully via legacy status endpoint', async () => {
      const now = new Date();
      const sBooking = await Booking.create({
        customerId: customer1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: techUser1._id,
        poolId: null,
        location: { type: 'Point', coordinates: [88.35, 22.55] },
        addressText: 'Standalone Arrived Test',
        timeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 7200000),
        },
        status: 'arrived',
        arrivedAt: new Date(),
        estimatedPrice: 400,
      });

      // Start via PATCH /api/v1/technicians/me/jobs/:id/status
      const startRes = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${sBooking._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'in_progress' },
        }
      );
      assert.equal(startRes.statusCode, 200);

      const updated = await Booking.findById(sBooking._id);
      assert.equal(updated.status, 'in_progress');
      assert.ok(updated.startedAt);
    });

    it('3. Arrived standalone booking can be cancelled via legacy status endpoint', async () => {
      const now = new Date();
      const sBooking = await Booking.create({
        customerId: customer2._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: techUser1._id,
        poolId: null,
        location: { type: 'Point', coordinates: [88.36, 22.56] },
        addressText: 'Standalone Arrived Cancel Test',
        timeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 7200000),
        },
        status: 'arrived',
        arrivedAt: new Date(),
        estimatedPrice: 400,
      });

      // Cancel via PATCH /api/v1/technicians/me/jobs/:id/status
      const cancelRes = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${sBooking._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'cancelled', reason: 'Customer cancelled at door' },
        }
      );
      assert.equal(cancelRes.statusCode, 200);

      const updated = await Booking.findById(sBooking._id);
      assert.equal(updated.status, 'cancelled');
      assert.equal(updated.rejectionReason, 'Customer cancelled at door');
    });
  });

  describe('13. Legacy Technician Status Endpoint Lifecycle Hardening (Step 6.3 - D-4 Bypass Remediation)', () => {
    async function createThreeStopPool({
      stop1Status = 'accepted',
      stop2Status = 'accepted',
      stop3Status = 'accepted',
      poolStatus = 'accepted',
    } = {}) {
      const now = new Date();

      const b1 = await Booking.create({
        customerId: customer1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: techUser1._id,
        location: { type: 'Point', coordinates: [88.412, 22.581] },
        addressText: 'Suite 13 Stop 1',
        timeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 7200000),
        },
        status: stop1Status,
        stopSequence: 1,
        estimatedPrice: 500,
        ...(stop1Status === 'completed' ? { completedAt: new Date() } : {}),
        ...(stop1Status === 'cancelled' ? { cancelledAt: new Date(), rejectionReason: 'Prior cancellation' } : {}),
      });

      const b2 = await Booking.create({
        customerId: customer2._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: techUser1._id,
        location: { type: 'Point', coordinates: [88.414, 22.583] },
        addressText: 'Suite 13 Stop 2',
        timeWindow: {
          start: new Date(now.getTime() + 4500000),
          end: new Date(now.getTime() + 8100000),
        },
        status: stop2Status,
        stopSequence: 2,
        estimatedPrice: 600,
        ...(stop2Status === 'completed' ? { completedAt: new Date() } : {}),
        ...(stop2Status === 'cancelled' ? { cancelledAt: new Date(), rejectionReason: 'Prior cancellation' } : {}),
      });

      const b3 = await Booking.create({
        customerId: customer3._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: techUser1._id,
        location: { type: 'Point', coordinates: [88.416, 22.585] },
        addressText: 'Suite 13 Stop 3',
        timeWindow: {
          start: new Date(now.getTime() + 5400000),
          end: new Date(now.getTime() + 9000000),
        },
        status: stop3Status,
        stopSequence: 3,
        estimatedPrice: 700,
        ...(stop3Status === 'completed' ? { completedAt: new Date() } : {}),
        ...(stop3Status === 'cancelled' ? { cancelledAt: new Date(), rejectionReason: 'Prior cancellation' } : {}),
      });

      const pool = await ServicePool.create({
        serviceCategoryId: category._id,
        zoneId: zone._id,
        status: poolStatus,
        assignedTechnicianId: techUser1._id,
        assignedAt: new Date(),
        acceptedAt: new Date(),
        maxCapacity: 4,
        poolRadiusKm: 5.0,
        centroidLocation: { type: 'Point', coordinates: [88.415, 22.58] },
        aggregateTimeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 9000000),
        },
        lockCutoffTime: new Date(now.getTime() - 200000),
        members: [
          { bookingId: b1._id, customerId: customer1._id, location: b1.location, status: 'active' },
          { bookingId: b2._id, customerId: customer2._id, location: b2.location, status: 'active' },
          { bookingId: b3._id, customerId: customer3._id, location: b3.location, status: 'active' },
        ],
        routeOrder: [
          { bookingId: b1._id, sequenceIndex: 1, status: stop1Status },
          { bookingId: b2._id, sequenceIndex: 2, status: stop2Status },
          { bookingId: b3._id, sequenceIndex: 3, status: stop3Status },
        ],
      });

      await Booking.updateMany(
        { _id: { $in: [b1._id, b2._id, b3._id] } },
        { $set: { poolId: pool._id } }
      );

      return { pool, b1, b2, b3 };
    }

    // 1. Pool-level requests (Tests 1–5)
    it('1. Pool ID + in_progress -> 409 POOL_STOP_PROGRESSION_REQUIRED and leaves member bookings unchanged', async () => {
      const { pool, b1, b2, b3 } = await createThreeStopPool();

      const res = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${pool._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'in_progress' },
        }
      );

      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'POOL_STOP_PROGRESSION_REQUIRED');

      const [chk1, chk2, chk3, chkPool] = await Promise.all([
        Booking.findById(b1._id),
        Booking.findById(b2._id),
        Booking.findById(b3._id),
        ServicePool.findById(pool._id),
      ]);

      assert.equal(chk1.status, 'accepted');
      assert.equal(chk2.status, 'accepted');
      assert.equal(chk3.status, 'accepted');
      assert.equal(chkPool.status, 'accepted');
    });

    it('2. Pool ID + completed -> 409 POOL_STOP_PROGRESSION_REQUIRED and leaves member bookings unchanged', async () => {
      const { pool, b1, b2, b3 } = await createThreeStopPool();

      const res = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${pool._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'completed' },
        }
      );

      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'POOL_STOP_PROGRESSION_REQUIRED');

      const [chk1, chk2, chk3, chkPool] = await Promise.all([
        Booking.findById(b1._id),
        Booking.findById(b2._id),
        Booking.findById(b3._id),
        ServicePool.findById(pool._id),
      ]);

      assert.equal(chk1.status, 'accepted');
      assert.equal(chk2.status, 'accepted');
      assert.equal(chk3.status, 'accepted');
      assert.equal(chkPool.status, 'accepted');
    });

    it('3. Pool ID + cancelled -> valid whole-pool cancellation succeeds (200)', async () => {
      const { pool, b1, b2, b3 } = await createThreeStopPool();

      const res = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${pool._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'cancelled', reason: 'Technician equipment failure' },
        }
      );

      assert.equal(res.statusCode, 200);

      const [chk1, chk2, chk3, chkPool] = await Promise.all([
        Booking.findById(b1._id),
        Booking.findById(b2._id),
        Booking.findById(b3._id),
        ServicePool.findById(pool._id),
      ]);

      assert.equal(chkPool.status, 'cancelled');
      assert.equal(chkPool.rejectionReason, 'Technician equipment failure');
      assert.equal(chk1.status, 'cancelled');
      assert.equal(chk1.rejectionReason, 'Technician equipment failure');
      assert.equal(chk2.status, 'cancelled');
      assert.equal(chk2.rejectionReason, 'Technician equipment failure');
      assert.equal(chk3.status, 'cancelled');
      assert.equal(chk3.rejectionReason, 'Technician equipment failure');
    });

    it('4. Pool cancellation preserves completed and previously cancelled bookings', async () => {
      const { pool, b1, b2, b3 } = await createThreeStopPool({
        stop1Status: 'completed',
        stop2Status: 'cancelled',
        stop3Status: 'accepted',
        poolStatus: 'in_progress',
      });

      const res = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${pool._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'cancelled', reason: 'Road block cancellation' },
        }
      );

      assert.equal(res.statusCode, 200);

      const [chk1, chk2, chk3, chkPool] = await Promise.all([
        Booking.findById(b1._id),
        Booking.findById(b2._id),
        Booking.findById(b3._id),
        ServicePool.findById(pool._id),
      ]);

      assert.equal(chkPool.status, 'cancelled');
      assert.equal(chk1.status, 'completed', 'Completed Stop 1 must remain completed');
      assert.equal(chk2.status, 'cancelled');
      assert.equal(chk2.rejectionReason, 'Prior cancellation', 'Prior cancellation reason must be preserved');
      assert.equal(chk3.status, 'cancelled');
      assert.equal(chk3.rejectionReason, 'Road block cancellation');
    });

    it('5. Pool cancellation sends notifications only for newly cancelled bookings', async () => {
      const { pool, b1, b2, b3 } = await createThreeStopPool({
        stop1Status: 'completed',
        stop2Status: 'cancelled',
        stop3Status: 'accepted',
        poolStatus: 'in_progress',
      });

      const count1Before = await Notification.countDocuments({ userId: customer1._id });
      const count2Before = await Notification.countDocuments({ userId: customer2._id });
      const count3Before = await Notification.countDocuments({ userId: customer3._id });

      const res = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${pool._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'cancelled', reason: 'Flash flood alert' },
        }
      );
      assert.equal(res.statusCode, 200);

      const count1After = await Notification.countDocuments({ userId: customer1._id });
      const count2After = await Notification.countDocuments({ userId: customer2._id });
      const count3After = await Notification.countDocuments({ userId: customer3._id });

      assert.equal(count1After, count1Before, 'Completed customer should receive no cancellation notification');
      assert.equal(count2After, count2Before, 'Previously cancelled customer should receive no cancellation notification');
      assert.equal(count3After, count3Before + 1, 'Newly cancelled customer must receive exactly one notification');

      const notif3 = await Notification.findOne({
        userId: customer3._id,
        relatedEntityId: b3._id,
        type: 'execution',
      }).sort({ createdAt: -1 });

      assert.ok(notif3);
      assert.equal(notif3.title, 'Service Pool Cancelled');
      assert.ok(notif3.message.includes('Flash flood alert'));
    });

    // 2. Individual pooled member requests (Tests 6–10)
    it('6. Stop 2 booking ID + in_progress -> 409 POOL_STOP_PROGRESSION_REQUIRED', async () => {
      const { b2 } = await createThreeStopPool();

      const res = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${b2._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'in_progress' },
        }
      );

      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'POOL_STOP_PROGRESSION_REQUIRED');
    });

    it('7. Stop 3 booking ID + in_progress -> 409 POOL_STOP_PROGRESSION_REQUIRED', async () => {
      const { b3 } = await createThreeStopPool();

      const res = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${b3._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'in_progress' },
        }
      );

      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'POOL_STOP_PROGRESSION_REQUIRED');
    });

    it('8. Stop 2 booking ID + completed -> 409 POOL_STOP_PROGRESSION_REQUIRED', async () => {
      const { b2 } = await createThreeStopPool();

      const res = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${b2._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'completed' },
        }
      );

      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'POOL_STOP_PROGRESSION_REQUIRED');
    });

    it('9. Stop 2 booking ID + cancelled -> 409 POOL_STOP_PROGRESSION_REQUIRED', async () => {
      const { b2 } = await createThreeStopPool();

      const res = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${b2._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'cancelled', reason: 'Customer requested' },
        }
      );

      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'POOL_STOP_PROGRESSION_REQUIRED');
    });

    it('10. Rejected requests leave booking, parent pool, route order, and notifications unchanged', async () => {
      const { pool, b2 } = await createThreeStopPool();
      const notifsBefore = await Notification.countDocuments();

      const res = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${b2._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'in_progress' },
        }
      );
      assert.equal(res.statusCode, 409);

      const [chkBooking, chkPool, notifsAfter] = await Promise.all([
        Booking.findById(b2._id),
        ServicePool.findById(pool._id),
        Notification.countDocuments(),
      ]);

      assert.equal(chkBooking.status, 'accepted');
      assert.ok(!chkBooking.startedAt);
      assert.equal(chkPool.status, 'accepted');
      assert.equal(chkPool.routeOrder.length, 3);
      assert.equal(chkPool.routeOrder[1].status, 'accepted');
      assert.equal(notifsAfter, notifsBefore);
    });

    // 3. Stop-order integrity (Tests 11–14)
    it('11. Stop 2 cannot start while Stop 1 is unfinished', async () => {
      const { pool, b2 } = await createThreeStopPool();

      // Attempt via legacy endpoint
      const legacyRes = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${b2._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'in_progress' },
        }
      );
      assert.equal(legacyRes.statusCode, 409);
      assert.equal(legacyRes.body.error.code, 'POOL_STOP_PROGRESSION_REQUIRED');

      // Attempt via canonical stop progression API
      const stopProgRes = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${pool._id}/stops/${b2._id}/start`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
        }
      );
      assert.equal(stopProgRes.statusCode, 409);

      const chkB2 = await Booking.findById(b2._id);
      assert.equal(chkB2.status, 'accepted');
    });

    it('12. Stop 3 cannot start while earlier stops are unfinished', async () => {
      const { pool, b3 } = await createThreeStopPool({
        stop1Status: 'completed',
        stop2Status: 'accepted',
        stop3Status: 'accepted',
        poolStatus: 'in_progress',
      });

      // Attempt via legacy endpoint
      const legacyRes = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${b3._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'in_progress' },
        }
      );
      assert.equal(legacyRes.statusCode, 409);
      assert.equal(legacyRes.body.error.code, 'POOL_STOP_PROGRESSION_REQUIRED');

      // Attempt via canonical stop progression API
      const stopProgRes = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${pool._id}/stops/${b3._id}/start`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
        }
      );
      assert.equal(stopProgRes.statusCode, 409);

      const chkB3 = await Booking.findById(b3._id);
      assert.equal(chkB3.status, 'accepted');
    });

    it('13. Stop 2 cannot complete before Stop 1', async () => {
      const { pool, b2 } = await createThreeStopPool();

      // Attempt via legacy endpoint
      const legacyRes = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${b2._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'completed' },
        }
      );
      assert.equal(legacyRes.statusCode, 409);
      assert.equal(legacyRes.body.error.code, 'POOL_STOP_PROGRESSION_REQUIRED');

      // Attempt via canonical stop progression API
      const stopProgRes = await requestApp(
        'POST',
        `/api/v1/technicians/me/jobs/${pool._id}/stops/${b2._id}/complete`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
        }
      );
      assert.equal(stopProgRes.statusCode, 409);

      const chkB2 = await Booking.findById(b2._id);
      assert.equal(chkB2.status, 'accepted');
    });

    it('14. Pool-level legacy completion cannot mark unfinished stops completed', async () => {
      const { pool, b1, b2, b3 } = await createThreeStopPool({
        stop1Status: 'in_progress',
        stop2Status: 'accepted',
        stop3Status: 'accepted',
        poolStatus: 'in_progress',
      });

      const res = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${pool._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'completed' },
        }
      );
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'POOL_STOP_PROGRESSION_REQUIRED');

      const [chk1, chk2, chk3] = await Promise.all([
        Booking.findById(b1._id),
        Booking.findById(b2._id),
        Booking.findById(b3._id),
      ]);

      assert.equal(chk1.status, 'in_progress');
      assert.equal(chk2.status, 'accepted');
      assert.equal(chk3.status, 'accepted');
    });

    // 4. Standalone compatibility (Tests 15–18)
    it('15. Accepted standalone booking can start (200)', async () => {
      const now = new Date();
      const sBooking = await Booking.create({
        customerId: customer1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: techUser1._id,
        poolId: null,
        location: { type: 'Point', coordinates: [88.35, 22.55] },
        addressText: 'Standalone Accepted Test',
        timeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 7200000),
        },
        status: 'accepted',
        estimatedPrice: 450,
      });

      const res = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${sBooking._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'in_progress' },
        }
      );

      assert.equal(res.statusCode, 200);
      const updated = await Booking.findById(sBooking._id);
      assert.equal(updated.status, 'in_progress');
      assert.ok(updated.startedAt);
    });

    it('16. Arrived standalone booking can start (200)', async () => {
      const now = new Date();
      const sBooking = await Booking.create({
        customerId: customer2._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: techUser1._id,
        poolId: null,
        location: { type: 'Point', coordinates: [88.36, 22.56] },
        addressText: 'Standalone Arrived Test',
        timeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 7200000),
        },
        status: 'arrived',
        arrivedAt: new Date(),
        estimatedPrice: 450,
      });

      const res = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${sBooking._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'in_progress' },
        }
      );

      assert.equal(res.statusCode, 200);
      const updated = await Booking.findById(sBooking._id);
      assert.equal(updated.status, 'in_progress');
      assert.ok(updated.startedAt);
    });

    it('17. Valid standalone cancellation still succeeds (200)', async () => {
      const now = new Date();
      const sBooking = await Booking.create({
        customerId: customer3._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: techUser1._id,
        poolId: null,
        location: { type: 'Point', coordinates: [88.37, 22.57] },
        addressText: 'Standalone Cancel Test',
        timeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 7200000),
        },
        status: 'accepted',
        estimatedPrice: 450,
      });

      const res = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${sBooking._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'cancelled', reason: 'Customer requested reschedule' },
        }
      );

      assert.equal(res.statusCode, 200);
      const updated = await Booking.findById(sBooking._id);
      assert.equal(updated.status, 'cancelled');
      assert.equal(updated.rejectionReason, 'Customer requested reschedule');
    });

    it('18. Invalid standalone transitions remain rejected (409)', async () => {
      const now = new Date();
      // Case A: accepted -> completed (illegal)
      const sBooking1 = await Booking.create({
        customerId: customer1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: techUser1._id,
        poolId: null,
        location: { type: 'Point', coordinates: [88.35, 22.55] },
        addressText: 'Invalid Standalone Test 1',
        timeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 7200000),
        },
        status: 'accepted',
        estimatedPrice: 450,
      });

      const resA = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${sBooking1._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'completed' },
        }
      );
      assert.equal(resA.statusCode, 409);
      assert.equal(resA.body.error.code, 'INVALID_STATUS_TRANSITION');

      // Case B: cancelled -> in_progress (illegal)
      const sBooking2 = await Booking.create({
        customerId: customer2._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: techUser1._id,
        poolId: null,
        location: { type: 'Point', coordinates: [88.36, 22.56] },
        addressText: 'Invalid Standalone Test 2',
        timeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 7200000),
        },
        status: 'cancelled',
        cancelledAt: new Date(),
        rejectionReason: 'Cancelled previously',
        estimatedPrice: 450,
      });

      const resB = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${sBooking2._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'in_progress' },
        }
      );
      assert.equal(resB.statusCode, 409);
      assert.equal(resB.body.error.code, 'INVALID_STATUS_TRANSITION');

      // Case C: completed -> in_progress (illegal)
      const sBooking3 = await Booking.create({
        customerId: customer3._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: techUser1._id,
        poolId: null,
        location: { type: 'Point', coordinates: [88.37, 22.57] },
        addressText: 'Invalid Standalone Test 3',
        timeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 7200000),
        },
        status: 'completed',
        completedAt: new Date(),
        estimatedPrice: 450,
      });

      const resC = await requestApp(
        'PATCH',
        `/api/v1/technicians/me/jobs/${sBooking3._id}/status`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { status: 'in_progress' },
        }
      );
      assert.equal(resC.statusCode, 409);
      assert.equal(resC.body.error.code, 'INVALID_STATUS_TRANSITION');
    });
  });
});
