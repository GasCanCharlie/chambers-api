/**
 * OpenAI Realtime API Client
 *
 * Handles WebSocket connection to OpenAI's Realtime API
 * for bidirectional audio streaming
 */

import WebSocket from 'ws';

export interface OpenAIRealtimeConfig {
  apiKey: string;
  model: string;
  systemPrompt: string;
  voice: string;
  onAudioDelta: (audio: string, itemId: string) => void;
  onAudioDone: (itemId: string) => void;
  onTranscriptDelta: (text: string, itemId: string) => void;
  onTranscriptDone: (text: string, itemId: string) => void;
  onUserSpeechStarted: () => void;
  onUserSpeechStopped: () => void;
  onError: (error: Error) => void;
  onClose: () => void;
}

export class OpenAIRealtimeClient {
  private ws: WebSocket | null = null;
  private config: OpenAIRealtimeConfig;
  private isConnected = false;
  private currentResponseItemId: string | null = null;

  constructor(config: OpenAIRealtimeConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `wss://api.openai.com/v1/realtime?model=${this.config.model}`;

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      this.ws.on('open', () => {
        this.isConnected = true;
        this.configureSession();
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (error) => {
        this.config.onError(error);
        if (!this.isConnected) {
          reject(error);
        }
      });

      this.ws.on('close', () => {
        this.isConnected = false;
        this.config.onClose();
      });

      // Connection timeout
      setTimeout(() => {
        if (!this.isConnected) {
          reject(new Error('Connection timeout'));
          this.close();
        }
      }, 10000);
    });
  }

  private configureSession(): void {
    this.send({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: this.config.systemPrompt,
        voice: this.config.voice,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: {
          model: 'whisper-1',
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
      },
    });
  }

  private handleMessage(data: Buffer): void {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'session.created':
        case 'session.updated':
          // Session configured successfully
          break;

        case 'input_audio_buffer.speech_started':
          this.config.onUserSpeechStarted();
          break;

        case 'input_audio_buffer.speech_stopped':
          this.config.onUserSpeechStopped();
          break;

        case 'response.created':
          // New response starting
          break;

        case 'response.output_item.added':
          if (message.item?.type === 'message') {
            this.currentResponseItemId = message.item.id;
          }
          break;

        case 'response.audio.delta':
          if (message.delta) {
            const itemId = message.item_id || this.currentResponseItemId || 'unknown';
            this.config.onAudioDelta(message.delta, itemId);
          }
          break;

        case 'response.audio.done':
          const audioItemId = message.item_id || this.currentResponseItemId || 'unknown';
          this.config.onAudioDone(audioItemId);
          break;

        case 'response.audio_transcript.delta':
          if (message.delta) {
            const transcriptItemId = message.item_id || this.currentResponseItemId || 'unknown';
            this.config.onTranscriptDelta(message.delta, transcriptItemId);
          }
          break;

        case 'response.audio_transcript.done':
          if (message.transcript) {
            const transcriptDoneItemId = message.item_id || this.currentResponseItemId || 'unknown';
            this.config.onTranscriptDone(message.transcript, transcriptDoneItemId);
          }
          break;

        case 'response.done':
          this.currentResponseItemId = null;
          break;

        case 'error':
          this.config.onError(new Error(message.error?.message || 'Unknown OpenAI error'));
          break;

        case 'input_audio_buffer.committed':
        case 'input_audio_buffer.cleared':
        case 'conversation.item.created':
        case 'response.content_part.added':
        case 'response.content_part.done':
        case 'conversation.item.input_audio_transcription.completed':
          // Informational events, no action needed
          break;

        default:
          // Log unknown message types for debugging
          console.log('Unknown OpenAI message type:', message.type);
      }
    } catch (error) {
      console.error('Error parsing OpenAI message:', error);
    }
  }

  sendAudio(base64Audio: string): void {
    if (!this.isConnected) return;

    this.send({
      type: 'input_audio_buffer.append',
      audio: base64Audio,
    });
  }

  interrupt(): void {
    if (!this.isConnected) return;

    // Cancel current response
    this.send({ type: 'response.cancel' });

    // Clear input buffer
    this.send({ type: 'input_audio_buffer.clear' });
  }

  private send(message: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }
}
