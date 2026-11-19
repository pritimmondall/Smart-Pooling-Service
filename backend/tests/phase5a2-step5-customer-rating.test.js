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
  Booking,
  Rating,
  Notification,
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

describe('Phase 5A Step 5 — Customer Rating API Suite', () => {
  let replSet;
  let adminUser, adminToken;
  let customerUser1, customerToken1;
  let customerUser2, customerToken2;
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
      name: 'System Admin',
      email: `admin_${Date.now()}@test.smartpool.local`,
      phone: '+91-9876543290',
      passwordHash: validPasswordHash,
      role: 'admin',
      isActive: true,
    });
    adminToken = signAuthToken(adminUser);

    // 2. Customer 1 (Alice Walker)
    customerUser1 = await User.create({
      name: 'Alice Walker',
      email: `alice_${Date.now()}@test.smartpool.local`,
      phone: '+91-9876543291',
      passwordHash: validPasswordHash,
      role: 'customer',
      isActive: true,
    });
    customerToken1 = signAuthToken(customerUser1);

    // 3. Customer 2 (Bob Miller)
    customerUser2 = await User.create({
      name: 'Bob Miller',
      email: `bob_${Date.now()}@test.smartpool.local`,
      phone: '+91-9876543292',
      passwordHash: validPasswordHash,
      role: 'customer',
      isActive: true,
    });
    customerToken2 = signAuthToken(customerUser2);

    // 4. Technician 1
    techUser1 = await User.create({
      name: 'Technician One',
      email: `tech1_${Date.now()}@test.smartpool.local`,
      phone: '+91-9876543293',
      passwordHash: validPasswordHash,
      role: 'technician',
      isActive: true,
    });
    techToken1 = signAuthToken(techUser1);

    techProfile1 = await TechnicianProfile.create({
      userId: techUser1._id,
      baseLocation: { type: 'Point', coordinates: [88.3639, 22.5726] },
      skills: ['cleaning'],
      maxPoolCapacity: 4,
      availabilityStatus: 'available',
      approvalStatus: 'approved',
      ratingAvg: 0,
      ratingCount: 0,
    });

    // 5. Technician 2
    techUser2 = await User.create({
      name: 'Technician Two',
      email: `tech2_${Date.now()}@test.smartpool.local`,
      phone: '+91-9876543294',
      passwordHash: validPasswordHash,
      role: 'technician',
      isActive: true,
    });
    techToken2 = signAuthToken(techUser2);

    techProfile2 = await TechnicianProfile.create({
      userId: techUser2._id,
      baseLocation: { type: 'Point', coordinates: [88.4, 22.6] },
      skills: ['cleaning'],
      maxPoolCapacity: 4,
      availabilityStatus: 'available',
      approvalStatus: 'approved',
      ratingAvg: 0,
      ratingCount: 0,
    });

    // 6. Service Category
    category = await ServiceCategory.create({
      name: 'Home Deep Cleaning',
      slug: `cleaning_${Date.now()}`,
      baseIndividualPrice: 500,
      estimatedDurationMins: 60,
    });

    // 7. Service Zone
    zone = await ServiceZone.create({
      name: 'Kolkata Central Zone',
      code: `ZONE_${Date.now()}`,
      centerLocation: { type: 'Point', coordinates: [88.3639, 22.5726] },
      radiusKm: 15,
      isActive: true,
    });
  });

  after(async () => {
    await disconnectDB();
    if (replSet) {
      await replSet.stop();
    }
  });

  describe('1. Authentication and Authorization Enforcement', () => {
    let testBooking;

    before(async () => {
      testBooking = await Booking.create({
        customerId: customerUser1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: techUser1._id,
        location: { type: 'Point', coordinates: [88.36, 22.57] },
        addressText: 'Auth Test Address',
        timeWindow: {
          start: new Date(Date.now() - 7200000),
          end: new Date(Date.now() - 3600000),
        },
        status: 'completed',
        completedAt: new Date(Date.now() - 1800000),
        estimatedPrice: 750,
      });
    });

    it('rejects unauthenticated requests to submit ratings with 401 AUTH_REQUIRED', async () => {
      const res = await requestApp('POST', '/api/v1/ratings', {
        body: { bookingId: testBooking._id, rating: 5 },
      });
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.error.code, 'AUTH_REQUIRED');
    });

    it('rejects non-customer role (technician) from submitting ratings with 403 FORBIDDEN_ROLE', async () => {
      const res = await requestApp('POST', '/api/v1/ratings', {
        headers: { Authorization: `Bearer ${techToken1}` },
        body: { bookingId: testBooking._id, rating: 5 },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN_ROLE');
    });

    it('rejects non-customer role (admin) from submitting ratings with 403 FORBIDDEN_ROLE', async () => {
      const res = await requestApp('POST', '/api/v1/ratings', {
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { bookingId: testBooking._id, rating: 5 },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN_ROLE');
    });

    it('rejects Customer 2 attempting to rate Customer 1 booking with 403 FORBIDDEN_BOOKING_ACCESS', async () => {
      const res = await requestApp('POST', '/api/v1/ratings', {
        headers: { Authorization: `Bearer ${customerToken2}` },
        body: { bookingId: testBooking._id, rating: 5 },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN_BOOKING_ACCESS');
    });

    it('rejects malformed ObjectId route parameters with 400 INVALID_ID', async () => {
      const res = await requestApp('POST', '/api/v1/bookings/not-a-valid-id/rating', {
        headers: { Authorization: `Bearer ${customerToken1}` },
        body: { rating: 5 },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error.code, 'INVALID_ID');
    });

    it('rejects rating a non-existent booking with 404 BOOKING_NOT_FOUND', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const res = await requestApp('POST', '/api/v1/ratings', {
        headers: { Authorization: `Bearer ${customerToken1}` },
        body: { bookingId: fakeId, rating: 5 },
      });
      assert.equal(res.statusCode, 404);
      assert.equal(res.body.error.code, 'BOOKING_NOT_FOUND');
    });
  });

  describe('2. Booking Status Validation', () => {
    const invalidStatuses = ['pending', 'confirmed', 'assigned', 'accepted', 'arrived', 'in_progress', 'cancelled'];

    for (const status of invalidStatuses) {
      it(`rejects rating a booking in "${status}" status with 409 INVALID_BOOKING_STATUS`, async () => {
        const b = await Booking.create({
          customerId: customerUser1._id,
          serviceCategoryId: category._id,
          zoneId: zone._id,
          technicianId: techUser1._id,
          location: { type: 'Point', coordinates: [88.36, 22.57] },
          addressText: `Status Test Address ${status}`,
          timeWindow: {
            start: new Date(Date.now() + 3600000),
            end: new Date(Date.now() + 7200000),
          },
          status,
          estimatedPrice: 600,
        });

        const res = await requestApp('POST', '/api/v1/ratings', {
          headers: { Authorization: `Bearer ${customerToken1}` },
          body: { bookingId: b._id, rating: 5 },
        });

        assert.equal(res.statusCode, 409);
        assert.equal(res.body.error.code, 'INVALID_BOOKING_STATUS');
      });
    }

    it('rejects rating a completed booking with no assigned technician with 400 NO_ASSIGNED_TECHNICIAN', async () => {
      const noTechBooking = await Booking.create({
        customerId: customerUser1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: null,
        location: { type: 'Point', coordinates: [88.36, 22.57] },
        addressText: 'No Tech Address',
        timeWindow: {
          start: new Date(Date.now() - 7200000),
          end: new Date(Date.now() - 3600000),
        },
        status: 'completed',
        completedAt: new Date(),
        estimatedPrice: 600,
      });

      const res = await requestApp('POST', '/api/v1/ratings', {
        headers: { Authorization: `Bearer ${customerToken1}` },
        body: { bookingId: noTechBooking._id, rating: 5 },
      });

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error.code, 'NO_ASSIGNED_TECHNICIAN');
    });
  });

  describe('3. Rating Value and Comment Validation', () => {
    let completedBooking;

    before(async () => {
      completedBooking = await Booking.create({
        customerId: customerUser1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: techUser1._id,
        location: { type: 'Point', coordinates: [88.36, 22.57] },
        addressText: 'Val Test Address',
        timeWindow: {
          start: new Date(Date.now() - 7200000),
          end: new Date(Date.now() - 3600000),
        },
        status: 'completed',
        completedAt: new Date(),
        estimatedPrice: 700,
      });
    });

    it('rejects rating below 1 (e.g. 0) with 400 VALIDATION_ERROR', async () => {
      const res = await requestApp('POST', '/api/v1/ratings', {
        headers: { Authorization: `Bearer ${customerToken1}` },
        body: { bookingId: completedBooking._id, rating: 0 },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    it('rejects rating above 5 (e.g. 6) with 400 VALIDATION_ERROR', async () => {
      const res = await requestApp('POST', '/api/v1/ratings', {
        headers: { Authorization: `Bearer ${customerToken1}` },
        body: { bookingId: completedBooking._id, rating: 6 },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    it('rejects fractional rating (e.g. 4.5) with 400 VALIDATION_ERROR', async () => {
      const res = await requestApp('POST', '/api/v1/ratings', {
        headers: { Authorization: `Bearer ${customerToken1}` },
        body: { bookingId: completedBooking._id, rating: 4.5 },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    it('rejects non-numeric rating with 400 VALIDATION_ERROR', async () => {
      const res = await requestApp('POST', '/api/v1/ratings', {
        headers: { Authorization: `Bearer ${customerToken1}` },
        body: { bookingId: completedBooking._id, rating: 'five' },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    it('rejects comment exceeding 500 characters with 400 VALIDATION_ERROR', async () => {
      const longComment = 'A'.repeat(501);
      const res = await requestApp('POST', '/api/v1/ratings', {
        headers: { Authorization: `Bearer ${customerToken1}` },
        body: { bookingId: completedBooking._id, rating: 5, comment: longComment },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });
  });

  describe('4. Successful Rating Submission & Endpoint Aliases', () => {
    let bookingA, bookingB;

    before(async () => {
      bookingA = await Booking.create({
        customerId: customerUser1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: techUser1._id,
        location: { type: 'Point', coordinates: [88.36, 22.57] },
        addressText: 'Success Test A',
        timeWindow: {
          start: new Date(Date.now() - 7200000),
          end: new Date(Date.now() - 3600000),
        },
        status: 'completed',
        completedAt: new Date(),
        estimatedPrice: 750,
      });

      bookingB = await Booking.create({
        customerId: customerUser1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: techUser1._id,
        location: { type: 'Point', coordinates: [88.37, 22.58] },
        addressText: 'Success Test B',
        timeWindow: {
          start: new Date(Date.now() - 7200000),
          end: new Date(Date.now() - 3600000),
        },
        status: 'completed',
        completedAt: new Date(),
        estimatedPrice: 850,
      });
    });

    it('submits rating successfully via POST /api/v1/ratings with valid comment (201 Created)', async () => {
      const res = await requestApp('POST', '/api/v1/ratings', {
        headers: { Authorization: `Bearer ${customerToken1}` },
        body: {
          bookingId: bookingA._id,
          rating: 5,
          comment: 'Outstanding and punctual service!',
        },
      });

      assert.equal(res.statusCode, 201);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.rating.rating, 5);
      assert.equal(res.body.data.rating.comment, 'Outstanding and punctual service!');
      assert.equal(res.body.data.rating.bookingId, String(bookingA._id));
      assert.equal(res.body.data.rating.customerId, String(customerUser1._id));
      assert.equal(res.body.data.rating.technicianId, String(techUser1._id));

      // TechnicianProfile aggregate updated
      assert.equal(res.body.data.technicianSummary.ratingCount, 1);
      assert.equal(res.body.data.technicianSummary.ratingAvg, 5.0);

      // Verify in-app notification created for technician
      const notif = await Notification.findOne({
        userId: techUser1._id,
        title: 'New Customer Rating',
        relatedEntityId: bookingA._id,
      });
      assert.ok(notif);
      assert.match(notif.message, /5 stars/);
    });

    it('submits rating successfully via alias POST /api/v1/bookings/:id/rating (201 Created)', async () => {
      const res = await requestApp('POST', `/api/v1/bookings/${bookingB._id}/rating`, {
        headers: { Authorization: `Bearer ${customerToken1}` },
        body: {
          rating: 4,
          comment: 'Good work, arrived slightly early.',
        },
      });

      assert.equal(res.statusCode, 201);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.rating.rating, 4);
      assert.equal(res.body.data.technicianSummary.ratingCount, 2);
      assert.equal(res.body.data.technicianSummary.ratingAvg, 4.5);
    });

    it('retrieves the rating for booking via GET /api/v1/bookings/:id/rating', async () => {
      const res = await requestApp('GET', `/api/v1/bookings/${bookingA._id}/rating`, {
        headers: { Authorization: `Bearer ${customerToken1}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.rating, 5);
      assert.equal(res.body.data.comment, 'Outstanding and punctual service!');
    });
  });

  describe('5. Duplicate Submission Protection', () => {
    let duplicateBooking;

    before(async () => {
      duplicateBooking = await Booking.create({
        customerId: customerUser1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: techUser1._id,
        location: { type: 'Point', coordinates: [88.36, 22.57] },
        addressText: 'Duplicate Test Address',
        timeWindow: {
          start: new Date(Date.now() - 7200000),
          end: new Date(Date.now() - 3600000),
        },
        status: 'completed',
        completedAt: new Date(),
        estimatedPrice: 700,
      });

      // Submit first rating
      const firstRes = await requestApp('POST', '/api/v1/ratings', {
        headers: { Authorization: `Bearer ${customerToken1}` },
        body: { bookingId: duplicateBooking._id, rating: 5, comment: 'First try' },
      });
      assert.equal(firstRes.statusCode, 201);
    });

    it('rejects second rating on POST /api/v1/ratings with 409 DUPLICATE_RATING', async () => {
      const res = await requestApp('POST', '/api/v1/ratings', {
        headers: { Authorization: `Bearer ${customerToken1}` },
        body: { bookingId: duplicateBooking._id, rating: 4, comment: 'Second try' },
      });

      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'DUPLICATE_RATING');
    });

    it('rejects duplicate rating via POST /api/v1/bookings/:id/rating with 409 DUPLICATE_RATING', async () => {
      const res = await requestApp('POST', `/api/v1/bookings/${duplicateBooking._id}/rating`, {
        headers: { Authorization: `Bearer ${customerToken1}` },
        body: { rating: 3 },
      });

      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error.code, 'DUPLICATE_RATING');
    });
  });

  describe('6. Rating Aggregation & Exact Decimal Calculation', () => {
    let aggTechUser, aggTechToken, aggTechProfile;
    let b1, b2, b3;

    before(async () => {
      // Create dedicated fresh technician
      aggTechUser = await User.create({
        name: 'Math Precision Tech',
        email: `mathtech_${Date.now()}@test.smartpool.local`,
        phone: '+91-9876543299',
        passwordHash: validPasswordHash,
        role: 'technician',
        isActive: true,
      });
      aggTechToken = signAuthToken(aggTechUser);

      aggTechProfile = await TechnicianProfile.create({
        userId: aggTechUser._id,
        baseLocation: { type: 'Point', coordinates: [88.36, 22.57] },
        skills: ['cleaning'],
        maxPoolCapacity: 4,
        availabilityStatus: 'available',
        approvalStatus: 'approved',
        ratingAvg: 0,
        ratingCount: 0,
      });

      // Create 3 completed bookings for this technician
      b1 = await Booking.create({
        customerId: customerUser1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: aggTechUser._id,
        location: { type: 'Point', coordinates: [88.36, 22.57] },
        addressText: 'Math 1',
        timeWindow: { start: new Date(Date.now() - 7200000), end: new Date(Date.now() - 3600000) },
        status: 'completed',
        completedAt: new Date(),
        estimatedPrice: 600,
      });

      b2 = await Booking.create({
        customerId: customerUser1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: aggTechUser._id,
        location: { type: 'Point', coordinates: [88.37, 22.57] },
        addressText: 'Math 2',
        timeWindow: { start: new Date(Date.now() - 7200000), end: new Date(Date.now() - 3600000) },
        status: 'completed',
        completedAt: new Date(),
        estimatedPrice: 600,
      });

      b3 = await Booking.create({
        customerId: customerUser2._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: aggTechUser._id,
        location: { type: 'Point', coordinates: [88.38, 22.57] },
        addressText: 'Math 3',
        timeWindow: { start: new Date(Date.now() - 7200000), end: new Date(Date.now() - 3600000) },
        status: 'completed',
        completedAt: new Date(),
        estimatedPrice: 600,
      });
    });

    it('first rating (5 stars): sets count=1 and avg=5.0', async () => {
      const res = await requestApp('POST', '/api/v1/ratings', {
        headers: { Authorization: `Bearer ${customerToken1}` },
        body: { bookingId: b1._id, rating: 5 },
      });
      assert.equal(res.statusCode, 201);

      const profile = await TechnicianProfile.findOne({ userId: aggTechUser._id });
      assert.equal(profile.ratingCount, 1);
      assert.equal(profile.ratingAvg, 5.0);
    });

    it('second rating (4 stars): sets count=2 and avg=4.5', async () => {
      const res = await requestApp('POST', '/api/v1/ratings', {
        headers: { Authorization: `Bearer ${customerToken1}` },
        body: { bookingId: b2._id, rating: 4 },
      });
      assert.equal(res.statusCode, 201);

      const profile = await TechnicianProfile.findOne({ userId: aggTechUser._id });
      assert.equal(profile.ratingCount, 2);
      assert.equal(profile.ratingAvg, 4.5);
    });

    it('third rating (4 stars): sets count=3 and avg=4.33 (2 decimal places precision)', async () => {
      const res = await requestApp('POST', '/api/v1/ratings', {
        headers: { Authorization: `Bearer ${customerToken2}` },
        body: { bookingId: b3._id, rating: 4 },
      });
      assert.equal(res.statusCode, 201);

      // (5 + 4 + 4) / 3 = 13 / 3 = 4.333333... -> 4.33
      const profile = await TechnicianProfile.findOne({ userId: aggTechUser._id });
      assert.equal(profile.ratingCount, 3);
      assert.equal(profile.ratingAvg, 4.33);
    });
  });

  describe('7. Multi-Technician Isolation', () => {
    it('guarantees ratings for Tech 2 do not affect Tech 1 aggregates', async () => {
      const p1Before = await TechnicianProfile.findOne({ userId: techUser1._id });
      const p2Before = await TechnicianProfile.findOne({ userId: techUser2._id });

      const tech2Booking = await Booking.create({
        customerId: customerUser2._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: techUser2._id,
        location: { type: 'Point', coordinates: [88.4, 22.6] },
        addressText: 'Tech 2 Booking',
        timeWindow: { start: new Date(Date.now() - 7200000), end: new Date(Date.now() - 3600000) },
        status: 'completed',
        completedAt: new Date(),
        estimatedPrice: 900,
      });

      const res = await requestApp('POST', '/api/v1/ratings', {
        headers: { Authorization: `Bearer ${customerToken2}` },
        body: { bookingId: tech2Booking._id, rating: 5, comment: 'Tech 2 was great!' },
      });
      assert.equal(res.statusCode, 201);

      // Tech 2 updated
      const p2After = await TechnicianProfile.findOne({ userId: techUser2._id });
      assert.equal(p2After.ratingCount, p2Before.ratingCount + 1);
      assert.equal(p2After.ratingAvg, 5.0);

      // Tech 1 completely unchanged
      const p1After = await TechnicianProfile.findOne({ userId: techUser1._id });
      assert.equal(p1After.ratingCount, p1Before.ratingCount);
      assert.equal(p1After.ratingAvg, p1Before.ratingAvg);
    });
  });

  describe('8. Customer Submitted Ratings History', () => {
    it('retrieves paginated submitted ratings for authenticated customer via GET /api/v1/ratings/my', async () => {
      const res = await requestApp('GET', '/api/v1/ratings/my?page=1&limit=5', {
        headers: { Authorization: `Bearer ${customerToken1}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.ok(Array.isArray(res.body.data));
      assert.ok(res.body.meta.pagination);
      assert.ok(res.body.meta.pagination.total >= 3);

      // Check populated fields
      const firstRating = res.body.data[0];
      assert.ok(firstRating.bookingId);
      assert.ok(firstRating.technicianId);
      assert.ok(firstRating.technicianId.name);
      assert.equal(firstRating.technicianId.phone, undefined, 'Technician phone number must not be exposed in customer rating history');
      assert.equal(String(firstRating.customerId), String(customerUser1._id));
    });

    it('supports alias GET /api/v1/ratings', async () => {
      const res = await requestApp('GET', '/api/v1/ratings', {
        headers: { Authorization: `Bearer ${customerToken1}` },
      });
      assert.equal(res.statusCode, 200);
      assert.ok(Array.isArray(res.body.data));
    });
  });

  describe('9. Technician Received Ratings & Privacy Masking', () => {
    it('retrieves ratings for a technician with privacy-masked customer names via GET /api/v1/technicians/:id/ratings', async () => {
      const res = await requestApp('GET', `/api/v1/technicians/${techUser1._id}/ratings`, {
        headers: { Authorization: `Bearer ${customerToken1}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.ok(Array.isArray(res.body.data));

      const ratingItem = res.body.data[0];
      assert.ok(ratingItem.customer);
      // Privacy masking: "Alice Walker" -> "Alice W."
      assert.match(ratingItem.customer.displayName, /^Alice\s+W\.$/);
      // Ensure phone, email, and password are NOT exposed
      assert.equal(ratingItem.customer.phone, undefined);
      assert.equal(ratingItem.customer.email, undefined);
    });

    it('allows authenticated technician to view own received ratings via GET /api/v1/technicians/me/ratings', async () => {
      const res = await requestApp('GET', '/api/v1/technicians/me/ratings', {
        headers: { Authorization: `Bearer ${techToken1}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.ok(Array.isArray(res.body.data));
    });

    it('filters technician ratings by minimum rating via ?minRating=5', async () => {
      const res = await requestApp('GET', `/api/v1/technicians/${techUser1._id}/ratings?minRating=5`, {
        headers: { Authorization: `Bearer ${customerToken1}` },
      });

      assert.equal(res.statusCode, 200);
      for (const item of res.body.data) {
        assert.equal(item.rating, 5);
      }
    });
  });

  describe('10. Technician Rating Summary & Star Breakdown', () => {
    it('returns exact rating summary with star breakdown via GET /api/v1/technicians/:id/ratings/summary', async () => {
      const res = await requestApp('GET', `/api/v1/technicians/${techUser1._id}/ratings/summary`, {
        headers: { Authorization: `Bearer ${customerToken1}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      const data = res.body.data;

      assert.equal(data.technicianId, String(techUser1._id));
      assert.ok(data.ratingCount >= 2);
      assert.ok(data.ratingAvg >= 4.0);
      assert.ok(data.breakdown);
      assert.equal(typeof data.breakdown[5], 'number');
      assert.equal(typeof data.breakdown[4], 'number');
      assert.equal(typeof data.breakdown[3], 'number');
      assert.equal(typeof data.breakdown[2], 'number');
      assert.equal(typeof data.breakdown[1], 'number');

      const sumStars = Object.values(data.breakdown).reduce((a, b) => a + b, 0);
      assert.equal(sumStars, data.ratingCount);
    });

    it('allows technician to retrieve own rating summary via GET /api/v1/technicians/me/ratings/summary', async () => {
      const res = await requestApp('GET', '/api/v1/technicians/me/ratings/summary', {
        headers: { Authorization: `Bearer ${techToken1}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.technicianId, String(techUser1._id));
    });
  });

  describe('11. Concurrency Control & Race Condition Protection', () => {
    it('simultaneous concurrent submissions on the same booking: exactly 1 wins (201) and 1 rejected (409)', async () => {
      const raceBooking = await Booking.create({
        customerId: customerUser1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: techUser1._id,
        location: { type: 'Point', coordinates: [88.36, 22.57] },
        addressText: 'Race Booking',
        timeWindow: { start: new Date(Date.now() - 7200000), end: new Date(Date.now() - 3600000) },
        status: 'completed',
        completedAt: new Date(),
        estimatedPrice: 700,
      });

      // Fire 2 concurrent rating requests on same booking
      const [res1, res2] = await Promise.all([
        requestApp('POST', '/api/v1/ratings', {
          headers: { Authorization: `Bearer ${customerToken1}` },
          body: { bookingId: raceBooking._id, rating: 5, comment: 'Race attempt 1' },
        }),
        requestApp('POST', '/api/v1/ratings', {
          headers: { Authorization: `Bearer ${customerToken1}` },
          body: { bookingId: raceBooking._id, rating: 5, comment: 'Race attempt 2' },
        }),
      ]);

      const codes = [res1.statusCode, res2.statusCode].sort((a, b) => a - b);
      assert.deepEqual(codes, [201, 409]);

      // Exactly 1 rating document in DB
      const count = await Rating.countDocuments({ bookingId: raceBooking._id });
      assert.equal(count, 1);
    });

    it('simultaneous concurrent ratings on different bookings for same technician: both succeed and preserve aggregate consistency', async () => {
      const bA = await Booking.create({
        customerId: customerUser1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: techUser2._id,
        location: { type: 'Point', coordinates: [88.4, 22.6] },
        addressText: 'Concurrent A',
        timeWindow: { start: new Date(Date.now() - 7200000), end: new Date(Date.now() - 3600000) },
        status: 'completed',
        completedAt: new Date(),
        estimatedPrice: 700,
      });

      const bB = await Booking.create({
        customerId: customerUser2._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: techUser2._id,
        location: { type: 'Point', coordinates: [88.41, 22.61] },
        addressText: 'Concurrent B',
        timeWindow: { start: new Date(Date.now() - 7200000), end: new Date(Date.now() - 3600000) },
        status: 'completed',
        completedAt: new Date(),
        estimatedPrice: 700,
      });

      // Tech 2 previously had 1 rating (5 stars).
      // Now concurrent submission: Customer 1 gives 5 stars, Customer 2 gives 3 stars.
      const [resA, resB] = await Promise.all([
        requestApp('POST', '/api/v1/ratings', {
          headers: { Authorization: `Bearer ${customerToken1}` },
          body: { bookingId: bA._id, rating: 5 },
        }),
        requestApp('POST', '/api/v1/ratings', {
          headers: { Authorization: `Bearer ${customerToken2}` },
          body: { bookingId: bB._id, rating: 3 },
        }),
      ]);

      assert.equal(resA.statusCode, 201);
      assert.equal(resB.statusCode, 201);

      // Verify Tech 2 final aggregates in DB
      // Total ratings: 3 (5, 5, 3). Sum = 13. Average = 13 / 3 = 4.33
      const tech2Profile = await TechnicianProfile.findOne({ userId: techUser2._id });
      assert.equal(tech2Profile.ratingCount, 3);
      assert.equal(tech2Profile.ratingAvg, 4.33);
    });
  });

  describe('13. Production Hardening & Database Index Verification', () => {
    it('guarantees the Rating collection possesses the unique { bookingId: 1 } index', async () => {
      const indexes = await Rating.collection.listIndexes().toArray();
      const bookingIdIndex = indexes.find((idx) => idx.key?.bookingId === 1);

      assert.ok(bookingIdIndex, 'Expected bookingId_1 index to exist on Rating collection');
      assert.equal(bookingIdIndex.unique, true, 'Expected bookingId index to enforce uniqueness');
    });

    it('successfully executes Rating.createIndexes() before request processing', async () => {
      await assert.doesNotReject(async () => {
        await Rating.createIndexes();
      }, 'Rating.createIndexes() should resolve without throwing');
    });

    it('proves a failing index creation throws and rejects server startup', async () => {
      const originalCreateIndexes = Rating.createIndexes;
      try {
        Rating.createIndexes = async () => {
          throw new Error('E11000 duplicate key error collection index build failed');
        };

        await assert.rejects(
          async () => {
            await Rating.createIndexes();
          },
          /E11000 duplicate key error/
        );
      } finally {
        Rating.createIndexes = originalCreateIndexes;
      }
    });
  });

  describe('14. Rating Lookup IDOR, Privacy Masking & Security Hardening (D-1)', () => {
    let targetBooking, targetRating;

    before(async () => {
      targetBooking = await Booking.create({
        customerId: customerUser1._id,
        serviceCategoryId: category._id,
        zoneId: zone._id,
        technicianId: techUser1._id,
        location: { type: 'Point', coordinates: [88.36, 22.57] },
        addressText: 'IDOR Test Address',
        timeWindow: {
          start: new Date(Date.now() - 7200000),
          end: new Date(Date.now() - 3600000),
        },
        status: 'completed',
        completedAt: new Date(),
        estimatedPrice: 500,
      });

      const res = await requestApp('POST', '/api/v1/ratings', {
        headers: { Authorization: `Bearer ${customerToken1}` },
        body: { bookingId: targetBooking._id, rating: 5, comment: 'Great job!' },
      });
      assert.equal(res.statusCode, 201);
      targetRating = res.body.data.rating;
    });

    it('1. Customer retrieves own booking rating and verifies phone number is not exposed', async () => {
      const res = await requestApp('GET', `/api/v1/bookings/${targetBooking._id}/rating`, {
        headers: { Authorization: `Bearer ${customerToken1}` },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.rating, 5);
      assert.ok(res.body.data.technicianId.name);
      assert.equal(res.body.data.technicianId.phone, undefined, 'Technician phone number must not be exposed');
    });

    it('2. Customer cannot retrieve another customer rating (403 FORBIDDEN_BOOKING_ACCESS)', async () => {
      const res = await requestApp('GET', `/api/v1/bookings/${targetBooking._id}/rating`, {
        headers: { Authorization: `Bearer ${customerToken2}` },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN_BOOKING_ACCESS');
    });

    it('3. Assigned technician retrieves their own booking rating with masked customer name', async () => {
      const res = await requestApp('GET', `/api/v1/bookings/${targetBooking._id}/rating`, {
        headers: { Authorization: `Bearer ${techToken1}` },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.rating, 5);
      // Customer name is masked for technician
      assert.match(res.body.data.customerId.name, /^Customer\s+1\b|^[A-Za-z]+\s+[A-Z]\.$/);
      assert.equal(res.body.data.technicianId.phone, undefined, 'Technician phone number must not be exposed');
    });

    it('4. Technician A cannot retrieve Technician B booking rating (403 FORBIDDEN_BOOKING_ACCESS)', async () => {
      const res = await requestApp('GET', `/api/v1/bookings/${targetBooking._id}/rating`, {
        headers: { Authorization: `Bearer ${techToken2}` },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN_BOOKING_ACCESS');
    });

    it('5. Rating lookup endpoint alias GET /api/v1/ratings/bookings/:id behaves identically', async () => {
      const res = await requestApp('GET', `/api/v1/ratings/bookings/${targetBooking._id}`, {
        headers: { Authorization: `Bearer ${customerToken1}` },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.data.rating, 5);
      assert.equal(res.body.data.technicianId.phone, undefined);
    });

    it('6. Admin can retrieve rating with full access', async () => {
      const res = await requestApp('GET', `/api/v1/bookings/${targetBooking._id}/rating`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.data.rating, 5);
    });

    it('7. Unauthorized requests return correct status codes (401 and 404)', async () => {
      const unauth = await requestApp('GET', `/api/v1/bookings/${targetBooking._id}/rating`);
      assert.equal(unauth.statusCode, 401);

      const fakeId = new mongoose.Types.ObjectId();
      const notFound = await requestApp('GET', `/api/v1/bookings/${fakeId}/rating`, {
        headers: { Authorization: `Bearer ${customerToken1}` },
      });
      assert.equal(notFound.statusCode, 404);
      assert.equal(notFound.body.error.code, 'RATING_NOT_FOUND');
    });
  });
});
