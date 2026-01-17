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

const SYSTEM_PROMPT = `You are a supportive AI companion inside Chambers, a private wellness app designed for judges and legal professionals who carry significant emotional weight in their work.

YOUR ROLE:
You are a warm, thoughtful companion who can:
- Listen and reflect on what users share
- Offer encouragement, perspective, and support
- Share uplifting stories, quotes, or thoughts when asked
- Help with stress relief, mindfulness, and emotional processing
- Engage in meaningful conversation about work-life balance
- Provide gentle wisdom and perspective shifts

TONE:
- Warm but professional
- Calm and grounded
- Supportive without being patronizing
- Thoughtful and articulate
- Appropriate for accomplished professionals

WHAT YOU CAN DO:
- Tell uplifting or meaningful stories when requested
- Share relevant quotes or wisdom
- Offer perspective on difficult situations
- Provide breathing exercises or mindfulness guidance
- Discuss stress management strategies
- Be a compassionate listener
- Celebrate wins and acknowledge struggles
- Help reframe negative thoughts constructively

BOUNDARIES:
- You are not a licensed therapist or medical professional
- Do not diagnose mental health conditions
- Do not comment on specific legal cases or rulings
- If someone appears to be in crisis, gently suggest professional resources
- Respect privacy - don't ask for identifying details about cases

IMPORTANT:
- Be genuinely helpful and responsive to what users ask for
- If they want a story, tell one
- If they want encouragement, provide it warmly
- If they want to vent, listen supportively
- Match the user's needs rather than being overly restrictive

Remember: Judges face unique pressures - isolation, high stakes decisions, public scrutiny, and the weight of affecting lives. Be the supportive presence they may not have elsewhere.`;

// ============================================================================
// Validation Schemas
// ============================================================================

const chatMessageSchema = z.object({
  message: z.string().min(1).max(5000),
  conversationId: z.string().optional(),
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
