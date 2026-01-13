/**
 * Authentication Middleware
 *
 * JWT verification and user authentication
 */

import { FastifyRequest, FastifyReply } from 'fastify';

// Extend FastifyRequest type
declare module 'fastify' {
  interface FastifyRequest {
    userId: string | null;
  }
}

/**
 * Authenticate user via JWT
 * Attaches userId to request if valid
 */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const token = request.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    const decoded = await request.jwtVerify<{ sub: string }>();
    request.userId = decoded.sub;
  } catch (err) {
    return reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Invalid or expired token',
    });
  }
}

/**
 * Optional authentication
 * Sets userId if token present and valid, but doesn't reject if missing
 */
export async function optionalAuth(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  try {
    const token = request.headers.authorization?.replace('Bearer ', '');

    if (token) {
      const decoded = await request.jwtVerify<{ sub: string }>();
      request.userId = decoded.sub;
    }
  } catch {
    // Silently ignore invalid tokens for optional auth
    request.userId = null;
  }
}
