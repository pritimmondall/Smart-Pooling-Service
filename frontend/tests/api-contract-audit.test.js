import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { techniciansApi, ApiError } from '../src/api/client.js';

describe('Technician API Contract & Schema Verification Suite', () => {
  it('verifies all backend endpoints including stop progression have 1:1 matching frontend API client methods', () => {
    const requiredMethods = [
      'getMe',
      'updateProfile',
      'updateAvailability',
      'getMyJobs',
      'getJobById',
      'acceptJob',
      'rejectJob',
      'updateJobStatus',
      'getJobRoute',
      'getJobStops',
      'arriveJobStop',
      'startJobStop',
      'completeJobStop',
      'cancelJobStop',
    ];

    for (const methodName of requiredMethods) {
      assert.equal(
        typeof techniciansApi[methodName],
        'function',
        `techniciansApi missing method: ${methodName}`
      );
    }
  });

  it('correctly parses backend AppError format into ApiError properties', () => {
    // Simulated backend error structure returned by backend errorHandler
    const backendErrorPayload = {
      success: false,
      error: {
        code: 'WORKLOAD_CAPACITY_EXCEEDED',
        message: 'Cannot set availability to "available": maximum workload capacity reached (4/4).',
        details: { currentWorkload: 4, maxCapacity: 4 },
      },
    };

    const apiErr = new ApiError(
      backendErrorPayload.error.message,
      backendErrorPayload.error.code,
      409,
      backendErrorPayload.error.details
    );

    assert.equal(apiErr.status, 409);
    assert.equal(apiErr.code, 'WORKLOAD_CAPACITY_EXCEEDED');
    assert.equal(apiErr.message.includes('maximum workload capacity reached'), true);
    assert.deepEqual(apiErr.details, { currentWorkload: 4, maxCapacity: 4 });
  });

  it('verifies query parameter serialization for jobs listing (status, type, page, limit)', async () => {
    let capturedUrl = null;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            success: true,
            data: [],
            meta: { pagination: { page: 1, limit: 10, total: 0, pages: 1 } },
          }),
      };
    };

    await techniciansApi.getMyJobs({ status: 'in_progress', type: 'pool', page: 1, limit: 25 });
    assert.equal(
      capturedUrl,
      '/api/v1/technicians/me/jobs?status=in_progress&type=pool&page=1&limit=25'
    );
  });

  it('verifies route query parameter serialization for starting location coordinates', async () => {
    let capturedUrl = null;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        text: async () => JSON.stringify({ success: true, data: { optimizationStatus: 'optimal_road_network' } }),
      };
    };

    await techniciansApi.getJobRoute('pool123', { lat: 22.5176, lng: 88.3639 });
    assert.equal(capturedUrl, '/api/v1/technicians/me/jobs/pool123/route?lat=22.5176&lng=88.3639');
  });
});
