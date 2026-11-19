import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * Centralized environment configuration for the Express backend.
 */
export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 5001,
  mongodbUri: process.env.MONGODB_URI || '',
  allowLocalDbFallback:
    process.env.NODE_ENV !== 'production' &&
    (process.env.ALLOW_LOCAL_DB_FALLBACK === 'true' || process.env.NODE_ENV === 'development'),
  mongodbFallbackUri:
    process.env.NODE_ENV !== 'production'
      ? process.env.MONGODB_FALLBACK_URI || 'mongodb://127.0.0.1:27017/smartpool?retryWrites=false'
      : '',
  jwtSecret:
    process.env.JWT_SECRET ||
    (process.env.NODE_ENV === 'test' ? 'test-jwt-secret-minimum-32-characters!' : ''),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  travelCostPerKm: Number(process.env.TRAVEL_COST_PER_KM ?? 10),
  routingProvider: process.env.ROUTING_PROVIDER || 'osrm',
  osrmBaseUrl: process.env.OSRM_BASE_URL || 'https://router.project-osrm.org',
  routingTimeoutMs: Number(process.env.ROUTING_TIMEOUT_MS) || 5000,
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
};

/**
 * Validates required runtime secrets and database connection strings before server boot.
 */
export function validateEnv() {
  if (!Number.isFinite(env.travelCostPerKm) || env.travelCostPerKm < 0 || env.travelCostPerKm > 1000) {
    throw new Error('TRAVEL_COST_PER_KM must be between 0 and 1000 INR.');
  }
  const missing = [];
  if (!env.mongodbUri) missing.push('MONGODB_URI');
  if (!env.jwtSecret) missing.push('JWT_SECRET');

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. Copy backend/.env.example to backend/.env and configure them.`
    );
  }

  if (env.nodeEnv !== 'test' && env.jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters long for secure HS256 signing.');
  }
}
