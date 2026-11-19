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
} from '../src/models/index.js';
import { signAuthToken } from '../src/middleware/auth.js';
import { getDateBoundaries } from '../src/modules/technicians/technicianMetrics.service.js';

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

describe('Phase 5A.2 Step 2 — Technician Dashboard Metrics API Suite', () => {
  let replSet;
  let adminUser, adminToken;
  let customerUser, customerToken;
  let techUser1, techToken1, techProfile1;
  let techUser2, techToken2, techProfile2;
  let category;
  let zone;

  const validPasswordHash = '$2a$10$abcdefghijklmnopqrstuvwxyz123456';

  before(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = replSet.getUri();
    process.env.MONGODB_URI = uri;

    await connectDB(uri);

    // 1. Admin
    adminUser = await User.create({
      name: 'Admin Test',
      email: `admin_${Date.now()}@test.local`,
      passwordHash: validPasswordHash,
      role: 'admin',
      isActive: true,
    });
    adminToken = signAuthToken(adminUser);

    // 2. Customer
    customerUser = await User.create({
      name: 'Customer Test',
      email: `customer_${Date.now()}@test.local`,
      passwordHash: validPasswordHash,
      role: 'customer',
      isActive: true,
    });
    customerToken = signAuthToken(customerUser);

    // 3. Category & Zone
    category = await ServiceCategory.create({
      name: 'Air Conditioner Repair',
      slug: `ac_repair_${Date.now()}`,
      description: 'AC cooling diagnostics and maintenance',
      baseIndividualPrice: 650,
      estimatedDurationMins: 60,
      defaultPoolRadiusKm: 5.0,
      maxPoolSize: 4,
      poolLockCutoffMins: 60,
      isActive: true,
    });

    zone = await ServiceZone.create({
      name: 'Salt Lake Zone',
      code: `SLK_${Date.now().toString().slice(-4)}`,
      city: 'Kolkata',
      centerLocation: { type: 'Point', coordinates: [88.41, 22.58] },
      radiusKm: 12,
      isActive: true,
    });

    // 4. Technician 1
    techUser1 = await User.create({
      name: 'Technician Primary',
      email: `tech1_${Date.now()}@test.local`,
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
      addressText: 'Salt Lake Sector V',
      serviceRadiusKm: 10,
      maxPoolCapacity: 4,
      activeWorkload: 0,
      approvalStatus: 'approved',
      availabilityStatus: 'available',
      ratingAvg: 4.85,
      ratingCount: 22,
      jobsCompleted: 35,
    });

    // 5. Technician 2 (for isolation testing)
    techUser2 = await User.create({
      name: 'Technician Secondary',
      email: `tech2_${Date.now()}@test.local`,
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
      baseLocation: { type: 'Point', coordinates: [88.39, 22.56] },
      addressText: 'Kankurgachi',
      serviceRadiusKm: 10,
      maxPoolCapacity: 4,
      activeWorkload: 0,
      approvalStatus: 'approved',
      availabilityStatus: 'available',
      ratingAvg: 4.6,
      ratingCount: 14,
      jobsCompleted: 18,
    });
  });

  after(async () => {
    await disconnectDB();
    if (replSet) {
      await replSet.stop();
    }
  });

  describe('1. Authentication and Authorization', () => {
    it('rejects unauthenticated requests with 401 AUTH_REQUIRED', async () => {
      const res = await requestApp('GET', '/api/v1/technicians/me/metrics');
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'AUTH_REQUIRED');
    });

    it('rejects customer requests with 403 FORBIDDEN_ROLE', async () => {
      const res = await requestApp('GET', '/api/v1/technicians/me/metrics', {
        headers: { Authorization: `Bearer ${customerToken}` },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'FORBIDDEN_ROLE');
    });

    it('rejects admin requests with 403 FORBIDDEN_ROLE', async () => {
      const res = await requestApp('GET', '/api/v1/technicians/me/metrics', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'FORBIDDEN_ROLE');
    });

    it('derives identity exclusively from authenticated user, ignoring client-supplied technicianId parameter', async () => {
      // Tech 1 attempts to pass ?technicianId=tech2._id
      const res = await requestApp(
        'GET',
        `/api/v1/technicians/me/metrics?technicianId=${techUser2._id}`,
        {
          headers: { Authorization: `Bearer ${techToken1}` },
        }
      );
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      // Response must strictly belong to tech 1
      assert.equal(res.body.data.technicianId, String(techUser1._id));
    });
  });

  describe('2. Empty State Handling', () => {
    it('returns zero values consistently with no misleading nulls for a technician with 0 jobs', async () => {
      const res = await requestApp('GET', '/api/v1/technicians/me/metrics', {
        headers: { Authorization: `Bearer ${techToken1}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      const data = res.body.data;

      // Summary
      assert.equal(data.summary.totalAssignedJobs, 0);
      assert.equal(data.summary.activeJobs, 0);
      assert.equal(data.summary.completedJobs, 0);
      assert.equal(data.summary.cancelledJobs, 0);
      assert.equal(data.summary.pendingActionJobs, 0);

      // Jobs details
      assert.equal(data.jobs.total, 0);
      assert.equal(data.jobs.active, 0);
      assert.equal(data.jobs.pendingAcceptance, 0);
      assert.equal(data.jobs.accepted, 0);
      assert.equal(data.jobs.inProgress, 0);
      assert.equal(data.jobs.completed, 0);
      assert.equal(data.jobs.cancelled, 0);

      // Pools details
      assert.equal(data.pools.totalAssigned, 0);
      assert.equal(data.pools.active, 0);
      assert.equal(data.pools.completed, 0);
      assert.equal(data.pools.cancelled, 0);

      // Date metrics
      assert.equal(data.dateMetrics.completedToday, 0);
      assert.equal(data.dateMetrics.assignedToday, 0);
      assert.equal(data.dateMetrics.completedThisMonth, 0);
      assert.equal(data.dateMetrics.breakdownToday.poolsCompleted, 0);
      assert.equal(data.dateMetrics.breakdownToday.individualCompleted, 0);
      assert.equal(data.dateMetrics.breakdownToday.poolsAssigned, 0);
      assert.equal(data.dateMetrics.breakdownToday.individualAssigned, 0);

      // Capacity & Performance
      assert.equal(data.capacity.maxPoolCapacity, 4);
      assert.equal(data.capacity.availableCapacity, 4);
      assert.equal(data.capacity.utilizationPercentage, 0);
      assert.equal(data.performance.ratingAvg, 4.85);
      assert.equal(data.performance.ratingCount, 22);
      assert.equal(data.performance.lifetimeJobsCompleted, 35);

      // Period metadata
      assert.ok(data.period.startOfDay);
      assert.ok(data.period.endOfDay);
      assert.ok(data.period.startOfMonth);
      assert.ok(data.period.endOfMonth);
      assert.ok(data.period.generatedAt);

      // Earnings is intentionally omitted as documented
      assert.equal(data.earnings, undefined);
    });
  });

  describe('3. Metric Correctness and Non-Double-Counting', () => {
    it('computes exact counts across pools, standalone bookings, and excludes member bookings in pools', async () => {
      const now = new Date();
      const pastTime = new Date(now.getTime() - 100000);

      // 1. Pool: assigned today, status 'assigned' (pendingAcceptance: 1)
      const poolAssigned = await ServicePool.create({
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
        pricing: { individualBasePrice: 650 },
      });

      // 2. Pool: accepted earlier, status 'in_progress' (inProgress: 1)
      const poolInProgress = await ServicePool.create({
        serviceCategoryId: category._id,
        zoneId: zone._id,
        status: 'in_progress',
        assignedTechnicianId: techUser1._id,
        assignedAt: pastTime,
        acceptedAt: pastTime,
        startedAt: now,
        maxCapacity: 4,
        poolRadiusKm: 5.0,
        centroidLocation: { type: 'Point', coordinates: [88.41, 22.58] },
        aggregateTimeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 7200000),
        },
        lockCutoffTime: new Date(now.getTime() + 1800000),
        pricing: { individualBasePrice: 650 },
      });

      // 3. Pool: completed today (completed: 1, completedToday: 1)
      const poolCompleted = await ServicePool.create({
        serviceCategoryId: category._id,
        zoneId: zone._id,
        status: 'completed',
        assignedTechnicianId: techUser1._id,
        assignedAt: pastTime,
        acceptedAt: pastTime,
        startedAt: pastTime,
        completedAt: now,
        maxCapacity: 4,
        poolRadiusKm: 5.0,
        centroidLocation: { type: 'Point', coordinates: [88.41, 22.58] },
        aggregateTimeWindow: {
          start: new Date(now.getTime() - 7200000),
          end: new Date(now.getTime() - 3600000),
        },
        lockCutoffTime: new Date(now.getTime() - 10000000),
        pricing: { individualBasePrice: 650 },
      });

      // 4. Standalone Booking: assigned and accepted (accepted: 1)
      const bookingAccepted = await Booking.create({
        customerId: customerUser._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        poolId: null, // Standalone
        technicianId: techUser1._id,
        assignedAt: now,
        acceptedAt: now,
        status: 'accepted',
        location: { type: 'Point', coordinates: [88.41, 22.58] },
        addressText: 'Salt Lake Block BD',
        timeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 7200000),
        },
        estimatedPrice: 650,
      });

      // 5. Standalone Booking: completed today (completed: 1, completedToday: 1)
      const bookingCompleted = await Booking.create({
        customerId: customerUser._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        poolId: null, // Standalone
        technicianId: techUser1._id,
        assignedAt: pastTime,
        acceptedAt: pastTime,
        startedAt: pastTime,
        completedAt: now,
        status: 'completed',
        location: { type: 'Point', coordinates: [88.41, 22.58] },
        addressText: 'Salt Lake Block AE',
        timeWindow: {
          start: new Date(now.getTime() - 7200000),
          end: new Date(now.getTime() - 3600000),
        },
        estimatedPrice: 650,
      });

      // 6. MEMBER BOOKING inside pool: must NOT be counted as a standalone job!
      const memberBookingInPool = await Booking.create({
        customerId: customerUser._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        poolId: poolInProgress._id, // LINKED TO POOL
        technicianId: techUser1._id,
        assignedAt: now,
        status: 'in_progress',
        location: { type: 'Point', coordinates: [88.41, 22.58] },
        addressText: 'Salt Lake Member Booking',
        timeWindow: {
          start: new Date(now.getTime() + 3600000),
          end: new Date(now.getTime() + 7200000),
        },
        estimatedPrice: 585,
      });

      // Update technician 1 profile workload to reflect 3 active commitments
      await TechnicianProfile.updateOne(
        { userId: techUser1._id },
        { $set: { activeWorkload: 3, availabilityStatus: 'busy' } }
      );

      // Fetch metrics
      const res = await requestApp('GET', '/api/v1/technicians/me/metrics', {
        headers: { Authorization: `Bearer ${techToken1}` },
      });

      assert.equal(res.statusCode, 200);
      const data = res.body.data;

      // Assert Summary
      // Total assigned = 3 pools + 2 standalone bookings = 5 (memberBookingInPool excluded!)
      assert.equal(data.summary.totalAssignedJobs, 5);
      // Active = 1 pool assigned + 1 pool in_progress + 1 booking accepted = 3
      assert.equal(data.summary.activeJobs, 3);
      // Completed = 1 pool + 1 standalone booking = 2
      assert.equal(data.summary.completedJobs, 2);
      assert.equal(data.summary.pendingActionJobs, 1);
      assert.equal(data.summary.cancelledJobs, 0);

      // Assert Jobs Breakdown
      assert.equal(data.jobs.total, 5);
      assert.equal(data.jobs.active, 3);
      assert.equal(data.jobs.pendingAcceptance, 1);
      assert.equal(data.jobs.accepted, 1);
      assert.equal(data.jobs.inProgress, 1);
      assert.equal(data.jobs.completed, 2);
      assert.equal(data.jobs.breakdown.pools.total, 3);
      assert.equal(data.jobs.breakdown.pools.active, 2);
      assert.equal(data.jobs.breakdown.pools.completed, 1);
      assert.equal(data.jobs.breakdown.individual.total, 2);
      assert.equal(data.jobs.breakdown.individual.active, 1);
      assert.equal(data.jobs.breakdown.individual.completed, 1);

      // Assert Pools object
      assert.equal(data.pools.totalAssigned, 3);
      assert.equal(data.pools.active, 2);
      assert.equal(data.pools.completed, 1);
      assert.equal(data.pools.cancelled, 0);

      // Assert Date Metrics
      assert.equal(data.dateMetrics.completedToday, 2);
      assert.equal(data.dateMetrics.breakdownToday.poolsCompleted, 1);
      assert.equal(data.dateMetrics.breakdownToday.individualCompleted, 1);
      // Assigned today: poolAssigned + bookingAccepted = 2 (pastTime pool/booking was created earlier)
      assert.equal(data.dateMetrics.assignedToday >= 2, true);
      assert.equal(data.dateMetrics.completedThisMonth, 2);

      // Assert Capacity
      assert.equal(data.capacity.activeWorkload, 3);
      assert.equal(data.capacity.availableCapacity, 1);
      assert.equal(data.capacity.utilizationPercentage, 75.0);
      assert.equal(data.capacity.availabilityStatus, 'busy');
    });

    it('accurately tracks standalone booking through arrived -> completed and arrived -> cancelled transitions', async () => {
      // 1. Create a standalone booking in arrived status for Tech 1
      const arrivedBooking = await Booking.create({
        customerId: customerUser._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        poolId: null,
        technicianId: techUser1._id,
        location: { type: 'Point', coordinates: [88.36, 22.58] },
        addressText: 'Arrived Metric Test',
        timeWindow: {
          start: new Date(Date.now() + 3600000),
          end: new Date(Date.now() + 7200000),
        },
        status: 'arrived',
        arrivedAt: new Date(),
        assignedAt: new Date(),
        estimatedPrice: 750,
      });

      let res = await requestApp('GET', '/api/v1/technicians/me/metrics', {
        headers: { Authorization: `Bearer ${techToken1}` },
      });
      assert.equal(res.statusCode, 200);
      let data = res.body.data;

      // Arrived booking must be included in active workload and breakdown
      assert.equal(data.jobs.arrived, 1);
      assert.equal(data.jobs.breakdown.individual.arrived, 1);
      const activeBeforeComplete = data.jobs.active;
      const totalBeforeComplete = data.jobs.total;

      // 2. Complete the arrived booking
      arrivedBooking.status = 'completed';
      arrivedBooking.completedAt = new Date();
      await arrivedBooking.save();

      res = await requestApp('GET', '/api/v1/technicians/me/metrics', {
        headers: { Authorization: `Bearer ${techToken1}` },
      });
      assert.equal(res.statusCode, 200);
      data = res.body.data;

      assert.equal(data.jobs.arrived, 0);
      assert.equal(data.jobs.breakdown.individual.arrived, 0);
      assert.equal(data.jobs.active, activeBeforeComplete - 1);
      assert.equal(data.jobs.total, totalBeforeComplete);

      // 3. Clean up the test booking
      await Booking.deleteOne({ _id: arrivedBooking._id });
    });
  });

  describe('4. Data Isolation Between Technicians', () => {
    it('strictly isolates metrics and never counts another technicians jobs or rejected pools', async () => {
      // 1. Assign a pool to Tech 2
      const poolTech2 = await ServicePool.create({
        serviceCategoryId: category._id,
        zoneId: zone._id,
        status: 'assigned',
        assignedTechnicianId: techUser2._id,
        assignedAt: new Date(),
        maxCapacity: 4,
        poolRadiusKm: 5.0,
        centroidLocation: { type: 'Point', coordinates: [88.39, 22.56] },
        aggregateTimeWindow: {
          start: new Date(Date.now() + 3600000),
          end: new Date(Date.now() + 7200000),
        },
        lockCutoffTime: new Date(Date.now() + 1800000),
        pricing: { individualBasePrice: 650 },
      });

      // 2. Create a pool rejected by Tech 2, but currently unassigned (locked)
      const poolRejected = await ServicePool.create({
        serviceCategoryId: category._id,
        zoneId: zone._id,
        status: 'locked',
        assignedTechnicianId: null,
        rejectedTechnicians: [techUser2._id],
        maxCapacity: 4,
        poolRadiusKm: 5.0,
        centroidLocation: { type: 'Point', coordinates: [88.39, 22.56] },
        aggregateTimeWindow: {
          start: new Date(Date.now() + 3600000),
          end: new Date(Date.now() + 7200000),
        },
        lockCutoffTime: new Date(Date.now() + 1800000),
        pricing: { individualBasePrice: 650 },
      });

      // Fetch Tech 2 metrics
      const resTech2 = await requestApp('GET', '/api/v1/technicians/me/metrics', {
        headers: { Authorization: `Bearer ${techToken2}` },
      });
      assert.equal(resTech2.statusCode, 200);

      // Tech 2 must have exactly 1 assigned pool (the rejected pool with assignedTechnicianId: null is NOT counted)
      assert.equal(resTech2.body.data.summary.totalAssignedJobs, 1);
      assert.equal(resTech2.body.data.pools.totalAssigned, 1);
      assert.equal(resTech2.body.data.pools.active, 1);

      // Fetch Tech 1 metrics
      const resTech1 = await requestApp('GET', '/api/v1/technicians/me/metrics', {
        headers: { Authorization: `Bearer ${techToken1}` },
      });
      assert.equal(resTech1.statusCode, 200);

      // Tech 1 counts must be completely unaffected by Tech 2's jobs
      assert.equal(resTech1.body.data.summary.totalAssignedJobs, 5);
    });
  });

  describe('5. Date and Midnight Boundary Accuracy', () => {
    it('correctly includes records at midnight boundaries and excludes records outside boundaries', async () => {
      const boundaries = getDateBoundaries(new Date(), 'UTC');
      const { startOfDay, endOfDay, startOfMonth } = boundaries;

      // 1. Record completed EXACTLY at startOfDay (00:00:00.000) -> MUST be included in completedToday
      const bookingAtMidnight = await Booking.create({
        customerId: customerUser._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        poolId: null,
        technicianId: techUser1._id,
        status: 'completed',
        assignedAt: new Date(startOfDay.getTime() - 3600000),
        completedAt: new Date(startOfDay.getTime()),
        location: { type: 'Point', coordinates: [88.41, 22.58] },
        addressText: 'Midnight Booking Test',
        timeWindow: {
          start: new Date(startOfDay.getTime() - 7200000),
          end: new Date(startOfDay.getTime() - 3600000),
        },
        estimatedPrice: 650,
      });

      // 2. Record completed 1ms before startOfDay -> MUST NOT be in completedToday
      const bookingBeforeStart = await Booking.create({
        customerId: customerUser._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        poolId: null,
        technicianId: techUser1._id,
        status: 'completed',
        assignedAt: new Date(startOfDay.getTime() - 86400000),
        completedAt: new Date(startOfDay.getTime() - 1),
        location: { type: 'Point', coordinates: [88.41, 22.58] },
        addressText: 'Yesterday Booking Test',
        timeWindow: {
          start: new Date(startOfDay.getTime() - 86400000),
          end: new Date(startOfDay.getTime() - 80000000),
        },
        estimatedPrice: 650,
      });

      // 3. Record completed EXACTLY at endOfDay (exclusive) -> MUST NOT be in completedToday
      const bookingAtNextMidnight = await Booking.create({
        customerId: customerUser._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        poolId: null,
        technicianId: techUser1._id,
        status: 'completed',
        assignedAt: new Date(endOfDay.getTime() - 3600000),
        completedAt: new Date(endOfDay.getTime()),
        location: { type: 'Point', coordinates: [88.41, 22.58] },
        addressText: 'Next Midnight Booking Test',
        timeWindow: {
          start: new Date(endOfDay.getTime() - 7200000),
          end: new Date(endOfDay.getTime() - 3600000),
        },
        estimatedPrice: 650,
      });

      const res = await requestApp('GET', '/api/v1/technicians/me/metrics', {
        headers: { Authorization: `Bearer ${techToken1}` },
      });
      assert.equal(res.statusCode, 200);

      // Previously 2 completed today; bookingAtMidnight adds 1 -> total completedToday = 3
      assert.equal(res.body.data.dateMetrics.completedToday, 3);
    });

    it('supports custom IANA timezone queries via ?timezone=Asia/Kolkata', async () => {
      const res = await requestApp(
        'GET',
        '/api/v1/technicians/me/metrics?timezone=Asia/Kolkata',
        {
          headers: { Authorization: `Bearer ${techToken1}` },
        }
      );
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.data.period.timeZone, 'Asia/Kolkata');
      assert.ok(res.body.data.period.startOfDay);
      assert.ok(res.body.data.period.endOfDay);
    });
  });

  describe('6. Endpoint Route Aliases', () => {
    it('supports GET /api/v1/technicians/dashboard/metrics alias', async () => {
      const res = await requestApp(
        'GET',
        '/api/v1/technicians/dashboard/metrics',
        {
          headers: { Authorization: `Bearer ${techToken1}` },
        }
      );
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.ok(res.body.data.summary);
    });

    it('supports GET /api/technician/dashboard/metrics alias', async () => {
      const res = await requestApp(
        'GET',
        '/api/technician/dashboard/metrics',
        {
          headers: { Authorization: `Bearer ${techToken1}` },
        }
      );
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.ok(res.body.data.summary);
    });
  });
});
