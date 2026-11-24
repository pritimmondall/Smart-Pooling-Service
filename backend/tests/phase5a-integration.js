import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import app from '../src/app.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import {
  User,
  ServiceCategory,
  ServiceZone,
  TechnicianProfile,
  ServicePool,
  Booking,
  PoolMembership,
  Notification,
} from '../src/models/index.js';
import { toGeoJSONPoint } from '../src/utils/geo.js';
import { signAuthToken } from '../src/middleware/auth.js';
import { assignPoolToTechnician } from '../src/modules/pools/poolAssignment.service.js';

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

describe('Phase 5A Real Replica Set Integration: Assignment, Lifecycle, Availability & Routing Suite', () => {
  let replSet;
  let adminUser, adminToken;
  let techAUser, techAToken, techAProfile;
  let techBUser, techBToken, techBProfile;
  let unapprovedTechUser, unapprovedTechToken, unapprovedTechProfile;
  let customer1User, customer1Token;
  let customer2User, customer2Token;
  let categoryAC, categoryPlumbing;
  let zoneBallygunge;

  before(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = replSet.getUri();
    process.env.MONGODB_URI = uri;
    process.env.ROUTING_PROVIDER = 'mock'; // Use mock provider for deterministic integration test execution

    await connectDB(uri);

    // 1. Create categories
    categoryAC = await ServiceCategory.create({
      name: 'AC Repair Test',
      slug: `ac_repair_${Date.now()}`,
      description: 'Testing AC repair',
      baseIndividualPrice: 600,
      estimatedDurationMins: 45,
      defaultPoolRadiusKm: 3.0,
      maxPoolSize: 4,
      poolLockCutoffMins: 60,
    });

    categoryPlumbing = await ServiceCategory.create({
      name: 'Plumbing Test',
      slug: `plumbing_${Date.now()}`,
      description: 'Testing plumbing',
      baseIndividualPrice: 450,
      estimatedDurationMins: 40,
      defaultPoolRadiusKm: 2.0,
      maxPoolSize: 4,
      poolLockCutoffMins: 60,
    });

    // 2. Create zone in Ballygunge
    zoneBallygunge = await ServiceZone.create({
      name: 'Ballygunge Central',
      code: `ZONE_BAL_${Date.now()}`,
      city: 'Kolkata',
      centerLocation: toGeoJSONPoint(22.528, 88.365),
      radiusKm: 5,
    });

    // 3. Create Users
    adminUser = await User.create({
      name: 'Platform Admin',
      email: `admin_${Date.now()}@test.local`,
      phone: '+91-9000000001',
      passwordHash: 'ValidPass123!',
      role: 'admin',
      isActive: true,
    });
    adminToken = signAuthToken(adminUser);

    customer1User = await User.create({
      name: 'Customer 1',
      email: `cust1_${Date.now()}@test.local`,
      phone: '+91-9000000101',
      passwordHash: 'ValidPass123!',
      role: 'customer',
      isActive: true,
    });
    customer1Token = signAuthToken(customer1User);

    customer2User = await User.create({
      name: 'Customer 2',
      email: `cust2_${Date.now()}@test.local`,
      phone: '+91-9000000102',
      passwordHash: 'ValidPass123!',
      role: 'customer',
      isActive: true,
    });
    customer2Token = signAuthToken(customer2User);

    // Tech A: Approved, Available, AC category, Ballygunge base location
    techAUser = await User.create({
      name: 'Technician A',
      email: `techa_${Date.now()}@test.local`,
      phone: '+91-9000000201',
      passwordHash: 'ValidPass123!',
      role: 'technician',
      isActive: true,
    });
    techAToken = signAuthToken(techAUser);

    techAProfile = await TechnicianProfile.create({
      userId: techAUser._id,
      serviceCategories: [categoryAC._id],
      zoneId: zoneBallygunge._id,
      baseLocation: toGeoJSONPoint(22.528, 88.365),
      addressText: 'Ballygunge, Kolkata',
      serviceRadiusKm: 8,
      maxPoolCapacity: 4,
      availabilityStatus: 'available',
      approvalStatus: 'approved',
    });

    // Tech B: Approved, Available, Plumbing only
    techBUser = await User.create({
      name: 'Technician B',
      email: `techb_${Date.now()}@test.local`,
      phone: '+91-9000000202',
      passwordHash: 'ValidPass123!',
      role: 'technician',
      isActive: true,
    });
    techBToken = signAuthToken(techBUser);

    techBProfile = await TechnicianProfile.create({
      userId: techBUser._id,
      serviceCategories: [categoryPlumbing._id],
      zoneId: zoneBallygunge._id,
      baseLocation: toGeoJSONPoint(22.528, 88.365),
      addressText: 'Ballygunge, Kolkata',
      serviceRadiusKm: 8,
      maxPoolCapacity: 4,
      availabilityStatus: 'available',
      approvalStatus: 'approved',
    });

    // Unapproved Tech: pending approval
    unapprovedTechUser = await User.create({
      name: 'Unapproved Tech',
      email: `unapproved_${Date.now()}@test.local`,
      phone: '+91-9000000203',
      passwordHash: 'ValidPass123!',
      role: 'technician',
      isActive: true,
    });
    unapprovedTechToken = signAuthToken(unapprovedTechUser);

    unapprovedTechProfile = await TechnicianProfile.create({
      userId: unapprovedTechUser._id,
      serviceCategories: [categoryAC._id],
      baseLocation: toGeoJSONPoint(22.528, 88.365),
      serviceRadiusKm: 8,
      availabilityStatus: 'offline',
      approvalStatus: 'pending',
    });
  });

  after(async () => {
    await disconnectDB();
    if (replSet) {
      await replSet.stop();
    }
  });

  describe('1. Technician Availability Management', () => {
    it('allows approved technician to toggle between available, busy, unavailable, and offline', async () => {
      // Available -> busy
      const resBusy = await requestApp('PATCH', '/api/v1/technicians/me/availability', {
        headers: { authorization: `Bearer ${techAToken}` },
        body: { availabilityStatus: 'busy' },
      });
      assert.equal(resBusy.statusCode, 200);
      assert.equal(resBusy.body.data.availabilityStatus, 'busy');

      // Busy -> unavailable
      const resUnavail = await requestApp('PATCH', '/api/v1/technicians/me/availability', {
        headers: { authorization: `Bearer ${techAToken}` },
        body: { availabilityStatus: 'unavailable' },
      });
      assert.equal(resUnavail.statusCode, 200);
      assert.equal(resUnavail.body.data.availabilityStatus, 'unavailable');

      // Unavailable -> offline
      const resOffline = await requestApp('PATCH', '/api/v1/technicians/me/availability', {
        headers: { authorization: `Bearer ${techAToken}` },
        body: { availabilityStatus: 'offline' },
      });
      assert.equal(resOffline.statusCode, 200);
      assert.equal(resOffline.body.data.availabilityStatus, 'offline');

      // Offline -> available (valid because Tech A is approved)
      const resAvail = await requestApp('PATCH', '/api/v1/technicians/me/availability', {
        headers: { authorization: `Bearer ${techAToken}` },
        body: { availabilityStatus: 'available' },
      });
      assert.equal(resAvail.statusCode, 200);
      assert.equal(resAvail.body.data.availabilityStatus, 'available');
    });

    it('updates working hours and enforces strict format validation', async () => {
      // Valid working hours
      const res = await requestApp('PATCH', '/api/v1/technicians/me/availability', {
        headers: { authorization: `Bearer ${techAToken}` },
        body: {
          availabilityStatus: 'available',
          workingHours: {
            start: '08:30',
            end: '17:30',
            daysOfWeek: [1, 2, 3, 4, 5],
          },
        },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.data.workingHours.start, '08:30');
      assert.equal(res.body.data.workingHours.end, '17:30');
      assert.deepEqual(res.body.data.workingHours.daysOfWeek, [1, 2, 3, 4, 5]);

      // Invalid working hours: end before start
      const resInvalid = await requestApp('PATCH', '/api/v1/technicians/me/availability', {
        headers: { authorization: `Bearer ${techAToken}` },
        body: {
          availabilityStatus: 'available',
          workingHours: {
            start: '18:00',
            end: '09:00',
          },
        },
      });
      assert.equal(resInvalid.statusCode, 400);
      assert.equal(resInvalid.body.error.code, 'VALIDATION_ERROR');
    });

    it('prevents unapproved technician from becoming available', async () => {
      const res = await requestApp('PATCH', '/api/v1/technicians/me/availability', {
        headers: { authorization: `Bearer ${unapprovedTechToken}` },
        body: { availabilityStatus: 'available' },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error.code, 'TECH_NOT_APPROVED');
    });

    it('allows Admin oversight to update technician availability directly', async () => {
      const res = await requestApp('PATCH', `/api/v1/technicians/${techAProfile._id}/availability`, {
        headers: { authorization: `Bearer ${adminToken}` },
        body: { availabilityStatus: 'available' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.data.availabilityStatus, 'available');
    });
  });

  describe('2. Pool Assignment & Eligibility Verification', () => {
    let poolLocked;
    let booking1, booking2;

    before(async () => {
      // Create bookings
      const start = new Date(Date.now() + 3600000);
      const end = new Date(Date.now() + 7200000);

      booking1 = await Booking.create({
        customerId: customer1User._id,
        serviceCategoryId: categoryAC._id,
        zoneId: zoneBallygunge._id,
        location: toGeoJSONPoint(22.525, 88.362),
        addressText: '10 Ballygunge Circular Rd, Kolkata',
        timeWindow: { start, end },
        bookingMode: 'pool',
        status: 'confirmed',
        estimatedPrice: 540,
        notes: 'Ring bell on 2nd floor',
      });

      booking2 = await Booking.create({
        customerId: customer2User._id,
        serviceCategoryId: categoryAC._id,
        zoneId: zoneBallygunge._id,
        location: toGeoJSONPoint(22.531, 88.368),
        addressText: '25 Ballygunge Park, Kolkata',
        timeWindow: { start, end },
        bookingMode: 'pool',
        status: 'confirmed',
        estimatedPrice: 540,
        notes: 'Call before arriving',
      });

      // Create locked pool
      poolLocked = await ServicePool.create({
        serviceCategoryId: categoryAC._id,
        zoneId: zoneBallygunge._id,
        status: 'locked',
        maxCapacity: 4,
        poolRadiusKm: 3.0,
        centroidLocation: toGeoJSONPoint(22.528, 88.365),
        aggregateTimeWindow: { start, end },
        lockCutoffTime: new Date(Date.now() - 60000), // past cutoff
        members: [
          {
            bookingId: booking1._id,
            customerId: customer1User._id,
            location: booking1.location,
            addressText: booking1.addressText,
            status: 'active',
          },
          {
            bookingId: booking2._id,
            customerId: customer2User._id,
            location: booking2.location,
            addressText: booking2.addressText,
            status: 'active',
          },
        ],
        pricing: {
          discountPercentage: 10,
          finalPricePerMember: 540,
          poolTotal: 1080,
        },
      });

      booking1.poolId = poolLocked._id;
      await booking1.save();
      booking2.poolId = poolLocked._id;
      await booking2.save();
    });

    it('lists eligible technicians with proximity metrics for Admin evaluation', async () => {
      const res = await requestApp('GET', `/api/v1/pools/${poolLocked._id}/eligible-technicians`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.ok(res.body.data.eligibleCount >= 1);
      const candidates = res.body.data.candidates;

      // Tech A has matching category (AC) and is approved & available
      const techACandidate = candidates.find((c) => String(c.technicianId) === String(techAUser._id));
      assert.ok(techACandidate);
      assert.equal(techACandidate.isEligible, true);
      assert.ok(techACandidate.distanceKm >= 0);

      // Tech B lacks AC category skill (has plumbing only)
      const techBCandidate = candidates.find((c) => String(c.technicianId) === String(techBUser._id));
      assert.ok(techBCandidate);
      assert.equal(techBCandidate.isEligible, false);
      assert.ok(techBCandidate.ineligibilityReasons.some((r) => r.includes('service category skill')));
    });

    it('rejects assigning pool to an ineligible technician (incompatible category skill)', async () => {
      const res = await requestApp('POST', `/api/v1/pools/${poolLocked._id}/assign`, {
        headers: { authorization: `Bearer ${adminToken}` },
        body: { technicianId: techBUser._id }, // Tech B has plumbing, not AC
      });

      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'TECHNICIAN_NOT_ELIGIBLE');
    });

    it('rejects assigning pool to an unapproved technician', async () => {
      const res = await requestApp('POST', `/api/v1/pools/${poolLocked._id}/assign`, {
        headers: { authorization: `Bearer ${adminToken}` },
        body: { technicianId: unapprovedTechUser._id },
      });

      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'TECHNICIAN_NOT_ELIGIBLE');
    });

    it('successfully assigns locked pool to eligible Technician A with atomic transaction synchronization', async () => {
      const res = await requestApp('POST', `/api/v1/pools/${poolLocked._id}/assign`, {
        headers: { authorization: `Bearer ${adminToken}` },
        body: { technicianId: techAUser._id },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.data.status, 'assigned');
      assert.equal(String(res.body.data.assignedTechnicianId), String(techAUser._id));
      assert.ok(res.body.data.assignedAt);

      // Verify ServicePool in DB
      const freshPool = await ServicePool.findById(poolLocked._id);
      assert.equal(freshPool.status, 'assigned');
      assert.equal(String(freshPool.assignedTechnicianId), String(techAUser._id));

      // Verify member Bookings in DB are synchronized to assigned
      const freshBooking1 = await Booking.findById(booking1._id);
      assert.equal(freshBooking1.status, 'assigned');
      assert.equal(String(freshBooking1.technicianId), String(techAUser._id));

      const freshBooking2 = await Booking.findById(booking2._id);
      assert.equal(freshBooking2.status, 'assigned');
      assert.equal(String(freshBooking2.technicianId), String(techAUser._id));

      // Verify notifications generated
      const techNotif = await Notification.findOne({
        userId: techAUser._id,
        type: 'dispatch',
        relatedEntityId: poolLocked._id,
      });
      assert.ok(techNotif, 'Technician notification must be created');
      assert.equal(techNotif.title, 'New Pooled Job Assigned');
    });

    it('prevents duplicate assignment of an already assigned pool', async () => {
      const res = await requestApp('POST', `/api/v1/pools/${poolLocked._id}/assign`, {
        headers: { authorization: `Bearer ${adminToken}` },
        body: { technicianId: techAUser._id },
      });

      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'INVALID_POOL_STATUS');
    });

    it('detects scheduling conflicts and prevents assigning overlapping jobs to the same technician', async () => {
      // Create another locked pool with overlapping aggregateTimeWindow
      const conflictPool = await ServicePool.create({
        serviceCategoryId: categoryAC._id,
        zoneId: zoneBallygunge._id,
        status: 'locked',
        maxCapacity: 4,
        poolRadiusKm: 3.0,
        centroidLocation: toGeoJSONPoint(22.528, 88.365),
        aggregateTimeWindow: poolLocked.aggregateTimeWindow, // Exact same overlapping window!
        lockCutoffTime: new Date(Date.now() - 60000),
        members: [],
      });

      const res = await requestApp('POST', `/api/v1/pools/${conflictPool._id}/assign`, {
        headers: { authorization: `Bearer ${adminToken}` },
        body: { technicianId: techAUser._id },
      });

      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'TECHNICIAN_NOT_ELIGIBLE');
      assert.ok(res.body.error.message.includes('Scheduling conflict'));
    });

    it('handles concurrent assignment race condition safely: exactly 1 wins, duplicate prevented', async () => {
      // Create a fresh locked pool
      const racePool = await ServicePool.create({
        serviceCategoryId: categoryAC._id,
        zoneId: zoneBallygunge._id,
        status: 'locked',
        maxCapacity: 4,
        poolRadiusKm: 3.0,
        centroidLocation: toGeoJSONPoint(22.528, 88.365),
        aggregateTimeWindow: {
          start: new Date(Date.now() + 86400000), // Tomorrow
          end: new Date(Date.now() + 90000000),
        },
        lockCutoffTime: new Date(Date.now() - 60000),
        members: [],
      });

      // Fire 5 concurrent assignment requests simultaneously
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          assignPoolToTechnician(racePool._id, techAUser._id)
        )
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      assert.equal(fulfilled.length, 1, 'Exactly one concurrent assignment request must succeed');
      assert.equal(rejected.length, 4, 'All competing concurrent requests must be rejected');

      // Verify exactly one technician is recorded in DB
      const finalPool = await ServicePool.findById(racePool._id);
      assert.equal(finalPool.status, 'assigned');
      assert.equal(String(finalPool.assignedTechnicianId), String(techAUser._id));
    });
  });

  describe('3. Technician Job Management, Lifecycle & Privacy Protection', () => {
    let pool;
    let b1, b2;

    before(async () => {
      const start = new Date(Date.now() + 10000000);
      const end = new Date(Date.now() + 14000000);

      b1 = await Booking.create({
        customerId: customer1User._id,
        serviceCategoryId: categoryAC._id,
        zoneId: zoneBallygunge._id,
        location: toGeoJSONPoint(22.527, 88.364),
        addressText: 'Flat 3B, Ballygunge Circular Rd, Kolkata',
        timeWindow: { start, end },
        bookingMode: 'pool',
        status: 'assigned',
        technicianId: techAUser._id,
        estimatedPrice: 540,
        notes: 'Doorbell is muted, please call on arrival',
      });

      b2 = await Booking.create({
        customerId: customer2User._id,
        serviceCategoryId: categoryAC._id,
        zoneId: zoneBallygunge._id,
        location: toGeoJSONPoint(22.535, 88.372),
        addressText: 'Ground Floor, 25 Ballygunge Park, Kolkata',
        timeWindow: { start, end },
        bookingMode: 'pool',
        status: 'assigned',
        technicianId: techAUser._id,
        estimatedPrice: 540,
      });

      pool = await ServicePool.create({
        serviceCategoryId: categoryAC._id,
        zoneId: zoneBallygunge._id,
        status: 'assigned',
        assignedTechnicianId: techAUser._id,
        assignedAt: new Date(),
        maxCapacity: 4,
        poolRadiusKm: 3.0,
        centroidLocation: toGeoJSONPoint(22.528, 88.365),
        aggregateTimeWindow: { start, end },
        lockCutoffTime: new Date(Date.now() - 60000),
        members: [
          {
            bookingId: b1._id,
            customerId: customer1User._id,
            location: b1.location,
            addressText: b1.addressText,
            status: 'active',
          },
          {
            bookingId: b2._id,
            customerId: customer2User._id,
            location: b2.location,
            addressText: b2.addressText,
            status: 'active',
          },
        ],
        routeOrder: [
          { bookingId: b1._id, sequenceIndex: 1 },
          { bookingId: b2._id, sequenceIndex: 2 },
        ],
        pricing: {
          discountPercentage: 10,
          finalPricePerMember: 540,
          poolTotal: 1080,
        },
      });

      b1.poolId = pool._id;
      b1.stopSequence = 1;
      await b1.save();
      b2.poolId = pool._id;
      b2.stopSequence = 2;
      await b2.save();
    });

    it('allows assigned technician to view their jobs with UNMASKED customer details for field execution', async () => {
      // Tech A views list
      const resList = await requestApp('GET', '/api/v1/technicians/me/jobs', {
        headers: { authorization: `Bearer ${techAToken}` },
      });
      assert.equal(resList.statusCode, 200);
      assert.ok(resList.body.data.some((j) => String(j._id) === String(pool._id)));

      // Tech A views single pool details
      const resDetail = await requestApp('GET', `/api/v1/technicians/me/jobs/${pool._id}`, {
        headers: { authorization: `Bearer ${techAToken}` },
      });
      assert.equal(resDetail.statusCode, 200);
      assert.equal(resDetail.body.data.jobType, 'pool');
      assert.equal(resDetail.body.data.memberCount, 2);

      // Verify unmasked customer name and phone
      const member1 = resDetail.body.data.members.find((m) => String(m.bookingId) === String(b1._id));
      assert.ok(member1);
      assert.equal(member1.customer.name, 'Customer 1');
      assert.equal(member1.customer.phone, '+91-9000000101');
      assert.equal(member1.addressText, 'Flat 3B, Ballygunge Circular Rd, Kolkata');
      assert.equal(member1.notes, 'Doorbell is muted, please call on arrival');
    });

    it('strictly prevents Technician B from accessing Technician A private jobs with 403', async () => {
      const res = await requestApp('GET', `/api/v1/technicians/me/jobs/${pool._id}`, {
        headers: { authorization: `Bearer ${techBToken}` },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN_JOB_ACCESS');
    });

    it('strictly prevents Technician B from modifying Technician A job status with 403', async () => {
      const res = await requestApp('PATCH', `/api/v1/technicians/me/jobs/${pool._id}/status`, {
        headers: { authorization: `Bearer ${techBToken}` },
        body: { status: 'in_progress' },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN_JOB_ACCESS');
    });

    it('rejects legacy status completion on pool with 409 POOL_STOP_PROGRESSION_REQUIRED', async () => {
      // First accept
      await requestApp('POST', `/api/v1/technicians/me/jobs/${pool._id}/accept`, {
        headers: { authorization: `Bearer ${techAToken}` },
      });

      // Try marking completed directly from accepted via legacy endpoint
      const res = await requestApp('PATCH', `/api/v1/technicians/me/jobs/${pool._id}/status`, {
        headers: { authorization: `Bearer ${techAToken}` },
        body: { status: 'completed' },
      });

      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'POOL_STOP_PROGRESSION_REQUIRED');
    });

    it('executes valid lifecycle transitions: accepted -> in_progress -> completed via canonical stop progression', async () => {
      // 1. Verifies that legacy bulk PATCH status on pooled job is strictly rejected with 409 POOL_STOP_PROGRESSION_REQUIRED
      const resProgressLegacy = await requestApp('PATCH', `/api/v1/technicians/me/jobs/${pool._id}/status`, {
        headers: { authorization: `Bearer ${techAToken}` },
        body: { status: 'in_progress' },
      });
      assert.equal(resProgressLegacy.statusCode, 409);
      assert.equal(resProgressLegacy.body.error.code, 'POOL_STOP_PROGRESSION_REQUIRED');

      // 2. Progress Stop 1: arrive -> start -> complete
      const resArrive1 = await requestApp('POST', `/api/v1/technicians/me/jobs/${pool._id}/stops/${b1._id}/arrive`, {
        headers: { authorization: `Bearer ${techAToken}` },
      });
      assert.equal(resArrive1.statusCode, 200);

      const resStart1 = await requestApp('POST', `/api/v1/technicians/me/jobs/${pool._id}/stops/${b1._id}/start`, {
        headers: { authorization: `Bearer ${techAToken}` },
      });
      assert.equal(resStart1.statusCode, 200);

      // Verify technician has active workload once service starts
      const techProfileAfterStart = await TechnicianProfile.findOne({ userId: techAUser._id });
      assert.ok(techProfileAfterStart.activeWorkload >= 1);

      const resComp1 = await requestApp('POST', `/api/v1/technicians/me/jobs/${pool._id}/stops/${b1._id}/complete`, {
        headers: { authorization: `Bearer ${techAToken}` },
      });
      assert.equal(resComp1.statusCode, 200);

      // 3. Progress Stop 2: arrive -> start -> complete (terminal completion)
      await requestApp('POST', `/api/v1/technicians/me/jobs/${pool._id}/stops/${b2._id}/arrive`, {
        headers: { authorization: `Bearer ${techAToken}` },
      });
      await requestApp('POST', `/api/v1/technicians/me/jobs/${pool._id}/stops/${b2._id}/start`, {
        headers: { authorization: `Bearer ${techAToken}` },
      });
      const resComp2 = await requestApp('POST', `/api/v1/technicians/me/jobs/${pool._id}/stops/${b2._id}/complete`, {
        headers: { authorization: `Bearer ${techAToken}` },
      });
      assert.equal(resComp2.statusCode, 200);

      // Verify parent pool and member bookings are completed
      const poolAfterDone = await ServicePool.findById(pool._id);
      assert.equal(poolAfterDone.status, 'completed');
      assert.ok(poolAfterDone.completedAt);

      const fb1 = await Booking.findById(b1._id);
      assert.equal(fb1.status, 'completed');
      assert.ok(fb1.completedAt);

      const fb2 = await Booking.findById(b2._id);
      assert.equal(fb2.status, 'completed');
      assert.ok(fb2.completedAt);

      // Verify technician's jobsCompleted incremented
      const techProfileAfterDone = await TechnicianProfile.findOne({ userId: techAUser._id });
      assert.ok(techProfileAfterDone.jobsCompleted >= 1);
    });

    it('handles job rejection properly: reverts pool to locked for reassignment', async () => {
      // Create a new assigned pool
      const start = new Date(Date.now() + 20000000);
      const end = new Date(Date.now() + 24000000);

      const rejBooking = await Booking.create({
        customerId: customer1User._id,
        serviceCategoryId: categoryAC._id,
        zoneId: zoneBallygunge._id,
        location: toGeoJSONPoint(22.525, 88.362),
        addressText: 'Ballygunge',
        timeWindow: { start, end },
        bookingMode: 'pool',
        status: 'assigned',
        technicianId: techAUser._id,
        estimatedPrice: 540,
      });

      const rejPool = await ServicePool.create({
        serviceCategoryId: categoryAC._id,
        zoneId: zoneBallygunge._id,
        status: 'assigned',
        assignedTechnicianId: techAUser._id,
        assignedAt: new Date(),
        maxCapacity: 4,
        poolRadiusKm: 3.0,
        centroidLocation: toGeoJSONPoint(22.528, 88.365),
        aggregateTimeWindow: { start, end },
        lockCutoffTime: new Date(Date.now() - 60000),
        members: [
          {
            bookingId: rejBooking._id,
            customerId: customer1User._id,
            location: rejBooking.location,
            addressText: rejBooking.addressText,
            status: 'active',
          },
        ],
      });

      const resReject = await requestApp('POST', `/api/v1/technicians/me/jobs/${rejPool._id}/reject`, {
        headers: { authorization: `Bearer ${techAToken}` },
        body: { reason: 'Bike breakdown on highway' },
      });

      assert.equal(resReject.statusCode, 200);
      assert.equal(resReject.body.data.status, 'locked');
      assert.equal(resReject.body.data.assignedTechnicianId, null);
      assert.equal(resReject.body.data.rejectionReason, 'Bike breakdown on highway');

      // Verify pool in DB is locked and unassigned
      const poolInDb = await ServicePool.findById(rejPool._id);
      assert.equal(poolInDb.status, 'locked');
      assert.equal(poolInDb.assignedTechnicianId, null);

      // Verify booking reverted to confirmed
      const bookingInDb = await Booking.findById(rejBooking._id);
      assert.equal(bookingInDb.status, 'confirmed');
      assert.equal(bookingInDb.technicianId, null);
    });

    it('handles job cancellation properly during execution and restores availability', async () => {
      const start = new Date(Date.now() + 25000000);
      const end = new Date(Date.now() + 29000000);

      const cancelBooking = await Booking.create({
        customerId: customer1User._id,
        serviceCategoryId: categoryAC._id,
        zoneId: zoneBallygunge._id,
        location: toGeoJSONPoint(22.525, 88.362),
        addressText: 'Ballygunge Circular Rd',
        timeWindow: { start, end },
        bookingMode: 'pool',
        status: 'assigned',
        technicianId: techAUser._id,
        estimatedPrice: 540,
      });

      const cancelPool = await ServicePool.create({
        serviceCategoryId: categoryAC._id,
        zoneId: zoneBallygunge._id,
        status: 'assigned',
        assignedTechnicianId: techAUser._id,
        assignedAt: new Date(),
        maxCapacity: 4,
        poolRadiusKm: 3.0,
        centroidLocation: toGeoJSONPoint(22.528, 88.365),
        aggregateTimeWindow: { start, end },
        lockCutoffTime: new Date(Date.now() - 60000),
        members: [
          {
            bookingId: cancelBooking._id,
            customerId: customer1User._id,
            location: cancelBooking.location,
            addressText: cancelBooking.addressText,
            status: 'active',
          },
        ],
      });

      // 1. Accept job
      await requestApp('POST', `/api/v1/technicians/me/jobs/${cancelPool._id}/accept`, {
        headers: { authorization: `Bearer ${techAToken}` },
      });

      // 2. Cancel job due to field emergency
      const resCancel = await requestApp('PATCH', `/api/v1/technicians/me/jobs/${cancelPool._id}/status`, {
        headers: { authorization: `Bearer ${techAToken}` },
        body: { status: 'cancelled', reason: 'Field equipment malfunction' },
      });

      assert.equal(resCancel.statusCode, 200);
      assert.equal(resCancel.body.data.status, 'cancelled');
      assert.ok(resCancel.body.data.cancelledAt);
      assert.equal(resCancel.body.data.rejectionReason, 'Field equipment malfunction');

      // 4. Verify pool and booking state in DB
      const poolInDb = await ServicePool.findById(cancelPool._id);
      assert.equal(poolInDb.status, 'cancelled');

      const bookingInDb = await Booking.findById(cancelBooking._id);
      assert.equal(bookingInDb.status, 'cancelled');
      assert.ok(bookingInDb.cancelledAt);
      assert.equal(bookingInDb.rejectionReason, 'Field equipment malfunction');

      // 5. Verify technician availability restored to 'available'
      const techAfterCancel = await TechnicianProfile.findOne({ userId: techAUser._id });
      assert.equal(techAfterCancel.availabilityStatus, 'available');

      // 6. Verify cannot transition from cancelled back to in_progress or completed
      const resInvalid = await requestApp('PATCH', `/api/v1/technicians/me/jobs/${cancelPool._id}/status`, {
        headers: { authorization: `Bearer ${techAToken}` },
        body: { status: 'completed' },
      });
      assert.equal(resInvalid.statusCode, 409);
      assert.equal(resInvalid.body.error.code, 'POOL_STOP_PROGRESSION_REQUIRED');
    });
  });

  describe('4. Optimized Route API Endpoint Verification', () => {
    let routePool;
    let bA, bB;

    before(async () => {
      const start = new Date(Date.now() + 30000000);
      const end = new Date(Date.now() + 35000000);

      bA = await Booking.create({
        customerId: customer1User._id,
        serviceCategoryId: categoryAC._id,
        zoneId: zoneBallygunge._id,
        location: toGeoJSONPoint(22.525, 88.362), // Ballygunge Circular Rd (~0.4 km)
        addressText: 'Ballygunge Circular Rd',
        timeWindow: { start, end },
        bookingMode: 'pool',
        status: 'assigned',
        technicianId: techAUser._id,
        estimatedPrice: 540,
      });

      bB = await Booking.create({
        customerId: customer2User._id,
        serviceCategoryId: categoryAC._id,
        zoneId: zoneBallygunge._id,
        location: toGeoJSONPoint(22.498, 88.368), // Jadavpur (~3.3 km)
        addressText: 'Jadavpur Central',
        timeWindow: { start, end },
        bookingMode: 'pool',
        status: 'assigned',
        technicianId: techAUser._id,
        estimatedPrice: 540,
      });

      routePool = await ServicePool.create({
        serviceCategoryId: categoryAC._id,
        zoneId: zoneBallygunge._id,
        status: 'assigned',
        assignedTechnicianId: techAUser._id,
        assignedAt: new Date(),
        maxCapacity: 4,
        poolRadiusKm: 3.0,
        centroidLocation: toGeoJSONPoint(22.528, 88.365),
        aggregateTimeWindow: { start, end },
        lockCutoffTime: new Date(Date.now() - 60000),
        members: [
          {
            bookingId: bB._id, // Notice bB is listed first in members array!
            customerId: customer2User._id,
            location: bB.location,
            addressText: bB.addressText,
            status: 'active',
          },
          {
            bookingId: bA._id, // bA is closer to technician base
            customerId: customer1User._id,
            location: bA.location,
            addressText: bA.addressText,
            status: 'active',
          },
        ],
      });
    });

    it('retrieves road-optimized route with correct stop ordering, units and timestamps', async () => {
      const res = await requestApp('GET', `/api/v1/technicians/me/jobs/${routePool._id}/route`, {
        headers: { authorization: `Bearer ${techAToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      const route = res.body.data;

      assert.equal(route.optimizationStatus, 'optimal_road_network');
      assert.equal(route.roadDistanceCalculated, true);
      assert.equal(route.stops.length, 2);

      // Stop 1 must be Ballygunge Circular Rd (bA) because it is closer to tech base location
      assert.equal(route.stops[0].addressText, 'Ballygunge Circular Rd');
      assert.equal(route.stops[0].sequenceIndex, 1);
      assert.ok(route.stops[0].estimatedArrival);
      assert.ok(route.stops[0].estimatedServiceStart);
      assert.ok(route.stops[0].estimatedServiceEnd);

      // Units verified
      assert.equal(route.totalTravelDistance.unit, 'km');
      assert.equal(route.totalTravelTime.unit, 'minutes');
      assert.equal(route.totalServiceDuration.unit, 'minutes');
      assert.equal(route.totalTripDuration.unit, 'minutes');

      assert.equal((await ServicePool.findById(routePool._id)).routeOrder.length, 0);
      assert.ok(!(await Booking.findById(bA._id)).stopSequence);
      await ServicePool.updateOne({ _id: routePool._id }, { status: 'accepted' });
      const replanned = await requestApp('POST', `/api/v1/technicians/me/jobs/${routePool._id}/replan`, {
        headers: { authorization: `Bearer ${techAToken}` }, body: {},
      });
      assert.equal(replanned.statusCode, 200);
      assert.equal((await ServicePool.findById(routePool._id)).routeOrder.length, 2);
      assert.equal((await Booking.findById(bA._id)).stopSequence, 1);

    });

    it('rejects Technician B attempting to get route for Technician A pool with 403', async () => {
      const res = await requestApp('GET', `/api/v1/technicians/me/jobs/${routePool._id}/route`, {
        headers: { authorization: `Bearer ${techBToken}` },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN_JOB_ACCESS');
    });
  });
});
