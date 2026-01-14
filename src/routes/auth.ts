/**
 * Authentication Routes
 *
 * Handles verification, registration, and session management
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import * as argon2 from 'argon2';
import { nanoid } from 'nanoid';
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import { authenticate } from '../middleware/auth.js';
import crypto from 'crypto';

// ============================================================================
// Validation Schemas
// ============================================================================

const startVerificationSchema = z.object({
  method: z.enum(['EMAIL', 'CREDENTIAL', 'REFERRAL']),
  email: z.string().email().optional(),
  referralCode: z.string().optional(),
});

const completeVerificationSchema = z.object({
  verificationId: z.string(),
  code: z.string().optional(), // Email verification code
});

const registerSchema = z.object({
  verificationId: z.string(),
  pseudonym: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/, {
    message: 'Pseudonym can only contain letters, numbers, and underscores',
  }),
  pin: z.string().length(6).regex(/^\d+$/, {
    message: 'PIN must be 6 digits',
  }),
  yearsOnBench: z.string().optional(),
  courtType: z.enum(['FEDERAL', 'STATE', 'TRIBAL', 'ADMINISTRATIVE', 'MUNICIPAL']).optional(),
});

const loginSchema = z.object({
  pseudonym: z.string(),
  pin: z.string(),
  deviceId: z.string(),
  deviceName: z.string().optional(),
});

const refreshTokenSchema = z.object({
  refreshToken: z.string(),
});

// ============================================================================
// Route Handler
// ============================================================================

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Start verification process
   * POST /api/auth/verify/start
   */
  app.post('/verify/start', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = startVerificationSchema.parse(request.body);

    // TEMPORARY: Auto-verify all email verifications during testing
    // TODO: Remove this and implement proper email verification
    const shouldAutoVerify = body.method === 'EMAIL';

    // Hash email if provided (we never store plain emails)
    let emailHash: string | undefined;
    let verification;

    if (body.email) {
      emailHash = crypto
        .createHash('sha256')
        .update(body.email.toLowerCase())
        .digest('hex');

      // Check if already exists with this email
      const existing = await prisma.verification.findUnique({
        where: { emailHash },
      });

      if (existing) {
        // If already verified and used for registration, reject
        if (existing.status === 'VERIFIED' && existing.userId) {
          return reply.status(400).send({
            statusCode: 400,
            error: 'Already Registered',
            message: 'This email has already been used to create an account. Please sign in.',
          });
        }

        // For admin emails, always update to VERIFIED
        if (shouldAutoVerify) {
          verification = await prisma.verification.update({
            where: { id: existing.id },
            data: { status: 'VERIFIED' },
          });
        } else {
          verification = existing;
        }
      }
    }

    // Create new verification record if none exists
    if (!verification) {
      verification = await prisma.verification.create({
        data: {
          method: body.method,
          emailHash,
          referralCode: body.referralCode,
          status: shouldAutoVerify ? 'VERIFIED' : 'PENDING',
        },
      });
    }

    return reply.status(201).send({
      verificationId: verification.id,
      status: verification.status,
      method: verification.method,
      message: getVerificationMessage(body.method),
    });
  });

  /**
   * Check verification status
   * GET /api/auth/verify/:id/status
   */
  app.get('/verify/:id/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const verification = await prisma.verification.findUnique({
      where: { id },
    });

    if (!verification) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Verification not found',
      });
    }

    return {
      status: verification.status,
      method: verification.method,
      canProceed: verification.status === 'VERIFIED',
    };
  });

  /**
   * Complete registration after verification
   * POST /api/auth/register
   */
  app.post('/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = registerSchema.parse(request.body);

    // Check verification
    const verification = await prisma.verification.findUnique({
      where: { id: body.verificationId },
    });

    if (!verification || verification.status !== 'VERIFIED') {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Invalid Verification',
        message: 'Please complete verification first',
      });
    }

    if (verification.userId) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Already Registered',
        message: 'This verification has already been used',
      });
    }

    // Check pseudonym availability
    const existingUser = await prisma.user.findUnique({
      where: { pseudonym: body.pseudonym },
    });

    if (existingUser) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Pseudonym Taken',
        message: 'This pseudonym is already in use. Please choose another.',
      });
    }

    // Hash PIN
    const pinHash = await argon2.hash(body.pin, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    // Create user and update verification in transaction
    const user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          pseudonym: body.pseudonym,
          pinHash,
          yearsOnBench: body.yearsOnBench,
          courtType: body.courtType,
        },
      });

      await tx.verification.update({
        where: { id: body.verificationId },
        data: { userId: newUser.id },
      });

      // Create default preferences
      await tx.userPreferences.create({
        data: { userId: newUser.id },
      });

      return newUser;
    });

    // Generate tokens
    const { accessToken, refreshToken } = await generateTokens(app, user.id);

    return reply.status(201).send({
      user: {
        id: user.id,
        pseudonym: user.pseudonym,
        yearsOnBench: user.yearsOnBench,
        courtType: user.courtType,
      },
      accessToken,
      refreshToken,
    });
  });

  /**
   * Login with pseudonym and PIN
   * POST /api/auth/login
   */
  app.post('/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = loginSchema.parse(request.body);

    const user = await prisma.user.findUnique({
      where: { pseudonym: body.pseudonym },
    });

    if (!user || !user.isActive) {
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Invalid credentials',
      });
    }

    // Verify PIN
    const validPin = await argon2.verify(user.pinHash, body.pin);

    if (!validPin) {
      // Log failed attempt (for security monitoring)
      await prisma.auditLog.create({
        data: {
          action: 'auth.login.failed',
          userId: user.id,
          metadata: JSON.stringify({ deviceId: body.deviceId }),
        },
      });

      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Invalid credentials',
      });
    }

    // Generate tokens
    const { accessToken, refreshToken } = await generateTokens(app, user.id);

    // Create session
    await prisma.session.create({
      data: {
        userId: user.id,
        deviceId: body.deviceId,
        deviceName: body.deviceName,
        refreshToken: await argon2.hash(refreshToken),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      },
    });

    // Update last active
    await prisma.user.update({
      where: { id: user.id },
      data: { lastActiveAt: new Date() },
    });

    // Log successful login
    await prisma.auditLog.create({
      data: {
        action: 'auth.login.success',
        userId: user.id,
        metadata: JSON.stringify({ deviceId: body.deviceId }),
      },
    });

    return {
      user: {
        id: user.id,
        pseudonym: user.pseudonym,
        yearsOnBench: user.yearsOnBench,
        courtType: user.courtType,
        isGuide: user.isGuide,
      },
      accessToken,
      refreshToken,
    };
  });

  /**
   * Refresh access token
   * POST /api/auth/refresh
   */
  app.post('/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = refreshTokenSchema.parse(request.body);

    // Find session with matching refresh token
    const sessions = await prisma.session.findMany({
      where: {
        expiresAt: { gt: new Date() },
      },
      include: { user: true },
    });

    let validSession = null;
    for (const session of sessions) {
      const valid = await argon2.verify(session.refreshToken, body.refreshToken);
      if (valid) {
        validSession = session;
        break;
      }
    }

    if (!validSession) {
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Invalid refresh token',
      });
    }

    // Generate new tokens
    const { accessToken, refreshToken: newRefreshToken } = await generateTokens(
      app,
      validSession.userId
    );

    // Update session with new refresh token
    await prisma.session.update({
      where: { id: validSession.id },
      data: {
        refreshToken: await argon2.hash(newRefreshToken),
        lastUsedAt: new Date(),
      },
    });

    return {
      accessToken,
      refreshToken: newRefreshToken,
    };
  });

  /**
   * Logout (invalidate session)
   * POST /api/auth/logout
   */
  app.post('/logout', { preHandler: [authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = refreshTokenSchema.parse(request.body);

    // Find and delete the session
    const sessions = await prisma.session.findMany({
      where: { userId: request.userId! },
    });

    for (const session of sessions) {
      const valid = await argon2.verify(session.refreshToken, body.refreshToken);
      if (valid) {
        await prisma.session.delete({ where: { id: session.id } });
        break;
      }
    }

    await prisma.auditLog.create({
      data: {
        action: 'auth.logout',
        userId: request.userId,
      },
    });

    return { message: 'Logged out successfully' };
  });

  /**
   * Logout all sessions
   * POST /api/auth/logout-all
   */
  app.post('/logout-all', { preHandler: [authenticate] }, async (request: FastifyRequest) => {
    await prisma.session.deleteMany({
      where: { userId: request.userId! },
    });

    await prisma.auditLog.create({
      data: {
        action: 'auth.logout.all',
        userId: request.userId,
      },
    });

    return { message: 'All sessions terminated' };
  });
}

// ============================================================================
// Helper Functions
// ============================================================================

async function generateTokens(
  app: FastifyInstance,
  userId: string
): Promise<{ accessToken: string; refreshToken: string }> {
  const accessToken = app.jwt.sign(
    { sub: userId },
    { expiresIn: env.JWT_EXPIRES_IN }
  );

  const refreshToken = nanoid(64);

  return { accessToken, refreshToken };
}

function getVerificationMessage(method: string): string {
  switch (method) {
    case 'EMAIL':
      return 'Please check your email for a verification link.';
    case 'CREDENTIAL':
      return 'Your credentials will be reviewed within 48 hours.';
    case 'REFERRAL':
      return 'Your referral code has been submitted for verification.';
    default:
      return 'Verification in progress.';
  }
}
