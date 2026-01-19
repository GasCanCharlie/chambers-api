/**
 * Voice Chat WebSocket Routes
 *
 * Real-time voice conversation using OpenAI Realtime API
 * Handles bidirectional audio streaming with barge-in support
 */

import { FastifyInstance, FastifyRequest } from 'fastify';
import { WebSocket } from 'ws';
import { env } from '../config/env.js';
import { OpenAIRealtimeClient } from '../services/openaiRealtime.js';

// Rate limiting: track messages per connection
const connectionRateLimits = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_PER_SEC = 10;

// Session timeout: 10 minutes
const SESSION_TIMEOUT_MS = 600000;

// System prompt for voice conversations
const REALTIME_SYSTEM_PROMPT = `You are a friendly voice companion in Chambers, a wellness app for judges. This is a casual voice conversation - keep it natural and conversational.

VOICE STYLE:
- Speak naturally like a supportive friend
- Keep responses SHORT - aim for 5-10 seconds of speech
- One thought at a time, one question at a time
- Use contractions (I'm, you're, that's)
- Brief confirmations (mm-hmm, got it, I see)
- Avoid starting every response with "Sure!" or "Absolutely!"
- Never say "As an AI" or "I'm just a language model"

CONVERSATION FLOW:
- Listen more than you speak
- Ask follow-up questions to show you're engaged
- When someone shares something heavy, acknowledge it first before offering perspective
- For troubleshooting: short, direct steps
- For brainstorming: one idea at a time, ask if they want more

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

interface ClientMessage {
  type: string;
  audio?: string;
  config?: {
    voice?: string;
  };
}

export default async function voiceRoutes(app: FastifyInstance): Promise<void> {
  // Register WebSocket handler for /api/voice
  app.get('/voice', { websocket: true }, async (socket: WebSocket, req: FastifyRequest) => {
    const connectionId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
    let userId: string | null = null;
    let openaiClient: OpenAIRealtimeClient | null = null;
    let sessionTimeout: NodeJS.Timeout | null = null;

    // Initialize rate limit tracker
    connectionRateLimits.set(connectionId, { count: 0, resetAt: Date.now() + 1000 });

    const log = (level: string, message: string, data?: Record<string, unknown>) => {
      const logData: Record<string, unknown> = { connectionId, userId, ...data };
      // Don't log audio content
      if (logData.audio && typeof logData.audio === 'string') {
        logData.audio = `[base64 ${logData.audio.length} chars]`;
      }
      if (level === 'error') {
        req.log.error(logData, message);
      } else {
        req.log.info(logData, message);
      }
    };

    const sendToClient = (message: Record<string, unknown>) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    };

    const closeConnection = (reason: string) => {
      log('info', 'Closing connection', { reason });
      sendToClient({ type: 'session.ended', reason });

      if (sessionTimeout) {
        clearTimeout(sessionTimeout);
      }
      if (openaiClient) {
        openaiClient.close();
      }
      connectionRateLimits.delete(connectionId);

      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000, reason);
      }
    };

    // Check rate limit
    const checkRateLimit = (): boolean => {
      const now = Date.now();
      const limit = connectionRateLimits.get(connectionId);

      if (!limit) return false;

      if (now > limit.resetAt) {
        limit.count = 1;
        limit.resetAt = now + 1000;
        return true;
      }

      if (limit.count >= RATE_LIMIT_PER_SEC) {
        return false;
      }

      limit.count++;
      return true;
    };

    // Authenticate on first message
    const authenticate = async (token: string): Promise<boolean> => {
      try {
        const decoded = app.jwt.verify(token) as { userId: string };
        userId = decoded.userId;
        log('info', 'User authenticated');
        return true;
      } catch (error) {
        log('error', 'Authentication failed');
        return false;
      }
    };

    // Handle incoming messages from client
    socket.on('message', async (data: Buffer) => {
      try {
        const message: ClientMessage & { token?: string } = JSON.parse(data.toString());

        // Rate limit check (except for auth)
        if (message.type !== 'auth' && !checkRateLimit()) {
          sendToClient({ type: 'error', message: 'Rate limit exceeded', code: 'RATE_LIMIT' });
          return;
        }

        switch (message.type) {
          case 'auth': {
            if (!message.token) {
              sendToClient({ type: 'error', message: 'Token required', code: 'AUTH_REQUIRED' });
              closeConnection('No token provided');
              return;
            }

            const authenticated = await authenticate(message.token);
            if (!authenticated) {
              sendToClient({ type: 'error', message: 'Invalid token', code: 'AUTH_FAILED' });
              closeConnection('Authentication failed');
              return;
            }

            sendToClient({ type: 'auth.success' });
            break;
          }

          case 'session.start': {
            if (!userId) {
              sendToClient({ type: 'error', message: 'Not authenticated', code: 'NOT_AUTHENTICATED' });
              return;
            }

            if (openaiClient) {
              log('info', 'Closing existing OpenAI session');
              openaiClient.close();
            }

            // Create OpenAI Realtime client
            const voice = message.config?.voice || 'sage';
            openaiClient = new OpenAIRealtimeClient({
              apiKey: env.OPENAI_API_KEY!,
              model: 'gpt-4o-realtime-preview-2024-12-17',
              systemPrompt: REALTIME_SYSTEM_PROMPT,
              voice,
              onAudioDelta: (audio, itemId) => {
                sendToClient({ type: 'audio.chunk', audio, itemId });
              },
              onAudioDone: (itemId) => {
                sendToClient({ type: 'audio.done', itemId });
              },
              onTranscriptDelta: (text, itemId) => {
                sendToClient({ type: 'transcript.delta', text, itemId });
              },
              onTranscriptDone: (text, itemId) => {
                sendToClient({ type: 'transcript.done', text, itemId });
              },
              onUserSpeechStarted: () => {
                sendToClient({ type: 'user.speech_started' });
              },
              onUserSpeechStopped: () => {
                sendToClient({ type: 'user.speech_stopped' });
              },
              onError: (error) => {
                log('error', 'OpenAI error', { error: error.message });
                sendToClient({ type: 'error', message: error.message, code: 'OPENAI_ERROR' });
              },
              onClose: () => {
                log('info', 'OpenAI connection closed');
                sendToClient({ type: 'session.ended', reason: 'OpenAI connection closed' });
              },
            });

            try {
              await openaiClient.connect();
              log('info', 'OpenAI session started');
              sendToClient({ type: 'session.ready', sessionId: connectionId });

              // Start session timeout
              sessionTimeout = setTimeout(() => {
                closeConnection('Session timeout');
              }, SESSION_TIMEOUT_MS);
            } catch (error: any) {
              log('error', 'Failed to connect to OpenAI', { error: error.message });
              sendToClient({ type: 'error', message: 'Failed to start voice session', code: 'CONNECTION_FAILED' });
            }
            break;
          }

          case 'audio.chunk': {
            if (!openaiClient) {
              sendToClient({ type: 'error', message: 'No active session', code: 'NO_SESSION' });
              return;
            }

            if (message.audio) {
              openaiClient.sendAudio(message.audio);
            }
            break;
          }

          case 'interrupt': {
            if (openaiClient) {
              openaiClient.interrupt();
              log('info', 'Interrupted assistant');
            }
            break;
          }

          case 'session.end': {
            closeConnection('Client requested end');
            break;
          }

          default:
            log('info', 'Unknown message type', { messageType: message.type });
        }
      } catch (error: any) {
        log('error', 'Error processing message', { error: error.message });
        sendToClient({ type: 'error', message: 'Invalid message format', code: 'INVALID_MESSAGE' });
      }
    });

    socket.on('close', () => {
      log('info', 'Client disconnected');
      if (sessionTimeout) {
        clearTimeout(sessionTimeout);
      }
      if (openaiClient) {
        openaiClient.close();
      }
      connectionRateLimits.delete(connectionId);
    });

    socket.on('error', (error) => {
      log('error', 'WebSocket error', { error: error.message });
    });

    log('info', 'Client connected');
  });
}
