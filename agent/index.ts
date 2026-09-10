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
import { searchProducts, compareProducts, GEMINI_SHOPPING_TOOL, GEMINI_COMPARE_TOOL, SHOPPING_TOOLS_DEFINITIONS, compactToolResult } from './tools/shopping.js';
import { GenerationTracker } from './tracker.js';
import { startTokenServer } from './token_server.js';

import { Room } from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';

// 3-Level LLM Configuration Constants
const PRIMARY_GEMINI_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_FALLBACK_MODEL = 'gemini-3.1-flash-lite';
const GROQ_FALLBACK_MODEL = 'openai/gpt-oss-20b';

/**
 * Checks if an error is specifically a quota exhaustion or rate limit error (HTTP 429 / RESOURCE_EXHAUSTED).
 * Does not match cancellations, aborts, or ordinary network/syntax errors.
 */
function isQuotaError(err: any): boolean {
  if (!err) return false;
  if (err.name === 'AbortError' || err.message === 'Operation aborted') return false;
  const status = err.status || err.statusCode || err.code || err.httpStatus;
  if (status === 429) return true;
  const msg = (err.message || err.toString() || '').toLowerCase();
  if (
    msg.includes('429') ||
    msg.includes('resource_exhausted') ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('resourceexhausted')
  ) {
    return true;
  }
  return false;
}

/**
 * Converts Gemini-formatted conversation history into OpenAI/Groq standard chat message format.
 */
function convertHistoryToGroqMessages(history: Array<{ role: 'user' | 'model'; parts: Array<any> }>) {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  for (const item of history) {
    const textParts = item.parts
      ? item.parts.filter((p) => p && typeof p.text === 'string').map((p) => p.text).join(' ')
      : '';
    if (textParts) {
      messages.push({
        role: item.role === 'model' ? 'assistant' : 'user',
        content: textParts,
      });
    }
  }
  return messages;
}

/**
 * Parses Server-Sent Events (SSE) from Groq streaming completions.
 */
