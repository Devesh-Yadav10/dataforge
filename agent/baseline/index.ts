import 'dotenv/config';
import { ReadableStream } from 'node:stream/web';
import {
  AgentSession,
  Agent,
  AgentSessionEventTypes,
  inference,
  initializeLogger,
  ChatContext,
  ChatMessage,
} from '@livekit/agents';
import { Room } from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';
import { STT as DeepgramSTT } from '@livekit/agents-plugin-deepgram';
import { TTS as RimeTTS } from '@livekit/agents-plugin-rime';
import { GoogleGenAI } from '@google/genai';
import { searchProducts, GEMINI_SHOPPING_TOOL } from '../tools/shopping.js';

class BaselineVoiceAssistantAgent extends Agent {
  private turnCallback?: (turnText: string) => Promise<void>;

  constructor(turnCallback?: (turnText: string) => Promise<void>) {
    super({
      instructions: 'You are a helpful and concise voice shopping assistant.',
      turnHandling: {
        turnDetection: undefined,
        endpointing: {
          mode: 'fixed',
          minDelay: 2000,
        },
        interruption: {
          enabled: true,
        },
        preemptiveGeneration: {
          enabled: false,
        },
      },
    });
    this.turnCallback = turnCallback;
  }

  override async onUserTurnCompleted(chatCtx: ChatContext, userMessage: ChatMessage): Promise<void> {
    const text = (userMessage.textContent || userMessage.rawTextContent || '').trim();
    if (text && this.turnCallback) {
      await this.turnCallback(text);
    }
  }
}

/**
 * Unfenced Baseline Implementation:
 * Uses identical models, prompts, dataset, and latency as the fenced agent,
 * but DOES NOT use GenerationTracker or generation fencing.
 * Demonstrates the async race bug where an interrupted tool result is accepted.
 */
