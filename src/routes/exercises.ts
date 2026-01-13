/**
 * Exercises Routes
 *
 * Reframing exercises and wellbeing tools
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { authenticate } from '../middleware/auth.js';

// ============================================================================
// Validation Schemas
// ============================================================================

const completeExerciseSchema = z.object({
  exerciseId: z.string(),
  encryptedReflection: z.string().optional(),
});

// ============================================================================
// Route Handler
// ============================================================================

export default async function exercisesRoutes(app: FastifyInstance): Promise<void> {
  // All routes require authentication
  app.addHook('preHandler', authenticate);

  /**
   * Get all exercises
   * GET /api/exercises
   */
  app.get('/', async () => {
    const exercises = await prisma.exercise.findMany({
      where: { isActive: true },
      orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }],
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        category: true,
        duration: true,
      },
    });

    // Group by category
    const grouped = exercises.reduce((acc, exercise) => {
      const category = exercise.category;
      if (!acc[category]) {
        acc[category] = [];
      }
      acc[category].push(exercise);
      return acc;
    }, {} as Record<string, typeof exercises>);

    return {
      exercises,
      grouped,
    };
  });

  /**
   * Get a specific exercise with content
   * GET /api/exercises/:slug
   */
  app.get('/:slug', async (request: FastifyRequest, reply: FastifyReply) => {
    const { slug } = request.params as { slug: string };

    const exercise = await prisma.exercise.findUnique({
      where: { slug, isActive: true },
    });

    if (!exercise) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Exercise not found',
      });
    }

    // Check if user has completed this exercise before
    const lastCompletion = await prisma.exerciseCompletion.findFirst({
      where: {
        userId: request.userId!,
        exerciseId: exercise.id,
      },
      orderBy: { completedAt: 'desc' },
    });

    return {
      ...exercise,
      lastCompletedAt: lastCompletion?.completedAt ?? null,
    };
  });

  /**
   * Record exercise completion
   * POST /api/exercises/complete
   */
  app.post('/complete', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = completeExerciseSchema.parse(request.body);

    const exercise = await prisma.exercise.findUnique({
      where: { id: body.exerciseId },
    });

    if (!exercise) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Exercise not found',
      });
    }

    const completion = await prisma.exerciseCompletion.create({
      data: {
        userId: request.userId!,
        exerciseId: body.exerciseId,
        encryptedReflection: body.encryptedReflection,
      },
    });

    await prisma.auditLog.create({
      data: {
        action: 'exercise.complete',
        userId: request.userId,
        targetId: exercise.id,
        targetType: 'EXERCISE',
      },
    });

    return reply.status(201).send({
      id: completion.id,
      completedAt: completion.completedAt,
    });
  });

  /**
   * Get user's exercise history
   * GET /api/exercises/history
   */
  app.get('/history', async (request: FastifyRequest) => {
    const { days = '30' } = request.query as { days?: string };
    const daysNum = Math.min(parseInt(days), 365);

    const since = new Date();
    since.setDate(since.getDate() - daysNum);

    const completions = await prisma.exerciseCompletion.findMany({
      where: {
        userId: request.userId!,
        completedAt: { gte: since },
      },
      orderBy: { completedAt: 'desc' },
      include: {
        exercise: {
          select: {
            id: true,
            slug: true,
            title: true,
            category: true,
            duration: true,
          },
        },
      },
    });

    // Calculate stats
    const totalMinutes = completions.reduce(
      (sum, c) => sum + (c.exercise?.duration ?? 0),
      0
    );

    const byCategory = completions.reduce((acc, c) => {
      const category = c.exercise?.category ?? 'UNKNOWN';
      acc[category] = (acc[category] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return {
      completions: completions.map((c) => ({
        id: c.id,
        exercise: c.exercise,
        completedAt: c.completedAt,
      })),
      stats: {
        total: completions.length,
        totalMinutes,
        byCategory,
      },
    };
  });

  /**
   * Get user's streaks and achievements
   * GET /api/exercises/stats
   */
  app.get('/stats', async (request: FastifyRequest) => {
    // Get all completions to calculate streak
    const completions = await prisma.exerciseCompletion.findMany({
      where: { userId: request.userId! },
      orderBy: { completedAt: 'desc' },
      select: { completedAt: true },
    });

    // Calculate current streak
    let currentStreak = 0;
    let longestStreak = 0;
    let tempStreak = 0;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const uniqueDays = new Set<string>();
    completions.forEach((c) => {
      const day = new Date(c.completedAt);
      day.setHours(0, 0, 0, 0);
      uniqueDays.add(day.toISOString());
    });

    const sortedDays = Array.from(uniqueDays).sort().reverse();

    for (let i = 0; i < sortedDays.length; i++) {
      const day = new Date(sortedDays[i] ?? '');
      const expectedDay = new Date(today);
      expectedDay.setDate(expectedDay.getDate() - i);

      if (day.getTime() === expectedDay.getTime()) {
        tempStreak++;
        if (i === 0 || tempStreak > currentStreak) {
          currentStreak = tempStreak;
        }
      } else if (i === 0) {
        // Didn't exercise today, check yesterday
        expectedDay.setDate(expectedDay.getDate() - 1);
        if (day.getTime() === expectedDay.getTime()) {
          tempStreak++;
        } else {
          tempStreak = 0;
        }
      } else {
        tempStreak = 1;
      }

      longestStreak = Math.max(longestStreak, tempStreak);
    }

    // Get mood check-in streak
    const moodCheckins = await prisma.moodCheckin.findMany({
      where: { userId: request.userId! },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    const moodDays = new Set<string>();
    moodCheckins.forEach((c) => {
      const day = new Date(c.createdAt);
      day.setHours(0, 0, 0, 0);
      moodDays.add(day.toISOString());
    });

    return {
      exerciseStreak: currentStreak,
      longestExerciseStreak: longestStreak,
      totalExercises: completions.length,
      totalCheckIns: moodCheckins.length,
      activeDays: uniqueDays.size,
    };
  });
}
