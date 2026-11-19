import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { optimizePoolRoute } from '../src/modules/routing/routeOptimization.service.js';
import { MockRoadRoutingProvider } from '../src/modules/routing/providers/mockRoadRoutingProvider.js';
import { OsrmRoutingProvider } from '../src/modules/routing/providers/osrmRoutingProvider.js';
import { BaseRoutingProvider, RoutingProviderError } from '../src/modules/routing/providers/baseRoutingProvider.js';

/**
 * Custom test routing provider for testing arbitrary asymmetric distance matrices.
 */
class AsymmetricMatrixRoutingProvider extends BaseRoutingProvider {
  constructor(durations, distances) {
    super('custom_asymmetric');
    this.customDurations = durations;
    this.customDistances = distances;
  }

  async getDistanceMatrix(coordinates) {
    return {
      durations: this.customDurations,
      distances: this.customDistances,
      provider: 'custom_asymmetric',
    };
  }
}

describe('Phase 5A.1 Route Optimization Algorithm Audit & Road Engine Suite', () => {
  const startLoc = { lat: 22.528, lng: 88.365 };

  it('supports asymmetric road-distance matrices (A -> B != B -> A) and picks the directional optimal path', async () => {
    // 3 stops (Stops 1, 2, 3), indices 0 = start, 1 = stopA, 2 = stopB, 3 = stopC
    // Consider one-way road:
    // Path Start -> A -> B -> C is fast (100 + 100 + 100 = 300s)
    // Path Start -> C -> B -> A is very slow due to one-way detour (500 + 500 + 500 = 1500s)
    const n = 4;
    const durations = Array.from({ length: n }, () => Array(n).fill(1000));
    const distances = Array.from({ length: n }, () => Array(n).fill(10000));

    for (let i = 0; i < n; i++) {
      durations[i][i] = 0;
      distances[i][i] = 0;
    }

    // Fast clockwise direction:
    // 0 -> 1 = 100s, 1 -> 2 = 100s, 2 -> 3 = 100s
    durations[0][1] = 100; distances[0][1] = 1000;
    durations[1][2] = 100; distances[1][2] = 1000;
    durations[2][3] = 100; distances[2][3] = 1000;

    // Slow counter-clockwise:
    // 0 -> 3 = 600s, 3 -> 2 = 600s, 2 -> 1 = 600s
    durations[0][3] = 600; distances[0][3] = 6000;
    durations[3][2] = 600; distances[3][2] = 6000;
    durations[2][1] = 600; distances[2][1] = 6000;

    // Cross routes
    durations[0][2] = 800; distances[0][2] = 8000;
    durations[1][3] = 800; distances[1][3] = 8000;

    const customProvider = new AsymmetricMatrixRoutingProvider(durations, distances);

    const stops = [
      {
        bookingId: 'stop_A',
        customerName: 'Customer A',
        location: { lat: 22.53, lng: 88.36 },
        timeWindow: { start: new Date('2026-11-15T09:00:00Z'), end: new Date('2026-11-15T14:00:00Z') },
        estimatedDurationMins: 15,
      },
      {
        bookingId: 'stop_B',
        customerName: 'Customer B',
        location: { lat: 22.54, lng: 88.37 },
        timeWindow: { start: new Date('2026-11-15T09:00:00Z'), end: new Date('2026-11-15T14:00:00Z') },
        estimatedDurationMins: 15,
      },
      {
        bookingId: 'stop_C',
        customerName: 'Customer C',
        location: { lat: 22.55, lng: 88.38 },
        timeWindow: { start: new Date('2026-11-15T09:00:00Z'), end: new Date('2026-11-15T14:00:00Z') },
        estimatedDurationMins: 15,
      },
    ];

    const result = await optimizePoolRoute({
      technicianStartLocation: startLoc,
      stops,
      departureTime: new Date('2026-11-15T09:00:00Z'),
      routingProvider: customProvider,
    });

    assert.equal(result.optimizationStatus, 'optimal_road_network');
    assert.equal(result.algorithm, 'branch_and_bound_exact');
    assert.equal(result.stops[0].bookingId, 'stop_A');
    assert.equal(result.stops[1].bookingId, 'stop_B');
    assert.equal(result.stops[2].bookingId, 'stop_C');
    assert.equal(result.totalTravelDistance.meters, 3000);
    assert.equal(result.totalTravelTime.seconds, 300);
  });

  it('optimizes multiple stops (N=4 and N=5) correctly with branch-and-bound pruning', async () => {
    const mockProvider = new MockRoadRoutingProvider({ tortuosityFactor: 1.35, averageSpeedKmH: 30 });

    const stops5 = [
      {
        bookingId: 'stop_1',
        customerName: 'Customer 1',
        location: { lat: 22.529, lng: 88.366 },
        timeWindow: { start: new Date('2026-11-15T09:00:00Z'), end: new Date('2026-11-15T15:00:00Z') },
        estimatedDurationMins: 20,
      },
      {
        bookingId: 'stop_2',
        customerName: 'Customer 2',
        location: { lat: 22.535, lng: 88.369 },
        timeWindow: { start: new Date('2026-11-15T09:00:00Z'), end: new Date('2026-11-15T15:00:00Z') },
        estimatedDurationMins: 20,
      },
      {
        bookingId: 'stop_3',
        customerName: 'Customer 3',
        location: { lat: 22.540, lng: 88.372 },
        timeWindow: { start: new Date('2026-11-15T09:00:00Z'), end: new Date('2026-11-15T15:00:00Z') },
        estimatedDurationMins: 20,
      },
      {
        bookingId: 'stop_4',
        customerName: 'Customer 4',
        location: { lat: 22.545, lng: 88.375 },
        timeWindow: { start: new Date('2026-11-15T09:00:00Z'), end: new Date('2026-11-15T15:00:00Z') },
        estimatedDurationMins: 20,
      },
      {
        bookingId: 'stop_5',
        customerName: 'Customer 5',
        location: { lat: 22.550, lng: 88.378 },
        timeWindow: { start: new Date('2026-11-15T09:00:00Z'), end: new Date('2026-11-15T15:00:00Z') },
        estimatedDurationMins: 20,
      },
    ];

    const result = await optimizePoolRoute({
      technicianStartLocation: startLoc,
      stops: stops5,
      departureTime: new Date('2026-11-15T09:00:00Z'),
      routingProvider: mockProvider,
    });

    assert.equal(result.optimizationStatus, 'optimal_road_network');
    assert.equal(result.algorithm, 'branch_and_bound_exact');
    assert.equal(result.isGloballyOptimal, true);
    assert.equal(result.stops.length, 5);
    // Stops along a linear northward corridor must sequence 1 -> 2 -> 3 -> 4 -> 5
    assert.equal(result.stops[0].bookingId, 'stop_1');
    assert.equal(result.stops[1].bookingId, 'stop_2');
    assert.equal(result.stops[2].bookingId, 'stop_3');
    assert.equal(result.stops[3].bookingId, 'stop_4');
    assert.equal(result.stops[4].bookingId, 'stop_5');
  });

  it('evaluates waiting time correctly when technician arrives before window start', async () => {
    const mockProvider = new MockRoadRoutingProvider({ averageSpeedKmH: 30 });

    // Stop 0.5 km away (~1 min driving). Technician departs at 09:00, arrival is ~09:01.
    // Customer window only starts at 09:30.
    // Technician must wait ~29 minutes until 09:30 before starting service!
    const earlyStop = {
      bookingId: 'stop_early',
      customerName: 'Waiting Customer',
      location: { lat: 22.530, lng: 88.365 },
      timeWindow: {
        start: new Date('2026-11-15T09:30:00Z'),
        end: new Date('2026-11-15T11:00:00Z'),
      },
      estimatedDurationMins: 30,
    };

    const result = await optimizePoolRoute({
      technicianStartLocation: startLoc,
      stops: [earlyStop],
      departureTime: new Date('2026-11-15T09:00:00Z'),
      routingProvider: mockProvider,
    });

    assert.equal(result.optimizationStatus, 'optimal_road_network');
    assert.equal(result.stops.length, 1);
    const stopRes = result.stops[0];

    // Estimated arrival ~09:01
    const arr = new Date(stopRes.estimatedArrival);
    assert.ok(arr < new Date('2026-11-15T09:10:00Z'));

    // Estimated service start must be 09:30:00 (waiting until window opens)
    assert.equal(stopRes.estimatedServiceStart, '2026-11-15T09:30:00.000Z');

    // Service ends at 10:00:00 (09:30 + 30 mins)
    assert.equal(stopRes.estimatedServiceEnd, '2026-11-15T10:00:00.000Z');

    // Waiting minutes must be recorded
    assert.ok(stopRes.estimatedTravelFromPrevious.waitingMinutes > 25);
  });

  it('breaks ties deterministically on equal-cost routes', async () => {
    // Symmetrical distance matrix where both tours have identical cost
    const n = 3;
    const durations = [
      [0, 100, 100],
      [100, 0, 100],
      [100, 100, 0],
    ];
    const distances = [
      [0, 1000, 1000],
      [1000, 0, 1000],
      [1000, 1000, 0],
    ];

    const customProvider = new AsymmetricMatrixRoutingProvider(durations, distances);

    const stops = [
      {
        bookingId: 'stop_sym_1',
        customerName: 'Sym 1',
        location: { lat: 22.53, lng: 88.36 },
        timeWindow: { start: new Date('2026-11-15T09:00:00Z'), end: new Date('2026-11-15T12:00:00Z') },
        estimatedDurationMins: 30,
      },
      {
        bookingId: 'stop_sym_2',
        customerName: 'Sym 2',
        location: { lat: 22.54, lng: 88.37 },
        timeWindow: { start: new Date('2026-11-15T09:00:00Z'), end: new Date('2026-11-15T12:00:00Z') },
        estimatedDurationMins: 30,
      },
    ];

    const res1 = await optimizePoolRoute({
      technicianStartLocation: startLoc,
      stops,
      departureTime: new Date('2026-11-15T09:00:00Z'),
      routingProvider: customProvider,
    });

    const res2 = await optimizePoolRoute({
      technicianStartLocation: startLoc,
      stops,
      departureTime: new Date('2026-11-15T09:00:00Z'),
      routingProvider: customProvider,
    });

    // Deterministic results: same sequence on repeat runs
    assert.equal(res1.stops[0].bookingId, res2.stops[0].bookingId);
    assert.equal(res1.stops[1].bookingId, res2.stops[1].bookingId);
    assert.equal(res1.totalTravelDistance.value, res2.totalTravelDistance.value);
  });

  it('separates mock provider from live road network and labels simulated metrics clearly', async () => {
    const mockProvider = new MockRoadRoutingProvider();

    const result = await optimizePoolRoute({
      technicianStartLocation: startLoc,
      stops: [
        {
          bookingId: 'stop_check',
          customerName: 'Check',
          location: { lat: 22.53, lng: 88.36 },
          timeWindow: { start: new Date('2026-11-15T09:00:00Z'), end: new Date('2026-11-15T12:00:00Z') },
          estimatedDurationMins: 30,
        },
      ],
      departureTime: new Date('2026-11-15T09:00:00Z'),
      routingProvider: mockProvider,
    });

    // Verification of mock provider separation:
    assert.equal(result.provider, 'mock');
    assert.equal(result.measurementType, 'simulated_road_network');
    assert.ok(result.limitations.includes('simulated using an urban road tortuosity factor (1.35x)'));
    assert.ok(result.limitations.includes('Not measured on live road traffic'));
  });

  it('parses real OSRM table API responses correctly and handles API failure modes', async () => {
    // 1. Successful OSRM response parsing
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          code: 'Ok',
          durations: [
            [0, 180],
            [190, 0],
          ],
          distances: [
            [0, 1200],
            [1250, 0],
          ],
        }),
      });

      const osrmProvider = new OsrmRoutingProvider({ baseUrl: 'http://osrm-test.local' });
      const matrix = await osrmProvider.getDistanceMatrix([startLoc, { lat: 22.53, lng: 88.36 }]);

      assert.equal(matrix.provider, 'osrm');
      assert.equal(matrix.durations[0][1], 180);
      assert.equal(matrix.distances[0][1], 1200);

      // 2. Unroutable points (null durations in OSRM response)
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          code: 'Ok',
          durations: [
            [0, null],
            [null, 0],
          ],
          distances: [
            [0, null],
            [null, 0],
          ],
        }),
      });

      await assert.rejects(
        async () => {
          await osrmProvider.getDistanceMatrix([startLoc, { lat: 22.53, lng: 88.36 }]);
        },
        (err) => {
          assert.equal(err.name, 'RoutingProviderError');
          assert.equal(err.code, 'NO_ROUTE_FOUND');
          return true;
        }
      );

      // 3. Rate limited (429)
      globalThis.fetch = async () => ({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      });

      await assert.rejects(
        async () => {
          await osrmProvider.getDistanceMatrix([startLoc, { lat: 22.53, lng: 88.36 }]);
        },
        (err) => {
          assert.equal(err.name, 'RoutingProviderError');
          assert.equal(err.code, 'RATE_LIMITED');
          return true;
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
