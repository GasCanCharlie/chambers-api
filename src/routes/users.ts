/**
 * User Routes
 *
 * Profile management and user interactions
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import * as argon2 from 'argon2';
import { prisma } from '../config/database.js';
import { authenticate } from '../middleware/auth.js';

// ============================================================================
// Validation Schemas
// ============================================================================

const updateProfileSchema = z.object({
  pseudonym: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/).optional(),
  yearsOnBench: z.string().optional(),
  courtType: z.enum(['FEDERAL', 'STATE', 'TRIBAL', 'ADMINISTRATIVE', 'MUNICIPAL']).optional().nullable(),

  // NEW: Detailed segmentation fields
  stateJurisdiction: z.enum([
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
    'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
    'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
    'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
    'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'
  ]).optional().nullable(),
  federalCircuit: z.enum([
    'FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH',
    'SEVENTH', 'EIGHTH', 'NINTH', 'TENTH', 'ELEVENTH', 'DC', 'FEDERAL'
  ]).optional().nullable(),
  courtLevel: z.enum(['TRIAL', 'APPELLATE', 'SUPREME', 'SPECIALIZED']).optional().nullable(),
  judgeType: z.enum(['ELECTED', 'APPOINTED', 'MAGISTRATE', 'COMMISSIONER']).optional().nullable(),
  specializations: z.array(z.enum([
    'TRAFFIC', 'MISDEMEANORS', 'FELONIES', 'SMALL_CLAIMS', 'REGULAR_CLAIMS',
    'LARGE_CLAIMS', 'ENVIRONMENTAL', 'PROBATE', 'FAMILY', 'JUVENILE',
    'CIVIL', 'CRIMINAL', 'BANKRUPTCY', 'TAX', 'PATENT', 'IMMIGRATION'
  ])).optional(),
});

const updatePreferencesSchema = z.object({
  // Notifications
  dailyCheckIn: z.boolean().optional(),
  dailyCheckInTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  directMessages: z.boolean().optional(),
  discussionReplies: z.boolean().optional(),
  // Privacy
  showYearsOnBench: z.boolean().optional(),
  showCourtType: z.boolean().optional(),
  // NEW: Privacy controls for detailed fields
  showJurisdiction: z.boolean().optional(),
  showCourtLevel: z.boolean().optional(),
  showJudgeType: z.boolean().optional(),
  showSpecializations: z.boolean().optional(),
  allowDirectMessages: z.boolean().optional(),
  allowConnectionReqs: z.boolean().optional(),
  // App
  theme: z.enum(['light', 'dark', 'system']).optional(),
  reducedMotion: z.boolean().optional(),
});

const updatePinSchema = z.object({
  currentPin: z.string().length(6),
  newPin: z.string().length(6).regex(/^\d+$/),
});

const connectionRequestSchema = z.object({
  userId: z.string(),
});

// ============================================================================
// Route Handler
// ============================================================================

export default async function userRoutes(app: FastifyInstance): Promise<void> {
  // All routes require authentication
  app.addHook('preHandler', authenticate);

  /**
   * Get current user profile
   * GET /api/users/me
   */
  app.get('/me', async (request: FastifyRequest) => {
    const user = await prisma.user.findUnique({
      where: { id: request.userId! },
      include: {
        preferences: true,
        specializations: true,
        _count: {
          select: {
            journalEntries: true,
            moodCheckins: true,
            posts: true,
          },
        },
      },
    });

    if (!user) {
      throw { statusCode: 404, message: 'User not found' };
    }

    return {
      id: user.id,
      pseudonym: user.pseudonym,
      yearsOnBench: user.yearsOnBench,
      courtType: user.courtType,
      stateJurisdiction: user.stateJurisdiction,
      federalCircuit: user.federalCircuit,
      courtLevel: user.courtLevel,
      judgeType: user.judgeType,
      isGuide: user.isGuide,
      createdAt: user.createdAt,
      preferences: user.preferences,
      specializations: user.specializations,
      stats: {
        journalEntries: user._count.journalEntries,
        moodCheckins: user._count.moodCheckins,
        posts: user._count.posts,
      },
    };
  });

  /**
   * Update user profile
   * PATCH /api/users/me
   */
  app.patch('/me', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = updateProfileSchema.parse(request.body);

    // Check pseudonym availability if changing
    if (body.pseudonym) {
      const existing = await prisma.user.findUnique({
        where: { pseudonym: body.pseudonym },
      });

      if (existing && existing.id !== request.userId) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Pseudonym Taken',
          message: 'This pseudonym is already in use.',
        });
      }
    }

    // Use transaction to update user and specializations
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: request.userId! },
        data: {
          pseudonym: body.pseudonym,
          yearsOnBench: body.yearsOnBench,
          courtType: body.courtType,
          stateJurisdiction: body.stateJurisdiction,
          federalCircuit: body.federalCircuit,
          courtLevel: body.courtLevel,
          judgeType: body.judgeType,
        },
      });

      // Update specializations if provided
      if (body.specializations !== undefined) {
        // Delete existing specializations
        await tx.userSpecialization.deleteMany({
          where: { userId: request.userId! },
        });

        // Create new specializations
        if (body.specializations.length > 0) {
          await tx.userSpecialization.createMany({
            data: body.specializations.map(spec => ({
              userId: request.userId!,
              specialization: spec,
            })),
          });
        }
      }

      // Fetch updated specializations
      const specializations = await tx.userSpecialization.findMany({
        where: { userId: request.userId! },
      });

      return { user, specializations };
    });

    await prisma.auditLog.create({
      data: {
        action: 'user.profile.update',
        userId: request.userId,
      },
    });

    return {
      id: result.user.id,
      pseudonym: result.user.pseudonym,
      yearsOnBench: result.user.yearsOnBench,
      courtType: result.user.courtType,
      stateJurisdiction: result.user.stateJurisdiction,
      federalCircuit: result.user.federalCircuit,
      courtLevel: result.user.courtLevel,
      judgeType: result.user.judgeType,
      specializations: result.specializations,
    };
  });

  /**
   * Update user preferences
   * PATCH /api/users/me/preferences
   */
  app.patch('/me/preferences', async (request: FastifyRequest) => {
    const body = updatePreferencesSchema.parse(request.body);

    const preferences = await prisma.userPreferences.upsert({
      where: { userId: request.userId! },
      update: body,
      create: {
        userId: request.userId!,
        ...body,
      },
    });

    return preferences;
  });

  /**
   * Update PIN
   * POST /api/users/me/pin
   */
  app.post('/me/pin', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = updatePinSchema.parse(request.body);

    const user = await prisma.user.findUnique({
      where: { id: request.userId! },
    });

    if (!user) {
      throw { statusCode: 404, message: 'User not found' };
    }

    // Verify current PIN
    const validPin = await argon2.verify(user.pinHash, body.currentPin);

    if (!validPin) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Invalid PIN',
        message: 'Current PIN is incorrect',
      });
    }

    // Hash new PIN
    const newPinHash = await argon2.hash(body.newPin, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    await prisma.user.update({
      where: { id: request.userId! },
      data: { pinHash: newPinHash },
    });

    await prisma.auditLog.create({
      data: {
        action: 'user.pin.update',
        userId: request.userId,
      },
    });

    return { message: 'PIN updated successfully' };
  });

  /**
   * Get user's active sessions
   * GET /api/users/me/sessions
   */
  app.get('/me/sessions', async (request: FastifyRequest) => {
    const sessions = await prisma.session.findMany({
      where: {
        userId: request.userId!,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        deviceId: true,
        deviceName: true,
        createdAt: true,
        lastUsedAt: true,
      },
      orderBy: { lastUsedAt: 'desc' },
    });

    return sessions;
  });

  /**
   * Revoke a specific session
   * DELETE /api/users/me/sessions/:sessionId
   */
  app.delete('/me/sessions/:sessionId', async (request: FastifyRequest, reply: FastifyReply) => {
    const { sessionId } = request.params as { sessionId: string };

    const session = await prisma.session.findFirst({
      where: {
        id: sessionId,
        userId: request.userId!,
      },
    });

    if (!session) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Session not found',
      });
    }

    await prisma.session.delete({ where: { id: sessionId } });

    return { message: 'Session revoked' };
  });

  /**
   * Request connection with another user
   * POST /api/users/connections
   */
  app.post('/connections', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = connectionRequestSchema.parse(request.body);

    if (body.userId === request.userId) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Invalid Request',
        message: 'Cannot connect with yourself',
      });
    }

    // Check if target user exists and allows connections
    const targetUser = await prisma.user.findUnique({
      where: { id: body.userId },
      include: { preferences: true },
    });

    if (!targetUser || !targetUser.isActive) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'User not found',
      });
    }

    if (!targetUser.preferences?.allowConnectionReqs) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'User is not accepting connection requests',
      });
    }

    // Check existing connection
    const existing = await prisma.connection.findUnique({
      where: {
        userId_connectedId: {
          userId: request.userId!,
          connectedId: body.userId,
        },
      },
    });

    if (existing) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Already Exists',
        message: 'Connection request already sent',
      });
    }

    const connection = await prisma.connection.create({
      data: {
        userId: request.userId!,
        connectedId: body.userId,
        status: 'PENDING',
      },
    });

    return reply.status(201).send({
      id: connection.id,
      status: connection.status,
      message: 'Connection request sent',
    });
  });

  /**
   * Get pending connection requests
   * GET /api/users/connections/pending
   */
  app.get('/connections/pending', async (request: FastifyRequest) => {
    const pending = await prisma.connection.findMany({
      where: {
        connectedId: request.userId!,
        status: 'PENDING',
      },
      include: {
        user: {
          select: {
            id: true,
            pseudonym: true,
            yearsOnBench: true,
            courtType: true,
            isGuide: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return pending.map((c) => ({
      id: c.id,
      user: c.user,
      createdAt: c.createdAt,
    }));
  });

  /**
   * Accept/reject connection request
   * PATCH /api/users/connections/:connectionId
   */
  app.patch('/connections/:connectionId', async (request: FastifyRequest, reply: FastifyReply) => {
    const { connectionId } = request.params as { connectionId: string };
    const { action } = request.body as { action: 'accept' | 'reject' };

    const connection = await prisma.connection.findFirst({
      where: {
        id: connectionId,
        connectedId: request.userId!,
        status: 'PENDING',
      },
    });

    if (!connection) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Connection request not found',
      });
    }

    if (action === 'accept') {
      // Create bidirectional connection
      await prisma.$transaction([
        prisma.connection.update({
          where: { id: connectionId },
          data: { status: 'ACCEPTED' },
        }),
        prisma.connection.create({
          data: {
            userId: request.userId!,
            connectedId: connection.userId,
            status: 'ACCEPTED',
          },
        }),
      ]);

      return { message: 'Connection accepted' };
    } else {
      await prisma.connection.delete({ where: { id: connectionId } });
      return { message: 'Connection rejected' };
    }
  });

  /**
   * Get user's connections
   * GET /api/users/connections
   */
  app.get('/connections', async (request: FastifyRequest) => {
    const connections = await prisma.connection.findMany({
      where: {
        userId: request.userId!,
        status: 'ACCEPTED',
      },
      include: {
        connected: {
          select: {
            id: true,
            pseudonym: true,
            yearsOnBench: true,
            courtType: true,
            isGuide: true,
            lastActiveAt: true,
          },
        },
      },
    });

    return connections.map((c) => c.connected);
  });

  /**
   * Delete account (GDPR compliance)
   * DELETE /api/users/me
   */
  app.delete('/me', async (request: FastifyRequest) => {
    // This cascades to delete all user data
    await prisma.user.delete({
      where: { id: request.userId! },
    });

    await prisma.auditLog.create({
      data: {
        action: 'user.account.deleted',
        metadata: JSON.stringify({ deletedUserId: request.userId }),
      },
    });

    return { message: 'Account deleted successfully' };
  });
}
