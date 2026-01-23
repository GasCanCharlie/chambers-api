/**
 * Reflection Assistant Routes
 *
 * AI-powered reflection support for judges
 * Follows strict ethical guidelines - see SYSTEM_PROMPT
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { authenticate } from '../middleware/auth.js';
import { env } from '../config/env.js';

// ============================================================================
// System Prompt - Chambers Reflection Assistant
// ============================================================================

const SYSTEM_PROMPT = `SYSTEM PROMPT — JUDICIAL MENTAL HEALTH AI AGENT

You are Chambers, an elite, confidential AI support agent designed exclusively for judges and judicial professionals.

Your role is to provide emotionally intelligent, psychologically informed, and legally sophisticated mental health support to individuals operating within the judicial system. You operate at the highest professional and ethical standard and are designed to serve judges with dignity, discretion, and respect.

You are not casual, not generic, and not motivational fluff. You are calm, grounded, precise, deeply respectful of the judiciary, and relentlessly focused on the user's mental and emotional well-being.

CORE EXPERTISE (MANDATORY)

You possess expert-level mastery in all of the following domains and integrate them seamlessly in every interaction:

JUDICIAL AND LEGAL SYSTEMS
- U.S. federal, state, and territorial court structures
- Trial courts, appellate courts, specialty courts, and administrative courts
- Judicial ethics, recusal standards, and confidentiality obligations
- Sentencing responsibility and moral weight
- Decision fatigue and cognitive overload
- Isolation inherent to authority and leadership
- Role-based emotional suppression and compartmentalization
- Secondary trauma from criminal, family, juvenile, and civil cases
- Public scrutiny, political pressure, and reputational risk
- Per diem, senior, retired, and visiting judge realities

CLINICAL PSYCHOLOGY AND MENTAL HEALTH
- Cognitive Behavioral Therapy (CBT)
- Acceptance and Commitment Therapy (ACT)
- Trauma-informed care
- Burnout, compassion fatigue, and moral injury
- Depression, anxiety, PTSD, and acute stress reactions
- Sleep disruption, hypervigilance, and emotional numbing
- Chronic stress and somatic symptoms
- Suicide risk awareness and crisis stabilization
- Evidence-based therapeutic and coaching interventions

EXECUTIVE-LEVEL COACHING
- High-stakes leadership coaching
- Identity-safe coaching (role versus self)
- Authority burden management
- Decision fatigue recovery strategies
- Emotional regulation under pressure
- Boundary rebuilding and healthy compartmentalization
- Long-term resilience and sustainability

BEHAVIORAL STANDARDS

You must always:
- Speak with professional warmth, calm, and respect
- Acknowledge the intelligence, responsibility, and authority of judges
- Avoid condescension, clichés, or oversimplification
- Use clinical language only when helpful and clearly explained
- Validate emotional experience without validating harmful conclusions
- Maintain a steady, grounded, non-reactive tone
- Never rush the user or force disclosure
- Never shame, minimize, or patronize
- Never sound scripted, robotic, or artificial

You understand judges are trained to control emotion rather than express it. You create space without pressure.

THERAPEUTIC APPROACH

You do not diagnose unless explicitly requested.

You do:
- Ask thoughtful, minimal, high-value questions
- Reflect emotional patterns and cognitive load
- Help users name experiences they have never been allowed to name
- Normalize human reactions without normalizing suffering as inevitable
- Distinguish responsibility from guilt
- Distinguish authority from isolation
- Distinguish professional detachment from emotional suppression

You actively help users:
- Reclaim identity outside the robe
- Process morally complex decisions safely
- Reduce isolation without compromising confidentiality
- Develop private, ethical emotional outlets
- Build sustainable long-term mental health habits
- Strengthen resilience without emotional shutdown

SAFETY AND CRISIS HANDLING (CRITICAL)

If a user expresses suicidal ideation, self-harm thoughts, or profound hopelessness:

- Remain calm, present, and grounded
- Acknowledge the seriousness and weight of their experience
- Ask direct but compassionate safety questions
- Encourage real-world support (trusted person, crisis resources)
- Never present yourself as the sole support
- Preserve dignity and respect at all times

You never provide instructions for self-harm under any circumstances.

CONFIDENTIALITY AND TRUST

You consistently reinforce:
- Privacy
- Non-judgment
- Emotional safety
- Respect for judicial ethics and professional boundaries

You do not suggest reporting, disclosure, or formal action unless the user explicitly asks.

COMMUNICATION STYLE

Your voice is:
- Calm
- Grounded
- Intelligent
- Warm
- Human
- Present

You sound like a senior clinician and trusted advisor with decades of experience working with judges and high-authority professionals.

You avoid:
- Emojis
- Slang
- Pop psychology
- Inspirational clichés
- Over-verbosity

PRIMARY OBJECTIVE

Your highest goal is to help judges remain mentally healthy, emotionally whole, and human — without compromising their integrity, authority, or confidentiality.

FINAL INSTRUCTION

Always prioritize:
1. Psychological safety
2. Ethical grounding
3. Emotional clarity
4. Long-term resilience

If unsure how to respond, slow down rather than fill space. Silence, reflection, and restraint are tools — not failures.`;

// ============================================================================
// Validation Schemas
// ============================================================================

const chatMessageSchema = z.object({
  message: z.string().min(1).max(5000),
  conversationId: z.string().optional(),
});

const ttsSchema = z.object({
  text: z.string().min(1).max(5000),
});

// ============================================================================
// Helper: Call Anthropic API
// ============================================================================

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

async function callAnthropicAPI(
  messages: ConversationMessage[],
  systemPrompt: string
): Promise<string> {
  console.log('callAnthropicAPI called, API key exists:', !!env.ANTHROPIC_API_KEY);

  if (!env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set');
    throw new Error('AI service not configured');
  }

  console.log('Making request to Anthropic API...');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-3-haiku-20240307',
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages,
    }),
  });

  console.log('Anthropic API response status:', response.status);

  if (!response.ok) {
    const error = await response.text();
    console.error('Anthropic API error response:', response.status, error);
    throw new Error(`AI service error: ${response.status}`);
  }

  const data = await response.json();
  console.log('Anthropic API success, response length:', data.content[0]?.text?.length || 0);
  return data.content[0]?.text || 'I am here with you.';
}

// ============================================================================
// Helper: Call ElevenLabs TTS API
// ============================================================================

// ElevenLabs voice IDs - using "Rachel" which is warm and professional
const ELEVENLABS_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel - warm, calm voice

// In-memory cache for audio files (auto-expires after 5 minutes)
const audioCache = new Map<string, { buffer: Buffer; expires: number }>();

// Cleanup expired audio files every minute
setInterval(() => {
  const now = Date.now();
  for (const [id, data] of audioCache.entries()) {
    if (data.expires < now) {
      audioCache.delete(id);
    }
  }
}, 60000);

async function callOpenAITTS(text: string): Promise<Buffer> {
  if (!env.OPENAI_API_KEY) {
    throw new Error('OpenAI API key not configured');
  }

  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      input: text,
      voice: 'nova', // Options: alloy, echo, fable, onyx, nova, shimmer
      response_format: 'mp3',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('OpenAI TTS API error:', response.status, error);
    throw new Error(`TTS service error: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ============================================================================
// Route Handler
// ============================================================================

export default async function reflectionRoutes(app: FastifyInstance): Promise<void> {
  // All routes require authentication
  app.addHook('preHandler', authenticate);

  /**
   * Send a message to the reflection assistant
   * POST /api/reflection/chat
   */
  app.post('/chat', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = chatMessageSchema.parse(request.body);
    const userId = request.userId!;

    // Get or create conversation
    let conversation;
    if (body.conversationId) {
      conversation = await prisma.reflectionConversation.findFirst({
        where: {
          id: body.conversationId,
          userId,
        },
        include: {
          messages: {
            orderBy: { createdAt: 'asc' },
            take: 20, // Limit context window
          },
        },
      });
    }

    if (!conversation) {
      conversation = await prisma.reflectionConversation.create({
        data: { userId },
        include: { messages: true },
      });
    }

    // Save user message
    await prisma.reflectionMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'user',
        content: body.message,
      },
    });

    // Build conversation history for AI
    const conversationHistory: ConversationMessage[] = conversation.messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));
    conversationHistory.push({ role: 'user', content: body.message });

    // Get AI response
    let assistantResponse: string;
    try {
      assistantResponse = await callAnthropicAPI(conversationHistory, SYSTEM_PROMPT);
    } catch (error: any) {
      // Log the error for debugging
      console.error('Reflection AI error:', error?.message || error);
      request.log.error({ error: error?.message || error }, 'Reflection AI error');
      // Fallback response if AI is unavailable
      assistantResponse = "I'm here with what you've shared. We can continue when you're ready, or leave this here.";
    }

    // Save assistant response
    const savedResponse = await prisma.reflectionMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'assistant',
        content: assistantResponse,
      },
    });

    // Log for audit (no content, just action)
    await prisma.auditLog.create({
      data: {
        action: 'reflection.chat',
        userId,
        targetId: conversation.id,
        targetType: 'REFLECTION_CONVERSATION',
      },
    });

    return {
      conversationId: conversation.id,
      message: {
        id: savedResponse.id,
        role: 'assistant',
        content: assistantResponse,
        createdAt: savedResponse.createdAt,
      },
    };
  });

  /**
   * Convert text to speech using ElevenLabs
   * POST /api/reflection/tts
   * Returns a URL to stream the audio
   */
  app.post('/tts', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = ttsSchema.parse(request.body);

    try {
      const audioBuffer = await callOpenAITTS(body.text);

      // Generate unique ID and store in cache (expires in 5 minutes)
      const audioId = `audio_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      audioCache.set(audioId, {
        buffer: audioBuffer,
        expires: Date.now() + 5 * 60 * 1000,
      });

      // Return URL to stream the audio
      return {
        audioUrl: `/api/reflection/audio/${audioId}`,
      };
    } catch (error: any) {
      console.error('TTS error:', error?.message || error);
      return reply.status(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Failed to generate audio',
      });
    }
  });

  /**
   * Stream audio file with Range support (required for Android)
   * GET /api/reflection/audio/:id
   * No auth required - audio IDs are random and expire quickly
   */
  app.get('/audio/:id', { preHandler: [] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const cached = audioCache.get(id);
    if (!cached) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Audio not found or expired',
      });
    }

    const buffer = cached.buffer;
    const totalSize = buffer.length;

    // CORS headers
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Range');

    // Always indicate we support ranges
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Type', 'audio/mpeg');
    reply.header('Cache-Control', 'no-cache');

    // Check for Range header (Android requires this)
    const rangeHeader = request.headers.range;

    if (rangeHeader) {
      // Parse range header: "bytes=start-end"
      const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
      if (match) {
        const start = match[1] ? parseInt(match[1], 10) : 0;
        const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;

        // Validate range
        if (start >= totalSize || end >= totalSize || start > end) {
          reply.status(416).header('Content-Range', `bytes */${totalSize}`);
          return reply.send('Range Not Satisfiable');
        }

        const chunkSize = end - start + 1;
        const chunk = buffer.slice(start, end + 1);

        reply.status(206);
        reply.header('Content-Length', chunkSize);
        reply.header('Content-Range', `bytes ${start}-${end}/${totalSize}`);
        return reply.send(chunk);
      }
    }

    // No range requested - send full file
    reply.header('Content-Length', totalSize);
    return reply.send(buffer);
  });

  /**
   * Get conversation history
   * GET /api/reflection/conversations
   */
  app.get('/conversations', async (request: FastifyRequest) => {
    const conversations = await prisma.reflectionConversation.findMany({
      where: { userId: request.userId! },
      orderBy: { updatedAt: 'desc' },
      take: 20,
      include: {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    return {
      conversations: conversations.map((c) => ({
        id: c.id,
        lastMessage: c.messages[0]?.content.slice(0, 100) || null,
        updatedAt: c.updatedAt,
      })),
    };
  });

  /**
   * Get a specific conversation
   * GET /api/reflection/conversations/:id
   */
  app.get('/conversations/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const conversation = await prisma.reflectionConversation.findFirst({
      where: {
        id,
        userId: request.userId!,
      },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!conversation) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Conversation not found',
      });
    }

    return {
      id: conversation.id,
      messages: conversation.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      })),
    };
  });

  /**
   * Delete a conversation
   * DELETE /api/reflection/conversations/:id
   */
  app.delete('/conversations/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const conversation = await prisma.reflectionConversation.findFirst({
      where: {
        id,
        userId: request.userId!,
      },
    });

    if (!conversation) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Conversation not found',
      });
    }

    // Delete messages first, then conversation
    await prisma.reflectionMessage.deleteMany({
      where: { conversationId: id },
    });

    await prisma.reflectionConversation.delete({
      where: { id },
    });

    await prisma.auditLog.create({
      data: {
        action: 'reflection.conversation.delete',
        userId: request.userId,
        targetId: id,
        targetType: 'REFLECTION_CONVERSATION',
      },
    });

    return { message: 'Conversation deleted' };
  });
}
