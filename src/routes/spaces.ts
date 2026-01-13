/**
 * Spaces Routes
 *
 * Discussion rooms and community interactions
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { authenticate } from '../middleware/auth.js';

// ============================================================================
// Validation Schemas
// ============================================================================

const createPostSchema = z.object({
  spaceId: z.string(),
  content: z.string().min(1).max(5000),
});

const createCommentSchema = z.object({
  content: z.string().min(1).max(2000),
  parentId: z.string().optional(),
});

const reportSchema = z.object({
  reason: z.string().min(10).max(500),
  details: z.string().max(1000).optional(),
});

// ============================================================================
// Route Handler
// ============================================================================

export default async function spacesRoutes(app: FastifyInstance): Promise<void> {
  // All routes require authentication
  app.addHook('preHandler', authenticate);

  /**
   * Get all discussion spaces
   * GET /api/spaces
   */
  app.get('/', async () => {
    const spaces = await prisma.space.findMany({
      where: { isActive: true },
      include: {
        _count: {
          select: { posts: { where: { isVisible: true } } },
        },
      },
      orderBy: { name: 'asc' },
    });

    // Get active user counts (users who posted in last 24h)
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const spacesWithActivity = await Promise.all(
      spaces.map(async (space) => {
        const recentPosts = await prisma.post.findMany({
          where: {
            spaceId: space.id,
            createdAt: { gte: dayAgo },
            isVisible: true,
          },
          select: { authorId: true },
          distinct: ['authorId'],
        });

        return {
          id: space.id,
          name: space.name,
          description: space.description,
          color: space.color,
          icon: space.icon,
          postCount: space._count.posts,
          activeToday: recentPosts.length,
        };
      })
    );

    return spacesWithActivity;
  });

  /**
   * Get a specific space with recent posts
   * GET /api/spaces/:spaceId
   */
  app.get('/:spaceId', async (request: FastifyRequest, reply: FastifyReply) => {
    const { spaceId } = request.params as { spaceId: string };

    const space = await prisma.space.findUnique({
      where: { id: spaceId, isActive: true },
    });

    if (!space) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Space not found',
      });
    }

    return space;
  });

  /**
   * Get posts in a space (paginated)
   * GET /api/spaces/:spaceId/posts
   */
  app.get('/:spaceId/posts', async (request: FastifyRequest, reply: FastifyReply) => {
    const { spaceId } = request.params as { spaceId: string };
    const { cursor, limit = '20' } = request.query as { cursor?: string; limit?: string };

    const space = await prisma.space.findUnique({
      where: { id: spaceId, isActive: true },
    });

    if (!space) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Space not found',
      });
    }

    const take = Math.min(parseInt(limit), 50);

    const posts = await prisma.post.findMany({
      where: {
        spaceId,
        isVisible: true,
      },
      take: take + 1, // Fetch one extra to check if there's more
      ...(cursor && {
        cursor: { id: cursor },
        skip: 1,
      }),
      orderBy: { createdAt: 'desc' },
      include: {
        author: {
          select: {
            id: true,
            pseudonym: true,
            isGuide: true,
          },
        },
        _count: {
          select: { comments: { where: { isVisible: true } } },
        },
      },
    });

    const hasMore = posts.length > take;
    const items = hasMore ? posts.slice(0, -1) : posts;
    const nextCursor = hasMore ? items[items.length - 1]?.id : null;

    return {
      items: items.map((post) => ({
        id: post.id,
        content: post.content,
        author: post.author,
        commentCount: post._count.comments,
        createdAt: post.createdAt,
      })),
      nextCursor,
      hasMore,
    };
  });

  /**
   * Create a new post
   * POST /api/spaces/posts
   */
  app.post('/posts', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = createPostSchema.parse(request.body);

    const space = await prisma.space.findUnique({
      where: { id: body.spaceId, isActive: true },
    });

    if (!space) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Space not found',
      });
    }

    const post = await prisma.post.create({
      data: {
        spaceId: body.spaceId,
        authorId: request.userId!,
        content: body.content,
      },
      include: {
        author: {
          select: {
            id: true,
            pseudonym: true,
            isGuide: true,
          },
        },
      },
    });

    await prisma.auditLog.create({
      data: {
        action: 'post.create',
        userId: request.userId,
        targetId: post.id,
        targetType: 'POST',
      },
    });

    return reply.status(201).send({
      id: post.id,
      content: post.content,
      author: post.author,
      createdAt: post.createdAt,
    });
  });

  /**
   * Get a specific post with comments
   * GET /api/spaces/posts/:postId
   */
  app.get('/posts/:postId', async (request: FastifyRequest, reply: FastifyReply) => {
    const { postId } = request.params as { postId: string };

    const post = await prisma.post.findUnique({
      where: { id: postId, isVisible: true },
      include: {
        author: {
          select: {
            id: true,
            pseudonym: true,
            isGuide: true,
            yearsOnBench: true,
            courtType: true,
          },
        },
        space: {
          select: {
            id: true,
            name: true,
          },
        },
        comments: {
          where: { isVisible: true, parentId: null },
          orderBy: { createdAt: 'asc' },
          include: {
            author: {
              select: {
                id: true,
                pseudonym: true,
                isGuide: true,
              },
            },
            replies: {
              where: { isVisible: true },
              orderBy: { createdAt: 'asc' },
              include: {
                author: {
                  select: {
                    id: true,
                    pseudonym: true,
                    isGuide: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!post) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Post not found',
      });
    }

    return post;
  });

  /**
   * Add comment to a post
   * POST /api/spaces/posts/:postId/comments
   */
  app.post('/posts/:postId/comments', async (request: FastifyRequest, reply: FastifyReply) => {
    const { postId } = request.params as { postId: string };
    const body = createCommentSchema.parse(request.body);

    const post = await prisma.post.findUnique({
      where: { id: postId, isVisible: true },
    });

    if (!post) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Post not found',
      });
    }

    // Validate parent comment if provided
    if (body.parentId) {
      const parentComment = await prisma.comment.findUnique({
        where: { id: body.parentId, postId, isVisible: true },
      });

      if (!parentComment) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Parent comment not found',
        });
      }
    }

    const comment = await prisma.comment.create({
      data: {
        postId,
        authorId: request.userId!,
        content: body.content,
        parentId: body.parentId,
      },
      include: {
        author: {
          select: {
            id: true,
            pseudonym: true,
            isGuide: true,
          },
        },
      },
    });

    return reply.status(201).send({
      id: comment.id,
      content: comment.content,
      author: comment.author,
      parentId: comment.parentId,
      createdAt: comment.createdAt,
    });
  });

  /**
   * Delete own post
   * DELETE /api/spaces/posts/:postId
   */
  app.delete('/posts/:postId', async (request: FastifyRequest, reply: FastifyReply) => {
    const { postId } = request.params as { postId: string };

    const post = await prisma.post.findUnique({
      where: { id: postId },
    });

    if (!post) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Post not found',
      });
    }

    if (post.authorId !== request.userId) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'You can only delete your own posts',
      });
    }

    await prisma.post.update({
      where: { id: postId },
      data: { isVisible: false },
    });

    await prisma.auditLog.create({
      data: {
        action: 'post.delete',
        userId: request.userId,
        targetId: postId,
        targetType: 'POST',
      },
    });

    return { message: 'Post deleted' };
  });

  /**
   * Report a post or comment
   * POST /api/spaces/report
   */
  app.post('/report', async (request: FastifyRequest, reply: FastifyReply) => {
    const { targetId, targetType, reason, details } = request.body as {
      targetId: string;
      targetType: 'POST' | 'COMMENT';
      reason: string;
      details?: string;
    };

    const validatedReport = reportSchema.parse({ reason, details });

    // Verify target exists
    if (targetType === 'POST') {
      const post = await prisma.post.findUnique({ where: { id: targetId } });
      if (!post) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Content not found',
        });
      }

      // Increment report count
      await prisma.post.update({
        where: { id: targetId },
        data: { reportCount: { increment: 1 } },
      });
    } else {
      const comment = await prisma.comment.findUnique({ where: { id: targetId } });
      if (!comment) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Content not found',
        });
      }

      await prisma.comment.update({
        where: { id: targetId },
        data: { reportCount: { increment: 1 } },
      });
    }

    await prisma.report.create({
      data: {
        reporterId: request.userId!,
        targetId,
        targetType,
        reason: validatedReport.reason,
        details: validatedReport.details,
      },
    });

    return reply.status(201).send({
      message: 'Report submitted. Thank you for helping keep our community safe.',
    });
  });
}
