import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { techniciansApi } from '../src/api/client.js';
import { formatRouteMetric } from '../src/utils/routeFormatters.js';

describe('Technician Pooled Job Stop Progression Suite (DEF-01 Remediation)', () => {
  it('1. verifies sequential progression eligibility rules across multi-stop pools', () => {
    // Model a 3-stop pooled job
    const stops = [
      { bookingId: 'stop1', sequenceIndex: 1, status: 'accepted', customer: { name: 'Alice' } },
      { bookingId: 'stop2', sequenceIndex: 2, status: 'accepted', customer: { name: 'Bob' } },
      { bookingId: 'stop3', sequenceIndex: 3, status: 'accepted', customer: { name: 'Charlie' } },
    ];

    const evaluateCanProgress = (allStops, index, parentStatus) => {
      const earlierStops = allStops.slice(0, index);
      const earlierIncomplete = earlierStops.find(
        (s) => !['completed', 'cancelled'].includes(s.status)
      );
      return !earlierIncomplete && ['accepted', 'in_progress'].includes(parentStatus);
    };

    // Initial state: parent job is accepted
    assert.equal(evaluateCanProgress(stops, 0, 'accepted'), true, 'Stop 1 must be eligible to progress');
    assert.equal(evaluateCanProgress(stops, 1, 'accepted'), false, 'Stop 2 cannot progress before Stop 1 finishes');
    assert.equal(evaluateCanProgress(stops, 2, 'accepted'), false, 'Stop 3 cannot progress before Stop 1 & 2 finish');

    // Stop 1 arrives
    stops[0].status = 'arrived';
    assert.equal(evaluateCanProgress(stops, 0, 'in_progress'), true, 'Stop 1 can transition arrived -> in_progress');
    assert.equal(evaluateCanProgress(stops, 1, 'in_progress'), false, 'Stop 2 remains blocked');

    // Stop 1 starts
    stops[0].status = 'in_progress';
    assert.equal(evaluateCanProgress(stops, 0, 'in_progress'), true, 'Stop 1 can transition in_progress -> completed');
    assert.equal(evaluateCanProgress(stops, 1, 'in_progress'), false, 'Stop 2 remains blocked');

    // Stop 1 completes
    stops[0].status = 'completed';
    assert.equal(evaluateCanProgress(stops, 1, 'in_progress'), true, 'Stop 2 is now eligible after Stop 1 completes');
    assert.equal(evaluateCanProgress(stops, 2, 'in_progress'), false, 'Stop 3 remains blocked while Stop 2 is incomplete');

    // Stop 2 completes
    stops[1].status = 'completed';
    assert.equal(evaluateCanProgress(stops, 2, 'in_progress'), true, 'Stop 3 is now eligible after Stop 2 completes');

    // Stop 3 completes
    stops[2].status = 'completed';
    const allTerminal = stops.every((s) => ['completed', 'cancelled'].includes(s.status));
    assert.equal(allTerminal, true, 'All stops have reached valid terminal state');
  });

  it('2. verifies arrival, start, and complete API calls send correct HTTP methods and paths', async () => {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
      return {
        ok: true,
        text: async () => JSON.stringify({ success: true, data: { status: 'ok' } }),
      };
    };

    // 1. Arrive
    await techniciansApi.arriveJobStop('pool-99', 'stop-1');
    assert.equal(calls[0].url, '/api/v1/technicians/me/jobs/pool-99/stops/stop-1/arrive');
    assert.equal(calls[0].method, 'POST');

    // 2. Start
    await techniciansApi.startJobStop('pool-99', 'stop-1');
    assert.equal(calls[1].url, '/api/v1/technicians/me/jobs/pool-99/stops/stop-1/start');
    assert.equal(calls[1].method, 'POST');

    // 3. Complete
    await techniciansApi.completeJobStop('pool-99', 'stop-1');
    assert.equal(calls[2].url, '/api/v1/technicians/me/jobs/pool-99/stops/stop-1/complete');
    assert.equal(calls[2].method, 'POST');

    // 4. Get stops
    await techniciansApi.getJobStops('pool-99');
    assert.equal(calls[3].url, '/api/v1/technicians/me/jobs/pool-99/stops');
    assert.equal(calls[3].method, 'GET');
  });

  it('3. confirms standalone individual booking workflow preserves legacy updateJobStatus calls', async () => {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
      return {
        ok: true,
        text: async () => JSON.stringify({ success: true, data: { status: 'in_progress' } }),
      };
    };

    await techniciansApi.updateJobStatus('indiv-123', 'in_progress');
    assert.equal(calls[0].url, '/api/v1/technicians/me/jobs/indiv-123/status');
    assert.equal(calls[0].method, 'PATCH');
    assert.deepEqual(calls[0].body, { status: 'in_progress' });

    await techniciansApi.updateJobStatus('indiv-123', 'completed');
    assert.equal(calls[1].url, '/api/v1/technicians/me/jobs/indiv-123/status');
    assert.equal(calls[1].method, 'PATCH');
    assert.deepEqual(calls[1].body, { status: 'completed' });
  });

  it('4. calculates stop progression percentages and remaining stop counters correctly', () => {
    const stops = [
      { status: 'completed' },
      { status: 'completed' },
      { status: 'in_progress' },
      { status: 'accepted' },
    ];
    const total = stops.length;
    const completed = stops.filter((s) => s.status === 'completed').length;
    const pct = Math.round((completed / total) * 100);

    assert.equal(total, 4);
    assert.equal(completed, 2);
    assert.equal(pct, 50);
  });
});

