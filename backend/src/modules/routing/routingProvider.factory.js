import { env } from '../../config/env.js';
import { OsrmRoutingProvider } from './providers/osrmRoutingProvider.js';
import { MockRoadRoutingProvider } from './providers/mockRoadRoutingProvider.js';

let defaultProviderInstance = null;

/**
 * Creates or retrieves a road routing provider instance.
 * Provider choice is configurable via ROUTING_PROVIDER environment variable ('osrm' | 'mock').
 *
 * @param {string} [providerName]
 * @param {Object} [options]
 * @returns {import('./providers/baseRoutingProvider.js').BaseRoutingProvider}
 */
export function getRoutingProvider(providerName = env.routingProvider, options = {}) {
  const normalized = (providerName || 'osrm').toLowerCase().trim();

  switch (normalized) {
    case 'osrm':
      return new OsrmRoutingProvider({
        baseUrl: options.baseUrl || env.osrmBaseUrl,
        timeoutMs: options.timeoutMs || env.routingTimeoutMs,
      });

    case 'mock':
      return new MockRoadRoutingProvider(options);

    default:
      console.warn(`[Routing] Unrecognized provider "${providerName}"; falling back to OSRM.`);
      return new OsrmRoutingProvider();
  }
}

/**
 * Sets a custom provider instance (used for dependency injection in tests).
 */
export function setDefaultRoutingProvider(provider) {
  defaultProviderInstance = provider;
}

/**
 * Gets the current active singleton or default routing provider.
 */
export function getDefaultRoutingProvider() {
  if (!defaultProviderInstance) {
    defaultProviderInstance = getRoutingProvider();
  }
  return defaultProviderInstance;
}
