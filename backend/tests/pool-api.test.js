import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import mongoose from 'mongoose';
import app from '../src/app.js';
import { signAuthToken } from '../src/middleware/auth.js';
import { User, ServicePool } from '../src/models/index.js';

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
        // Keep raw string
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

describe('Phase 4 Pool REST API, Privacy Masking & RBAC Suite', () => {
  it('rejects unauthenticated requests to /api/v1/pools/my with 401', async () => {
    const res = await requestApp('GET', '/api/v1/pools/my');
    assert.equal(res.status, 401);
  });

  it('rejects non-admin requests to /api/v1/pools/lock-evaluation with 403', async () => {
    const customerId = new mongoose.Types.ObjectId();
    const originalUserFindById = User.findById;
    User.findById = () => ({
      select: async () => ({ _id: customerId, role: 'customer', isActive: true }),
    });

    try {
      const token = signAuthToken({ _id: customerId, role: 'customer' });
      const res = await requestApp('POST', '/api/v1/pools/lock-evaluation', {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN_ROLE');
    } finally {
      User.findById = originalUserFindById;
    }
  });

  it('masks co-poolers personal identifying information (PII) on GET /api/v1/pools/:id', async () => {
    const customerAId = new mongoose.Types.ObjectId();
    const customerBId = new mongoose.Types.ObjectId();
    const poolId = new mongoose.Types.ObjectId();

    // Mock User.findById for auth
    const originalUserFindById = User.findById;
    User.findById = (id) => ({
      select: async () => ({ _id: customerAId, role: 'customer', isActive: true }),
    });

    // Mock ServicePool.findById
    const originalPoolFindById = ServicePool.findById;
    ServicePool.findById = (id) => {
      const mockQuery = {
        populate: () => mockQuery,
        then: (resolve) =>
          resolve({
            _id: poolId,
            status: 'forming',
            maxCapacity: 4,
            poolRadiusKm: 2,
            lockCutoffTime: new Date(Date.now() + 3600000),
            aggregateTimeWindow: {
              start: new Date(Date.now() + 7200000),
              end: new Date(Date.now() + 10800000),
            },
            pricing: {
              individualBasePrice: 600,
              memberCount: 2,
              discountPercentage: 10,
              finalPricePerMember: 540,
              totalSavingsPerMember: 60,
            },
            members: [
              {
                _id: new mongoose.Types.ObjectId(),
                customerId: { _id: customerAId, name: 'Anil Roy', email: 'anil@secret.com', phone: '+919999999999' },
                bookingId: new mongoose.Types.ObjectId(),
                addressText: 'Flat 4B, Tower 2, Lake Gardens, Kolkata',
                status: 'active',
                joinedAt: new Date(),
              },
              {
                _id: new mongoose.Types.ObjectId(),
                customerId: { _id: customerBId, name: 'Bidisha Sen', email: 'bidisha@secret.com', phone: '+918888888888' },
                bookingId: new mongoose.Types.ObjectId(),
                addressText: '12/1 Jodhpur Park, Near South City Mall, Kolkata',
                status: 'active',
                joinedAt: new Date(),
              },
            ],
            toObject() {
              return JSON.parse(JSON.stringify(this));
            },
          }),
      };
      return mockQuery;
    };

    try {
      const token = signAuthToken({ _id: customerAId, role: 'customer' });
      const res = await requestApp('GET', `/api/v1/pools/${poolId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      assert.equal(res.status, 200);
      const members = res.body.data.members;
      assert.equal(members.length, 2);

      // Customer A is viewing self
      const memberA = members.find((m) => m.isCurrentUser);
      assert.ok(memberA);
      assert.equal(memberA.displayName, 'Anil Roy');
      assert.equal(memberA.addressText, 'Flat 4B, Tower 2, Lake Gardens, Kolkata');

      // Customer B is a co-pooler: PII MUST be masked
      const memberB = members.find((m) => !m.isCurrentUser);
      assert.ok(memberB);
      assert.equal(memberB.displayName, 'Bidisha S.', 'Name must be masked to first name and last initial');
      assert.equal(memberB.phone, undefined, 'Phone must never be exposed');
      assert.equal(memberB.email, undefined, 'Email must never be exposed');
      assert.ok(
        !memberB.approximateAddress.includes('12/1'),
        'Exact house/door number must be stripped from approximate address'
      );
    } finally {
      User.findById = originalUserFindById;
      ServicePool.findById = originalPoolFindById;
    }
  });

  it('rejects access to /api/v1/pools/:id for customers who are not members of that pool with 403', async () => {
    const outsiderId = new mongoose.Types.ObjectId();
    const customerAId = new mongoose.Types.ObjectId();
    const poolId = new mongoose.Types.ObjectId();

    const originalUserFindById = User.findById;
    User.findById = (id) => ({
      select: async () => ({ _id: outsiderId, role: 'customer', isActive: true }),
    });

    const originalPoolFindById = ServicePool.findById;
    ServicePool.findById = (id) => {
      const mockQuery = {
        populate: () => mockQuery,
        then: (resolve) =>
          resolve({
            _id: poolId,
            status: 'forming',
            members: [
              {
                customerId: customerAId,
                status: 'active',
              },
            ],
            toObject() {
              return JSON.parse(JSON.stringify(this));
            },
          }),
      };
      return mockQuery;
    };

    try {
      const token = signAuthToken({ _id: outsiderId, role: 'customer' });
      const res = await requestApp('GET', `/api/v1/pools/${poolId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN_POOL_ACCESS');
    } finally {
      User.findById = originalUserFindById;
      ServicePool.findById = originalPoolFindById;
    }
  });

  it('includes accepted pools in GET /api/v1/pools/my query filter and preserves ownership (D-5)', async () => {
    const customerId = new mongoose.Types.ObjectId();
    const originalUserFindById = User.findById;
    User.findById = (id) => ({
      select: async () => ({ _id: customerId, role: 'customer', isActive: true }),
    });

    let capturedFilter = null;
    const originalPoolFind = ServicePool.find;
    ServicePool.find = (filter) => {
      capturedFilter = filter;
      const mockQuery = {
        populate: () => mockQuery,
        sort: () => mockQuery,
        then: (resolve) =>
          resolve([
            {
              _id: new mongoose.Types.ObjectId(),
              status: 'accepted',
              members: [
                {
                  customerId: { _id: customerId, name: 'Alice Customer' },
                  status: 'active',
                },
              ],
              toObject() {
                return JSON.parse(JSON.stringify(this));
              },
            },
          ]),
      };
      return mockQuery;
    };

    try {
      const token = signAuthToken({ _id: customerId, role: 'customer' });
      const res = await requestApp('GET', '/api/v1/pools/my', {
        headers: { Authorization: `Bearer ${token}` },
      });

      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.data));
      assert.equal(res.body.data.length, 1);
      assert.equal(res.body.data[0].status, 'accepted');

      // Check captured filter contains 'accepted'
      assert.ok(capturedFilter);
      assert.ok(Array.isArray(capturedFilter.status?.$in));
      assert.ok(capturedFilter.status.$in.includes('accepted'), 'status filter must include accepted');
      assert.ok(capturedFilter.status.$in.includes('assigned'), 'status filter must include assigned');
      assert.ok(capturedFilter.status.$in.includes('in_progress'), 'status filter must include in_progress');
      assert.equal(capturedFilter.status.$in.includes('completed'), false, 'status filter must not include completed');
      assert.equal(capturedFilter.status.$in.includes('cancelled'), false, 'status filter must not include cancelled');
      assert.equal(capturedFilter.members.$elemMatch.status, 'active');
      assert.equal(String(capturedFilter.members.$elemMatch.customerId), String(customerId));
    } finally {
      User.findById = originalUserFindById;
      ServicePool.find = originalPoolFind;
    }
  });
});
