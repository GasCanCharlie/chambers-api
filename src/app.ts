/**
 * Fastify Application Setup
 *
 * Core application configuration with all plugins
 */

import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { env, isDev } from './config/env.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport: isDev
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
    },
  });

  // Security headers
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
  });

  // CORS configuration
  await app.register(cors, {
    origin: true, // Allow all origins for now (mobile app + web testing)
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Rate limiting
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Please slow down. Try again in a moment.',
    }),
  });

  // JWT authentication
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: {
      expiresIn: env.JWT_EXPIRES_IN,
    },
  });

  // Cookie support (for refresh tokens)
  await app.register(cookie, {
    secret: env.JWT_SECRET,
    hook: 'onRequest',
  });

  // WebSocket support (for voice chat)
  await app.register(websocket);

  // Custom decorators
  app.decorateRequest('userId', null);

  // Health check endpoint
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }));

  // Register routes
  await app.register(import('./routes/auth.js'), { prefix: '/api/auth' });
  await app.register(import('./routes/agreements.js'), { prefix: '/api/agreements' });
  await app.register(import('./routes/users.js'), { prefix: '/api/users' });
  await app.register(import('./routes/spaces.js'), { prefix: '/api/spaces' });
  await app.register(import('./routes/journal.js'), { prefix: '/api/journal' });
  await app.register(import('./routes/exercises.js'), { prefix: '/api/exercises' });
  await app.register(import('./routes/reflection.js'), { prefix: '/api/reflection' });
  await app.register(import('./routes/realtime.js'), { prefix: '/api/realtime' });
  await app.register(import('./routes/voice.js'), { prefix: '/api' });
  await app.register(import('./routes/voiceChat.js'), { prefix: '/api' });

  // Global error handler
  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    app.log.error(error);

    // Don't expose internal errors in production
    const statusCode = error.statusCode ?? 500;
    const message = statusCode >= 500 && !isDev
      ? 'An unexpected error occurred'
      : error.message;

    reply.status(statusCode).send({
      statusCode,
      error: error.name,
      message,
    });
  });

  // Not found handler
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: `Route ${request.method} ${request.url} not found`,
    });
  });

  return app;
}
