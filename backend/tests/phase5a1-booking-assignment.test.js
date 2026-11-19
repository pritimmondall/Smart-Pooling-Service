import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
  Booking,
} from '../src/models/index.js';
import { toGeoJSONPoint } from '../src/utils/geo.js';
import { signAuthToken } from '../src/middleware/auth.js';
import { assignBookingToTechnician } from '../src/modules/pools/poolAssignment.service.js';

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

describe('Phase 5A.1 Individual Booking Assignment & Lifecycle Suite', () => {
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
      name: 'System Admin',
      email: `admin_booking_${Date.now()}@test.local`,
      phone: '+91-9830009999',
      passwordHash: 'AdminPass123!',
      role: 'admin',
      isActive: true,
    });
    adminToken = signAuthToken(adminUser);

    // 2. Customer
    customerUser = await User.create({
      name: 'Suman Ghosh',
      email: `customer_b_${Date.now()}@test.local`,
      phone: '+91-9830008888',
      passwordHash: 'CustomerPass123!',
      role: 'customer',
      isActive: true,
    });
    customerToken = signAuthToken(customerUser);

    // 3. Category
    category = await ServiceCategory.create({
      name: 'Plumbing Emergency',
      slug: `plumbing_ind_${Date.now()}`,
      description: 'Emergency plumbing repairs',
      baseIndividualPrice: 400,
      estimatedDurationMins: 30,
      defaultPoolRadiusKm: 3.0,
      maxPoolSize: 4,
      poolLockCutoffMins: 60,
    });

    // 4. Zone
    zone = await ServiceZone.create({
      name: 'Central Kolkata',
      code: `CKOL_${Date.now()}`,
      city: 'Kolkata',
      boundary: {
        type: 'Polygon',
        coordinates: [
          [
            [88.30, 22.50],
            [88.40, 22.50],
            [88.40, 22.60],
            [88.30, 22.60],
            [88.30, 22.50],
          ],
        ],
      },
      centerLocation: toGeoJSONPoint(22.55, 88.35),
      isActive: true,
    });

    // 5. Technician
    techUser = await User.create({
      name: 'Amitabh Sen',
      email: `tech_ind_${Date.now()}@test.local`,
      phone: '+91-9830007777',
      passwordHash: 'TechPass123!',
      role: 'technician',
      isActive: true,
    });
    techToken = signAuthToken(techUser);

    techProfile = await TechnicianProfile.create({
      userId: techUser._id,
      serviceCategories: [category._id],
      zoneId: zone._id,
      baseLocation: toGeoJSONPoint(22.55, 88.35),
      addressText: 'Park Street, Kolkata',
      serviceRadiusKm: 10,
      maxPoolCapacity: 3,
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

  it('allows Admin to retrieve eligible technicians for an individual booking', async () => {
    const booking = await Booking.create({
      customerId: customerUser._id,
      serviceCategoryId: category._id,
      zoneId: zone._id,
      location: toGeoJSONPoint(22.552, 88.352),
      addressText: 'Park Street, Flat 2A, Kolkata',
      timeWindow: {
        start: new Date(Date.now() + 86400000),
        end: new Date(Date.now() + 86400000 + 3 * 3600000),
      },
      bookingMode: 'individual',
      status: 'confirmed',
      estimatedPrice: 400,
    });

    // 1. Non-admin blocked
    const resBlocked = await requestApp('GET', `/api/v1/bookings/${booking._id}/eligible-technicians`, {
      headers: { authorization: `Bearer ${customerToken}` },
    });
    assert.equal(resBlocked.statusCode, 403);

    // 2. Admin retrieves eligible technicians
    const res = await requestApp('GET', `/api/v1/bookings/${booking._id}/eligible-technicians`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.data.eligibleTechnicians));
    assert.ok(res.body.data.eligibleTechnicians.length > 0);

    const match = res.body.data.eligibleTechnicians.find((t) => String(t.technicianId) === String(techUser._id));
    assert.ok(match, 'Configured technician must be found');
    assert.equal(match.isEligible, true);
    assert.ok(match.distanceKm >= 0);
  });

  it('allows Admin to assign an individual booking to an eligible technician with status synchronization', async () => {
    const booking = await Booking.create({
      customerId: customerUser._id,
      serviceCategoryId: category._id,
      zoneId: zone._id,
      location: toGeoJSONPoint(22.552, 88.352),
      addressText: 'Park Street, Flat 2A, Kolkata',
      timeWindow: {
        start: new Date(Date.now() + 100000000),
        end: new Date(Date.now() + 100000000 + 3 * 3600000),
      },
      bookingMode: 'individual',
      status: 'confirmed',
      estimatedPrice: 400,
    });

    // 1. Non-admin blocked
    const resBlocked = await requestApp('POST', `/api/v1/bookings/${booking._id}/assign`, {
      headers: { authorization: `Bearer ${customerToken}` },
      body: { technicianId: techUser._id },
    });
    assert.equal(resBlocked.statusCode, 403);

    // 2. Admin assigns booking
    const resAssign = await requestApp('POST', `/api/v1/bookings/${booking._id}/assign`, {
      headers: { authorization: `Bearer ${adminToken}` },
      body: { technicianId: techUser._id },
    });
    assert.equal(resAssign.statusCode, 200);
    assert.equal(resAssign.body.success, true);
    assert.equal(resAssign.body.data.status, 'assigned');
    assert.equal(String(resAssign.body.data.technicianId), String(techUser._id));

    // Verify booking in DB
    const dbBooking = await Booking.findById(booking._id);
    assert.equal(dbBooking.status, 'assigned');
    assert.equal(String(dbBooking.technicianId), String(techUser._id));
    assert.ok(dbBooking.assignedAt);

    // Verify technician workload increased
    const profile = await TechnicianProfile.findOne({ userId: techUser._id });
    assert.ok(profile.activeWorkload >= 1);
  });

  it('supports the complete technician lifecycle for an individual booking: view -> accept -> in_progress -> completed', async () => {
    const booking = await Booking.create({
      customerId: customerUser._id,
      serviceCategoryId: category._id,
      zoneId: zone._id,
      location: toGeoJSONPoint(22.552, 88.352),
      addressText: 'Park Street, Flat 2A, Kolkata',
      timeWindow: {
        start: new Date(Date.now() + 200000000),
        end: new Date(Date.now() + 200000000 + 3 * 3600000),
      },
      bookingMode: 'individual',
      status: 'assigned',
      technicianId: techUser._id,
      assignedAt: new Date(),
      estimatedPrice: 400,
      notes: 'Please ring the bell twice',
    });

    // 1. Technician views their assigned jobs
    const resList = await requestApp('GET', '/api/v1/technicians/me/jobs', {
      headers: { authorization: `Bearer ${techToken}` },
    });
    assert.equal(resList.statusCode, 200);
    const jobs = Array.isArray(resList.body.data) ? resList.body.data : (resList.body.data.jobs || []);
    const found = jobs.find((j) => String(j._id) === String(booking._id));
    assert.ok(found, 'Technician must see the assigned individual booking in jobs list');
    assert.equal(found.jobType, 'individual');

    // 2. Technician views specific job details (unmasked customer info)
    const resDetail = await requestApp('GET', `/api/v1/technicians/me/jobs/${booking._id}`, {
      headers: { authorization: `Bearer ${techToken}` },
    });
    assert.equal(resDetail.statusCode, 200);
    assert.equal(resDetail.body.data.customer.phone, '+91-9830008888');
    assert.equal(resDetail.body.data.notes, 'Please ring the bell twice');

    // 3. Technician accepts the assignment
    const resAccept = await requestApp('POST', `/api/v1/technicians/me/jobs/${booking._id}/accept`, {
      headers: { authorization: `Bearer ${techToken}` },
    });
    assert.equal(resAccept.statusCode, 200);
    assert.equal(resAccept.body.data.status, 'accepted');

    const dbAfterAccept = await Booking.findById(booking._id);
    assert.equal(dbAfterAccept.status, 'accepted');
    assert.ok(dbAfterAccept.acceptedAt);

    // 4. Technician starts the job (in_progress)
    const resStart = await requestApp('PATCH', `/api/v1/technicians/me/jobs/${booking._id}/status`, {
      headers: { authorization: `Bearer ${techToken}` },
      body: { status: 'in_progress' },
    });
    assert.equal(resStart.statusCode, 200);
    assert.equal(resStart.body.data.status, 'in_progress');

    // Technician must become busy
    const profileDuringJob = await TechnicianProfile.findOne({ userId: techUser._id });
    assert.equal(profileDuringJob.availabilityStatus, 'busy');

    // 5. Technician completes the job
    const resComplete = await requestApp('PATCH', `/api/v1/technicians/me/jobs/${booking._id}/status`, {
      headers: { authorization: `Bearer ${techToken}` },
      body: { status: 'completed' },
    });
    assert.equal(resComplete.statusCode, 200);
    assert.equal(resComplete.body.data.status, 'completed');

    // Customer booking status must be completed
    const dbAfterComplete = await Booking.findById(booking._id);
    assert.equal(dbAfterComplete.status, 'completed');
    assert.ok(dbAfterComplete.completedAt);

    // Technician jobsCompleted incremented
    const profileAfterComplete = await TechnicianProfile.findOne({ userId: techUser._id });
    assert.ok(profileAfterComplete.jobsCompleted >= 1);
  });

  it('handles technician rejection of an individual booking cleanly', async () => {
    const booking = await Booking.create({
      customerId: customerUser._id,
      serviceCategoryId: category._id,
      zoneId: zone._id,
      location: toGeoJSONPoint(22.552, 88.352),
      addressText: 'Park Street, Flat 2A, Kolkata',
      timeWindow: {
        start: new Date(Date.now() + 300000000),
        end: new Date(Date.now() + 300000000 + 3 * 3600000),
      },
      bookingMode: 'individual',
      status: 'assigned',
      technicianId: techUser._id,
      assignedAt: new Date(),
      estimatedPrice: 400,
    });

    const resReject = await requestApp('POST', `/api/v1/technicians/me/jobs/${booking._id}/reject`, {
      headers: { authorization: `Bearer ${techToken}` },
      body: { reason: 'Bike breakdown on route' },
    });
    assert.equal(resReject.statusCode, 200);
    assert.equal(resReject.body.data.status, 'confirmed');

    // Booking must revert to confirmed with technicianId = null
    const dbBooking = await Booking.findById(booking._id);
    assert.equal(dbBooking.status, 'confirmed');
    assert.equal(dbBooking.technicianId, null);
    assert.equal(dbBooking.rejectionReason, 'Bike breakdown on route');
  });

  it('prevents concurrent duplicate assignment of the same individual booking', async () => {
    const raceBooking = await Booking.create({
      customerId: customerUser._id,
      serviceCategoryId: category._id,
      zoneId: zone._id,
      location: toGeoJSONPoint(22.552, 88.352),
      addressText: 'Park Street, Flat 2A, Kolkata',
      timeWindow: {
        start: new Date(Date.now() + 400000000),
        end: new Date(Date.now() + 400000000 + 3 * 3600000),
      },
      bookingMode: 'individual',
      status: 'confirmed',
      estimatedPrice: 400,
    });

    // Fire 5 concurrent requests assigning this booking to the technician
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        assignBookingToTechnician(raceBooking._id, techUser._id)
      )
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'Exactly one concurrent booking assignment must succeed');
    assert.equal(rejected.length, 4, 'Remaining 4 competing requests must fail');

    const finalBooking = await Booking.findById(raceBooking._id);
    assert.equal(finalBooking.status, 'assigned');
    assert.equal(String(finalBooking.technicianId), String(techUser._id));
  });
});
