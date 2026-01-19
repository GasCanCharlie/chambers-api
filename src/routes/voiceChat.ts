/**
 * Voice Chat Routes (Simple STT/Chat/TTS approach)
 *
 * 1. Receive audio from client
 * 2. Transcribe with Whisper
 * 3. Get response from GPT-4
 * 4. Convert to speech with TTS
 * 5. Return audio response
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env.js';
import OpenAI from 'openai';

// System prompt for voice conversations
const VOICE_SYSTEM_PROMPT = `You are a friendly voice companion in Chambers, a wellness app for judges. This is a casual voice conversation - keep it natural and conversational.

VOICE STYLE:
- Speak naturally like a supportive friend
- Keep responses SHORT - aim for 2-3 sentences max
- One thought at a time, one question at a time
- Use contractions (I'm, you're, that's)
- Avoid starting every response with "Sure!" or "Absolutely!"
- Never say "As an AI" or "I'm just a language model"

CONVERSATION FLOW:
- Listen more than you speak
- Ask follow-up questions to show you're engaged
- When someone shares something heavy, acknowledge it first before offering perspective

TOPICS YOU'RE GREAT AT:
- Stress from difficult cases
- Work-life balance
- Processing emotions from court
- Quick mindfulness or breathing guidance
- General encouragement and perspective

BOUNDARIES:
- Don't give legal advice
- If someone seems in crisis, gently suggest professional support
- Keep it supportive, not therapeutic

Remember: Judges often feel isolated. Be the thoughtful friend they can talk to.`;

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface VoiceChatRequest {
  audio: string; // base64 encoded audio
  conversationHistory?: ConversationMessage[];
}

export default async function voiceChatRoutes(app: FastifyInstance): Promise<void> {
  // Log API key status
  if (!env.OPENAI_API_KEY) {
    app.log.warn('OPENAI_API_KEY not configured - voice chat will not work');
  }

  // Create OpenAI client if key is available
  const openai = env.OPENAI_API_KEY ? new OpenAI({ apiKey: env.OPENAI_API_KEY }) : null;

  /**
   * GET /api/voice-chat/status
   * Check if voice chat is available
   */
  app.get('/voice-chat/status', async (request, reply) => {
    return reply.send({
      available: !!env.OPENAI_API_KEY,
      features: {
        stt: true,
        chat: true,
        tts: true,
      },
    });
  });

  /**
   * POST /api/voice-chat
   * Process voice input and return voice response
   */
  app.post('/voice-chat', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['audio'],
        properties: {
          audio: { type: 'string' },
          conversationHistory: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string', enum: ['user', 'assistant'] },
                content: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: VoiceChatRequest }>, reply: FastifyReply) => {
    // Check if OpenAI is configured
    if (!openai) {
      return reply.status(503).send({
        error: 'Voice chat is not configured',
        code: 'NOT_CONFIGURED',
      });
    }

    const { audio, conversationHistory = [] } = request.body;

    try {
      // 1. Convert base64 audio to buffer
      const audioBuffer = Buffer.from(audio, 'base64');

      // Create a File object for the API
      const audioFile = new File([audioBuffer], 'audio.wav', { type: 'audio/wav' });

      // 2. Transcribe audio with Whisper
      request.log.info('Transcribing audio with Whisper...');
      const transcription = await openai.audio.transcriptions.create({
        file: audioFile,
        model: 'whisper-1',
        language: 'en',
      });

      const userText = transcription.text;
      request.log.info({ userText: userText.substring(0, 100) }, 'Transcription complete');

      if (!userText || userText.trim().length === 0) {
        return reply.status(400).send({
          error: 'Could not understand audio',
          code: 'TRANSCRIPTION_EMPTY',
        });
      }

      // 3. Get response from GPT-4
      request.log.info('Getting response from GPT-4...');
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: VOICE_SYSTEM_PROMPT },
        ...conversationHistory.map(msg => ({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        })),
        { role: 'user', content: userText },
      ];

      const chatResponse = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages,
        max_tokens: 150, // Keep responses short for voice
        temperature: 0.7,
      });

      const assistantText = chatResponse.choices[0]?.message?.content || 'I\'m sorry, I couldn\'t generate a response.';
      request.log.info({ assistantText: assistantText.substring(0, 100) }, 'Chat response complete');

      // 4. Convert response to speech with TTS
      request.log.info('Converting to speech with TTS...');
      const speechResponse = await openai.audio.speech.create({
        model: 'tts-1',
        voice: 'nova', // Warm, friendly voice
        input: assistantText,
        response_format: 'mp3',
      });

      // Get audio as buffer
      const audioArrayBuffer = await speechResponse.arrayBuffer();
      const responseAudioBuffer = Buffer.from(audioArrayBuffer);
      const responseAudioBase64 = responseAudioBuffer.toString('base64');

      request.log.info('Voice chat complete');

      // 5. Return response
      return reply.send({
        userText,
        assistantText,
        audio: responseAudioBase64,
        audioFormat: 'mp3',
      });

    } catch (error: any) {
      request.log.error({ error: error.message }, 'Voice chat error');

      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        return reply.status(503).send({
          error: 'Service temporarily unavailable',
          code: 'SERVICE_UNAVAILABLE',
        });
      }

      return reply.status(500).send({
        error: error.message || 'Voice chat failed',
        code: 'VOICE_CHAT_ERROR',
      });
    }
  });
}
