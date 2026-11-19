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
  TechnicianLocation,
  ServicePool,
  Booking,
} from '../src/models/index.js';
import { signAuthToken } from '../src/middleware/auth.js';

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

describe('Phase 5A.2 Step 3 — Technician Active Workload & Route Tracking APIs', () => {
  let replSet;
  let adminUser, adminToken;
  let customerUser, customerToken;
  let techUser1, techToken1, techProfile1;
  let techUser2, techToken2, techProfile2;
  let category, zone;

  const validPasswordHash = '$2a$10$abcdefghijklmnopqrstuvwxyz123456';

  before(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = replSet.getUri();
    process.env.MONGODB_URI = uri;

    await connectDB(uri);

    // 1. Admin
    adminUser = await User.create({
      name: 'Admin Supervisor',
      email: `admin_${Date.now()}@test.local`,
      passwordHash: validPasswordHash,
      role: 'admin',
      isActive: true,
    });
    adminToken = signAuthToken(adminUser);

    // 2. Customer
    customerUser = await User.create({
      name: 'Customer Client',
      email: `customer_${Date.now()}@test.local`,
      phone: '+91-9876543111',
      passwordHash: validPasswordHash,
      role: 'customer',
      isActive: true,
    });
    customerToken = signAuthToken(customerUser);

    // 3. Category & Zone
    category = await ServiceCategory.create({
      name: 'Electrical Diagnostics',
      slug: `elec_${Date.now()}`,
      description: 'Home wiring and electrical repairs',
      baseIndividualPrice: 500,
      estimatedDurationMins: 45,
      defaultPoolRadiusKm: 5.0,
      maxPoolSize: 4,
      poolLockCutoffMins: 60,
      isActive: true,
    });

    zone = await ServiceZone.create({
      name: 'Salt Lake Core',
      code: `SLC_${Date.now().toString().slice(-4)}`,
      city: 'Kolkata',
      centerLocation: { type: 'Point', coordinates: [88.41, 22.58] },
      radiusKm: 15,
      isActive: true,
    });

    // 4. Technician 1 (Primary)
    techUser1 = await User.create({
      name: 'Technician Alice',
      email: `tech_alice_${Date.now()}@test.local`,
      phone: '+91-9876543011',
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
      addressText: 'Salt Lake Base Depot',
      serviceRadiusKm: 12,
      maxPoolCapacity: 5,
      activeWorkload: 0,
      approvalStatus: 'approved',
      availabilityStatus: 'available',
    });

    // 5. Technician 2 (Secondary / Isolation)
    techUser2 = await User.create({
      name: 'Technician Bob',
      email: `tech_bob_${Date.now()}@test.local`,
      phone: '+91-9876543022',
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
      addressText: 'South Kolkata Depot',
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

  describe('1. Authentication and Authorization on All Endpoints', () => {
    it('rejects unauthenticated requests to workload and route endpoints with 401', async () => {
      const endpoints = [
        ['GET', '/api/v1/technicians/me/active-workload'],
        ['GET', `/api/v1/technicians/me/active-workload/${new mongoose.Types.ObjectId()}`],
        ['POST', '/api/v1/technicians/me/location'],
        ['GET', '/api/v1/technicians/me/location'],
        ['GET', '/api/v1/technicians/me/routes'],
        ['GET', `/api/v1/technicians/me/routes/${new mongoose.Types.ObjectId()}`],
      ];

      for (const [method, url] of endpoints) {
        const res = await requestApp(method, url);
        assert.equal(res.statusCode, 401, `Expected 401 for ${method} ${url}`);
        assert.equal(res.body.success, false);
        assert.equal(res.body.error.code, 'AUTH_REQUIRED');
      }
    });

    it('rejects customer role requests with 403 FORBIDDEN_ROLE', async () => {
      const res = await requestApp('GET', '/api/v1/technicians/me/active-workload', {
        headers: { Authorization: `Bearer ${customerToken}` },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN_ROLE');
    });

    it('rejects admin role requests with 403 FORBIDDEN_ROLE on technician personal workload', async () => {
      const res = await requestApp('GET', '/api/v1/technicians/me/active-workload', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN_ROLE');
    });

    it('ignores client-supplied technicianId query/body parameters', async () => {
      const res = await requestApp(
        'GET',
        `/api/v1/technicians/me/active-workload?technicianId=${techUser2._id}`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
        }
      );
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
    });
  });

  describe('2. Empty Workload State', () => {
    it('returns empty array and zero counts when a technician has zero active work', async () => {
      const res = await requestApp('GET', '/api/v1/technicians/me/active-workload', {
        headers: { Authorization: `Bearer ${techToken1}` },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.deepEqual(res.body.data, []);
      assert.equal(res.body.meta.counts.totalActive, 0);
      assert.equal(res.body.meta.counts.pools, 0);
      assert.equal(res.body.meta.counts.individual, 0);
    });
  });

  describe('3. Active Workload Filtering & Non-Double-Counting', () => {
    let activePool1, activePool2, completedPool, cancelledPool, lockedRejectedPool;
    let standaloneActive1, standaloneActive2, standaloneCompleted, memberBooking1, memberBooking2;

    before(async () => {
      const now = new Date();

      // 1. Pool 1: assigned
      activePool1 = await ServicePool.create({
        serviceCategoryId: category._id,
        zoneId: zone._id,
        status: 'assigned',
        assignedTechnicianId: techUser1._id,
        assignedAt: now,
        maxCapacity: 4,
        poolRadiusKm: 5.0,
        centroidLocation: { type: 'Point', coordinates: [88.41, 22.58] },
        aggregateTimeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 7200000),
        },
        lockCutoffTime: new Date(now.getTime() + 1800000),
      });

      // 2. Pool 2: in_progress
      activePool2 = await ServicePool.create({
        serviceCategoryId: category._id,
        zoneId: zone._id,
        status: 'in_progress',
        assignedTechnicianId: techUser1._id,
        assignedAt: new Date(now.getTime() - 3600000),
        acceptedAt: new Date(now.getTime() - 2400000),
        startedAt: now,
        maxCapacity: 4,
        poolRadiusKm: 5.0,
        centroidLocation: { type: 'Point', coordinates: [88.41, 22.58] },
        aggregateTimeWindow: {
          start: new Date(now.getTime() + 7200000),
          end: new Date(now.getTime() + 10800000),
        },
        lockCutoffTime: new Date(now.getTime() - 5400000),
      });

      // 3. Pool Member Bookings (MUST NOT appear as standalone bookings!)
      memberBooking1 = await Booking.create({
        customerId: customerUser._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        poolId: activePool1._id,
        technicianId: techUser1._id,
        location: { type: 'Point', coordinates: [88.41, 22.58] },
        addressText: 'Pool 1 Stop 1',
        timeWindow: activePool1.aggregateTimeWindow,
        status: 'assigned',
        estimatedPrice: 450,
      });

      memberBooking2 = await Booking.create({
        customerId: customerUser._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        poolId: activePool2._id,
        technicianId: techUser1._id,
        location: { type: 'Point', coordinates: [88.42, 22.59] },
        addressText: 'Pool 2 Stop 1',
        timeWindow: activePool2.aggregateTimeWindow,
        status: 'in_progress',
        estimatedPrice: 450,
      });

      activePool1.members.push({
        bookingId: memberBooking1._id,
        customerId: customerUser._id,
        location: memberBooking1.location,
        addressText: memberBooking1.addressText,
      });
      await activePool1.save();

      activePool2.members.push({
        bookingId: memberBooking2._id,
        customerId: customerUser._id,
        location: memberBooking2.location,
        addressText: memberBooking2.addressText,
      });
      await activePool2.save();

      // 4. Standalone Booking 1: accepted
      standaloneActive1 = await Booking.create({
        customerId: customerUser._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        poolId: null,
        technicianId: techUser1._id,
        status: 'accepted',
        assignedAt: now,
        acceptedAt: now,
        location: { type: 'Point', coordinates: [88.43, 22.57] },
        addressText: 'Standalone Customer Address A',
        timeWindow: {
          start: new Date(now.getTime() + 14400000),
          end: new Date(now.getTime() + 18000000),
        },
        estimatedPrice: 500,
        notes: 'Check fuse box',
      });

      // 5. Standalone Booking 2: in_progress
      standaloneActive2 = await Booking.create({
        customerId: customerUser._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        poolId: null,
        technicianId: techUser1._id,
        status: 'in_progress',
        assignedAt: now,
        acceptedAt: now,
        startedAt: now,
        location: { type: 'Point', coordinates: [88.44, 22.56] },
        addressText: 'Standalone Customer Address B',
        timeWindow: {
          start: new Date(now.getTime() + 21600000),
          end: new Date(now.getTime() + 25200000),
        },
        estimatedPrice: 500,
      });

      // 6. Non-Active Jobs (Completed, Cancelled, Rejected/Locked)
      completedPool = await ServicePool.create({
        serviceCategoryId: category._id,
        status: 'completed',
        assignedTechnicianId: techUser1._id,
        assignedAt: new Date(now.getTime() - 86400000),
        completedAt: new Date(now.getTime() - 80000000),
        maxCapacity: 4,
        poolRadiusKm: 5.0,
        centroidLocation: { type: 'Point', coordinates: [88.41, 22.58] },
        aggregateTimeWindow: {
          start: new Date(now.getTime() - 86400000),
          end: new Date(now.getTime() - 82800000),
        },
        lockCutoffTime: new Date(now.getTime() - 90000000),
      });

      cancelledPool = await ServicePool.create({
        serviceCategoryId: category._id,
        status: 'cancelled',
        assignedTechnicianId: techUser1._id,
        assignedAt: new Date(now.getTime() - 86400000),
        cancelledAt: new Date(now.getTime() - 80000000),
        maxCapacity: 4,
        poolRadiusKm: 5.0,
        centroidLocation: { type: 'Point', coordinates: [88.41, 22.58] },
        aggregateTimeWindow: {
          start: new Date(now.getTime() - 86400000),
          end: new Date(now.getTime() - 82800000),
        },
        lockCutoffTime: new Date(now.getTime() - 90000000),
      });

      lockedRejectedPool = await ServicePool.create({
        serviceCategoryId: category._id,
        status: 'locked',
        assignedTechnicianId: null,
        rejectedTechnicians: [techUser1._id],
        maxCapacity: 4,
        poolRadiusKm: 5.0,
        centroidLocation: { type: 'Point', coordinates: [88.41, 22.58] },
        aggregateTimeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 7200000),
        },
        lockCutoffTime: new Date(now.getTime() - 100000),
      });

      standaloneCompleted = await Booking.create({
        customerId: customerUser._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        poolId: null,
        technicianId: techUser1._id,
        status: 'completed',
        assignedAt: new Date(now.getTime() - 86400000),
        completedAt: new Date(now.getTime() - 80000000),
        location: { type: 'Point', coordinates: [88.43, 22.57] },
        addressText: 'Completed Booking',
        timeWindow: {
          start: new Date(now.getTime() - 86400000),
          end: new Date(now.getTime() - 82800000),
        },
        estimatedPrice: 500,
      });
    });

    it('returns exact active workload: 2 pools + 2 standalone bookings = 4 jobs total', async () => {
      const res = await requestApp('GET', '/api/v1/technicians/me/active-workload', {
        headers: { Authorization: `Bearer ${techToken1}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      const data = res.body.data;
      const meta = res.body.meta;

      // Must be exactly 4 active jobs (2 pools + 2 standalone bookings)
      assert.equal(data.length, 4);
      assert.equal(meta.counts.totalActive, 4);
      assert.equal(meta.counts.pools, 2);
      assert.equal(meta.counts.individual, 2);

      // Verify that member bookings did NOT appear as top-level individual jobs
      const standaloneBookingIds = data
        .filter((j) => j.jobType === 'individual')
        .map((j) => String(j._id));
      assert.ok(!standaloneBookingIds.includes(String(memberBooking1._id)));
      assert.ok(!standaloneBookingIds.includes(String(memberBooking2._id)));

      // Verify completed, cancelled, and rejected pools are completely absent
      const allJobIds = data.map((j) => String(j._id));
      assert.ok(!allJobIds.includes(String(completedPool._id)));
      assert.ok(!allJobIds.includes(String(cancelledPool._id)));
      assert.ok(!allJobIds.includes(String(lockedRejectedPool._id)));
      assert.ok(!allJobIds.includes(String(standaloneCompleted._id)));
    });

    it('returns full details for an individual active pool via /active-workload/:jobId', async () => {
      const res = await requestApp(
        'GET',
        `/api/v1/technicians/me/active-workload/${activePool1._id}`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
        }
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      const job = res.body.data;

      assert.equal(job.jobType, 'pool');
      assert.equal(job._id, String(activePool1._id));
      assert.equal(job.status, 'assigned');
      assert.equal(job.pool.memberCount, 1);
      assert.equal(job.pool.members[0].customer.name, 'Customer Client');
      assert.equal(job.pool.members[0].addressText, 'Pool 1 Stop 1');
      assert.ok(job.pool.centroidLocation);
    });

    it('returns full details for an individual active standalone booking via /active-workload/:jobId', async () => {
      const res = await requestApp(
        'GET',
        `/api/v1/technicians/me/active-workload/${standaloneActive1._id}`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
        }
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      const job = res.body.data;

      assert.equal(job.jobType, 'individual');
      assert.equal(job._id, String(standaloneActive1._id));
      assert.equal(job.status, 'accepted');
      assert.equal(job.customer.name, 'Customer Client');
      assert.equal(job.addressText, 'Standalone Customer Address A');
      assert.equal(job.notes, 'Check fuse box');
    });

    it('returns 404 for completed, cancelled or non-active jobs requested via /active-workload/:jobId', async () => {
      const resCompleted = await requestApp(
        'GET',
        `/api/v1/technicians/me/active-workload/${completedPool._id}`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
        }
      );
      assert.equal(resCompleted.statusCode, 404);
      assert.equal(resCompleted.body.error.code, 'JOB_NOT_FOUND');

      const resCancelled = await requestApp(
        'GET',
        `/api/v1/technicians/me/active-workload/${cancelledPool._id}`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
        }
      );
      assert.equal(resCancelled.statusCode, 404);
      assert.equal(resCancelled.body.error.code, 'JOB_NOT_FOUND');
    });

    it('returns 400 for malformed jobId parameter', async () => {
      const res = await requestApp(
        'GET',
        '/api/v1/technicians/me/active-workload/invalid-id-format',
        {
          headers: { Authorization: `Bearer ${techToken1}` },
        }
      );
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error.code, 'INVALID_ID');
    });
  });

  describe('4. Ownership Isolation & IDOR Protection', () => {
    let tech2Pool, tech2Booking;

    before(async () => {
      tech2Pool = await ServicePool.create({
        serviceCategoryId: category._id,
        zoneId: zone._id,
        status: 'assigned',
        assignedTechnicianId: techUser2._id,
        assignedAt: new Date(),
        maxCapacity: 4,
        poolRadiusKm: 5.0,
        centroidLocation: { type: 'Point', coordinates: [88.35, 22.54] },
        aggregateTimeWindow: {
          start: new Date(Date.now() + 3600000),
          end: new Date(Date.now() + 7200000),
        },
        lockCutoffTime: new Date(Date.now() + 1800000),
      });

      tech2Booking = await Booking.create({
        customerId: customerUser._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        poolId: null,
        technicianId: techUser2._id,
        status: 'assigned',
        assignedAt: new Date(),
        location: { type: 'Point', coordinates: [88.35, 22.54] },
        addressText: 'Tech 2 Address',
        timeWindow: {
          start: new Date(Date.now() + 3600000),
          end: new Date(Date.now() + 7200000),
        },
        estimatedPrice: 500,
      });
    });

    it('Technician 1 cannot view Technician 2 active workload list', async () => {
      const res = await requestApp('GET', '/api/v1/technicians/me/active-workload', {
        headers: { Authorization: `Bearer ${techToken1}` },
      });
      const ids = res.body.data.map((j) => String(j._id));
      assert.ok(!ids.includes(String(tech2Pool._id)));
      assert.ok(!ids.includes(String(tech2Booking._id)));
    });

    it('Technician 1 receives 404 JOB_NOT_FOUND when attempting to access Technician 2 active pool (IDOR safe)', async () => {
      const res = await requestApp(
        'GET',
        `/api/v1/technicians/me/active-workload/${tech2Pool._id}`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
        }
      );
      assert.equal(res.statusCode, 404);
      assert.equal(res.body.error.code, 'JOB_NOT_FOUND');
    });

    it('Technician 1 receives 404 JOB_NOT_FOUND when attempting to access Technician 2 standalone booking', async () => {
      const res = await requestApp(
        'GET',
        `/api/v1/technicians/me/active-workload/${tech2Booking._id}`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
        }
      );
      assert.equal(res.statusCode, 404);
      assert.equal(res.body.error.code, 'JOB_NOT_FOUND');
    });

    it('Technician 1 receives 404 when attempting to access Technician 2 route', async () => {
      const res = await requestApp(
        'GET',
        `/api/v1/technicians/me/routes/${tech2Pool._id}`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
        }
      );
      assert.equal(res.statusCode, 404);
      assert.equal(res.body.error.code, 'JOB_NOT_FOUND');
    });
  });

  describe('5. Technician Location Tracking & Telemetry', () => {
    it('returns hasLocation: false when technician has no recorded location', async () => {
      const res = await requestApp('GET', '/api/v1/technicians/me/location', {
        headers: { Authorization: `Bearer ${techToken2}` },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.data.hasLocation, false);
      assert.equal(res.body.data.location, null);
    });

    it('rejects location updates with missing or invalid latitude/longitude', async () => {
      // Missing latitude
      const res1 = await requestApp('POST', '/api/v1/technicians/me/location', {
        headers: { Authorization: `Bearer ${techToken1}` },
        body: { longitude: 88.36 },
      });
      assert.equal(res1.statusCode, 400);

      // Out of bounds latitude (> 90)
      const res2 = await requestApp('POST', '/api/v1/technicians/me/location', {
        headers: { Authorization: `Bearer ${techToken1}` },
        body: { latitude: 95.0, longitude: 88.36 },
      });
      assert.equal(res2.statusCode, 400);
      assert.equal(res2.body.error.code, 'VALIDATION_ERROR');

      // Out of bounds longitude (< -180)
      const res3 = await requestApp('POST', '/api/v1/technicians/me/location', {
        headers: { Authorization: `Bearer ${techToken1}` },
        body: { latitude: 22.57, longitude: -190.0 },
      });
      assert.equal(res3.statusCode, 400);
      assert.equal(res3.body.error.code, 'VALIDATION_ERROR');
    });

    it('rejects invalid or unreasonable timestamps', async () => {
      // Future timestamp (> 5 minutes in future)
      const futureTime = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const resFuture = await requestApp('POST', '/api/v1/technicians/me/location', {
        headers: { Authorization: `Bearer ${techToken1}` },
        body: { latitude: 22.57, longitude: 88.36, timestamp: futureTime },
      });
      assert.equal(resFuture.statusCode, 400);
      assert.equal(resFuture.body.error.code, 'VALIDATION_ERROR');

      // Ancient timestamp (> 48 hours ago)
      const ancientTime = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
      const resAncient = await requestApp('POST', '/api/v1/technicians/me/location', {
        headers: { Authorization: `Bearer ${techToken1}` },
        body: { latitude: 22.57, longitude: 88.36, timestamp: ancientTime },
      });
      assert.equal(resAncient.statusCode, 400);
      assert.equal(resAncient.body.error.code, 'VALIDATION_ERROR');
    });

    it('accepts valid GPS updates with optional telemetry (accuracy, speed, heading)', async () => {
      const now = new Date();
      const res = await requestApp('POST', '/api/v1/technicians/me/location', {
        headers: { Authorization: `Bearer ${techToken1}` },
        body: {
          latitude: 22.5726,
          longitude: 88.3639,
          accuracy: 12.5,
          speed: 4.2,
          heading: 185.0,
          timestamp: now.toISOString(),
        },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.latitude, 22.5726);
      assert.equal(res.body.data.longitude, 88.3639);
      assert.equal(res.body.data.accuracy, 12.5);
      assert.equal(res.body.data.speed, 4.2);
      assert.equal(res.body.data.heading, 185.0);

      // Verify persistence in TechnicianProfile
      const updatedProfile = await TechnicianProfile.findOne({ userId: techUser1._id });
      assert.deepEqual(updatedProfile.currentLocation.coordinates, [88.3639, 22.5726]);
      assert.ok(updatedProfile.lastLocationUpdate);

      // Verify persistence in TechnicianLocation log collection
      const locationLog = await TechnicianLocation.findOne({ technicianId: techUser1._id }).sort({ recordedAt: -1 });
      assert.ok(locationLog);
      assert.equal(locationLog.accuracy, 12.5);
    });

    it('enforces throttling when updates arrive too quickly (< 5 seconds)', async () => {
      // Immediate second update must be rejected with 429 RATE_LIMIT_EXCEEDED
      const resThrottled = await requestApp('POST', '/api/v1/technicians/me/location', {
        headers: { Authorization: `Bearer ${techToken1}` },
        body: {
          latitude: 22.573,
          longitude: 88.364,
        },
      });

      assert.equal(resThrottled.statusCode, 429);
      assert.equal(resThrottled.body.error.code, 'RATE_LIMIT_EXCEEDED');
    });

    it('retrieves the latest recorded location and identifies active vs stale status', async () => {
      const res = await requestApp('GET', '/api/v1/technicians/me/location', {
        headers: { Authorization: `Bearer ${techToken1}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      const data = res.body.data;

      assert.equal(data.hasLocation, true);
      assert.equal(data.latitude, 22.5726);
      assert.equal(data.longitude, 88.3639);
      assert.equal(data.accuracy, 12.5);
      assert.equal(data.isStale, false);
      assert.ok(data.ageSeconds >= 0);
    });

    it('correctly marks location as stale when last update is older than 15 minutes', async () => {
      // Artificially age the lastLocationUpdate on TechnicianProfile 1
      const staleTime = new Date(Date.now() - 20 * 60 * 1000); // 20 minutes ago
      await TechnicianProfile.updateOne(
        { userId: techUser1._id },
        { $set: { lastLocationUpdate: staleTime } }
      );

      const res = await requestApp('GET', '/api/v1/technicians/me/location', {
        headers: { Authorization: `Bearer ${techToken1}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.data.isStale, true);
      assert.ok(res.body.data.ageSeconds >= 1200);
    });

    it('Finding 1 — prevents out-of-order GPS timestamps from regressing profile currentLocation and lastLocationUpdate', async () => {
      // Reset lastLocationReceiptAt to avoid throttling
      await TechnicianProfile.updateOne(
        { userId: techUser1._id },
        { $set: { lastLocationReceiptAt: null } }
      );

      // Record a newer timestamp T1 (1 minute ago) at coords [88.3700, 22.5800]
      const tNewer = new Date(Date.now() - 60 * 1000);
      const resNewer = await requestApp('POST', '/api/v1/technicians/me/location', {
        headers: { Authorization: `Bearer ${techToken1}` },
        body: {
          latitude: 22.58,
          longitude: 88.37,
          timestamp: tNewer.toISOString(),
        },
      });
      assert.equal(resNewer.statusCode, 200);

      // Verify profile cache has the newer location
      const profileAfterNewer = await TechnicianProfile.findOne({ userId: techUser1._id }).lean();
      assert.deepEqual(profileAfterNewer.currentLocation.coordinates, [88.37, 22.58]);
      assert.equal(profileAfterNewer.lastLocationUpdate.toISOString(), tNewer.toISOString());

      // Reset lastLocationReceiptAt so the next request is not rejected by rate-limiting
      await TechnicianProfile.updateOne(
        { userId: techUser1._id },
        { $set: { lastLocationReceiptAt: null } }
      );

      // Record an older timestamp T0 (1 hour ago, delayed packet) at coords [88.3100, 22.5100]
      const tOlder = new Date(Date.now() - 60 * 60 * 1000);
      const resOlder = await requestApp('POST', '/api/v1/technicians/me/location', {
        headers: { Authorization: `Bearer ${techToken1}` },
        body: {
          latitude: 22.51,
          longitude: 88.31,
          timestamp: tOlder.toISOString(),
        },
      });
      assert.equal(resOlder.statusCode, 200);

      // Historical record MUST be inserted in TechnicianLocation
      const historicalLog = await TechnicianLocation.findOne({
        technicianId: techUser1._id,
        recordedAt: tOlder,
      });
      assert.ok(historicalLog, 'Historical record must be inserted in TechnicianLocation');
      assert.deepEqual(historicalLog.location.coordinates, [88.31, 22.51]);

      // BUT TechnicianProfile cache MUST NOT be overwritten with the older location/timestamp
      const profileAfterOlder = await TechnicianProfile.findOne({ userId: techUser1._id }).lean();
      assert.deepEqual(
        profileAfterOlder.currentLocation.coordinates,
        [88.37, 22.58],
        'TechnicianProfile.currentLocation must retain the newer fix and not be overwritten by out-of-order packet'
      );
      assert.equal(
        profileAfterOlder.lastLocationUpdate.toISOString(),
        tNewer.toISOString(),
        'TechnicianProfile.lastLocationUpdate must retain the newer timestamp'
      );

      // GET /location must also reflect the newer location
      const resGetLoc = await requestApp('GET', '/api/v1/technicians/me/location', {
        headers: { Authorization: `Bearer ${techToken1}` },
      });
      assert.equal(resGetLoc.statusCode, 200);
      assert.equal(resGetLoc.body.data.latitude, 22.58);
      assert.equal(resGetLoc.body.data.longitude, 88.37);
      assert.equal(resGetLoc.body.data.recordedAt, tNewer.toISOString());
    });

    it('Finding 2 — atomically throttles concurrent GPS update bursts for the same technician', async () => {
      // Reset lastLocationReceiptAt to allow the burst test to start cleanly
      await TechnicianProfile.updateOne(
        { userId: techUser1._id },
        { $set: { lastLocationReceiptAt: null } }
      );

      const countBefore = await TechnicianLocation.countDocuments({ technicianId: techUser1._id });

      // Send 2 concurrent requests simultaneously for the same technician
      const [resA, resB] = await Promise.all([
        requestApp('POST', '/api/v1/technicians/me/location', {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { latitude: 22.5741, longitude: 88.3651 },
        }),
        requestApp('POST', '/api/v1/technicians/me/location', {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { latitude: 22.5742, longitude: 88.3652 },
        }),
      ]);

      const statusCodes = [resA.statusCode, resB.statusCode].sort((a, b) => a - b);
      assert.deepEqual(
        statusCodes,
        [200, 429],
        'Exactly one concurrent update must succeed (200) and one must be throttled (429)'
      );

      const rejectedRes = resA.statusCode === 429 ? resA : resB;
      assert.equal(rejectedRes.body.error.code, 'RATE_LIMIT_EXCEEDED');

      // The rejected request must NOT write a document to TechnicianLocation
      const countAfter = await TechnicianLocation.countDocuments({ technicianId: techUser1._id });
      assert.equal(
        countAfter,
        countBefore + 1,
        'Only the single winning request should have written a TechnicianLocation record'
      );
    });

    it('Finding 2 — isolates throttling per technician (concurrent updates for different technicians both succeed)', async () => {
      // Clear lastLocationReceiptAt for both technicians
      await Promise.all([
        TechnicianProfile.updateOne(
          { userId: techUser1._id },
          { $set: { lastLocationReceiptAt: null } }
        ),
        TechnicianProfile.updateOne(
          { userId: techUser2._id },
          { $set: { lastLocationReceiptAt: null } }
        ),
      ]);

      // Fire concurrent requests for Tech 1 and Tech 2 simultaneously
      const [resTech1, resTech2] = await Promise.all([
        requestApp('POST', '/api/v1/technicians/me/location', {
          headers: { Authorization: `Bearer ${techToken1}` },
          body: { latitude: 22.5755, longitude: 88.3665 },
        }),
        requestApp('POST', '/api/v1/technicians/me/location', {
          headers: { Authorization: `Bearer ${techToken2}` },
          body: { latitude: 22.5422, longitude: 88.3522 },
        }),
      ]);

      assert.equal(resTech1.statusCode, 200, 'Tech 1 update must succeed');
      assert.equal(resTech2.statusCode, 200, 'Tech 2 update must succeed without throttle cross-talk');
    });
  });

  describe('6. Route Tracking APIs', () => {
    it('returns sequenced routes for all active assigned jobs via GET /me/routes', async () => {
      const res = await requestApp('GET', '/api/v1/technicians/me/routes', {
        headers: { Authorization: `Bearer ${techToken1}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      const routes = res.body.data;

      // 4 active jobs (2 pools + 2 standalone bookings)
      assert.equal(routes.length, 4);

      for (const route of routes) {
        assert.ok(route.jobId);
        assert.ok(['pool', 'individual'].includes(route.jobType));
        assert.ok(route.origin);
        assert.ok(['live_gps', 'base_location', 'override'].includes(route.originSource));
        assert.equal(typeof route.isOriginStale, 'boolean');
        assert.ok(route.originLastUpdatedAt === null || typeof route.originLastUpdatedAt === 'string');
        assert.ok(route.totalStops >= 1);
        assert.ok(Array.isArray(route.stops));
        for (const stop of route.stops) {
          assert.ok(stop.sequenceIndex >= 1);
          assert.ok(stop.location);
          assert.ok(stop.customer.name);
          assert.ok(stop.customer.phone);
        }
      }
    });

    it('Finding 3 — falls back to base_location originSource when technician has no GPS updates', async () => {
      // Clear GPS on techProfile2
      await TechnicianProfile.updateOne(
        { userId: techUser2._id },
        { $set: { currentLocation: null, lastLocationUpdate: null } }
      );

      const res = await requestApp('GET', '/api/v1/technicians/me/routes', {
        headers: { Authorization: `Bearer ${techToken2}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      const routes = res.body.data;
      assert.ok(routes.length >= 1);
      for (const route of routes) {
        assert.equal(route.originSource, 'base_location');
        assert.equal(route.isOriginStale, false);
        assert.equal(route.originLastUpdatedAt, null);
        assert.deepEqual(route.origin.coordinates, [88.35, 22.54]);
      }
    });

    it('Finding 3 — returns originSource override when query coordinates are provided in GET /me/routes/:jobId', async () => {
      const activePool = await ServicePool.findOne({
        assignedTechnicianId: techUser1._id,
        status: { $in: ['assigned', 'accepted', 'in_progress'] },
      });

      const res = await requestApp(
        'GET',
        `/api/v1/technicians/me/routes/${activePool._id}?lat=22.6100&lng=88.4200`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
        }
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      const route = res.body.data;
      assert.equal(route.originSource, 'override');
      assert.equal(route.isOriginStale, false);
      assert.equal(route.originLastUpdatedAt, null);
      assert.deepEqual(route.origin.coordinates, [88.42, 22.61]);
    });

    it('Finding 3 — flags route origin as stale when technician GPS fix is older than 15 minutes', async () => {
      // Set techProfile1 lastLocationUpdate to 20 minutes ago
      const staleTime = new Date(Date.now() - 20 * 60 * 1000);
      await TechnicianProfile.updateOne(
        { userId: techUser1._id },
        {
          $set: {
            currentLocation: { type: 'Point', coordinates: [88.37, 22.58] },
            lastLocationUpdate: staleTime,
          },
        }
      );

      const activePool = await ServicePool.findOne({
        assignedTechnicianId: techUser1._id,
        status: { $in: ['assigned', 'accepted', 'in_progress'] },
      });

      const res = await requestApp('GET', `/api/v1/technicians/me/routes/${activePool._id}`, {
        headers: { Authorization: `Bearer ${techToken1}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      const route = res.body.data;
      assert.equal(route.originSource, 'live_gps');
      assert.equal(route.isOriginStale, true);
      assert.equal(route.originLastUpdatedAt, staleTime.toISOString());
    });

    it('returns individual job route details via GET /me/routes/:jobId', async () => {
      // Find an active pool
      const activePool = await ServicePool.findOne({
        assignedTechnicianId: techUser1._id,
        status: { $in: ['assigned', 'accepted', 'in_progress'] },
      });

      const res = await requestApp('GET', `/api/v1/technicians/me/routes/${activePool._id}`, {
        headers: { Authorization: `Bearer ${techToken1}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      const route = res.body.data;

      assert.equal(route.jobId, String(activePool._id));
      assert.equal(route.jobType, 'pool');
      assert.ok(route.stops.length >= 1);
    });

    it('returns individual standalone booking route details via GET /me/routes/:jobId', async () => {
      // Find an active standalone booking
      const activeBooking = await Booking.findOne({
        technicianId: techUser1._id,
        poolId: null,
        status: { $in: ['assigned', 'accepted', 'in_progress'] },
      });

      const res = await requestApp('GET', `/api/v1/technicians/me/routes/${activeBooking._id}`, {
        headers: { Authorization: `Bearer ${techToken1}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      const route = res.body.data;

      assert.equal(route.jobId, String(activeBooking._id));
      assert.equal(route.jobType, 'individual');
      assert.equal(route.stops.length, 1);
    });

    it('returns 404 when querying routes for completed, cancelled, or missing jobs', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();
      const res = await requestApp('GET', `/api/v1/technicians/me/routes/${nonExistentId}`, {
        headers: { Authorization: `Bearer ${techToken1}` },
      });
      assert.equal(res.statusCode, 404);
      assert.equal(res.body.error.code, 'JOB_NOT_FOUND');
    });
  });

  describe('7. Active Workload Arrived Breakdown & Availability Guard Remediation (D-3)', () => {
    let arrivedBooking;

    before(async () => {
      const now = new Date();
      arrivedBooking = await Booking.create({
        customerId: customerUser._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: techUser1._id,
        poolId: null,
        location: { type: 'Point', coordinates: [88.35, 22.54] },
        addressText: 'Arrived Workload Test Address',
        timeWindow: {
          start: new Date(now.getTime() + 1800000),
          end: new Date(now.getTime() + 5400000),
        },
        status: 'arrived',
        arrivedAt: new Date(),
        estimatedPrice: 450,
      });
    });

    it('1. Reports meta.counts.arrived accurately and reconciles with totalActive', async () => {
      const res = await requestApp('GET', '/api/v1/technicians/me/active-workload', {
        headers: { Authorization: `Bearer ${techToken1}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      const { counts } = res.body.meta;

      assert.ok(counts.arrived >= 1, 'counts.arrived must be at least 1');
      assert.equal(
        counts.totalActive,
        counts.assigned + counts.accepted + counts.arrived + counts.inProgress,
        'totalActive must strictly reconcile with the sum of assigned, accepted, arrived, and inProgress'
      );
    });

    it('2. Prevents on-site arrived technician from manually setting availability to available (409 ACTIVE_JOB_IN_PROGRESS)', async () => {
      const res = await requestApp('PATCH', '/api/v1/technicians/me/availability', {
        headers: { Authorization: `Bearer ${techToken1}` },
        body: { availabilityStatus: 'available' },
      });

      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'ACTIVE_JOB_IN_PROGRESS');
      assert.match(res.body.error.message, /in progress or on-site/i);
    });

    it('3. Excludes arrived technician from new assignment eligibility', async () => {
      const { evaluateBookingEligibility } = await import('../src/modules/pools/poolAssignment.service.js');
      const now = new Date();

      const newBooking = await Booking.create({
        customerId: customerUser._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        location: { type: 'Point', coordinates: [88.35, 22.54] },
        addressText: 'Overlap Booking Test',
        timeWindow: {
          start: new Date(now.getTime() + 2000000),
          end: new Date(now.getTime() + 5000000),
        },
        status: 'pending',
        estimatedPrice: 500,
      });

      // Arrived booking has overlapping window
      const freshProfile = await TechnicianProfile.findById(techProfile1._id).populate('userId');
      const evaluation = await evaluateBookingEligibility(freshProfile, newBooking);
      assert.equal(evaluation.isEligible, false);
      assert.ok(
        evaluation.reasons.some((r) => /conflict|capacity|available/i.test(r)),
        'Arrived technician must not be eligible for overlapping assignment'
      );
    });

    it('4. Releasing arrived commitment via completion restores availability override ability', async () => {
      // Mark arrived booking completed
      await Booking.findByIdAndUpdate(arrivedBooking._id, {
        $set: { status: 'completed', completedAt: new Date() },
      });

      // Also ensure no other in_progress/arrived jobs for techUser2
      const res = await requestApp('PATCH', '/api/v1/technicians/me/availability', {
        headers: { Authorization: `Bearer ${techToken2}` },
        body: { availabilityStatus: 'available' },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.data.availabilityStatus, 'available');
    });
  });
});
