import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeValue, sanitizeRequest } from '../src/middleware/sanitize.js';
import { validateObjectIdParam, requireBodyFields } from '../src/middleware/validate.js';

function runMiddleware(middleware, req) {
  return new Promise((resolve) => {
    middleware(req, {}, (err) => resolve(err || null));
  });
}

describe('Request Sanitization & Validation Middleware', () => {
  it('strips MongoDB $ operators, dotted keys, and prototype-pollution keys recursively', () => {
    const dirty = {
      email: { $ne: '' },
      'nested.field': 'bad',
      __proto__: { polluted: true },
      items: [{ $gt: 0, safe: 'ok' }],
      name: 'Aarav',
    };

    const clean = sanitizeValue(dirty);
    assert.deepEqual(clean, {
      email: {},
      items: [{ safe: 'ok' }],
      name: 'Aarav',
    });
    assert.equal({}.polluted, undefined);
  });

  it('sanitizes req.body, req.query, and req.params in place', async () => {
    const req = {
      body: { $where: '1==1', title: 'AC' },
      query: { 'status.$ne': 'cancelled', page: '1' },
      params: { id: '123', $bad: 'x' },
    };

    const err = await runMiddleware(sanitizeRequest, req);
    assert.equal(err, null);
    assert.deepEqual(req.body, { title: 'AC' });
    assert.deepEqual(req.query, { page: '1' });
    assert.deepEqual(req.params, { id: '123' });
  });

  it('rejects malformed ObjectId route params with 400 INVALID_ID', async () => {
    const middleware = validateObjectIdParam('id');
    const err = await runMiddleware(middleware, { params: { id: 'not-a-valid-id' } });
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, 'INVALID_ID');

    const ok = await runMiddleware(middleware, { params: { id: '507f1f77bcf86cd799439011' } });
    assert.equal(ok, null);
  });

  it('rejects missing required body fields with 400 VALIDATION_ERROR', async () => {
    const middleware = requireBodyFields('email', 'password');
    const err = await runMiddleware(middleware, { body: { email: 'user@test.com', password: '   ' } });
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, 'VALIDATION_ERROR');
    assert.equal(err.details.length, 1);
    assert.equal(err.details[0].field, 'password');
  });
});
