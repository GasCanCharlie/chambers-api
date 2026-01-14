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
      // Check if the user actually exists (registration may have failed midway)
      const existingUserForVerification = await prisma.user.findUnique({
        where: { id: verification.userId },
      });

      if (existingUserForVerification) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Already Registered',
          message: 'This verification has already been used. Please sign in.',
        });
      }

      // User doesn't exist, clear the userId to allow retry
      await prisma.verification.update({
        where: { id: verification.id },
        data: { userId: null },
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

  /**
   * TEMPORARY: Admin endpoint to seed the database
   * POST /api/auth/admin/seed
   */
  app.post('/admin/seed', async (request: FastifyRequest, reply: FastifyReply) => {
    // Create discussion spaces
    const spaces = [
      { name: 'The Weight Room', description: 'Processing heavy cases and decisions', color: '#1E3A5F', icon: 'weight' },
      { name: 'Overwhelm & Workload', description: 'Caseload, time pressure, administrative burden', color: '#D4A574', icon: 'clock' },
      { name: 'Ethical Crossroads', description: 'Navigating gray areas and conscience', color: '#4A6741', icon: 'scale' },
      { name: 'Life Beyond the Bench', description: 'Family, identity, retirement transitions', color: '#7BA3A8', icon: 'home' },
      { name: 'New to the Robe', description: 'First 5 years on the bench', color: '#E8A87C', icon: 'star' },
      { name: 'Federal Perspectives', description: 'Federal judiciary-specific discussions', color: '#2A4A73', icon: 'building' },
      { name: 'State & Local Realities', description: 'State, county, and municipal court issues', color: '#5C7D52', icon: 'map' },
      { name: 'Mentorship Circle', description: 'Guidance from senior and retired judges', color: '#8B7E74', icon: 'users' },
    ];

    for (const space of spaces) {
      await prisma.space.upsert({
        where: { name: space.name },
        update: space,
        create: space,
      });
    }

    // Create exercises
    const exercises = [
      {
        slug: 'breathing-reset',
        title: 'Breathing Reset',
        description: '4-7-8 breathing technique for immediate calm',
        category: 'QUICK_TOOL',
        duration: 2,
        content: JSON.stringify({
          type: 'breathing',
          steps: [
            { instruction: 'Find a comfortable position', duration: 5 },
            { instruction: 'Breathe in through your nose', duration: 4, action: 'inhale' },
            { instruction: 'Hold your breath', duration: 7, action: 'hold' },
            { instruction: 'Exhale slowly through your mouth', duration: 8, action: 'exhale' },
          ],
          cycles: 4,
        }),
        sortOrder: 1,
      },
      {
        slug: 'grounding-exercise',
        title: 'Grounding Exercise',
        description: '5-4-3-2-1 sensory awareness technique',
        category: 'GROUNDING',
        duration: 3,
        content: JSON.stringify({
          type: 'grounding',
          steps: [
            { instruction: 'Name 5 things you can see', count: 5, sense: 'sight' },
            { instruction: 'Name 4 things you can touch', count: 4, sense: 'touch' },
            { instruction: 'Name 3 things you can hear', count: 3, sense: 'sound' },
            { instruction: 'Name 2 things you can smell', count: 2, sense: 'smell' },
            { instruction: 'Name 1 thing you can taste', count: 1, sense: 'taste' },
          ],
        }),
        sortOrder: 2,
      },
      {
        slug: 'perspective-shift',
        title: 'Perspective Shift',
        description: '"In 5 years, how will this matter?" reflection',
        category: 'QUICK_TOOL',
        duration: 5,
        content: JSON.stringify({
          type: 'reflection',
          prompts: [
            'What situation is weighing on you right now?',
            'In 5 years, how significant will this feel?',
            'What would you tell a colleague facing this?',
            'What is one thing you can control about this?',
          ],
        }),
        sortOrder: 3,
      },
      {
        slug: 'compassion-pause',
        title: 'Self-Compassion Pause',
        description: 'A brief practice in self-kindness',
        category: 'QUICK_TOOL',
        duration: 3,
        content: JSON.stringify({
          type: 'guided',
          steps: [
            { instruction: 'Place your hand on your heart', duration: 5 },
            { instruction: 'Acknowledge: "This is a moment of difficulty"', duration: 10 },
            { instruction: 'Remind yourself: "Difficulty is part of being human"', duration: 10 },
            { instruction: 'Offer yourself kindness: "May I be patient with myself"', duration: 10 },
            { instruction: 'Take three deep breaths', duration: 15 },
          ],
        }),
        sortOrder: 4,
      },
      {
        slug: 'weight-of-decision',
        title: 'The Weight of Decision',
        description: 'Reframe thoughts about difficult rulings',
        category: 'REFRAMING',
        duration: 10,
        content: JSON.stringify({
          type: 'cbt_reframe',
          introduction: 'Judges carry the weight of decisions that affect lives.',
          steps: [
            { title: 'Identify the Thought', prompt: 'What automatic thought keeps returning?' },
            { title: 'Examine the Evidence', prompt: 'What supports or contradicts this thought?' },
            { title: 'Alternative Perspective', prompt: 'What would you think of a colleague who made the same decision?' },
            { title: 'Balanced Response', prompt: 'Write a more balanced thought.' },
          ],
        }),
        sortOrder: 5,
      },
      {
        slug: 'burnout-check',
        title: 'Burnout Check-In',
        description: 'Assess signs of judicial exhaustion',
        category: 'REFLECTION',
        duration: 15,
        content: JSON.stringify({
          type: 'assessment',
          introduction: 'Burnout in the judiciary often goes unrecognized.',
          sections: [
            { title: 'Physical Signs', questions: ['How is your sleep?', 'Unexplained fatigue?', 'Eating habit changes?'] },
            { title: 'Emotional Signs', questions: ['Feeling cynical?', 'Harder to feel empathy?', 'Dread going to work?'] },
            { title: 'Behavioral Signs', questions: ['Withdrawing from others?', 'Stopped activities you enjoyed?', 'More errors than usual?'] },
          ],
        }),
        sortOrder: 6,
      },
    ];

    for (const exercise of exercises) {
      await prisma.exercise.upsert({
        where: { slug: exercise.slug },
        update: exercise,
        create: exercise,
      });
    }

    return {
      message: 'Database seeded successfully',
      spaces: spaces.length,
      exercises: exercises.length,
    };
  });

  /**
   * TEMPORARY: Admin endpoint to reset a user for testing
   * DELETE /api/auth/admin/reset-user/:pseudonym
   */
  app.delete('/admin/reset-user/:pseudonym', async (request: FastifyRequest, reply: FastifyReply) => {
    const { pseudonym } = request.params as { pseudonym: string };

    // Find the user
    const user = await prisma.user.findUnique({
      where: { pseudonym },
    });

    if (!user) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'User not found',
      });
    }

    // Delete related records first
    await prisma.session.deleteMany({ where: { userId: user.id } });
    await prisma.auditLog.deleteMany({ where: { userId: user.id } });
    await prisma.userPreferences.deleteMany({ where: { userId: user.id } });

    // Clear verification link
    await prisma.verification.updateMany({
      where: { userId: user.id },
      data: { userId: null },
    });

    // Delete the user
    await prisma.user.delete({ where: { id: user.id } });

    return { message: `User ${pseudonym} has been reset` };
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
