/**
 * Abstract Base Class for Road Routing Providers.
 * All road network providers must implement this interface.
 */
export class BaseRoutingProvider {
  constructor(name) {
    if (new.target === BaseRoutingProvider) {
      throw new TypeError('Cannot construct BaseRoutingProvider instances directly.');
    }
    this.name = name;
  }

  /**
   * Retrieves distance and duration matrices between given coordinates.
   *
   * @param {Array<{ lat: number, lng: number }>} coordinates
   * @returns {Promise<{
   *   distances: number[][], // Matrix of distances in meters
   *   durations: number[][], // Matrix of durations in seconds
   *   provider: string
   * }>}
   */
  async getDistanceMatrix(coordinates) {
    throw new Error('getDistanceMatrix() must be implemented by subclass.');
  }

  /**
   * Retrieves point-to-point driving route between origin and destination.
   *
   * @param {{ lat: number, lng: number }} origin
   * @param {{ lat: number, lng: number }} destination
   * @returns {Promise<{
   *   distanceMeters: number,
   *   durationSeconds: number,
   *   provider: string
   * }>}
   */
  async getRoute(origin, destination) {
    throw new Error('getRoute() must be implemented by subclass.');
  }
}

/**
 * Custom error class for routing provider failures.
 */
export class RoutingProviderError extends Error {
  constructor(message, code = 'PROVIDER_UNAVAILABLE', originalError = null) {
    super(message);
    this.name = 'RoutingProviderError';
    this.code = code;
    this.originalError = originalError;
  }
}
