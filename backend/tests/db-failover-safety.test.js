import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeMongoUri, runInTransaction } from '../src/config/db.js';

describe('Database Environment & Failover Safety Suite', () => {
  it('sanitizeMongoUri masks credentials cleanly from URIs', () => {
    const rawSrv = 'mongodb+srv://admin_user:SuperSecretPassword123@cluster0.a7tmvl1.mongodb.net/smartpool?retryWrites=true';
    const sanitizedSrv = sanitizeMongoUri(rawSrv);
    assert.ok(!sanitizedSrv.includes('SuperSecretPassword123'), 'Raw password must not be present in sanitized URI');
    assert.ok(sanitizedSrv.includes('admin_user:***@cluster0'), 'Password should be masked with ***');

    const rawStandard = 'mongodb://app_service:secretPass@127.0.0.1:27017/smartpool';
    const sanitizedStandard = sanitizeMongoUri(rawStandard);
    assert.ok(!sanitizedStandard.includes('secretPass'));
    assert.ok(sanitizedStandard.includes('app_service:***@127.0.0.1'));

    assert.equal(sanitizeMongoUri(''), 'none');
    assert.equal(sanitizeMongoUri(null), 'none');
    assert.equal(sanitizeMongoUri('mongodb://127.0.0.1:27017/smartpool'), 'mongodb://127.0.0.1:27017/smartpool');
  });

  it('runInTransaction throws TRANSACTIONS_UNSUPPORTED when requireTransaction is true or in production', async () => {
    // When transactionsSupported is false and requireTransaction is true
    await assert.rejects(
      async () => {
        await runInTransaction(async () => {}, { requireTransaction: true });
      },
      (err) => {
        assert.equal(err.code, 'TRANSACTIONS_UNSUPPORTED');
        assert.equal(err.statusCode, 500);
        return true;
      }
    );
  });
});
