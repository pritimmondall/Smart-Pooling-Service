import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { optimizePoolRoute } from '../src/modules/routing/routeOptimization.service.js';
import { MockRoadRoutingProvider } from '../src/modules/routing/providers/mockRoadRoutingProvider.js';
import { OsrmRoutingProvider } from '../src/modules/routing/providers/osrmRoutingProvider.js';
import { RoutingProviderError } from '../src/modules/routing/providers/baseRoutingProvider.js';

describe('Phase 5A Route Optimization & Road Network Suite', () => {
  // Technician base location in Central Kolkata (Ballygunge)
  const technicianStart = { lat: 22.528, lng: 88.365 };

  // Sample service pool stops across Kolkata
  const stopSouth = {
    bookingId: 'booking_south_1',
    customerName: 'Aarav Sen',
    customerPhone: '+91-9830000001',
    addressText: 'Jadavpur, Kolkata',
    location: { lat: 22.498, lng: 88.368 }, // ~3.3 km south
    timeWindow: {
      start: new Date('2026-11-15T09:00:00Z'),
      end: new Date('2026-11-15T12:00:00Z'),
    },
    estimatedDurationMins: 45,
  };

  const stopCentral = {
    bookingId: 'booking_central_1',
    customerName: 'Riya Mukherjee',
    customerPhone: '+91-9830000002',
    addressText: 'Ballygunge Circular Road, Kolkata',
    location: { lat: 22.525, lng: 88.362 }, // ~0.4 km from technician base
    timeWindow: {
      start: new Date('2026-11-15T09:00:00Z'),
      end: new Date('2026-11-15T12:00:00Z'),
    },
    estimatedDurationMins: 30,
  };

  const stopNorth = {
    bookingId: 'booking_north_1',
    customerName: 'Subham Roy',
    customerPhone: '+91-9830000003',
    addressText: 'Park Street area, Kolkata',
    location: { lat: 22.551, lng: 88.352 }, // ~2.8 km north
    timeWindow: {
      start: new Date('2026-11-15T09:00:00Z'),
      end: new Date('2026-11-15T12:00:00Z'),
    },
    estimatedDurationMins: 40,
  };

  it('optimizes multiple service locations and sequences the closest stop first', async () => {
    const mockProvider = new MockRoadRoutingProvider({ tortuosityFactor: 1.35, averageSpeedKmH: 30 });

    const result = await optimizePoolRoute({
      technicianStartLocation: technicianStart,
      stops: [stopSouth, stopCentral, stopNorth],
      departureTime: new Date('2026-11-15T09:00:00Z'),
      routingProvider: mockProvider,
    });

    assert.equal(result.optimizationStatus, 'optimal_road_network');
    assert.equal(result.algorithm, 'branch_and_bound_exact');
    assert.equal(result.isGloballyOptimal, true);
    assert.equal(result.roadDistanceCalculated, true);
    assert.equal(result.stops.length, 3);

    // Verify optimal stop sequencing:
    // The exact TSP solver finds the globally minimal road tour:
    // North (2.89 km) -> Central (3.07 km) -> South (3.06 km) = 9.02 km total road distance
    // (avoiding backtracking from Central to North then back to South which would be 9.64 km)
    assert.equal(result.stops[0].bookingId, 'booking_north_1');
    assert.equal(result.stops[0].sequenceIndex, 1);
    assert.equal(result.stops[1].bookingId, 'booking_central_1');
    assert.equal(result.stops[1].sequenceIndex, 2);
    assert.equal(result.stops[2].bookingId, 'booking_south_1');
    assert.equal(result.stops[2].sequenceIndex, 3);
    assert.ok(result.stops[0].estimatedArrival);
    assert.ok(result.stops[0].estimatedServiceStart);
    assert.ok(result.stops[0].estimatedServiceEnd);

    // Total distance and travel time must have appropriate units
    assert.equal(result.totalTravelDistance.unit, 'km');
    assert.ok(result.totalTravelDistance.value > 0);
    assert.equal(result.totalTravelTime.unit, 'minutes');
    assert.ok(result.totalTravelTime.value > 0);
    assert.equal(result.totalServiceDuration.unit, 'minutes');
    assert.equal(result.totalServiceDuration.value, 115); // 45 + 30 + 40
  });

  it('detects infeasible time windows and reports specific conflict details without crashing', async () => {
    const mockProvider = new MockRoadRoutingProvider();

    // Infeasible stop: customer window closes at 09:10, but technician departs at 09:00,
    // and after stopCentral (30 mins service), cannot reach stopInfeasible before 09:10!
    const stopInfeasible = {
      bookingId: 'booking_tight_window',
      customerName: 'Urgent Client',
      customerPhone: '+91-9830000004',
      addressText: 'Salt Lake Sector 5',
      location: { lat: 22.586, lng: 88.421 }, // ~9 km away
      timeWindow: {
        start: new Date('2026-11-15T09:00:00Z'),
        end: new Date('2026-11-15T09:10:00Z'), // Ends 10 mins after departure
      },
      estimatedDurationMins: 30,
    };

    const result = await optimizePoolRoute({
      technicianStartLocation: technicianStart,
      stops: [stopCentral, stopInfeasible],
      departureTime: new Date('2026-11-15T09:00:00Z'),
      routingProvider: mockProvider,
    });

    assert.equal(result.optimizationStatus, 'infeasible_time_windows');
    assert.ok(result.schedulingConflicts.length > 0);
    const conflict = result.schedulingConflicts.find((c) => c.bookingId === 'booking_tight_window');
    assert.ok(conflict, 'Must identify the conflicting booking');
    assert.ok(conflict.delayMinutes > 0, 'Delay must be positive');
    assert.ok(conflict.conflictDescription.includes('past window end'));
  });

  it('handles road-routing provider failure gracefully and never falsely claims road distance', async () => {
    const failingProvider = new MockRoadRoutingProvider({ simulateUnavailable: true });

    const result = await optimizePoolRoute({
      technicianStartLocation: technicianStart,
      stops: [stopCentral, stopSouth],
      departureTime: new Date('2026-11-15T09:00:00Z'),
      routingProvider: failingProvider,
    });

    // Verification of strict requirements:
    // 1. Clear fallback status returned
    assert.equal(result.optimizationStatus, 'provider_unavailable');
    // 2. roadDistanceCalculated must be false
    assert.equal(result.roadDistanceCalculated, false);
    // 3. Must NOT silently claim road distance
    assert.equal(result.totalTravelDistance, null);
    assert.equal(result.totalTravelTime, null);
    // 4. Clear error message explaining why
    assert.ok(result.errorMessage.includes('Straight-line distance was not substituted'));
    // 5. Preserves stops without fabricated arrival timestamps
    assert.equal(result.stops.length, 2);
    assert.equal(result.stops[0].estimatedArrival, null);
  });

  it('handles road-routing provider timeout gracefully and returns fallback status', async () => {
    const timeoutProvider = new MockRoadRoutingProvider({ simulateTimeout: true });

    const result = await optimizePoolRoute({
      technicianStartLocation: technicianStart,
      stops: [stopCentral, stopNorth],
      departureTime: new Date('2026-11-15T09:00:00Z'),
      routingProvider: timeoutProvider,
    });

    assert.equal(result.optimizationStatus, 'provider_unavailable');
    assert.equal(result.roadDistanceCalculated, false);
    assert.equal(result.totalTravelDistance, null);
    assert.ok(result.errorMessage.includes('timed out'));
  });

  it('rejects invalid or out-of-range coordinates with RoutingProviderError', async () => {
    const mockProvider = new MockRoadRoutingProvider();

    await assert.rejects(
      async () => {
        await optimizePoolRoute({
          technicianStartLocation: { lat: 999, lng: 88.365 }, // Invalid latitude > 90
          stops: [stopCentral],
          routingProvider: mockProvider,
        });
      },
      (err) => {
        assert.equal(err.name, 'RoutingProviderError');
        assert.equal(err.code, 'INVALID_COORDINATES');
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await optimizePoolRoute({
          technicianStartLocation: technicianStart,
          stops: [
            {
              bookingId: 'bad_coords',
              location: { lat: 22.5, lng: 'invalid_lng' },
            },
          ],
          routingProvider: mockProvider,
        });
      },
      (err) => {
        assert.equal(err.name, 'RoutingProviderError');
        assert.equal(err.code, 'INVALID_COORDINATES');
        return true;
      }
    );
  });

  it('supports empty stop list cleanly without errors', async () => {
    const mockProvider = new MockRoadRoutingProvider();
    const result = await optimizePoolRoute({
      technicianStartLocation: technicianStart,
      stops: [],
      routingProvider: mockProvider,
    });

    assert.equal(result.optimizationStatus, 'no_stops');
    assert.equal(result.stops.length, 0);
    assert.equal(result.totalTravelDistance.value, 0);
  });
});
