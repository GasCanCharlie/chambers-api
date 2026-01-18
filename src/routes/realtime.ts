/**
 * OpenAI Realtime API Routes
 *
 * Handles ephemeral token generation for WebRTC connections
 * to the OpenAI Realtime API for speech-to-speech AI.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate } from '../middleware/auth.js';
import { env } from '../config/env.js';
import { prisma } from '../config/database.js';

// System prompt for the Realtime AI assistant
const REALTIME_SYSTEM_PROMPT = `You are a supportive AI companion inside Chambers, a private wellness app designed for judges and legal professionals who carry significant emotional weight in their work.

YOUR ROLE:
You are a warm, thoughtful voice companion who can:
- Listen and reflect on what users share
- Offer encouragement, perspective, and support
- Share uplifting thoughts when asked
- Help with stress relief and emotional processing
- Be a compassionate listener

TONE:
- Warm but professional
- Calm and grounded
- Supportive without being patronizing
- Concise in responses (this is voice, keep it natural and not too long)
- Appropriate for accomplished professionals

BOUNDARIES:
- You are not a licensed therapist or medical professional
- Do not diagnose mental health conditions
- Do not comment on specific legal cases or rulings
- If someone appears to be in crisis, gently suggest professional resources
- Respect privacy - don't ask for identifying details about cases

IMPORTANT:
- Keep responses concise since this is voice conversation
- Be genuinely helpful and responsive
- Ask clarifying questions when needed
- Match the user's emotional tone`;

// ============================================================================
// Route Handler
// ============================================================================

export default async function realtimeRoutes(app: FastifyInstance): Promise<void> {
  // All routes require authentication
  app.addHook('preHandler', authenticate);

  /**
   * Create an ephemeral token for OpenAI Realtime API
   * POST /api/realtime/token
   *
   * Returns an ephemeral key that the client can use to connect
   * directly to OpenAI's Realtime API via WebRTC.
   */
  app.post('/token', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;

    // Check if OpenAI API key is configured
    if (!env.OPENAI_API_KEY) {
      request.log.error('OPENAI_API_KEY is not configured');
      return reply.status(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'Voice feature is not configured',
      });
    }

    try {
      // Create a session with OpenAI to get an ephemeral key
      const response = await fetch('https://api.openai.com/v1/realtime/sessions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-realtime-preview-2024-12-17',
          voice: 'sage', // Options: alloy, ash, ballad, coral, echo, sage, shimmer, verse
          instructions: REALTIME_SYSTEM_PROMPT,
          input_audio_transcription: {
            model: 'whisper-1',
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        request.log.error({ status: response.status, error: errorText }, 'OpenAI Realtime session creation failed');
        return reply.status(502).send({
          statusCode: 502,
          error: 'Bad Gateway',
          message: 'Failed to create voice session',
        });
      }

      const sessionData = await response.json();

      // Log session creation for audit (no sensitive data)
      await prisma.auditLog.create({
        data: {
          action: 'realtime.session.create',
          userId,
          targetType: 'REALTIME_SESSION',
        },
      });

      request.log.info({ userId }, 'Created Realtime session');

      // Return the ephemeral client secret
      return {
        client_secret: sessionData.client_secret,
        expires_at: sessionData.expires_at,
        session_id: sessionData.id,
      };
    } catch (error: any) {
      request.log.error({ error: error?.message }, 'Error creating Realtime session');
      return reply.status(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Failed to create voice session',
      });
    }
  });

  /**
   * Health check for realtime feature
   * GET /api/realtime/status
   */
  app.get('/status', async () => {
    return {
      available: !!env.OPENAI_API_KEY,
      model: 'gpt-4o-realtime-preview-2024-12-17',
      voice: 'sage',
    };
  });
}