describe('Route Optimization Metrics Formatter Suite (DEF-03 Remediation)', () => {
  it('1. correctly formats canonical backend { value, unit } structures', () => {
    // Total travel distance
    const dist = formatRouteMetric({ value: 12.34, unit: 'km' }, 'km');
    assert.equal(dist, '12.34 km');

    // Total travel time (minutes normalized to mins)
    const travelTime = formatRouteMetric({ value: 25.5, unit: 'minutes' }, 'mins');
    assert.equal(travelTime, '25.5 mins');

    // Total service duration (integer)
    const serviceDuration = formatRouteMetric({ value: 90, unit: 'minutes' }, 'mins');
    assert.equal(serviceDuration, '90 mins');

    // Total trip duration
    const totalTrip = formatRouteMetric({ value: 115.5, unit: 'minutes' }, 'mins');
    assert.equal(totalTrip, '115.5 mins');
  });

  it('2. properly preserves zero values rather than falling back to N/A', () => {
    // 0 distance
    const zeroDist = formatRouteMetric({ value: 0, unit: 'km' }, 'km');
    assert.equal(zeroDist, '0 km');

    // 0 travel time
    const zeroTime = formatRouteMetric({ value: 0, unit: 'minutes' }, 'mins');
    assert.equal(zeroTime, '0 mins');

    // primitive 0
    const zeroPrimitive = formatRouteMetric(0, 'km');
    assert.equal(zeroPrimitive, '0 km');
  });

  it('3. safely returns N/A for null, undefined, empty, or unpopulated metrics', () => {
    assert.equal(formatRouteMetric(null, 'km'), 'N/A');
    assert.equal(formatRouteMetric(undefined, 'mins'), 'N/A');
    assert.equal(formatRouteMetric({}, 'km'), 'N/A');
    assert.equal(formatRouteMetric({ value: null, unit: 'km' }, 'km'), 'N/A');
    assert.equal(formatRouteMetric({ value: undefined, unit: 'km' }, 'km'), 'N/A');
  });

  it('4. supports direct numbers and legacy { km } / { minutes } formats as fallback', () => {
    // Primitive numbers
    assert.equal(formatRouteMetric(15.75, 'km'), '15.75 km');
    assert.equal(formatRouteMetric(45, 'mins'), '45 mins');

    // Legacy object format
    assert.equal(formatRouteMetric({ km: 5.5 }), '5.5 km');
    assert.equal(formatRouteMetric({ minutes: 30 }), '30 mins');
    assert.equal(formatRouteMetric({ km: 0 }), '0 km');
  });
});