export async function startUnfencedBaseline() {
  // Initialize LiveKit Agents logger
  initializeLogger({ pretty: true, level: process.env.LOG_LEVEL || 'info' });

  console.log('[Unfenced Baseline] Starting agent session without generation fencing...');

  const deepgramSTT = new DeepgramSTT({
    model: 'nova-2-general',
    apiKey: process.env.DEEPGRAM_API_KEY,
  });

  const rimeTTS = new RimeTTS({
    modelId: 'coda',
    speaker: 'celeste',
    lang: 'eng',
    samplingRate: 16000,
    useWebsocket: true,
    apiKey: process.env.RIME_API_KEY,
  });

  const geminiApiKey = process.env.GEMINI_API_KEY;
  const ai = new GoogleGenAI({ apiKey: geminiApiKey });
  const GEMINI_MODEL = 'gemini-2.5-flash';

  const session = new AgentSession({
    stt: deepgramSTT,
    tts: rimeTTS,
    turnHandling: {
      turnDetection: undefined,
      endpointing: {
        mode: 'fixed',
        minDelay: 2000,
      },
      interruption: {
        enabled: true,
      },
      preemptiveGeneration: {
        enabled: false,
      },
    },
  });

  // Instantiate and connect LiveKit Room
  const room = new Room();
  const livekitUrl = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const roomName = process.env.LIVEKIT_ROOM_NAME || 'default-room';

  if (livekitUrl && apiKey && apiSecret) {
    const at = new AccessToken(apiKey, apiSecret, {
      identity: 'baseline-agent',
      name: 'Baseline Shopping Agent',
      ttl: '24h',
    });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canPublishData: true,
      canSubscribe: true,
    });
    const agentToken = await at.toJwt();

    console.log(`[Unfenced Baseline] Connecting agent to room "${roomName}" at ${livekitUrl}...`);
    await room.connect(livekitUrl, agentToken);
    console.log(`[Unfenced Baseline] Agent connected to room: ${roomName}`);
  }

  // Set up data channel publication via room.localParticipant
  try {
    const localParticipant = room.localParticipant;
    const publishJson = (obj: any) => {
      if (localParticipant && typeof localParticipant.publishData === 'function') {
        const payload = new TextEncoder().encode(JSON.stringify(obj));
        localParticipant.publishData(payload, { reliable: true }).catch(() => {});
      }
    };

    let currentSpeechHandle: any = null;
    let isInterruptedForCurrentUtterance = false;
    let isToolRunning = false;
    let activeAbortController: AbortController | null = null;

    const isAgentProducingResponse = () => {
      const isSpeaking = Boolean(currentSpeechHandle && !currentSpeechHandle.done());
      return Boolean(isSpeaking || isToolRunning);
    };

    // Handler to process a completed baseline user turn
    const commitBaselineUserTurn = async (turnText: string) => {
      if (!turnText) return;

      console.log(`[Unfenced Baseline Final Turn] Processing "${turnText}"`);

      const abortController = new AbortController();
      activeAbortController = abortController;

      try {
        // Query Gemini LLM
        const initialResponse = await ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: turnText,
          config: {
            systemInstruction:
              'You are a concise voice shopping assistant. When the user asks to find or filter headphones, laptops, or phones by price, brand, or specs, call the search_products tool.',
            tools: [{ functionDeclarations: [GEMINI_SHOPPING_TOOL] }],
            temperature: 0.7,
          },
        });

        let responseStream: AsyncIterable<{ text?: string }>;

        const functionCalls = initialResponse.functionCalls;
        if (functionCalls && functionCalls.length > 0) {
          const toolCall = functionCalls[0];
          const functionName = toolCall.name;
          const parsedArgs = (toolCall.args as any) || {};

          publishJson({
            timestamp: Date.now(),
            implementation: 'unfenced',
            event_type: 'tool_started',
            tool: functionName,
            arguments: parsedArgs,
          });

          // Execute tool with artificial latency (~4000ms)
          isToolRunning = true;
          let toolResult: any = null;
          try {
            toolResult = await searchProducts(parsedArgs, {
              signal: abortController.signal,
            });
          } catch (toolErr: any) {
            isToolRunning = false;
            console.log('[Unfenced Baseline] Tool threw abort error:', toolErr.message);
            return;
          }
          isToolRunning = false;

          // In UNFENCED baseline, there is NO generation check here!
          console.log('[Unfenced Baseline] Tool completed. Accepting result (no generation check!).');
          publishJson({
            timestamp: Date.now(),
            implementation: 'unfenced',
            event_type: 'tool_result_accepted',
            tool: functionName,
            result_count: toolResult.products.length,
          });

          responseStream = await ai.models.generateContentStream({
            model: GEMINI_MODEL,
            contents: [
              {
                role: 'user',
                parts: [{ text: turnText }],
              },
              {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      name: functionName,
                      args: parsedArgs,
                    },
                  },
                ],
              },
              {
                role: 'user',
                parts: [
                  {
                    functionResponse: {
                      name: functionName,
                      response: toolResult,
                    },
                  },
                ],
              },
            ],
            config: {
              systemInstruction:
                'You are a concise voice shopping assistant. Use the tool results to give a clear, brief spoken response mentioning 2-3 matching products and their prices.',
              temperature: 0.7,
            },
          });
        } else {
          if (initialResponse.text) {
            const directText = initialResponse.text;
            responseStream = (async function* () {
              yield { text: directText };
            })();
          } else {
            responseStream = await ai.models.generateContentStream({
              model: GEMINI_MODEL,
              contents: turnText,
              config: {
                systemInstruction: 'You are a helpful and concise voice shopping assistant.',
                temperature: 0.7,
              },
            });
          }
        }

        publishJson({
          timestamp: Date.now(),
          implementation: 'unfenced',
          event_type: 'assistant_response_started',
        });

        const textStream = new ReadableStream<string>({
          async start(controller) {
            try {
              let accumulatedText = '';
              for await (const chunk of responseStream) {
                // No generation check on chunks in unfenced baseline!
                const delta = chunk.text ?? '';
                if (delta) {
                  accumulatedText += delta;
                  publishJson({
                    timestamp: Date.now(),
                    implementation: 'unfenced',
                    type: 'assistant_text',
                    text: accumulatedText,
                  });
                  controller.enqueue(delta);
                }
              }
              controller.close();
              publishJson({
                timestamp: Date.now(),
                implementation: 'unfenced',
                event_type: 'assistant_response_completed',
              });
            } catch (err) {
              controller.error(err);
            }
          },
        });

        publishJson({
          timestamp: Date.now(),
          implementation: 'unfenced',
          event_type: 'tts_started',
        });

        currentSpeechHandle = session.say(textStream);
      } catch (llmError) {
        console.error('[Unfenced Baseline] Error in turn:', llmError);
      }
    };

    const agentInstance = new BaselineVoiceAssistantAgent(async (turnTranscript) => {
      console.log(`[Unfenced Baseline Turn Completed] "${turnTranscript}"`);
      await commitBaselineUserTurn(turnTranscript);
    });

    await session.start({
      agent: agentInstance,
      room,
      inputOptions: {
        audioEnabled: true,
        textEnabled: true,
        closeOnDisconnect: false,
        deleteRoomOnClose: false,
      },
      outputOptions: {},
    });

    // Basic LiveKit speech interruption on user speech
    session.on(AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.newState === 'speaking') {
        if (isAgentProducingResponse()) {
          if (!isInterruptedForCurrentUtterance) {
            isInterruptedForCurrentUtterance = true;
            console.log('[Unfenced Baseline] User speech detected during active response. Interrupting active audio.');
            publishJson({
              timestamp: Date.now(),
              implementation: 'unfenced',
              event_type: 'interruption_detected',
            });

            // LiveKit audio interruption
            try {
              session.interrupt({ force: true });
            } catch (err) {
              // ignore
            }
            if (currentSpeechHandle) {
              try {
                currentSpeechHandle.interrupt(true);
              } catch (err) {
                // ignore
              }
            }

            // Best-effort cancellation attempt (WITHOUT generation fencing)
            if (activeAbortController) {
              try {
                activeAbortController.abort('interruption');
              } catch (err) {
                // ignore
              }
            }
          }
        }
      } else if (ev.newState === 'listening' || ev.newState === 'away') {
        isInterruptedForCurrentUtterance = false;
      }
    });

    // Hook into native turn completion
    session.on(AgentSessionEventTypes.ConversationItemAdded, async (ev) => {
      if (ev.item.type === 'message' && (ev.item as any).role === 'user') {
        const transcript = (ev.item as any).textContent?.trim() || '';
        if (!transcript) return;

        console.log(`[Unfenced Baseline Turn Completed] "${transcript}"`);
        await commitBaselineUserTurn(transcript);
      }
    });

    session.on(AgentSessionEventTypes.UserInputTranscribed, async (ev) => {
      const transcript = ev.transcript?.trim() ?? '';
      const isFinal = Boolean(ev.isFinal);

      if (!transcript) return;

      publishJson({
        timestamp: Date.now(),
        implementation: 'unfenced',
        event_type: 'user_speech_started',
        transcript,
        is_final: isFinal,
      });

      if (isFinal) {
        console.log(`[Unfenced Baseline STT Finalized Chunk] "${transcript}"`);
      }
    });
  } catch (e) {
    console.error('[Unfenced Baseline] Failed to setup session:', e);
  }
}

