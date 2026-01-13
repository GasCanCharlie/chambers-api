/**
 * Journal Routes
 *
 * Private journaling with client-side encryption
 * Server only stores encrypted blobs - cannot read content
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { authenticate } from '../middleware/auth.js';

// ============================================================================
// Validation Schemas
// ============================================================================

const createEntrySchema = z.object({
  encryptedContent: z.string().min(1), // Client-encrypted content
  encryptedTitle: z.string().optional(),
  mood: z.number().min(1).max(4).optional(),
  promptId: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
});

const updateEntrySchema = z.object({
  encryptedContent: z.string().min(1).optional(),
  encryptedTitle: z.string().optional(),
  mood: z.number().min(1).max(4).optional(),
  expiresAt: z.string().datetime().optional().nullable(),
});

const moodCheckinSchema = z.object({
  mood: z.number().min(1).max(4),
  note: z.string().max(500).optional(), // Optional encrypted note
});

// ============================================================================
// Route Handler
// ============================================================================

export default async function journalRoutes(app: FastifyInstance): Promise<void> {
  // All routes require authentication
  app.addHook('preHandler', authenticate);

  /**
   * Get all journal entries (metadata only, content encrypted)
   * GET /api/journal/entries
   */
  app.get('/entries', async (request: FastifyRequest) => {
    const { cursor, limit = '20' } = request.query as { cursor?: string; limit?: string };
    const take = Math.min(parseInt(limit), 50);

    const entries = await prisma.journalEntry.findMany({
      where: { userId: request.userId! },
      take: take + 1,
      ...(cursor && {
        cursor: { id: cursor },
        skip: 1,
      }),
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        encryptedTitle: true,
        mood: true,
        promptId: true,
        createdAt: true,
        updatedAt: true,
        // Note: encryptedContent not included in list view for performance
      },
    });

    const hasMore = entries.length > take;
    const items = hasMore ? entries.slice(0, -1) : entries;
    const nextCursor = hasMore ? items[items.length - 1]?.id : null;

    return {
      items,
      nextCursor,
      hasMore,
    };
  });

  /**
   * Get a specific journal entry (with encrypted content)
   * GET /api/journal/entries/:entryId
   */
  app.get('/entries/:entryId', async (request: FastifyRequest, reply: FastifyReply) => {
    const { entryId } = request.params as { entryId: string };

    const entry = await prisma.journalEntry.findUnique({
      where: { id: entryId },
    });

    if (!entry) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Entry not found',
      });
    }

    if (entry.userId !== request.userId) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Access denied',
      });
    }

    return {
      id: entry.id,
      encryptedContent: entry.encryptedContent,
      encryptedTitle: entry.encryptedTitle,
      mood: entry.mood,
      promptId: entry.promptId,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      expiresAt: entry.expiresAt,
    };
  });

  /**
   * Create a new journal entry
   * POST /api/journal/entries
   */
  app.post('/entries', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = createEntrySchema.parse(request.body);

    const entry = await prisma.journalEntry.create({
      data: {
        userId: request.userId!,
        encryptedContent: body.encryptedContent,
        encryptedTitle: body.encryptedTitle,
        mood: body.mood,
        promptId: body.promptId,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      },
    });

    await prisma.auditLog.create({
      data: {
        action: 'journal.entry.create',
        userId: request.userId,
        targetId: entry.id,
        targetType: 'JOURNAL_ENTRY',
      },
    });

    return reply.status(201).send({
      id: entry.id,
      createdAt: entry.createdAt,
    });
  });

  /**
   * Update a journal entry
   * PATCH /api/journal/entries/:entryId
   */
  app.patch('/entries/:entryId', async (request: FastifyRequest, reply: FastifyReply) => {
    const { entryId } = request.params as { entryId: string };
    const body = updateEntrySchema.parse(request.body);

    const entry = await prisma.journalEntry.findUnique({
      where: { id: entryId },
    });

    if (!entry) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Entry not found',
      });
    }

    if (entry.userId !== request.userId) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Access denied',
      });
    }

    const updated = await prisma.journalEntry.update({
      where: { id: entryId },
      data: {
        encryptedContent: body.encryptedContent,
        encryptedTitle: body.encryptedTitle,
        mood: body.mood,
        expiresAt: body.expiresAt === null ? null : body.expiresAt ? new Date(body.expiresAt) : undefined,
      },
    });

    return {
      id: updated.id,
      updatedAt: updated.updatedAt,
    };
  });

  /**
   * Delete a journal entry
   * DELETE /api/journal/entries/:entryId
   */
  app.delete('/entries/:entryId', async (request: FastifyRequest, reply: FastifyReply) => {
    const { entryId } = request.params as { entryId: string };

    const entry = await prisma.journalEntry.findUnique({
      where: { id: entryId },
    });

    if (!entry) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Entry not found',
      });
    }

    if (entry.userId !== request.userId) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Access denied',
      });
    }

    await prisma.journalEntry.delete({ where: { id: entryId } });

    await prisma.auditLog.create({
      data: {
        action: 'journal.entry.delete',
        userId: request.userId,
        targetId: entryId,
        targetType: 'JOURNAL_ENTRY',
      },
    });

    return { message: 'Entry deleted' };
  });

  // ============================================================================
  // Mood Check-ins
  // ============================================================================

  /**
   * Record a mood check-in
   * POST /api/journal/mood
   */
  app.post('/mood', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = moodCheckinSchema.parse(request.body);

    // Check if already checked in today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const existing = await prisma.moodCheckin.findFirst({
      where: {
        userId: request.userId!,
        createdAt: {
          gte: today,
          lt: tomorrow,
        },
      },
    });

    if (existing) {
      // Update existing check-in
      const updated = await prisma.moodCheckin.update({
        where: { id: existing.id },
        data: {
          mood: body.mood,
          note: body.note,
        },
      });

      return {
        id: updated.id,
        mood: updated.mood,
        createdAt: updated.createdAt,
        updated: true,
      };
    }

    const checkin = await prisma.moodCheckin.create({
      data: {
        userId: request.userId!,
        mood: body.mood,
        note: body.note,
      },
    });

    return reply.status(201).send({
      id: checkin.id,
      mood: checkin.mood,
      createdAt: checkin.createdAt,
      updated: false,
    });
  });

  /**
   * Get mood history
   * GET /api/journal/mood/history
   */
  app.get('/mood/history', async (request: FastifyRequest) => {
    const { days = '30' } = request.query as { days?: string };
    const daysNum = Math.min(parseInt(days), 365);

    const since = new Date();
    since.setDate(since.getDate() - daysNum);

    const checkins = await prisma.moodCheckin.findMany({
      where: {
        userId: request.userId!,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        mood: true,
        createdAt: true,
      },
    });

    // Calculate stats
    const moods = checkins.map((c) => c.mood);
    const average = moods.length > 0
      ? moods.reduce((a, b) => a + b, 0) / moods.length
      : null;

    const distribution = {
      1: moods.filter((m) => m === 1).length,
      2: moods.filter((m) => m === 2).length,
      3: moods.filter((m) => m === 3).length,
      4: moods.filter((m) => m === 4).length,
    };

    return {
      checkins,
      stats: {
        total: checkins.length,
        average: average ? Math.round(average * 100) / 100 : null,
        distribution,
      },
    };
  });

  /**
   * Get today's check-in status
   * GET /api/journal/mood/today
   */
  app.get('/mood/today', async (request: FastifyRequest) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const checkin = await prisma.moodCheckin.findFirst({
      where: {
        userId: request.userId!,
        createdAt: {
          gte: today,
          lt: tomorrow,
        },
      },
    });

    return {
      hasCheckedIn: !!checkin,
      checkin: checkin
        ? {
            id: checkin.id,
            mood: checkin.mood,
            createdAt: checkin.createdAt,
          }
        : null,
    };
  });

  // ============================================================================
  // Prompts
  // ============================================================================

  /**
   * Get daily writing prompts
   * GET /api/journal/prompts
   */
  app.get('/prompts', async () => {
    // Static prompts for now - could be moved to database
    const prompts = [
      {
        id: 'decision-weight',
        text: 'What decision from this week are you still carrying?',
        category: 'reflection',
      },
      {
        id: 'gratitude',
        text: 'What moment today reminded you why you chose this path?',
        category: 'gratitude',
      },
      {
        id: 'boundary',
        text: 'Where do you need to set a clearer boundary?',
        category: 'self-care',
      },
      {
        id: 'isolation',
        text: 'When did you last feel truly understood in your role?',
        category: 'connection',
      },
      {
        id: 'growth',
        text: 'What has this work taught you about yourself recently?',
        category: 'growth',
      },
    ];

    // Return a "daily" prompt based on the date
    const today = new Date();
    const dayOfYear = Math.floor(
      (today.getTime() - new Date(today.getFullYear(), 0, 0).getTime()) / 86400000
    );
    const dailyPrompt = prompts[dayOfYear % prompts.length];

    return {
      daily: dailyPrompt,
      all: prompts,
    };
  });
}
