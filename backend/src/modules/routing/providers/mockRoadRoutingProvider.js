import { BaseRoutingProvider, RoutingProviderError } from './baseRoutingProvider.js';
import { haversineDistanceKm, validateCoordinates } from '../../../utils/geo.js';

/**
 * Mock Road Routing Provider for deterministic unit/integration testing and offline operation.
 * Accurately simulates realistic road-network travel distances (using standard urban road tortuosity of ~1.35x)
 * and realistic driving travel durations (30 km/h average speed in urban Kolkata traffic).
 *
 * Supports test hooks to simulate network timeouts, rate limiting, and service downtime.
 */
export class MockRoadRoutingProvider extends BaseRoutingProvider {
  constructor({
    tortuosityFactor = 1.35,
    averageSpeedKmH = 30,
    simulateTimeout = false,
    simulateUnavailable = false,
    simulateRateLimit = false,
  } = {}) {
    super('mock');
    this.tortuosityFactor = tortuosityFactor;
    this.averageSpeedKmH = averageSpeedKmH;
    this.simulateTimeout = simulateTimeout;
    this.simulateUnavailable = simulateUnavailable;
    this.simulateRateLimit = simulateRateLimit;
  }

  setSimulationFlags({ simulateTimeout, simulateUnavailable, simulateRateLimit } = {}) {
    if (simulateTimeout !== undefined) this.simulateTimeout = simulateTimeout;
    if (simulateUnavailable !== undefined) this.simulateUnavailable = simulateUnavailable;
    if (simulateRateLimit !== undefined) this.simulateRateLimit = simulateRateLimit;
  }

  /**
   * Computes simulated road distance and duration matrix.
   */
  async getDistanceMatrix(coordinates) {
    if (this.simulateTimeout) {
      throw new RoutingProviderError('Mock road routing provider timed out.', 'PROVIDER_TIMEOUT');
    }
    if (this.simulateUnavailable) {
      throw new RoutingProviderError('Mock road routing service is unavailable.', 'PROVIDER_UNAVAILABLE');
    }
    if (this.simulateRateLimit) {
      throw new RoutingProviderError('Mock road routing provider rate limit exceeded.', 'RATE_LIMITED');
    }

    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      throw new RoutingProviderError('At least 2 coordinates are required for distance matrix.', 'INVALID_COORDINATES');
    }

    const validated = coordinates.map((c, i) => {
      try {
        return validateCoordinates(c.lat, c.lng);
      } catch (err) {
        throw new RoutingProviderError(
          `Invalid coordinate at index ${i}: ${err.message}`,
          'INVALID_COORDINATES',
          err
        );
      }
    });

    const n = validated.length;
    const distances = Array.from({ length: n }, () => Array(n).fill(0));
    const durations = Array.from({ length: n }, () => Array(n).fill(0));

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) {
          distances[i][j] = 0;
          durations[i][j] = 0;
        } else {
          const straightKm = haversineDistanceKm(validated[i], validated[j]);
          // Realistic road distance with tortuosity factor
          const roadKm = straightKm * this.tortuosityFactor;
          const roadMeters = Math.round(roadKm * 1000);
          // Duration in seconds = (roadKm / averageSpeedKmH) * 3600
          const durationSeconds = Math.max(60, Math.round((roadKm / this.averageSpeedKmH) * 3600));

          distances[i][j] = roadMeters;
          durations[i][j] = durationSeconds;
        }
      }
    }

    return {
      distances,
      durations,
      provider: 'mock',
    };
  }

  async getRoute(origin, destination) {
    const matrix = await this.getDistanceMatrix([origin, destination]);
    return {
      distanceMeters: matrix.distances[0][1],
      durationSeconds: matrix.durations[0][1],
      provider: 'mock',
    };
  }
}
