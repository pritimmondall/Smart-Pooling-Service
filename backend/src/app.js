import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import { env } from './config/env.js';
import { getDbStatus } from './config/db.js';
import { sanitizeRequest } from './middleware/sanitize.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import { sendSuccess } from './utils/response.js';

import authRoutes from './modules/auth/auth.routes.js';
import userRoutes from './modules/users/user.routes.js';
import serviceRoutes from './modules/services/service.routes.js';
import zoneRoutes from './modules/zones/zone.routes.js';
import technicianRoutes from './modules/technicians/technician.routes.js';
import bookingRoutes from './modules/bookings/booking.routes.js';
import poolRoutes from './modules/pools/pool.routes.js';
import notificationRoutes from './modules/notifications/notification.routes.js';
import ratingRoutes from './modules/ratings/rating.routes.js';

/**
 * Builds and configures the Express application without side effects (no DB connect / listen).
 */
export function createApp() {
  const app = express();

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        connectSrc: ["'self'", 'https://nominatim.openstreetmap.org'],
        imgSrc: ["'self'", 'data:', 'https://*.tile.openstreetmap.org'],
        upgradeInsecureRequests: env.nodeEnv === 'production' ? [] : null,
      },
    },
  }));
  app.use(
    cors({
      origin: env.clientOrigin,
      credentials: true,
    })
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(sanitizeRequest);

  if (env.nodeEnv !== 'test') {
    app.use(morgan('dev'));
  }

  app.get('/api/v1/health', (_req, res) => {
    return sendSuccess(res, {
      message: 'Service healthy.',
      data: {
        service: 'smart-pool-backend',
        phase: 2,
        environment: env.nodeEnv,
        database: getDbStatus(),
        timestamp: new Date().toISOString(),
      },
    });
  });

  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/users', userRoutes);
  app.use('/api/v1/services', serviceRoutes);
  app.use('/api/v1/zones', zoneRoutes);
  app.use('/api/v1/technicians', technicianRoutes);
  app.use('/api/technician', technicianRoutes);
  app.use('/api/technicians', technicianRoutes);
  app.use('/api/v1/bookings', bookingRoutes);
  app.use('/api/v1/pools', poolRoutes);
  app.use('/api/v1/notifications', notificationRoutes);
  app.use('/api/v1/ratings', ratingRoutes);

  const index = fileURLToPath(new URL('../../frontend/dist/index.html', import.meta.url));
  if (existsSync(index)) {
    app.use(express.static(fileURLToPath(new URL('../../frontend/dist/', import.meta.url))));
    app.get(/^(?!\/api(?:\/|$))[^.]*$/, (_req, res) => res.sendFile(index));
  }
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

const app = createApp();
export default app;
