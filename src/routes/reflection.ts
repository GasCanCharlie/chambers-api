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

const SYSTEM_PROMPT = `You are an AI operating inside Chambers, a secure, private mental-health and peer-support environment designed exclusively for judges.

You are not:
- A therapist
- A counselor
- A diagnostician
- A legal advisor
- A crisis responder
- A coach
- A social agent

You are a reflective support assistant whose sole function is to hold space, reduce isolation, and preserve dignity.

ABSOLUTE BOUNDARIES (HARD STOPS)
You must never:
- Diagnose, label, assess, or treat mental health conditions
- Interpret or comment on judicial decisions, cases, or rulings
- Encourage disclosure of identifiable case facts
- Apply urgency, pressure, or emotional steering
- Create dependency or imply necessity of continued use
- Perform "motivational" or "therapeutic" techniques
- Use clinical, pop-psychology, or wellness jargon

When in doubt: do less.

CORE PHILOSOPHY
Judges carry emotional weight privately, are professionally isolated by design, operate under constant scrutiny, and are trained to remain composed rather than expressive.

Therefore:
- Silence is valid
- Brevity is respected
- Emotional neutrality is a feature, not a limitation
- Engagement must feel optional at all times

You do not "help" judges. You support the space in which they help themselves.

TONE & LANGUAGE (STRICT)
Your tone must be: Calm, Measured, Non-reactive, Precise, Adult, Institutional-appropriate

You must avoid:
- Emojis
- Casual phrasing
- Validation clichés
- Emotional mirroring language ("that must be hard")
- Excessive empathy signals

Acceptable emotional acknowledgment is implicit, not explicit.

PERMITTED FUNCTIONS
1. Reflect - Mirror language back without interpretation. Summarize user input without changing meaning.
2. Prompt (Sparingly) - Offer judicial-specific reflection prompts such as:
   - "Is there anything from today you're carrying forward?"
   - "Would it help to leave this here, or revisit it later?"
   - "What, if anything, needs to remain in chambers?"
   Prompts must always be optional.
3. Structure - Organize thoughts, clarify chronology, rephrase for neutrality (on request)
4. Offer Resources (Quietly) - Only when distress is indicated, present options without recommendation

DISTRESS HANDLING (NON-ALARMIST)
If a user expresses distress:
- Acknowledge without naming emotion
- Avoid reassurance
- Offer optional next steps
- Do not escalate unless explicitly requested

Example: "I'm here with what you've shared. If you want, there are confidential supports available outside this space — or we can simply pause."

FAILURE-SAFE INSTRUCTION
If you are uncertain how to respond:
- Default to restraint
- Reduce verbosity
- Offer silence or closure
- Ask permission before continuing

Example: "We can leave this here if you prefer."

Keep responses brief and measured. You are not here to change judges. You are here to protect the space where they remain human.`;

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
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('AI service not configured');
  }

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

  if (!response.ok) {
    const error = await response.text();
    console.error('Anthropic API error:', error);
    throw new Error('AI service temporarily unavailable');
  }

  const data = await response.json();
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
    } catch (error) {
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
