import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import app from '../src/app.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { signAuthToken } from '../src/middleware/auth.js';
import { TechnicianProfile, User } from '../src/models/index.js';
import { toGeoJSONPoint } from '../src/utils/geo.js';

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

describe('Phase 5A Technician Availability & Working Hours Suite', () => {
  let replSet;
  let activeTechUser, activeTechToken, activeTechProfile;
  let inactiveTechUser, inactiveTechToken, inactiveTechProfile;
  let adminUser, adminToken;

  before(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await connectDB(replSet.getUri());

    activeTechUser = await User.create({
      name: 'Active Approved Tech',
      email: `appr_tech_${Date.now()}@test.local`,
      passwordHash: 'ValidPassword123!',
      role: 'technician',
      isActive: true,
    });
    activeTechToken = signAuthToken(activeTechUser);

    activeTechProfile = await TechnicianProfile.create({
      userId: activeTechUser._id,
      baseLocation: toGeoJSONPoint(22.528, 88.365),
      availabilityStatus: 'offline',
      approvalStatus: 'approved',
    });

    inactiveTechUser = await User.create({
      name: 'Inactive Tech',
      email: `inact_tech_${Date.now()}@test.local`,
      passwordHash: 'ValidPassword123!',
      role: 'technician',
      isActive: false,
    });
    inactiveTechToken = signAuthToken(inactiveTechUser);

    inactiveTechProfile = await TechnicianProfile.create({
      userId: inactiveTechUser._id,
      baseLocation: toGeoJSONPoint(22.528, 88.365),
      availabilityStatus: 'offline',
      approvalStatus: 'approved',
    });

    adminUser = await User.create({
      name: 'Platform Admin',
      email: `admin_avail_${Date.now()}@test.local`,
      passwordHash: 'ValidPassword123!',
      role: 'admin',
      isActive: true,
    });
    adminToken = signAuthToken(adminUser);
  });

  after(async () => {
    await disconnectDB();
    if (replSet) {
      await replSet.stop();
    }
  });

  it('rejects invalid availability values with 400 VALIDATION_ERROR', async () => {
    const res = await requestApp('PATCH', '/api/v1/technicians/me/availability', {
      headers: { authorization: `Bearer ${activeTechToken}` },
      body: { availabilityStatus: 'online_invalid_status' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.ok(res.body.error.message.includes('availabilityStatus must be one of'));
  });

  it('blocks inactive technicians from updating availability with 403 ACCOUNT_INACTIVE', async () => {
    const res = await requestApp('PATCH', '/api/v1/technicians/me/availability', {
      headers: { authorization: `Bearer ${inactiveTechToken}` },
      body: { availabilityStatus: 'available' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error.code, 'ACCOUNT_INACTIVE');
  });

  it('validates working hours schema: rejects non-object or invalid time formats', async () => {
    // Non-object workingHours
    const res1 = await requestApp('PATCH', '/api/v1/technicians/me/availability', {
      headers: { authorization: `Bearer ${activeTechToken}` },
      body: { availabilityStatus: 'busy', workingHours: '9am-5pm' },
    });
    assert.equal(res1.statusCode, 400);
    assert.equal(res1.body.error.code, 'VALIDATION_ERROR');

    // Invalid time string (not HH:mm)
    const res2 = await requestApp('PATCH', '/api/v1/technicians/me/availability', {
      headers: { authorization: `Bearer ${activeTechToken}` },
      body: { availabilityStatus: 'busy', workingHours: { start: '25:99', end: '18:00' } },
    });
    assert.equal(res2.statusCode, 400);
    assert.equal(res2.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects admin availability update if technicianId is invalid ObjectId', async () => {
    const res = await requestApp('PATCH', '/api/v1/technicians/invalid-id/availability', {
      headers: { authorization: `Bearer ${adminToken}` },
      body: { availabilityStatus: 'offline' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'INVALID_ID');
  });

  it('rejects non-admin attempting to use admin availability update endpoint', async () => {
    const techId = new mongoose.Types.ObjectId();
    const res = await requestApp('PATCH', `/api/v1/technicians/${techId}/availability`, {
      headers: { authorization: `Bearer ${activeTechToken}` },
      body: { availabilityStatus: 'offline' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error.code, 'FORBIDDEN_ROLE');
  });
});
