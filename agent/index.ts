import 'dotenv/config';
import { ReadableStream } from 'node:stream/web';
import {
  AgentSession,
  Agent,
  RoomInputOptions,
  RoomOutputOptions,
  AgentSessionEventTypes,
  inference,
  initializeLogger,
  ChatContext,
  ChatMessage,
} from '@livekit/agents';
import { STT as DeepgramSTT } from '@livekit/agents-plugin-deepgram';
import { TTS as RimeTTS } from '@livekit/agents-plugin-rime';
import { GoogleGenAI } from '@google/genai';
import { searchProducts, GEMINI_SHOPPING_TOOL, compactToolResult } from './tools/shopping.js';
import { GenerationTracker } from './tracker.js';
import { startTokenServer } from './token_server.js';

import { Room } from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';

class VoiceAssistantAgent extends Agent {
  private turnCallback?: (turnText: string) => Promise<void>;

  constructor(turnCallback?: (turnText: string) => Promise<void>) {
    super({
      instructions: "You are a helpful and concise voice shopping assistant.",
      turnHandling: {
        turnDetection: new inference.TurnDetector(),
        endpointing: {
          mode: 'fixed',
          minDelay: 800,
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
    console.log(`[TURN] onUserTurnCompleted hook invoked: "${text}"`);
    if (text && this.turnCallback) {
      await this.turnCallback(text);
    }
  }
}

async function main() {
  // Initialize LiveKit Agents logger before creating any plugins or agent sessions
  initializeLogger({ pretty: true, level: process.env.LOG_LEVEL || 'info' });

  // Start the server-side LiveKit token endpoint (GET /token)
  startTokenServer();

  // Initialize centralized Generation and Operation tracker
  const tracker = new GenerationTracker();
  console.log(`[Tracker] Session initialized with session_id: ${tracker.sessionId}, initial generation: ${tracker.currentGeneration}`);

  // Create a Deepgram STT instance for Nova-2 using the plugin
  const deepgramSTT = new DeepgramSTT({
    model: 'nova-2-general',
    apiKey: process.env.DEEPGRAM_API_KEY,
  });

  // Create direct Rime TTS instance using Coda model and Celeste voice (streaming English TTS via WebSocket)
  const rimeTTS = new RimeTTS({
    modelId: 'coda',
    speaker: 'celeste',
    lang: 'eng',
    samplingRate: 16000,
    useWebsocket: true,
    apiKey: process.env.RIME_API_KEY,
  });
  console.log('[Rime] Direct Rime TTS initialized (model: coda, speaker: celeste, samplingRate: 16000, useWebsocket: true)');

  // Create Google Gemini AI client using official @google/genai SDK
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const ai = new GoogleGenAI({ apiKey: geminiApiKey });
  const GEMINI_MODEL = 'gemini-2.5-flash';

  const session = new AgentSession({
    stt: deepgramSTT,
    tts: rimeTTS,
    turnHandling: {
      turnDetection: new inference.TurnDetector(),
      endpointing: {
        mode: 'fixed',
        minDelay: 800,
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
      identity: 'shopping-agent',
      name: 'Shopping Assistant Agent',
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

    console.log(`[LiveKit] Connecting agent to room "${roomName}" at ${livekitUrl}...`);
    await room.connect(livekitUrl, agentToken);
    console.log(`[LiveKit] Agent successfully connected to room: ${roomName}`);

    // Detailed diagnostic logging for room track and participant events
    room.on('participantConnected', (p) => {
      console.log(`[LiveKit Agent] Remote participant connected: identity="${p.identity}", name="${p.name}", kind=${p.kind}`);
    });

    room.on('participantDisconnected', (p) => {
      console.log(`[LiveKit Agent] Remote participant disconnected: identity="${p.identity}"`);
    });

    room.on('trackPublished', (pub, p) => {
      console.log(`[LiveKit Agent] Remote track published: sid="${pub.sid}", kind=${pub.kind}, source=${pub.source} from participant="${p.identity}"`);
    });

    room.on('trackSubscribed', (track, pub, p) => {
      console.log(`[LiveKit Agent] Remote track subscribed: sid="${pub.sid}", kind=${track.kind}, source=${pub.source} from participant="${p.identity}"`);
    });

    room.on('trackUnsubscribed', (track, pub, p) => {
      console.log(`[LiveKit Agent] Remote track unsubscribed: sid="${pub.sid}" from participant="${p.identity}"`);
    });
  } else {
    console.warn('[LiveKit] Missing LIVEKIT_URL, LIVEKIT_API_KEY, or LIVEKIT_API_SECRET; starting session without active Room.');
  }

  // Set up data channel publication via room.localParticipant
  const localParticipant = room.localParticipant;
  const publishJson = (obj: any) => {
    if (localParticipant && typeof localParticipant.publishData === 'function') {
      const payload = new TextEncoder().encode(JSON.stringify(obj));
      localParticipant.publishData(payload, { reliable: true }).catch((err: Error) => {
        console.error('Failed to publish data:', err);
      });
    }
  };

  // Forward tracker events to client data channel for debugging and visibility
  tracker.addEventListener((ev) => {
    publishJson({
      type: 'tracker_event',
      event: ev,
    });
  });

  // Track active speech handle for explicit speech interruption
  let currentSpeechHandle: any = null;
  let isInterruptedForCurrentUtterance = false;

  // Centralized session conversation history for multi-turn Gemini context retention
  const conversationHistory: Array<{ role: 'user' | 'model'; parts: Array<any> }> = [];

  // Helper to check if the assistant is currently responding (TTS actively speaking or tool executing)
  // INVARIANT: An in-flight LLM query does NOT count as active response for barge-in
  const isAgentProducingResponse = () => {
    const isSpeakingTts = Boolean(currentSpeechHandle && !currentSpeechHandle.done());
    const isExecutingTool = tracker.hasRunningOperationType('tool');
    return Boolean(isSpeakingTts || isExecutingTool);
  };

  // Handler to process a completed user turn exactly once
  const commitUserTurn = async (turnText: string, turnGen: number) => {
    if (!turnText) return;

    console.log(`[Turn Committed] Processing full turn: "${turnText}" (Generation: ${turnGen})`);

    // Track initial LLM classification / tool selection operation
    const initialLlmOp = tracker.startOperation('llm', turnGen);
    let activeLlmOp = initialLlmOp;
    let ttsOp: ReturnType<typeof tracker.startOperation> | null = null;

    let userTurnContent = { role: 'user', parts: [{ text: turnText }] };
    let modelToolCallContent: any = null;
    let userToolResponseContent: any = null;

    try {
      console.log(`[LLM] Gemini request started: "${turnText}" (Gen: ${turnGen})`);

      // Construct multi-turn contents for Gemini, combining session history and current user turn
      const initialContents = [...conversationHistory, userTurnContent];

      // Step 1: Query Gemini LLM with deterministic shopping tool calling enabled & AbortSignal
      const initialResponse = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: initialContents,
        config: {
          systemInstruction:
            'You are a concise voice shopping assistant. When the user asks to find or filter headphones, laptops, or phones by price, brand, or specs, call the search_products tool. Remember previous products, brands, budgets, or constraints mentioned in the conversation context when the user provides follow-up instructions like "increase my budget to $400" or "specifically Sony".',
          tools: [{ functionDeclarations: [GEMINI_SHOPPING_TOOL] }],
          temperature: 0.7,
          maxOutputTokens: 256,
          abortSignal: initialLlmOp.abortController.signal,
        },
      });

      console.log(`[LLM] Gemini response received (Gen: ${turnGen})`);

      // Generation fence check after initial LLM completion
      if (!tracker.isCurrent(initialLlmOp)) {
        console.warn(`[Fenced] Discarding initial LLM response for stale ${initialLlmOp.operation_id} (Gen: ${initialLlmOp.generation_id}, Current: ${tracker.currentGeneration})`);
        tracker.recordDiscard(initialLlmOp, 'STALE_GENERATION');
        return;
      }

      let responseStream: AsyncIterable<{ text?: string }>;

      const functionCalls = initialResponse.functionCalls;
      if (functionCalls && functionCalls.length > 0) {
        tracker.completeOperation(initialLlmOp, { tool_called: true });

        const toolCall = functionCalls[0];
        const functionName = toolCall.name;
        const parsedArgs = (toolCall.args as any) || {};

        console.log(`[LLM] Gemini tool call: ${functionName}`, parsedArgs);

        // Start tracked tool operation with AbortController readiness
        const toolOp = tracker.startOperation('tool', turnGen);

        console.log(`[TOOL] searchProducts started (${toolOp.operation_id}, Gen: ${toolOp.generation_id})`, parsedArgs);
        publishJson({
          type: 'tool_event',
          event: 'tool_started',
          tool: functionName,
          operation_id: toolOp.operation_id,
          generation_id: toolOp.generation_id,
          arguments: parsedArgs,
        });

        // Execute deterministic tool with artificial latency (~4000ms) and abort signal
        let toolResult: any = null;
        try {
          toolResult = await searchProducts(parsedArgs, {
            signal: toolOp.abortController.signal,
          });
        } catch (toolErr: any) {
          if (toolErr.message === 'Operation aborted' || toolOp.abortController.signal.aborted) {
            console.log(`[Tool Cancelled] ${toolOp.operation_id} cancelled via AbortSignal`);
            tracker.recordCancellation(toolOp, { reason: 'aborted_by_interruption' });
            return;
          }
          throw toolErr;
        }

        // Generation fence check after tool completion
        if (!tracker.isCurrent(toolOp)) {
          console.warn(`[Fenced] Discarding tool result for stale ${toolOp.operation_id} (Gen: ${toolOp.generation_id}, Current: ${tracker.currentGeneration})`);
          tracker.recordDiscard(toolOp, 'STALE_GENERATION');
          return;
        }

        tracker.completeOperation(toolOp, { result_count: toolResult.products.length });
        console.log(`[TOOL] searchProducts completed: matched ${toolResult.products.length} products`);
        publishJson({
          type: 'tool_event',
          event: 'tool_completed',
          tool: functionName,
          operation_id: toolOp.operation_id,
          generation_id: toolOp.generation_id,
          result_count: toolResult.products.length,
          products: toolResult.products,
          arguments: parsedArgs,
        });

        // Track final LLM response generation
        const finalLlmOp = tracker.startOperation('llm', turnGen);
        activeLlmOp = finalLlmOp;

        console.log(`[LLM] Gemini final response stream started`);
        // Compact tool result before storing in history
        const compactedResult = compactToolResult(toolResult);

        modelToolCallContent = {
          role: 'model',
          parts: [{ functionCall: { name: functionName, args: parsedArgs } }],
        };
        userToolResponseContent = {
          role: 'user',
          parts: [{ functionResponse: { name: functionName, response: compactedResult } }],
        };

        const streamContents = [
          ...conversationHistory,
          userTurnContent,
          modelToolCallContent,
          userToolResponseContent,
        ];

        // Step 2: Stream final spoken response using compacted tool results & AbortSignal
        responseStream = await ai.models.generateContentStream({
          model: GEMINI_MODEL,
          contents: streamContents,
          config: {
            systemInstruction:
              'You are a concise voice shopping assistant. Use the tool results to give a clear, brief spoken response mentioning 2-3 matching products and their prices.',
            temperature: 0.7,
            maxOutputTokens: 256,
            abortSignal: finalLlmOp.abortController.signal,
          },
        });
      } else {
        // Direct streaming completion when no tool call is needed
        if (initialResponse.text) {
          const directText = initialResponse.text;
          responseStream = (async function* () {
            yield { text: directText };
          })();
        } else {
          responseStream = await ai.models.generateContentStream({
            model: GEMINI_MODEL,
            contents: initialContents,
            config: {
              systemInstruction: 'You are a helpful and concise voice shopping assistant.',
              temperature: 0.7,
              maxOutputTokens: 256,
              abortSignal: activeLlmOp.abortController.signal,
            },
          });
        }
      }

      // Track TTS output operation
      ttsOp = tracker.startOperation('tts', turnGen);
      const currentTtsOp = ttsOp;

      const textStream = new ReadableStream<string>({
        async start(controller) {
          try {
            let accumulatedText = '';
            for await (const chunk of responseStream) {
              // Check generation fence & abort signal for each streaming delta token
              if (!tracker.isCurrent(activeLlmOp) || activeLlmOp.abortController.signal.aborted) {
                console.warn(`[Fenced] Aborting text stream for stale ${activeLlmOp.operation_id} (Gen: ${activeLlmOp.generation_id}, Current: ${tracker.currentGeneration})`);
                tracker.recordDiscard(activeLlmOp, 'STALE_GENERATION');
                tracker.recordDiscard(currentTtsOp, 'STALE_GENERATION');
                controller.close();
                return;
              }

              const delta = chunk.text ?? '';
              if (delta) {
                accumulatedText += delta;
                console.log(`[LLM] Gemini delta: "${delta}"`);
                publishJson({
                  type: 'assistant_text',
                  text: accumulatedText,
                  generation_id: turnGen,
                  operation_id: activeLlmOp.operation_id,
                });
                controller.enqueue(delta);
              }
            }
            controller.close();
            tracker.completeOperation(activeLlmOp);
            tracker.completeOperation(currentTtsOp);

            // Successfully finished current turn without interruption: commit to multi-turn conversation history
            if (tracker.isCurrent(activeLlmOp) && !activeLlmOp.abortController.signal.aborted) {
              if (functionCalls && functionCalls.length > 0) {
                conversationHistory.push(userTurnContent);
                conversationHistory.push(modelToolCallContent);
                conversationHistory.push(userToolResponseContent);
                if (accumulatedText) {
                  conversationHistory.push({ role: 'model', parts: [{ text: accumulatedText }] });
                }
              } else {
                conversationHistory.push(userTurnContent);
                if (accumulatedText) {
                  conversationHistory.push({ role: 'model', parts: [{ text: accumulatedText }] });
                }
              }
              if (conversationHistory.length > 16) {
                conversationHistory.splice(0, conversationHistory.length - 16);
              }
            }
          } catch (err) {
            controller.error(err);
          }
        },
      });

      console.log(`[TTS] session.say starting`);
      console.log(`[Rime] synthesis started`);
      // Synthesize and stream speech through direct Rime TTS onto LiveKit audio track
      currentSpeechHandle = session.say(textStream);
      if (currentSpeechHandle) {
        currentSpeechHandle.waitForPlayout().then(() => {
          console.log('[Rime] audio received');
          console.log('[Rime] synthesis completed');
        }).catch((err: any) => {
          console.log('[Rime] playback/synthesis settled:', err?.message || String(err));
        });
      }
    } catch (llmError: any) {
      const isAborted =
        llmError?.name === 'AbortError' ||
        llmError?.message === 'Operation aborted' ||
        activeLlmOp.abortController.signal.aborted ||
        !tracker.isCurrent(turnGen);

      if (isAborted) {
        console.log(`[LLM Aborted/Fenced] Operation ${activeLlmOp.operation_id} (Gen: ${turnGen}) was cancelled cleanly.`);
        tracker.recordCancellation(activeLlmOp, { reason: 'aborted_by_interruption' });
        if (ttsOp && ttsOp.status === 'running') {
          tracker.recordCancellation(ttsOp, { reason: 'aborted_by_interruption' });
        }
        return;
      }

      console.error('Error in agent conversation turn:', llmError);
      // INVARIANT: When active LLM or Tool throws, cleanly mark operations as failed
      if (activeLlmOp && activeLlmOp.status === 'running') {
        tracker.recordFailure(activeLlmOp, 'LLM_API_ERROR', { error: llmError?.message || String(llmError) });
      }
      if (ttsOp && ttsOp.status === 'running') {
        tracker.recordFailure(ttsOp, 'LLM_API_ERROR', { error: llmError?.message || String(llmError) });
      }
      publishJson({
        type: 'error',
        error: llmError?.message || 'LLM API Error',
        generation_id: turnGen,
      });

      // Spoken fallback for real unhandled errors on the active generation
      if (tracker.isCurrent(turnGen)) {
        try {
          const fallbackMsg = "I'm having trouble retrieving information right now. Please ask again.";
          currentSpeechHandle = session.say(fallbackMsg);
        } catch (fallbackErr) {
          console.warn('Failed to synthesize fallback message:', fallbackErr);
        }
      }
    }
  };

  // Instantiate VoiceAssistantAgent with the turn completion callback
  const agentInstance = new VoiceAssistantAgent(async (turnTranscript) => {
    const turnGen = tracker.currentGeneration;
    console.log(`[TURN] onUserTurnCompleted triggered: "${turnTranscript}" (Generation: ${turnGen})`);

    publishJson({
      type: 'user_turn_completed',
      transcript: turnTranscript,
      generation_id: turnGen,
      session_id: tracker.sessionId,
    });

    await commitUserTurn(turnTranscript, turnGen);
  });

  // Start the AgentSession with the connected Room
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

  // Listen for user speech state changes (barge-in detection and speech start/stop)
  session.on(AgentSessionEventTypes.UserStateChanged, (ev) => {
    if (ev.newState === 'speaking') {
      // Check if assistant is genuinely producing response (TTS actively speaking or tool running)
      if (isAgentProducingResponse()) {
        if (!isInterruptedForCurrentUtterance) {
          isInterruptedForCurrentUtterance = true;
          console.log(`[Barge-In Detected] User speech detected while assistant is responding in Gen ${tracker.currentGeneration}. Invalidating generation...`);

          // Invalidate old generation & abort active operations immediately
          const { oldGeneration, newGeneration, abortedOperationsCount } = tracker.invalidateCurrentGeneration('user_barge_in');
          console.log(`[Interruption Fencing] Invalidated Gen ${oldGeneration} -> Active Gen ${newGeneration} (Aborted ${abortedOperationsCount} operations)`);

          // Stop agent speech playback through LiveKit
          try {
            session.interrupt({ force: true });
          } catch (intErr) {
            console.warn('session.interrupt notice:', intErr);
          }

          if (currentSpeechHandle) {
            try {
              currentSpeechHandle.interrupt(true);
            } catch (shErr) {
              // ignore
            }
          }
        }
      }
    } else if (ev.newState === 'listening' || ev.newState === 'away') {
      // Reset barge-in latch once the user finishes speaking
      isInterruptedForCurrentUtterance = false;
    }
  });

  session.on(AgentSessionEventTypes.AgentStateChanged, (ev) => {
    console.log(`[Agent State Changed] ${ev.oldState} -> ${ev.newState}`);
  });

  // Comprehensive diagnostic logging for ConversationItemAdded
  session.on(AgentSessionEventTypes.ConversationItemAdded, async (ev) => {
    console.log('[ConversationItemAdded RAW]', JSON.stringify(ev, null, 2));
    console.log('[TURN] ConversationItemAdded received');
    console.log('[TURN] item type:', ev.item.type);
    console.log('[TURN] item role:', (ev.item as any).role);
    const extractedText = (ev.item as any).textContent || (ev.item as any).rawTextContent || '';
    console.log('[TURN] extracted text:', extractedText);
    if (ev.item.type === 'message' && (ev.item as any).role === 'user' && extractedText) {
      console.log('[TURN] calling commitUserTurn from ConversationItemAdded');
      const turnGen = tracker.currentGeneration;
      publishJson({
        type: 'user_turn_completed',
        transcript: extractedText,
        generation_id: turnGen,
        session_id: tracker.sessionId,
      });
      await commitUserTurn(extractedText, turnGen);
    }
  });

  // Stream interim and final STT chunks strictly to UI for live visual updates
  session.on(AgentSessionEventTypes.UserInputTranscribed, async (ev) => {
    const transcript = ev.transcript?.trim() ?? '';
    const isFinal = Boolean(ev.isFinal);
    const currentGen = tracker.currentGeneration;

    if (!transcript) return;

    if (isFinal) {
      console.log(`[STT Segment Finalized] "${transcript}" (Gen: ${currentGen})`);
    }

    // Publish transcript event to UI for live visual display
    publishJson({
      type: 'transcript',
      text: transcript,
      is_final: isFinal,
      generation_id: currentGen,
      session_id: tracker.sessionId,
    });
  });
}

main().catch((err) => {
  console.error('Failed to start agent session:', err);
  process.exit(1);
});