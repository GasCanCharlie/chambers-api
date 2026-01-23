/**
 * Confidentiality Agreement Routes
 *
 * Handles fetching and accepting confidentiality agreements
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { authenticate } from '../middleware/auth.js';

// ============================================================================
// Validation Schemas
// ============================================================================

const acceptAgreementSchema = z.object({
  agreementId: z.string(),
});

// ============================================================================
// Route Handler
// ============================================================================

export default async function agreementsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Get active confidentiality agreement
   * GET /api/agreements/current
   */
  app.get('/current', async (request: FastifyRequest, reply: FastifyReply) => {
    const agreement = await prisma.confidentialityAgreement.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        version: true,
        content: true,
        summary: true,
        createdAt: true,
      },
    });

    if (!agreement) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'No active agreement found',
      });
    }

    return agreement;
  });

  /**
   * Check if user needs to accept new agreement
   * GET /api/agreements/status
   */
  app.get('/status', { preHandler: [authenticate] }, async (request: FastifyRequest) => {
    const currentAgreement = await prisma.confidentialityAgreement.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
    });

    if (!currentAgreement) {
      return {
        needsAcceptance: true,
        currentVersion: null,
        lastAcceptedAt: null,
      };
    }

    const userAcceptance = await prisma.confidentialityAgreementAcceptance.findFirst({
      where: {
        userId: request.userId!,
        agreementId: currentAgreement.id,
      },
    });

    return {
      needsAcceptance: !userAcceptance,
      currentVersion: currentAgreement.version,
      lastAcceptedAt: userAcceptance?.acceptedAt,
    };
  });

  /**
   * Accept confidentiality agreement
   * POST /api/agreements/accept
   */
  app.post('/accept', { preHandler: [authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = acceptAgreementSchema.parse(request.body);

    const agreement = await prisma.confidentialityAgreement.findUnique({
      where: { id: body.agreementId, isActive: true },
    });

    if (!agreement) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Invalid Agreement',
        message: 'Agreement not found or inactive',
      });
    }

    // Check if already accepted
    const existing = await prisma.confidentialityAgreementAcceptance.findUnique({
      where: {
        userId_agreementId: {
          userId: request.userId!,
          agreementId: body.agreementId,
        },
      },
    });

    if (existing) {
      return {
        message: 'Agreement already accepted',
        acceptedAt: existing.acceptedAt,
      };
    }

    const acceptance = await prisma.confidentialityAgreementAcceptance.create({
      data: {
        userId: request.userId!,
        agreementId: body.agreementId,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      },
    });

    await prisma.auditLog.create({
      data: {
        action: 'agreement.accepted',
        userId: request.userId,
        targetId: body.agreementId,
        targetType: 'AGREEMENT',
      },
    });

    return {
      message: 'Agreement accepted',
      acceptedAt: acceptance.acceptedAt,
    };
  });
}
