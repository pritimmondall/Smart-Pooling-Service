import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import {
  signAuthToken,
  createAuthMiddleware,
  authorizeRoles,
} from '../src/middleware/auth.js';

function runMiddleware(middleware, req) {
  return new Promise((resolve) => {
    middleware(req, {}, (err) => resolve(err || null));
  });
}

describe('JWT Authentication & RBAC Middleware', () => {
  it('authenticates valid Bearer token and attaches user to req.user', async () => {
    const userId = new mongoose.Types.ObjectId();
    const fakeUser = { _id: userId, role: 'customer', isActive: true };
    const token = signAuthToken(fakeUser);

    const protectMiddleware = createAuthMiddleware(async (id) => {
      assert.equal(id, String(userId));
      return fakeUser;
    });

    const req = { headers: { authorization: `Bearer ${token}` } };
    const err = await runMiddleware(protectMiddleware, req);

    assert.equal(err, null);
    assert.equal(req.user.role, 'customer');
  });

  it('rejects missing or malformed Authorization headers with 401', async () => {
    const protectMiddleware = createAuthMiddleware(async () => null);
    const err = await runMiddleware(protectMiddleware, { headers: {} });
    assert.equal(err.statusCode, 401);
    assert.equal(err.code, 'AUTH_REQUIRED');
  });

  it('rejects inactive accounts with 403', async () => {
    const userId = new mongoose.Types.ObjectId();
    const token = signAuthToken({ _id: userId, role: 'technician' });
    const protectMiddleware = createAuthMiddleware(async () => ({
      _id: userId,
      role: 'technician',
      isActive: false,
    }));

    const err = await runMiddleware(protectMiddleware, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(err.statusCode, 403);
    assert.equal(err.code, 'ACCOUNT_INACTIVE');
  });

  it('enforces role separation across customer, technician, and admin', async () => {
    const adminOnly = authorizeRoles('admin');
    const customerOnly = authorizeRoles('customer');

    const err1 = await runMiddleware(adminOnly, { user: { role: 'customer' } });
    assert.equal(err1.statusCode, 403);
    assert.equal(err1.code, 'FORBIDDEN_ROLE');

    const err2 = await runMiddleware(customerOnly, { user: { role: 'technician' } });
    assert.equal(err2.statusCode, 403);

    const ok = await runMiddleware(adminOnly, { user: { role: 'admin' } });
    assert.equal(ok, null);
  });
});
