import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError,
  authApi,
  servicesApi,
  zonesApi,
  bookingsApi,
  notificationsApi,
  techniciansApi,
} from '../src/api/client.js';

describe('Frontend API Client Suite', () => {
  it('instantiates ApiError with message, code, status, and details', () => {
    const err = new ApiError('Service not found', 'SERVICE_NOT_FOUND', 404, [{ field: 'id' }]);
    assert.equal(err.message, 'Service not found');
    assert.equal(err.code, 'SERVICE_NOT_FOUND');
    assert.equal(err.status, 404);
    assert.deepEqual(err.details, [{ field: 'id' }]);
  });

  it('zonesApi.listActive builds query string correctly for geospatial proximity', async () => {
    let capturedUrl = null;
    globalThis.fetch = mock.fn(async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        text: async () => JSON.stringify({ success: true, data: [] }),
      };
    });

    await zonesApi.listActive({ lat: 22.5015, lng: 88.3531, radiusKm: 5 });
    assert.equal(capturedUrl, '/api/v1/zones?lat=22.5015&lng=88.3531&radiusKm=5');

    await zonesApi.listActive();
    assert.equal(capturedUrl, '/api/v1/zones');
  });

  it('bookingsApi methods call proper endpoints with query parameters', async () => {
    let lastUrl = null;
    let lastMethod = null;
    let lastBody = null;

    globalThis.fetch = mock.fn(async (url, opts) => {
      lastUrl = url;
      lastMethod = opts.method;
      lastBody = opts.body ? JSON.parse(opts.body) : null;
      return {
        ok: true,
        text: async () => JSON.stringify({ success: true, data: { _id: 'b123' } }),
      };
    });

    await bookingsApi.getMyBookings({ status: 'pending', page: 1, limit: 10 });
    assert.equal(lastUrl, '/api/v1/bookings/my?status=pending&page=1&limit=10');
    assert.equal(lastMethod, 'GET');

    await bookingsApi.create({ serviceCategoryId: 's1', addressText: 'Kolkata' });
    assert.equal(lastUrl, '/api/v1/bookings');
    assert.equal(lastMethod, 'POST');
    assert.deepEqual(lastBody, { serviceCategoryId: 's1', addressText: 'Kolkata' });

    await bookingsApi.cancel('b123');
    assert.equal(lastUrl, '/api/v1/bookings/b123/cancel');
    assert.equal(lastMethod, 'PATCH');
  });

  it('notificationsApi methods call proper endpoints', async () => {
    let lastUrl = null;
    let lastMethod = null;

    globalThis.fetch = mock.fn(async (url, opts) => {
      lastUrl = url;
      lastMethod = opts.method;
      return {
        ok: true,
        text: async () => JSON.stringify({ success: true, data: [] }),
      };
    });

    await notificationsApi.getMyNotifications({ unreadOnly: true });
    assert.equal(lastUrl, '/api/v1/notifications/my?unreadOnly=true');

    await notificationsApi.markAsRead('n999');
    assert.equal(lastUrl, '/api/v1/notifications/n999/read');
    assert.equal(lastMethod, 'PATCH');
  });

  it('techniciansApi methods call proper endpoints and formats payload/queries correctly', async () => {
    let lastUrl = null;
    let lastMethod = null;
    let lastBody = null;

    globalThis.fetch = mock.fn(async (url, opts) => {
      lastUrl = url;
      lastMethod = opts.method;
      lastBody = opts.body ? JSON.parse(opts.body) : null;
      return {
        ok: true,
        text: async () => JSON.stringify({ success: true, data: { _id: 'job456' } }),
      };
    });

    // 1. getMe
    await techniciansApi.getMe();
    assert.equal(lastUrl, '/api/v1/technicians/me');
    assert.equal(lastMethod, 'GET');

    // 2. updateAvailability
    await techniciansApi.updateAvailability({ availabilityStatus: 'available' });
    assert.equal(lastUrl, '/api/v1/technicians/me/availability');
    assert.equal(lastMethod, 'PATCH');
    assert.deepEqual(lastBody, { availabilityStatus: 'available' });

    // 3. getMyJobs with filters
    await techniciansApi.getMyJobs({ status: 'assigned', type: 'pool', page: 2, limit: 15 });
    assert.equal(lastUrl, '/api/v1/technicians/me/jobs?status=assigned&type=pool&page=2&limit=15');
    assert.equal(lastMethod, 'GET');

    // 4. getJobById
    await techniciansApi.getJobById('job456');
    assert.equal(lastUrl, '/api/v1/technicians/me/jobs/job456');
    assert.equal(lastMethod, 'GET');

    // 5. acceptJob
    await techniciansApi.acceptJob('job456');
    assert.equal(lastUrl, '/api/v1/technicians/me/jobs/job456/accept');
    assert.equal(lastMethod, 'POST');

    // 6. rejectJob
    await techniciansApi.rejectJob('job456', 'Schedule conflict');
    assert.equal(lastUrl, '/api/v1/technicians/me/jobs/job456/reject');
    assert.equal(lastMethod, 'POST');
    assert.deepEqual(lastBody, { reason: 'Schedule conflict' });

    // 7. updateJobStatus
    await techniciansApi.updateJobStatus('job456', 'in_progress');
    assert.equal(lastUrl, '/api/v1/technicians/me/jobs/job456/status');
    assert.equal(lastMethod, 'PATCH');
    assert.deepEqual(lastBody, { status: 'in_progress' });

    // 8. getJobRoute with coordinates
    await techniciansApi.getJobRoute('job456', { lat: 22.51, lng: 88.36 });
    assert.equal(lastUrl, '/api/v1/technicians/me/jobs/job456/route?lat=22.51&lng=88.36');
    assert.equal(lastMethod, 'GET');

    // 9. getJobStops
    await techniciansApi.getJobStops('pool123');
    assert.equal(lastUrl, '/api/v1/technicians/me/jobs/pool123/stops');
    assert.equal(lastMethod, 'GET');

    // 10. arriveJobStop
    await techniciansApi.arriveJobStop('pool123', 'stopA', { latitude: 22.5, longitude: 88.3 });
    assert.equal(lastUrl, '/api/v1/technicians/me/jobs/pool123/stops/stopA/arrive');
    assert.equal(lastMethod, 'POST');
    assert.deepEqual(lastBody, { latitude: 22.5, longitude: 88.3 });

    // 11. startJobStop
    await techniciansApi.startJobStop('pool123', 'stopA');
    assert.equal(lastUrl, '/api/v1/technicians/me/jobs/pool123/stops/stopA/start');
    assert.equal(lastMethod, 'POST');

    // 12. completeJobStop
    await techniciansApi.completeJobStop('pool123', 'stopA');
    assert.equal(lastUrl, '/api/v1/technicians/me/jobs/pool123/stops/stopA/complete');
    assert.equal(lastMethod, 'POST');

    // 13. cancelJobStop
    await techniciansApi.cancelJobStop('pool123', 'stopA', 'Customer absent');
    assert.equal(lastUrl, '/api/v1/technicians/me/jobs/pool123/stops/stopA/cancel');
    assert.equal(lastMethod, 'POST');
    assert.deepEqual(lastBody, { reason: 'Customer absent' });
  });
});