async function* parseGroqSSE(stream: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<{ text?: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (trimmed === 'data: [DONE]') return;
        if (trimmed.startsWith('data: ')) {
          try {
            const data = JSON.parse(trimmed.slice(6));
            const delta = data.choices?.[0]?.delta?.content;
            if (delta) {
              yield { text: delta };
            }
          } catch {
            // Ignore incomplete JSON chunks
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

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

    let userTurnContent = { role: 'user' as const, parts: [{ text: turnText }] };
    let modelToolCallContent: any = null;
    let userToolResponseContent: any = null;

    // Helper functions for 3-level fallback
    async function runGeminiInitial(
      modelName: string,
      signal: AbortSignal
    ): Promise<{
      type: 'tool' | 'direct';
      functionName?: string;
      parsedArgs?: any;
      directText?: string;
      modelToolCallContent?: any;
    }> {
      console.log(`[LLM] Gemini request started (${modelName}): "${turnText}" (Gen: ${turnGen})`);
      const initialContents = [...conversationHistory, userTurnContent];

      const initialResponse = await ai.models.generateContent({
        model: modelName,
        contents: initialContents,
        config: {
          systemInstruction:
            'You are a concise voice shopping assistant. When the user asks to find or filter headphones, laptops, or phones by price, brand, or specs, call the search_products tool. When the user asks to compare two products (e.g., "compare the Sony and Bose ones", "compare them", "which one is better", "compare X and Y"), identify the two products from previous search results or conversation context and call the compare_products tool with their product IDs (e.g. hp-3, hp-1, lap-2) or product names. Remember previous products, brands, budgets, or constraints mentioned in context when the user provides follow-ups. If ambiguous, ask for clarification.',
          tools: [{ functionDeclarations: [GEMINI_SHOPPING_TOOL, GEMINI_COMPARE_TOOL] }],
          temperature: 0.7,
          maxOutputTokens: 256,
          abortSignal: signal,
        },
      });

      console.log(`[LLM] Gemini response received from ${modelName} (Gen: ${turnGen})`);

      const functionCalls = initialResponse.functionCalls;
      if (functionCalls && functionCalls.length > 0) {
        const fc = functionCalls[0];
        const functionName = fc.name;
        const parsedArgs = (fc.args as any) || {};
        const modelToolCallContent = initialResponse.candidates?.[0]?.content || {
          role: 'model',
          parts: [{ functionCall: { name: functionName, args: parsedArgs } }],
        };
        return {
          type: 'tool',
          functionName,
          parsedArgs,
          modelToolCallContent,
        };
      }

      return {
        type: 'direct',
        directText: initialResponse.text || '',
      };
    }

    async function runGroqInitial(
      signal: AbortSignal
    ): Promise<{
      type: 'tool' | 'direct';
      functionName?: string;
      parsedArgs?: any;
      directText?: string;
      groqToolCallId?: string;
      groqRawMessage?: any;
    }> {
      const groqApiKey = process.env.GROQ_API_KEY;
      if (!groqApiKey) {
        throw new Error('GROQ_API_KEY is not configured in environment');
      }

      console.log(`[LLM Fallback] Groq request started (${GROQ_FALLBACK_MODEL}): "${turnText}" (Gen: ${turnGen})`);
      const pastMessages = convertHistoryToGroqMessages(conversationHistory);
      const groqMessages = [
        {
          role: 'system',
          content:
            'You are a concise voice shopping assistant. When the user asks to find or filter headphones, laptops, or phones by price, brand, or specs, call the search_products tool. When the user asks to compare two products (e.g., "compare the Sony and Bose ones", "compare them", "which one is better", "compare X and Y"), identify the two products from previous search results or conversation context and call the compare_products tool with their product IDs (e.g. hp-3, hp-1, lap-2) or product names. If ambiguous, ask for clarification.',
        },
        ...pastMessages,
        { role: 'user', content: turnText },
      ];

      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${groqApiKey}`,
        },
        body: JSON.stringify({
          model: GROQ_FALLBACK_MODEL,
          messages: groqMessages,
          tools: SHOPPING_TOOLS_DEFINITIONS,
          tool_choice: 'auto',
          temperature: 0.7,
          max_tokens: 256,
        }),
        signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Groq API Error (${res.status}): ${errText}`);
      }

      const data: any = await res.json();
      const choice = data.choices?.[0];
      const message = choice?.message;

      if (message?.tool_calls && message.tool_calls.length > 0) {
        const tc = message.tool_calls[0];
        const functionName = tc.function.name;
        let parsedArgs = {};
        try {
          parsedArgs = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function.arguments || {});
        } catch {
          parsedArgs = {};
        }
        console.log(`[LLM Fallback] Groq tool call: ${functionName}`, parsedArgs);
        return {
          type: 'tool',
          functionName,
          parsedArgs,
          groqToolCallId: tc.id,
          groqRawMessage: message,
        };
      }

      console.log(`[LLM Fallback] Groq direct response received (Gen: ${turnGen})`);
      return {
        type: 'direct',
        directText: message?.content || '',
      };
    }

    async function runGeminiStream(
      modelName: string,
      streamContents: any[],
      signal: AbortSignal
    ): Promise<AsyncIterable<{ text?: string }>> {
      return await ai.models.generateContentStream({
        model: modelName,
        contents: streamContents,
        config: {
          systemInstruction:
            'You are a concise voice shopping assistant. If tool results are search products, mention 2-3 matching products and their prices. If tool results are a comparison, give a 2-3 sentence spoken summary stating the price difference, key spec differences, and which is cheaper.',
          temperature: 0.7,
          maxOutputTokens: 256,
          abortSignal: signal,
        },
      });
    }

    async function runGroqStream(
      groqRawMessage: any,
      toolCallId: string,
      compactedResult: any,
      signal: AbortSignal
    ): Promise<AsyncIterable<{ text?: string }>> {
      const groqApiKey = process.env.GROQ_API_KEY;
      if (!groqApiKey) {
        throw new Error('GROQ_API_KEY is not configured');
      }

      const pastMessages = convertHistoryToGroqMessages(conversationHistory);
      const groqMessages = [
        {
          role: 'system',
          content:
            'You are a concise voice shopping assistant. If tool results are search products, mention 2-3 matching products and their prices. If tool results are a comparison, give a 2-3 sentence spoken summary stating the price difference, key spec differences, and which is cheaper.',
        },
        ...pastMessages,
        { role: 'user', content: turnText },
        groqRawMessage,
        {
          role: 'tool',
          tool_call_id: toolCallId,
          content: JSON.stringify(compactedResult),
        },
      ];

      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${groqApiKey}`,
        },
        body: JSON.stringify({
          model: GROQ_FALLBACK_MODEL,
          messages: groqMessages,
          stream: true,
          temperature: 0.7,
          max_tokens: 256,
        }),
        signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Groq stream API Error (${res.status}): ${errText}`);
      }

      if (!res.body) {
        throw new Error('Groq response body is empty');
      }

      return parseGroqSSE(res.body as unknown as ReadableStream<Uint8Array>, signal);
    }

    try {
      let activeProvider: 'gemini_primary' | 'gemini_fallback' | 'groq' = 'gemini_primary';
      let turnResult: {
        type: 'tool' | 'direct';
        functionName?: string;
        parsedArgs?: any;
        directText?: string;
        modelToolCallContent?: any;
        groqToolCallId?: string;
        groqRawMessage?: any;
      } | null = null;

      // Tier 1: Primary Gemini Model (gemini-3.5-flash-lite)
      try {
        const res = await runGeminiInitial(PRIMARY_GEMINI_MODEL, initialLlmOp.abortController.signal);
        turnResult = res;
        activeProvider = 'gemini_primary';
      } catch (err1: any) {
        if (initialLlmOp.abortController.signal.aborted || !tracker.isCurrent(initialLlmOp)) throw err1;
        if (!isQuotaError(err1)) throw err1;
        console.warn(`[LLM Fallback] Primary model (${PRIMARY_GEMINI_MODEL}) quota exhausted. Falling back to Gemini fallback model (${GEMINI_FALLBACK_MODEL})...`, err1?.message || err1);

        // Tier 2: Gemini Fallback Model (gemini-3.1-flash-lite)
        try {
          const res = await runGeminiInitial(GEMINI_FALLBACK_MODEL, initialLlmOp.abortController.signal);
          turnResult = res;
          activeProvider = 'gemini_fallback';
        } catch (err2: any) {
          if (initialLlmOp.abortController.signal.aborted || !tracker.isCurrent(initialLlmOp)) throw err2;
          if (!isQuotaError(err2)) throw err2;
          console.warn(`[LLM Fallback] Gemini fallback model (${GEMINI_FALLBACK_MODEL}) quota exhausted. Falling back to Groq provider (${GROQ_FALLBACK_MODEL})...`, err2?.message || err2);

          if (!process.env.GROQ_API_KEY) {
            console.warn('[LLM Fallback] GROQ_API_KEY is not configured in environment. Skipping Groq fallback.');
            throw err2;
          }

          // Tier 3: Groq Provider Fallback (openai/gpt-oss-20b)
          const res = await runGroqInitial(initialLlmOp.abortController.signal);
          turnResult = res;
          activeProvider = 'groq';
        }
      }

      // Generation fence check after initial LLM completion
      if (!tracker.isCurrent(initialLlmOp)) {
        console.warn(`[Fenced] Discarding initial LLM response for stale ${initialLlmOp.operation_id} (Gen: ${initialLlmOp.generation_id}, Current: ${tracker.currentGeneration})`);
        tracker.recordDiscard(initialLlmOp, 'STALE_GENERATION');
        return;
      }

      if (!turnResult) {
        throw new Error('Failed to obtain initial LLM response from any configured provider.');
      }

      let responseStream: AsyncIterable<{ text?: string }>;
      const isToolCall = turnResult.type === 'tool' && Boolean(turnResult.functionName);

      if (isToolCall) {
        tracker.completeOperation(initialLlmOp, { tool_called: true, provider: activeProvider });

        const functionName = turnResult.functionName!;
        const parsedArgs = turnResult.parsedArgs || {};

        console.log(`[LLM] (${activeProvider}) tool call: ${functionName}`, parsedArgs);

        // Start tracked tool operation with AbortController readiness
        const toolOp = tracker.startOperation('tool', turnGen);

        console.log(`[TOOL] ${functionName} started (${toolOp.operation_id}, Gen: ${toolOp.generation_id})`, parsedArgs);
        publishJson({
          type: 'tool_event',
          event: 'tool_started',
          tool: functionName,
          operation_id: toolOp.operation_id,
          generation_id: toolOp.generation_id,
          arguments: parsedArgs,
        });

        // Execute deterministic tool with artificial latency and abort signal
        let toolResult: any = null;
        let compactedResult: any = null;
        try {
          if (functionName === 'compare_products') {
            toolResult = await compareProducts(parsedArgs, {
              signal: toolOp.abortController.signal,
            });
            compactedResult = toolResult;
          } else {
            toolResult = await searchProducts(parsedArgs, {
              signal: toolOp.abortController.signal,
            });
            compactedResult = compactToolResult(toolResult);
          }
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

        if (functionName === 'compare_products') {
          tracker.completeOperation(toolOp, { success: toolResult.success });
          console.log(`[TOOL] compare_products completed: success=${toolResult.success}`);
          publishJson({
            type: 'comparison_event',
            generation: toolOp.generation_id,
            operation_id: toolOp.operation_id,
            comparison: toolResult,
          });
        } else {
          tracker.completeOperation(toolOp, { result_count: toolResult.products?.length ?? 0 });
          console.log(`[TOOL] searchProducts completed: matched ${toolResult.products?.length ?? 0} products`);
          publishJson({
            type: 'tool_event',
            event: 'tool_completed',
            tool: functionName,
            operation_id: toolOp.operation_id,
            generation_id: toolOp.generation_id,
            result_count: toolResult.products?.length ?? 0,
            products: toolResult.products,
            arguments: parsedArgs,
          });
        }

        // Track final LLM response generation
        const finalLlmOp = tracker.startOperation('llm', turnGen);
        activeLlmOp = finalLlmOp;

        console.log(`[LLM] (${activeProvider}) final response stream started`);

        if (activeProvider === 'groq') {
          responseStream = await runGroqStream(
            turnResult.groqRawMessage,
            turnResult.groqToolCallId || 'call_0',
            compactedResult,
            finalLlmOp.abortController.signal
          );
        } else {
          modelToolCallContent = turnResult.modelToolCallContent || {
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

          // Stream final spoken response using compacted tool results & AbortSignal (with fallback if quota exhausted)
          const targetGeminiModel = activeProvider === 'gemini_fallback' ? GEMINI_FALLBACK_MODEL : PRIMARY_GEMINI_MODEL;
          try {
            responseStream = await runGeminiStream(targetGeminiModel, streamContents, finalLlmOp.abortController.signal);
          } catch (streamErr: any) {
            if (finalLlmOp.abortController.signal.aborted || !tracker.isCurrent(finalLlmOp)) throw streamErr;
            if (!isQuotaError(streamErr)) throw streamErr;

            if (targetGeminiModel === PRIMARY_GEMINI_MODEL) {
              console.warn(`[LLM Fallback] Final stream quota error on primary model. Trying fallback ${GEMINI_FALLBACK_MODEL}...`);
              try {
                responseStream = await runGeminiStream(GEMINI_FALLBACK_MODEL, streamContents, finalLlmOp.abortController.signal);
              } catch (streamErr2: any) {
                if (finalLlmOp.abortController.signal.aborted || !tracker.isCurrent(finalLlmOp)) throw streamErr2;
                if (!isQuotaError(streamErr2) || !process.env.GROQ_API_KEY) throw streamErr2;
                console.warn(`[LLM Fallback] Final stream quota error on Gemini fallback. Trying Groq (${GROQ_FALLBACK_MODEL})...`);
                responseStream = await runGroqStream(
                  { role: 'assistant', tool_calls: [{ id: 'call_fallback', type: 'function', function: { name: functionName, arguments: JSON.stringify(parsedArgs) } }] },
                  'call_fallback',
                  compactedResult,
                  finalLlmOp.abortController.signal
                );
              }
            } else if (process.env.GROQ_API_KEY) {
              console.warn(`[LLM Fallback] Final stream quota error on Gemini fallback. Trying Groq (${GROQ_FALLBACK_MODEL})...`);
              responseStream = await runGroqStream(
                { role: 'assistant', tool_calls: [{ id: 'call_fallback', type: 'function', function: { name: functionName, arguments: JSON.stringify(parsedArgs) } }] },
                'call_fallback',
                compactedResult,
                finalLlmOp.abortController.signal
              );
            } else {
              throw streamErr;
            }
          }
        }
      } else {
        // Direct streaming completion when no tool call is needed
        if (turnResult.directText) {
          const directText = turnResult.directText;
          responseStream = (async function* () {
            yield { text: directText };
          })();
        } else {
          const targetGeminiModel = activeProvider === 'gemini_fallback' ? GEMINI_FALLBACK_MODEL : PRIMARY_GEMINI_MODEL;
          const initialContents = [...conversationHistory, userTurnContent];
          responseStream = await ai.models.generateContentStream({
            model: targetGeminiModel,
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
                console.log(`[LLM] (${activeProvider}) delta: "${delta}"`);
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
              if (isToolCall && modelToolCallContent && userToolResponseContent) {
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