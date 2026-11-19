import mongoose from 'mongoose';
import { env } from './env.js';
import { AppError } from '../utils/appError.js';

let transactionsSupported = false;

/**
 * Strips credentials from a MongoDB connection URI for safe logging.
 * Returns only the protocol, username, and host/database identifiers.
 */
export function sanitizeMongoUri(uri) {
  if (!uri || typeof uri !== 'string') return 'none';
  try {
    return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
  } catch {
    return '[sanitized-uri]';
  }
}

/**
 * Connects Mongoose to MongoDB with environment-aware failover safety.
 * Production environments strictly enforce primary connection and never silently fall back to local storage.
 */
export async function connectDB(uri = env.mongodbUri) {
  if (!uri) {
    throw new Error('MONGODB_URI is required to connect to MongoDB.');
  }

  mongoose.set('strictQuery', true);
  let activeUri = uri;

  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  } catch (err) {
    const isProduction = env.nodeEnv === 'production';
    const fallbackPermitted = !isProduction && env.allowLocalDbFallback && Boolean(env.mongodbFallbackUri);

    if (!fallbackPermitted) {
      throw new Error(
        `[DB Fatal] Failed to connect to primary MongoDB at ${sanitizeMongoUri(uri)}. Database fallback is disabled in ${env.nodeEnv}. Startup aborted: ${err.message}`
      );
    }

    console.warn(
      `[DB Warning] Failed connecting to primary MongoDB (${sanitizeMongoUri(uri)}): ${err.message}. Explicit fallback is allowed in ${env.nodeEnv}. Attempting connection to ${sanitizeMongoUri(env.mongodbFallbackUri)}...`
    );

    try {
      // Cleanly flush previous connection and client options before fallback attempt
      await mongoose.disconnect();
      await mongoose.connect(env.mongodbFallbackUri, {
        serverSelectionTimeoutMS: 3000,
        retryWrites: false,
      });
      activeUri = env.mongodbFallbackUri;
      console.log(`[DB Info] Connected to fallback local database: ${sanitizeMongoUri(activeUri)}`);
    } catch (fallbackErr) {
      throw new Error(
        `[DB Fatal] Primary MongoDB failed (${err.message}) and local fallback failed (${fallbackErr.message}). Server startup aborted.`
      );
    }
  }

  try {
    const admin = mongoose.connection.db.admin();
    const hello = await admin.command({ hello: 1 });
    transactionsSupported = Boolean(hello.setName || hello.msg === 'isdbgrid');
    if (!transactionsSupported) {
      console.warn(
        '[DB Warning] Connected MongoDB topology is not a Replica Set; multi-document ACID transactions require MongoDB Atlas or a local Replica Set.'
      );
    }
  } catch {
    // Restricted Atlas roles may disallow admin hello command; transactions remain supported on Atlas clusters.
    transactionsSupported = activeUri.startsWith('mongodb+srv://');
  }

  console.log(
    `[DB Info] Active database: ${sanitizeMongoUri(activeUri)} | Replica Set Transactions: ${
      transactionsSupported ? 'SUPPORTED' : 'UNSUPPORTED'
    }`
  );

  return mongoose.connection;
}

/**
 * Closes the active Mongoose connection cleanly.
 */
export async function disconnectDB() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

/**
 * Returns current connection state for health checks.
 */
export function getDbStatus() {
  const stateMap = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  };

  return {
    state: stateMap[mongoose.connection.readyState] || 'unknown',
    transactionsSupported,
  };
}

/**
 * Executes an operation inside a MongoDB ACID transaction when supported.
 * In production or when requireTransaction is true, transaction support is strictly required
 * and will never silently downgrade to non-transactional execution.
 */
export async function runInTransaction(work, { requireTransaction = false } = {}) {
  const enforceTransactions = requireTransaction || env.nodeEnv === 'production';

  if (!transactionsSupported) {
    if (enforceTransactions) {
      throw new AppError(
        500,
        'ACID transactions are required for this operation, but the active database does not support multi-document transactions.',
        'TRANSACTIONS_UNSUPPORTED'
      );
    }
    return work(null);
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } catch (err) {
    const isStandaloneTxError =
      err?.code === 20 ||
      err?.message?.includes('Transaction numbers are only allowed on a replica set member');

    if (isStandaloneTxError && !enforceTransactions) {
      return work(null);
    }
    throw err;
  } finally {
    await session.endSession();
  }
}
