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
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      directives: {
        connectSrc: ["'self'", 'https://nominatim.openstreetmap.org'],
        imgSrc: ["'self'", 'data:', 'https://*.tile.openstreetmap.org'],
        upgradeInsecureRequests: env.nodeEnv === 'production' ? [] : null,
      },
    },
  }));

  const parseAllowedOrigins = (raw) => {
    if (!raw) return ['http://localhost:5173'];
    return raw
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean);
  };
  const allowedOrigins = parseAllowedOrigins(env.clientOrigin);

  const isOriginAllowed = (origin) => {
    // Allow requests with no origin (e.g. mobile apps, curl, uptime/health checks)
    if (!origin) return true;
    const cleanOrigin = origin.replace(/\/+$/, '');
    if (allowedOrigins.includes('*') || allowedOrigins.includes(cleanOrigin)) {
      return true;
    }
    // Automatically allow all Vercel deployment domains and local development
    try {
      const url = new URL(cleanOrigin);
      if (
        url.hostname.endsWith('.vercel.app') ||
        url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1'
      ) {
        return true;
      }
    } catch {
      // ignore URL parsing failures
    }
    // Support custom wildcards in allowedOrigins (e.g. *.yourdomain.com)
    return allowedOrigins.some((allowed) => {
      if (allowed.includes('*')) {
        const regex = new RegExp('^' + allowed.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
        return regex.test(cleanOrigin);
      }
      return false;
    });
  };

  const corsOptions = {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true,
  };

  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions));
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
