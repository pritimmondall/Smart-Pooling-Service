import { env, validateEnv } from './config/env.js';
import { connectDB, disconnectDB } from './config/db.js';
import { Rating } from './models/Rating.js';
import { startPoolWorker, stopPoolWorker } from './modules/pools/poolWorker.js';
import app from './app.js';

async function startServer() {
  validateEnv();
  await connectDB();

  // Ensure critical database indexes exist before accepting requests
  await Rating.createIndexes();

  // Start autonomous pool locking background worker
  startPoolWorker({ intervalMs: 30000 });

  const server = app.listen(env.port, () => {
    console.log(`Smart Service Pooling API listening on port ${env.port} (${env.nodeEnv})`);
  });

  const shutdown = async (signal) => {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    await stopPoolWorker();
    server.close(async () => {
      await disconnectDB();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

startServer().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
