import { BaseRoutingProvider, RoutingProviderError } from './baseRoutingProvider.js';
import { env } from '../../../config/env.js';
import { validateCoordinates } from '../../../utils/geo.js';

/**
 * Open Source Routing Machine (OSRM) Road Network Provider.
 * Uses OSRM driving profile to compute genuine road-network travel distances (meters)
 * and travel durations (seconds).
 */
export class OsrmRoutingProvider extends BaseRoutingProvider {
  constructor({ baseUrl = env.osrmBaseUrl, timeoutMs = env.routingTimeoutMs } = {}) {
    super('osrm');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  /**
   * Computes road distance (meters) and travel duration (seconds) matrix for given coordinates.
   *
   * @param {Array<{ lat: number, lng: number }>} coordinates
   * @returns {Promise<{ distances: number[][], durations: number[][], provider: string }>}
   */
  async getDistanceMatrix(coordinates) {
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      throw new RoutingProviderError('At least 2 coordinates are required for distance matrix.', 'INVALID_COORDINATES');
    }

    // Validate coordinates
    const validated = coordinates.map((c, i) => {
      try {
        return validateCoordinates(c.lat, c.lng);
      } catch (err) {
        throw new RoutingProviderError(
          `Invalid coordinate at index ${i} (${c?.lat}, ${c?.lng}): ${err.message}`,
          'INVALID_COORDINATES',
          err
        );
      }
    });

    // OSRM coordinates format: {longitude},{latitude};{longitude},{latitude}
    const coordString = validated.map((c) => `${c.lng},${c.lat}`).join(';');
    const url = `${this.baseUrl}/table/v1/driving/${coordString}?annotations=duration,distance`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'SmartPool-Backend/1.0',
        },
        signal: controller.signal,
      });

      if (response.status === 429) {
        throw new RoutingProviderError('OSRM road routing rate limit exceeded.', 'RATE_LIMITED');
      }

      if (!response.ok) {
        throw new RoutingProviderError(
          `OSRM routing server returned HTTP status ${response.status}: ${response.statusText}`,
          'PROVIDER_ERROR'
        );
      }

      const data = await response.json();

      if (data.code !== 'Ok') {
        throw new RoutingProviderError(
          `OSRM table API error: ${data.message || data.code}`,
          'PROVIDER_INVALID_RESPONSE'
        );
      }

      if (!Array.isArray(data.durations) || !Array.isArray(data.distances)) {
        throw new RoutingProviderError(
          'OSRM response missing duration or distance matrices.',
          'PROVIDER_MALFORMED_DATA'
        );
      }

      // Handle any null entries in matrix (unroutable points)
      const n = coordinates.length;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i !== j && (data.durations[i][j] === null || data.distances[i][j] === null)) {
            throw new RoutingProviderError(
              `No viable road route found between point ${i} and point ${j}.`,
              'NO_ROUTE_FOUND'
            );
          }
        }
      }

      return {
        distances: data.distances, // in meters
        durations: data.durations, // in seconds
        provider: 'osrm',
      };
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new RoutingProviderError(
          `OSRM routing request timed out after ${this.timeoutMs}ms.`,
          'PROVIDER_TIMEOUT',
          err
        );
      }
      if (err instanceof RoutingProviderError) {
        throw err;
      }
      throw new RoutingProviderError(
        `OSRM routing service unavailable: ${err.message}`,
        'PROVIDER_UNAVAILABLE',
        err
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Retrieves driving route between origin and destination.
   */
  async getRoute(origin, destination) {
    const matrix = await this.getDistanceMatrix([origin, destination]);
    return {
      distanceMeters: matrix.distances[0][1],
      durationSeconds: matrix.durations[0][1],
      provider: 'osrm',
    };
  }
}
