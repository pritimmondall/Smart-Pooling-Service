import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

import app from '../src/app.js';
import { User, Booking } from '../src/models/index.js';
import { signAuthToken } from '../src/middleware/auth.js';

/**
 * Invokes the Express application in-process using Node's IncomingMessage & ServerResponse,
 * exercising the full middleware stack without binding a network port.
 */
function requestApp(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
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

    const origEnd = res.end.bind(res);
    res.end = (chunk, encoding, cb) => {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      }
      const text = Buffer.concat(chunks).toString('utf8');
      let parsed = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // Keep raw string if non-JSON
      }
      resolve({ status: res.statusCode, headers: res.getHeaders(), body: parsed });
      return origEnd(chunk, encoding, cb);
    };

    res.on('error', reject);
    app(req, res);

    if (rawBody) {
      req.push(rawBody);
    }
    req.push(null);
  });
}

describe('Phase 2 Express API, Auth, Validation & RBAC HTTP Verification', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('GET /api/v1/health responds 200 with consistent success payload and Helmet headers', async () => {
    const res = await requestApp('GET', '/api/v1/health');

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.phase, 2);
    assert.ok(res.body.data.database);
    assert.ok(res.headers['x-content-type-options']);
  });

  it('returns 404 JSON error for unknown routes', async () => {
    const res = await requestApp('GET', '/api/v1/unknown-endpoint');

    assert.equal(res.status, 404);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, 'ROUTE_NOT_FOUND');
  });

  it('registers a customer, hashes password, and never exposes passwordHash', async () => {
    const newId = new mongoose.Types.ObjectId();
    let capturedHash;

    mock.method(User, 'findOne', async () => null);
    mock.method(mongoose, 'startSession', async () => ({
      withTransaction: async (fn) => fn(),
      endSession: async () => {},
    }));
    mock.method(User, 'create', async (docs) => {
      const doc = new User({ ...docs[0], _id: newId });
      const salt = await bcrypt.genSalt(10);
      doc.passwordHash = await bcrypt.hash(docs[0].passwordHash, salt);
      capturedHash = doc.passwordHash;
      return [doc];
    });

    const res = await requestApp('POST', '/api/v1/auth/register', {
      body: {
        name: 'Priya Sen',
        email: 'priya@test.com',
        password: 'StrongPassword1!',
        role: 'customer',
      },
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.ok(res.body.data.token);
    assert.equal(res.body.data.user.email, 'priya@test.com');
    assert.equal(res.body.data.user.passwordHash, undefined);
    assert.notEqual(capturedHash, 'StrongPassword1!');
    assert.equal(await bcrypt.compare('StrongPassword1!', capturedHash), true);
  });

  it('blocks admin self-registration via POST /api/v1/auth/register', async () => {
    const res = await requestApp('POST', '/api/v1/auth/register', {
      body: {
        name: 'Attempt Admin',
        email: 'admin@test.com',
        password: 'Password123!',
        role: 'admin',
      },
    });

    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'FORBIDDEN_ROLE');
  });

  it('validates credentials on login, rejects wrong passwords with 401, and strips NoSQL operators', async () => {
    const userId = new mongoose.Types.ObjectId();
    const hashed = await bcrypt.hash('CorrectPass123!', 10);
    const mockUser = new User({
      _id: userId,
      name: 'Login User',
      email: 'login@test.com',
      passwordHash: hashed,
      role: 'customer',
      isActive: true,
    });

    let lastQuery = null;
    mock.method(User, 'findOne', (query) => {
      lastQuery = query;
      return { select: async () => (query.email === 'login@test.com' ? mockUser : null) };
    });

    const injectionRes = await requestApp('POST', '/api/v1/auth/login', {
      body: { email: { $ne: '' }, password: 'x' },
    });
    assert.equal(injectionRes.status, 401);
    assert.deepEqual(lastQuery, { email: '[object object]' });

    const badRes = await requestApp('POST', '/api/v1/auth/login', {
      body: { email: 'login@test.com', password: 'WrongPassword' },
    });
    assert.equal(badRes.status, 401);
    assert.equal(badRes.body.error.code, 'INVALID_CREDENTIALS');

    const okRes = await requestApp('POST', '/api/v1/auth/login', {
      body: { email: 'login@test.com', password: 'CorrectPass123!' },
    });
    assert.equal(okRes.status, 200);
    assert.ok(okRes.body.data.token);
    assert.equal(okRes.body.data.user.passwordHash, undefined);
  });

  it('blocks unauthenticated access to protected endpoints', async () => {
    const res1 = await requestApp('GET', '/api/v1/bookings/my');
    assert.equal(res1.status, 401);

    const res2 = await requestApp('GET', '/api/v1/users/me');
    assert.equal(res2.status, 401);

    const res3 = await requestApp('GET', '/api/v1/technicians/me');
    assert.equal(res3.status, 401);
  });

  it('allows authenticated user to read and update own profile while preventing privilege changes', async () => {
    const userId = new mongoose.Types.ObjectId();
    const userDoc = new User({
      _id: userId,
      name: 'Original Name',
      email: 'user@test.com',
      phone: '9999999999',
      passwordHash: 'hashed_placeholder',
      role: 'customer',
      isActive: true,
    });

    mock.method(User, 'findById', () => ({ select: async () => userDoc }));
    mock.method(User, 'findByIdAndUpdate', async (_id, updates) => {
      assert.equal(updates.role, undefined);
      userDoc.name = updates.name ?? userDoc.name;
      return userDoc;
    });

    const token = signAuthToken(userDoc);
    const getRes = await requestApp('GET', '/api/v1/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.data.email, 'user@test.com');

    const patchRes = await requestApp('PATCH', '/api/v1/users/me', {
      headers: { Authorization: `Bearer ${token}` },
      body: { name: 'Updated Name', role: 'admin' },
    });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.body.data.name, 'Updated Name');
    assert.equal(patchRes.body.data.role, 'customer');
  });

  it('enforces role boundaries on services, zones, users, technicians, and bookings', async () => {
    const customerUser = { _id: new mongoose.Types.ObjectId(), role: 'customer', isActive: true };
    const techUser = { _id: new mongoose.Types.ObjectId(), role: 'technician', isActive: true };

    mock.method(User, 'findById', (id) => ({
      select: async () => (String(id) === String(customerUser._id) ? customerUser : techUser),
    }));

    const customerToken = signAuthToken(customerUser);
    const techToken = signAuthToken(techUser);

    const resServiceCreate = await requestApp('POST', '/api/v1/services', {
      headers: { Authorization: `Bearer ${customerToken}` },
      body: { name: 'AC', baseIndividualPrice: 600, estimatedDurationMins: 45 },
    });
    assert.equal(resServiceCreate.status, 403);

    const resZoneCreate = await requestApp('POST', '/api/v1/zones', {
      headers: { Authorization: `Bearer ${customerToken}` },
      body: { name: 'Zone A', code: 'Z-A', centerLocation: { lat: 22.5, lng: 88.3 } },
    });
    assert.equal(resZoneCreate.status, 403);

    const resUsersList = await requestApp('GET', '/api/v1/users', {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    assert.equal(resUsersList.status, 403);

    const resTechList = await requestApp('GET', '/api/v1/technicians', {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    assert.equal(resTechList.status, 403);

    const resTechCreateBooking = await requestApp('POST', '/api/v1/bookings', {
      headers: { Authorization: `Bearer ${techToken}` },
      body: {
        serviceCategoryId: String(new mongoose.Types.ObjectId()),
        location: { lat: 22.5, lng: 88.3 },
        addressText: 'Kolkata',
        timeWindow: {
          start: new Date(Date.now() + 7200_000).toISOString(),
          end: new Date(Date.now() + 10800_000).toISOString(),
        },
      },
    });
    assert.equal(resTechCreateBooking.status, 403);
  });

  it('validates route ObjectIds, required body fields, and invalid geospatial query coordinates', async () => {
    const customerUser = { _id: new mongoose.Types.ObjectId(), role: 'customer', isActive: true };
    mock.method(User, 'findById', () => ({ select: async () => customerUser }));
    const customerToken = signAuthToken(customerUser);

    const badIdRes = await requestApp('GET', '/api/v1/bookings/not-a-valid-objectid', {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    assert.equal(badIdRes.status, 400);
    assert.equal(badIdRes.body.error.code, 'INVALID_ID');

    const missingFieldsRes = await requestApp('POST', '/api/v1/bookings', {
      headers: { Authorization: `Bearer ${customerToken}` },
      body: { addressText: 'Only address provided' },
    });
    assert.equal(missingFieldsRes.status, 400);
    assert.equal(missingFieldsRes.body.error.code, 'VALIDATION_ERROR');

    const badGeoRes = await requestApp('GET', '/api/v1/zones?lat=999&lng=88.3');
    assert.equal(badGeoRes.status, 400);
    assert.equal(badGeoRes.body.error.code, 'INVALID_COORDINATES');
  });

  it('prevents a customer from viewing another customer booking (IDOR protection)', async () => {
    const requesterId = new mongoose.Types.ObjectId();
    const otherCustomerId = new mongoose.Types.ObjectId();
    const bookingId = new mongoose.Types.ObjectId();

    mock.method(User, 'findById', () => ({
      select: async () => ({ _id: requesterId, role: 'customer', isActive: true }),
    }));

    const mockQuery = {
      populate: () => mockQuery,
      then: (resolve) => resolve({
        _id: bookingId,
        customerId: otherCustomerId,
      }),
    };
    mock.method(Booking, 'findById', () => mockQuery);

    const token = signAuthToken({ _id: requesterId, role: 'customer' });
    const res = await requestApp('GET', `/api/v1/bookings/${bookingId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'FORBIDDEN_BOOKING_ACCESS');
  });

  it('handles unexpected async controller errors consistently via errorHandler', async () => {
    const customerUser = { _id: new mongoose.Types.ObjectId(), role: 'customer', isActive: true };
    mock.method(User, 'findById', () => ({ select: async () => customerUser }));
    mock.method(Booking, 'find', () => {
      throw new Error('Simulated unexpected database failure');
    });

    const token = signAuthToken(customerUser);
    const res = await requestApp('GET', '/api/v1/bookings/my', {
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.equal(res.status, 500);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, 'INTERNAL_ERROR');
  });
});
