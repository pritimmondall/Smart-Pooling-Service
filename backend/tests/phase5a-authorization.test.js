import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import app from '../src/app.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { User, TechnicianProfile, ServicePool, ServiceCategory } from '../src/models/index.js';
import { toGeoJSONPoint } from '../src/utils/geo.js';
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

describe('Phase 5A Authorization & RBAC Enforcement Suite', () => {
  let replSet;
  let customerUser, customerToken;
  let techAUser, techAToken;
  let techBUser, techBToken;
  let adminUser, adminToken;
  let poolAssignedToA;

  before(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await connectDB(replSet.getUri());

    customerUser = await User.create({
      name: 'Customer A',
      email: `cust_${Date.now()}@test.local`,
      passwordHash: 'ValidPassword123!',
      role: 'customer',
      isActive: true,
    });
    customerToken = signAuthToken(customerUser);

    techAUser = await User.create({
      name: 'Technician A',
      email: `techa_${Date.now()}@test.local`,
      passwordHash: 'ValidPassword123!',
      role: 'technician',
      isActive: true,
    });
    techAToken = signAuthToken(techAUser);

    techBUser = await User.create({
      name: 'Technician B',
      email: `techb_${Date.now()}@test.local`,
      passwordHash: 'ValidPassword123!',
      role: 'technician',
      isActive: true,
    });
    techBToken = signAuthToken(techBUser);

    adminUser = await User.create({
      name: 'Admin User',
      email: `admin_${Date.now()}@test.local`,
      passwordHash: 'ValidPassword123!',
      role: 'admin',
      isActive: true,
    });
    adminToken = signAuthToken(adminUser);

    const cat = await ServiceCategory.create({
      name: 'Category Auth Test',
      slug: `cat_auth_${Date.now()}`,
      baseIndividualPrice: 500,
      estimatedDurationMins: 30,
      defaultPoolRadiusKm: 2,
      maxPoolSize: 4,
      poolLockCutoffMins: 60,
    });

    poolAssignedToA = await ServicePool.create({
      serviceCategoryId: cat._id,
      status: 'assigned',
      assignedTechnicianId: techAUser._id,
      assignedAt: new Date(),
      maxCapacity: 4,
      poolRadiusKm: 2,
      centroidLocation: toGeoJSONPoint(22.5, 88.3),
      aggregateTimeWindow: {
        start: new Date(Date.now() + 3600000),
        end: new Date(Date.now() + 7200000),
      },
      lockCutoffTime: new Date(Date.now() - 60000),
      members: [],
    });
  });

  after(async () => {
    await disconnectDB();
    if (replSet) {
      await replSet.stop();
    }
  });

  it('rejects unauthenticated requests to technician job endpoints with 401', async () => {
    const res = await requestApp('GET', '/api/v1/technicians/me/jobs');
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, 'AUTH_REQUIRED');
  });

  it('blocks customers from accessing technician job endpoints with 403', async () => {
    const resJobs = await requestApp('GET', '/api/v1/technicians/me/jobs', {
      headers: { authorization: `Bearer ${customerToken}` },
    });
    assert.equal(resJobs.statusCode, 403);
    assert.equal(resJobs.body.error.code, 'FORBIDDEN_ROLE');

    const resAvail = await requestApp('PATCH', '/api/v1/technicians/me/availability', {
      headers: { authorization: `Bearer ${customerToken}` },
      body: { availabilityStatus: 'available' },
    });
    assert.equal(resAvail.statusCode, 403);
    assert.equal(resAvail.body.error.code, 'FORBIDDEN_ROLE');
  });

  it('blocks non-admin users from accessing pool assignment endpoints with 403', async () => {
    const resCust = await requestApp('POST', `/api/v1/pools/${poolAssignedToA._id}/assign`, {
      headers: { authorization: `Bearer ${customerToken}` },
      body: { technicianId: techAUser._id },
    });
    assert.equal(resCust.statusCode, 403);
    assert.equal(resCust.body.error.code, 'FORBIDDEN_ROLE');

    const resTech = await requestApp('POST', `/api/v1/pools/${poolAssignedToA._id}/assign`, {
      headers: { authorization: `Bearer ${techAToken}` },
      body: { technicianId: techAUser._id },
    });
    assert.equal(resTech.statusCode, 403);
    assert.equal(resTech.body.error.code, 'FORBIDDEN_ROLE');
  });

  it('blocks non-admin users from listing eligible technicians for a pool with 403', async () => {
    const resCust = await requestApp('GET', `/api/v1/pools/${poolAssignedToA._id}/eligible-technicians`, {
      headers: { authorization: `Bearer ${customerToken}` },
    });
    assert.equal(resCust.statusCode, 403);
    assert.equal(resCust.body.error.code, 'FORBIDDEN_ROLE');

    const resTech = await requestApp('GET', `/api/v1/pools/${poolAssignedToA._id}/eligible-technicians`, {
      headers: { authorization: `Bearer ${techAToken}` },
    });
    assert.equal(resTech.statusCode, 403);
    assert.equal(resTech.body.error.code, 'FORBIDDEN_ROLE');
  });

  it('prevents Technician B from accessing Technician A private jobs with 403', async () => {
    const res = await requestApp('GET', `/api/v1/technicians/me/jobs/${poolAssignedToA._id}`, {
      headers: { authorization: `Bearer ${techBToken}` },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error.code, 'FORBIDDEN_JOB_ACCESS');
  });

  it('prevents Technician B from modifying Technician A job status with 403', async () => {
    const res = await requestApp('PATCH', `/api/v1/technicians/me/jobs/${poolAssignedToA._id}/status`, {
      headers: { authorization: `Bearer ${techBToken}` },
      body: { status: 'in_progress' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error.code, 'FORBIDDEN_JOB_ACCESS');
  });
});
