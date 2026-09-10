import React, { useEffect, useState, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client';

interface Product {
  id: string;
  name: string;
  brand: string;
  category: 'headphones' | 'laptops' | 'phones';
  price: number;
  ram_gb?: number;
  description: string;
}

interface OperationState {
  operation_id: string;
  operation_type: 'stt' | 'llm' | 'tool' | 'tts';
  generation_id: number;
  status: 'running' | 'completed' | 'cancelled' | 'discarded';
  details?: string;
}

interface EventLogItem {
  id: string;
  timestamp: string;
  event_type: string;
  generation_id?: number | null;
  operation_id?: string;
  operation_type?: string;
  details?: string;
  is_stale_or_discarded?: boolean;
}

interface ChatMessage {
  id: string;
  sender: 'user' | 'assistant';
  text: string;
  generation_id: number;
  timestamp: string;
  interrupted?: boolean;
}

interface GenerationStatus {
  genId: number;
  status: 'active' | 'interrupted';
  query?: string;
}

function formatSearchQuery(args?: Record<string, any>): string {
  if (!args || Object.keys(args).length === 0) return 'Searching catalog...';
  const parts: string[] = [];
  if (args.brand) parts.push(args.brand);
  if (args.category) parts.push(args.category);
  else if (args.query) parts.push(`"${args.query}"`);
  else parts.push('products');
  if (args.max_price) parts.push(`under $${args.max_price}`);
  if (args.min_ram_gb) parts.push(`with ${args.min_ram_gb}GB+ RAM`);
  return `Searching ${parts.join(' ')}...`;
}

function App() {
  const [room, setRoom] = useState<Room | null>(null);
  const [connectionState, setConnectionState] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Generation & Session state
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [currentGeneration, setCurrentGeneration] = useState<number>(1);
  const [generationsList, setGenerationsList] = useState<GenerationStatus[]>([
    { genId: 1, status: 'active' }
  ]);
  const [interruptionCount, setInterruptionCount] = useState<number>(0);
  const [lastInterruptionNotice, setLastInterruptionNotice] = useState<{ oldGen: number; newGen: number; timestamp: string } | null>(null);

  // Search & Product State
  const [activeSearchState, setActiveSearchState] = useState<{
    queryText: string;
    isSearching: boolean;
    generation_id: number;
    wasInterrupted?: boolean;
  } | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [productsGen, setProductsGen] = useState<number>(1);

  // Voice & Assistant State
  const [assistantState, setAssistantState] = useState<'idle' | 'listening' | 'user_speaking' | 'processing' | 'speaking'>('idle');
  const [isMicMuted, setIsMicMuted] = useState<boolean>(false);

  // Active operations map
  const [operations, setOperations] = useState<Map<string, OperationState>>(new Map());

  // Chat messages & streaming
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentStreamingAssistantText, setCurrentStreamingAssistantText] = useState<{ text: string; gen: number } | null>(null);

  // Telemetry & Evidence (collapsible)
  const [eventLog, setEventLog] = useState<EventLogItem[]>([]);
  const [showTechnicalDetails, setShowTechnicalDetails] = useState<boolean>(false);

  const addEventLog = (
    eventType: string,
    genId?: number | null,
    opId?: string,
    opType?: string,
    details?: string,
    isStale = false
  ) => {
    const item: EventLogItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toLocaleTimeString(),
      event_type: eventType,
      generation_id: genId,
      operation_id: opId,
      operation_type: opType,
      details,
      is_stale_or_discarded: isStale,
    };
    setEventLog((prev) => [item, ...prev.slice(0, 49)]);
  };

  const connectToRoom = async () => {
    setConnectionState('connecting');
    setErrorMessage(null);

    try {
      addEventLog('token_requested', currentGeneration, undefined, undefined, 'Acquiring token from server');
      const tokenRes = await fetch('/token');
      if (!tokenRes.ok) {
        const errData = await tokenRes.json().catch(() => ({}));
        throw new Error(errData.error || `Server returned status ${tokenRes.status}`);
      }

      const tokenData: { url: string; token: string } = await tokenRes.json();
      if (!tokenData.url || !tokenData.token) {
        throw new Error('Invalid token response from server');
      }

      const newRoom = new Room();
      setRoom(newRoom);

      await newRoom.connect(tokenData.url, tokenData.token);
      setConnectionState('connected');
      setAssistantState('listening');
      addEventLog('room_connected', currentGeneration, undefined, undefined, `Connected to LiveKit room: ${newRoom.name}`);

      // Enable microphone
      if (newRoom.localParticipant) {
        try {
          await newRoom.localParticipant.setMicrophoneEnabled(true);
          setIsMicMuted(false);
          addEventLog('microphone_enabled', currentGeneration, undefined, undefined, 'Microphone active');
        } catch (micErr: any) {
          console.error('Microphone enable error:', micErr);
          setErrorMessage(`Microphone permission error: ${micErr.message}`);
        }
      }

      newRoom.on(RoomEvent.TrackMuted, (pub, participant) => {
        if (participant?.isLocal && pub.kind === Track.Kind.Audio) {
          setIsMicMuted(true);
        }
      });

      newRoom.on(RoomEvent.TrackUnmuted, (pub, participant) => {
        if (participant?.isLocal && pub.kind === Track.Kind.Audio) {
          setIsMicMuted(false);
        }
      });

      // Rime TTS Audio playout
      newRoom.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          document.body.appendChild(el);
          setAssistantState('speaking');
          addEventLog('tts_audio_playing', currentGeneration, undefined, 'tts', 'Rime Coda voice active');
        }
      });

      newRoom.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        track.detach().forEach((el) => el.remove());
        setAssistantState('listening');
      });

      newRoom.on('disconnected', () => {
        setConnectionState('disconnected');
        setAssistantState('idle');
      });

      // Handle server data channel messages
      newRoom.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
        try {
          const str = new TextDecoder().decode(payload);
          const data = JSON.parse(str);

          // 1. Transcript (User turn)
          if (data.type === 'transcript' && typeof data.text === 'string') {
            const gen = data.generation_id ?? currentGeneration;
            const isFinal = data.is_final !== false;
            if (data.session_id) setSessionId(data.session_id);
            if (data.generation_id) setCurrentGeneration(data.generation_id);

            setAssistantState(isFinal ? 'processing' : 'user_speaking');

            setMessages((prev) => {
              const lastMsg = prev[prev.length - 1];
              if (lastMsg && lastMsg.sender === 'user' && lastMsg.id.startsWith('user-interim-')) {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  id: isFinal ? `user-final-${Date.now()}` : lastMsg.id,
                  sender: 'user',
                  text: data.text,
                  generation_id: gen,
                  timestamp: new Date().toLocaleTimeString(),
                };
                return updated;
              }
              return [
                ...prev,
                {
                  id: isFinal ? `user-final-${Date.now()}` : `user-interim-${Date.now()}`,
                  sender: 'user',
                  text: data.text,
                  generation_id: gen,
                  timestamp: new Date().toLocaleTimeString(),
                },
              ];
            });

            if (isFinal) {
              addEventLog('user_transcript_finalized', gen, undefined, 'stt', `"${data.text}"`);
            }
          }

          // 2. Streaming Assistant text
          else if (data.type === 'assistant_text' && typeof data.text === 'string') {
            const gen = data.generation_id ?? currentGeneration;
            if (gen === currentGeneration) {
              setAssistantState('speaking');
              setCurrentStreamingAssistantText({ text: data.text, gen });
            }
          }

          // 3. Tool execution state & products
          else if (data.type === 'tool_event') {
            const gen = data.generation_id ?? currentGeneration;
            if (data.event === 'tool_started') {
              const queryLabel = formatSearchQuery(data.arguments);
              setActiveSearchState({
                queryText: queryLabel,
                isSearching: true,
                generation_id: gen,
              });
              setAssistantState('processing');

              setOperations((prev) => {
                const next = new Map(prev);
                next.set(data.operation_id ?? `tool-${Date.now()}`, {
                  operation_id: data.operation_id ?? 'tool',
                  operation_type: 'tool',
                  generation_id: gen,
                  status: 'running',
                  details: queryLabel,
                });
                return next;
              });
              addEventLog('tool_started', gen, data.operation_id, 'tool', queryLabel);
            } else if (data.event === 'tool_completed') {
              if (gen === currentGeneration) {
                setActiveSearchState(null);
                if (Array.isArray(data.products)) {
                  setProducts(data.products);
                  setProductsGen(gen);
                }
              }
              setOperations((prev) => {
                const next = new Map(prev);
                if (data.operation_id && next.has(data.operation_id)) {
                  next.set(data.operation_id, {
                    ...next.get(data.operation_id)!,
                    status: 'completed',
                    details: `Matched ${data.result_count} items`,
                  });
                }
                return next;
              });
              addEventLog('tool_completed', gen, data.operation_id, 'tool', `Matched ${data.result_count} products`);
            }
          }

          // 4. Tracker Events (Fencing & Interruptions)
          else if (data.type === 'tracker_event') {
            const ev = data.event;
            if (ev?.session_id) setSessionId(ev.session_id);

            // Interruption handling
            if (ev?.event_type === 'interruption_detected') {
              const oldG = ev.details?.interrupted_generation ?? currentGeneration;
              const newG = ev.details?.new_generation ?? currentGeneration + 1;

              setCurrentGeneration(newG);
              setInterruptionCount((c) => c + 1);
              setLastInterruptionNotice({
                oldGen: oldG,
                newGen: newG,
                timestamp: new Date().toLocaleTimeString(),
              });

              // Mark previous generation as interrupted in generation history
              setGenerationsList((prev) => {
                const updated = prev.map((item) =>
                  item.genId === oldG ? { ...item, status: 'interrupted' as const } : item
                );
                if (!updated.some((item) => item.genId === newG)) {
                  updated.push({ genId: newG, status: 'active' });
                }
                return updated;
              });

              // Mark previous user messages as interrupted visually
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.generation_id === oldG ? { ...msg, interrupted: true } : msg
                )
              );

              // Update active search state indicator to "Request updated"
              setActiveSearchState((prev) => {
                if (prev && prev.generation_id === oldG) {
                  return {
                    queryText: '⚡ Request updated (stale query cancelled)',
                    isSearching: false,
                    generation_id: oldG,
                    wasInterrupted: true,
                  };
                }
                return prev;
              });

              setCurrentStreamingAssistantText(null);
              setAssistantState('user_speaking');

              addEventLog(
                'interruption_detected',
                oldG,
                undefined,
                undefined,
                `User barge-in: Gen ${oldG} invalidated -> Gen ${newG} active`,
                true
              );
            }

            // Operation started
            else if (ev?.event_type === 'operation_started') {
              setOperations((prev) => {
                const next = new Map(prev);
                next.set(ev.operation_id, {
                  operation_id: ev.operation_id,
                  operation_type: ev.operation_type,
                  generation_id: ev.generation_id,
                  status: 'running',
                });
                return next;
              });
              addEventLog('operation_started', ev.generation_id, ev.operation_id, ev.operation_type);
            }

            // Operation completed
            else if (ev?.event_type === 'operation_completed') {
              setOperations((prev) => {
                const next = new Map(prev);
                if (next.has(ev.operation_id)) {
                  next.set(ev.operation_id, {
                    ...next.get(ev.operation_id)!,
                    status: 'completed',
                  });
                }
                return next;
              });
              addEventLog('operation_completed', ev.generation_id, ev.operation_id, ev.operation_type);

              // Commit text stream to message list when TTS completes
              if (ev.operation_type === 'tts' && currentStreamingAssistantText) {
                if (currentStreamingAssistantText.gen === currentGeneration) {
                  setMessages((prev) => [
                    ...prev,
                    {
                      id: `assistant-${Date.now()}`,
                      sender: 'assistant',
                      text: currentStreamingAssistantText.text,
                      generation_id: currentStreamingAssistantText.gen,
                      timestamp: new Date().toLocaleTimeString(),
                    },
                  ]);
                }
                setCurrentStreamingAssistantText(null);
                setAssistantState('listening');
              }
            }

            // Operation discarded (Generation Fenced)
            else if (ev?.event_type === 'operation_discarded') {
              setOperations((prev) => {
                const next = new Map(prev);
                next.set(ev.operation_id, {
                  operation_id: ev.operation_id,
                  operation_type: ev.operation_type,
                  generation_id: ev.generation_id,
                  status: 'discarded',
                  details: `Fence: ${ev.details?.reason ?? 'STALE_GENERATION'}`,
                });
                return next;
              });
              addEventLog(
                'operation_discarded',
                ev.generation_id,
                ev.operation_id,
                ev.operation_type,
                `🛡️ Fenced: ${ev.operation_type} from stale Gen ${ev.generation_id} discarded!`,
                true
              );
            }

            // Operation cancelled
            else if (ev?.event_type === 'operation_cancelled') {
              setOperations((prev) => {
                const next = new Map(prev);
                if (next.has(ev.operation_id)) {
                  next.set(ev.operation_id, {
                    ...next.get(ev.operation_id)!,
                    status: 'cancelled',
                    details: 'Aborted via signal',
                  });
                }
                return next;
              });
              addEventLog('operation_cancelled', ev.generation_id, ev.operation_id, ev.operation_type, 'Aborted mid-flight');
            }
          }
        } catch (e) {
          // ignore parse errors
        }
      });
    } catch (err: any) {
      console.error('Room connection failed:', err);
      setConnectionState('error');
      setErrorMessage(`Connection failed: ${err.message}`);
    }
  };

  const handleDisconnect = () => {
    if (room) {
      room.disconnect();
      setRoom(null);
      setConnectionState('disconnected');
      setAssistantState('idle');
      addEventLog('user_initiated_disconnect', currentGeneration);
    }
  };

  const toggleMic = async () => {
    if (room?.localParticipant) {
      try {
        const currentlyEnabled = room.localParticipant.isMicrophoneEnabled;
        await room.localParticipant.setMicrophoneEnabled(!currentlyEnabled);
        setIsMicMuted(currentlyEnabled);
      } catch (err: any) {
        setErrorMessage(`Microphone toggle error: ${err.message}`);
      }
    }
  };

  return (
    <div style={{ fontFamily: 'Inter, system-ui, -apple-system, sans-serif', background: '#f4f6f9', minHeight: '100vh', color: '#1e293b' }}>
      
      {/* APP HEADER */}
      <header style={{ background: '#0f172a', color: '#fff', padding: '16px 28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ background: 'linear-gradient(135deg, #3b82f6, #6366f1)', padding: '8px 12px', borderRadius: '10px', fontSize: '20px', fontWeight: 'bold', boxShadow: '0 2px 8px rgba(59,130,246,0.4)' }}>
            🛒
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: '20px', fontWeight: '800', display: 'flex', alignItems: 'center', gap: '8px' }}>
              DataForge Voice Shopping
              <span style={{ fontSize: '11px', background: '#3b82f6', color: '#fff', padding: '3px 8px', borderRadius: '12px', fontWeight: '600', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                Rime TTS + Generation Fencing
              </span>
            </h1>
            <p style={{ margin: '2px 0 0 0', fontSize: '13px', color: '#94a3b8' }}>
              Realtime Interruption-Tolerant Voice Assistant
            </p>
          </div>
        </div>

        {/* CONNECTION ACTIONS */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {connectionState === 'connected' ? (
            <>
              <button
                onClick={toggleMic}
                style={{
                  padding: '8px 16px',
                  background: isMicMuted ? '#ef4444' : '#10b981',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontWeight: '600',
                  fontSize: '13px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  boxShadow: '0 2px 6px rgba(0,0,0,0.15)',
                }}
              >
                {isMicMuted ? '🔇 Muted' : '🎙️ Mic On'}
              </button>
              <button
                onClick={handleDisconnect}
                style={{
                  padding: '8px 16px',
                  background: '#334155',
                  color: '#f8fafc',
                  border: '1px solid #475569',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontWeight: '600',
                  fontSize: '13px',
                }}
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              onClick={connectToRoom}
              disabled={connectionState === 'connecting'}
              style={{
                padding: '10px 20px',
                background: connectionState === 'connecting' ? '#64748b' : 'linear-gradient(135deg, #2563eb, #3b82f6)',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                cursor: connectionState === 'connecting' ? 'not-allowed' : 'pointer',
                fontWeight: '700',
                fontSize: '14px',
                boxShadow: '0 4px 12px rgba(37,99,235,0.3)',
              }}
            >
              {connectionState === 'connecting' ? 'Connecting to Voice...' : '🔌 Connect Voice Assistant'}
            </button>
          )}
        </div>
      </header>

      <main style={{ maxWidth: '1200px', margin: '24px auto', padding: '0 20px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
        
        {/* ERROR DISPLAY */}
        {errorMessage && (
          <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', color: '#991b1b', padding: '14px 18px', borderRadius: '10px', fontWeight: '500' }}>
            ⚠️ {errorMessage}
          </div>
        )}

        {/* TOP HERO & VOICE CONTROL PANEL */}
        <section style={{ background: '#fff', borderRadius: '16px', border: '1px solid #e2e8f0', padding: '24px 32px', boxShadow: '0 4px 16px rgba(0,0,0,0.03)', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', position: 'relative', overflow: 'hidden' }}>
          
          {/* BACKGROUND GLOW */}
          <div style={{ position: 'absolute', top: '-50px', left: '50%', transform: 'translateX(-50%)', width: '300px', height: '150px', background: assistantState === 'speaking' ? 'rgba(16, 185, 129, 0.12)' : assistantState === 'user_speaking' ? 'rgba(59, 130, 246, 0.12)' : 'rgba(99, 102, 241, 0.08)', filter: 'blur(50px)', borderRadius: '50%', pointerEvents: 'none' }} />

          {/* MAIN MIC HERO BUTTON */}
          <div style={{ marginBottom: '16px', position: 'relative' }}>
            <div
              onClick={() => {
                if (connectionState === 'disconnected') connectToRoom();
                else toggleMic();
              }}
              style={{
                width: '90px',
                height: '90px',
                borderRadius: '50%',
                background: connectionState !== 'connected'
                  ? '#cbd5e1'
                  : assistantState === 'speaking'
                  ? 'linear-gradient(135deg, #10b981, #059669)'
                  : assistantState === 'user_speaking'
                  ? 'linear-gradient(135deg, #3b82f6, #1d4ed8)'
                  : assistantState === 'processing'
                  ? 'linear-gradient(135deg, #f59e0b, #d97706)'
                  : isMicMuted
                  ? '#ef4444'
                  : 'linear-gradient(135deg, #6366f1, #4f46e5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '36px',
                color: '#fff',
                cursor: 'pointer',
                boxShadow: assistantState !== 'idle'
                  ? '0 0 0 12px rgba(99, 102, 241, 0.15), 0 8px 24px rgba(0,0,0,0.15)'
                  : '0 8px 20px rgba(0,0,0,0.1)',
                transition: 'all 0.3s ease',
                margin: '0 auto',
              }}
            >
              {connectionState !== 'connected' ? '🔌' : isMicMuted ? '🔇' : assistantState === 'speaking' ? '🔊' : assistantState === 'user_speaking' ? '🗣️' : assistantState === 'processing' ? '⚙️' : '🎙️'}
            </div>
          </div>

          {/* VOICE ASSISTANT STATUS TITLE */}
          <div style={{ marginBottom: '12px' }}>
            <h2 style={{ margin: '0 0 4px 0', fontSize: '22px', fontWeight: '800', color: '#0f172a' }}>
              {connectionState !== 'connected'
                ? 'Voice Shopping Assistant Offline'
                : assistantState === 'user_speaking'
                ? 'Listening to User Speech...'
                : assistantState === 'processing'
                ? 'Processing Request & Catalog Search...'
                : assistantState === 'speaking'
                ? 'Speaking via Rime Coda TTS...'
                : 'Listening for Voice Commands...'}
            </h2>
            <p style={{ margin: 0, fontSize: '14px', color: '#64748b' }}>
              Speak naturally into your microphone to find laptops, headphones, or phones. Interruption-safe with Generation Fencing.
            </p>
          </div>

          {/* GENERATION FENCING STATUS BADGES BAR */}
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '10px', marginTop: '8px' }}>
            {/* GENERATION CHIPS */}
            {generationsList.map((g) => (
              <div
                key={g.genId}
                style={{
                  padding: '5px 12px',
                  borderRadius: '20px',
                  fontSize: '12px',
                  fontWeight: '700',
                  background: g.status === 'active' ? '#dbeafe' : '#fee2e2',
                  color: g.status === 'active' ? '#1e40af' : '#991b1b',
                  border: `1px solid ${g.status === 'active' ? '#bfdbfe' : '#fca5a5'}`,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <span>{g.status === 'active' ? '🟢' : '⚡'} Gen {g.genId}</span>
                <span style={{ fontSize: '10px', textTransform: 'uppercase', opacity: 0.8 }}>
                  ({g.status})
                </span>
              </div>
            ))}

            {/* ENGINEERING GUARANTEE PILLS */}
            <div style={{ padding: '5px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: '600', background: '#f1f5f9', color: '#334155', border: '1px solid #cbd5e1' }}>
              ✓ Stale Results Blocked
            </div>
            <div style={{ padding: '5px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: '600', background: '#f1f5f9', color: '#334155', border: '1px solid #cbd5e1' }}>
              ✓ Obsolete Request Cancelled
            </div>
            {interruptionCount > 0 && (
              <div style={{ padding: '5px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: '700', background: '#fff7ed', color: '#c2410c', border: '1px solid #ffedd5' }}>
                ⚡ {interruptionCount} Interruption{interruptionCount > 1 ? 's' : ''} Recovered
              </div>
            )}
          </div>
        </section>

        {/* BARGE-IN INTERRUPTION ALERT BANNER */}
        {lastInterruptionNotice && (
          <div style={{ background: 'linear-gradient(90deg, #fff7ed, #fff)', border: '1px solid #ffedd5', borderLeft: '6px solid #f97316', padding: '14px 20px', borderRadius: '12px', boxShadow: '0 2px 8px rgba(249,115,22,0.1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: '14px', color: '#9a3412', fontWeight: '500' }}>
              <strong style={{ fontWeight: '800' }}>⚡ Interruption Detected & Fenced:</strong> Obsoleted <strong>Gen {lastInterruptionNotice.oldGen}</strong> ➔ Switched to <strong>Gen {lastInterruptionNotice.newGen}</strong>. Previous in-flight search and speech aborted immediately.
            </div>
            <span style={{ fontSize: '12px', color: '#c2410c', fontWeight: '600' }}>{lastInterruptionNotice.timestamp}</span>
          </div>
        )}

        {/* ACTIVE SEARCH & PROCESSING BANNER */}
        {activeSearchState && (
          <div
            style={{
              background: activeSearchState.wasInterrupted ? '#fef2f2' : '#f0fdf4',
              border: `1px solid ${activeSearchState.wasInterrupted ? '#fca5a5' : '#86efac'}`,
              padding: '14px 20px',
              borderRadius: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              boxShadow: '0 2px 8px rgba(0,0,0,0.03)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontSize: '20px' }}>{activeSearchState.wasInterrupted ? '⚡' : '🔎'}</span>
              <div>
                <div style={{ fontWeight: '700', fontSize: '14px', color: activeSearchState.wasInterrupted ? '#991b1b' : '#166534' }}>
                  {activeSearchState.queryText}
                </div>
                <div style={{ fontSize: '12px', color: activeSearchState.wasInterrupted ? '#b91c1c' : '#15803d' }}>
                  {activeSearchState.wasInterrupted
                    ? 'Gen ' + activeSearchState.generation_id + ' query cancelled due to user barge-in'
                    : 'Searching local product catalog (~4s simulated async delay under Gen ' + activeSearchState.generation_id + ')...'}
                </div>
              </div>
            </div>
            {activeSearchState.isSearching && (
              <div style={{ fontSize: '12px', fontWeight: '600', color: '#15803d', background: '#dcfce7', padding: '4px 10px', borderRadius: '12px' }}>
                Catalog Search Running...
              </div>
            )}
          </div>
        )}

        {/* TWO COLUMN CONTENT LAYOUT: LEFT (CONVERSATION TRANSCRIPT) / RIGHT (PRODUCT RESULTS) */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: '24px' }}>
          
          {/* CONVERSATION TRANSCRIPT PANEL */}
          <section style={{ background: '#fff', borderRadius: '16px', border: '1px solid #e2e8f0', padding: '20px', boxShadow: '0 4px 16px rgba(0,0,0,0.03)', display: 'flex', flexDirection: 'column', height: '520px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #f1f5f9', paddingBottom: '12px', marginBottom: '14px' }}>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '700', color: '#0f172a', display: 'flex', alignItems: 'center', gap: '8px' }}>
                💬 Voice Conversation Transcript
              </h3>
              <span style={{ fontSize: '12px', color: '#64748b', fontWeight: '500' }}>
                Gen {currentGeneration} Active
              </span>
            </div>

            {/* MESSAGES LIST */}
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '14px', paddingRight: '4px' }}>
              {messages.length === 0 && !currentStreamingAssistantText && (
                <div style={{ textAlign: 'center', color: '#94a3b8', margin: 'auto 0', padding: '40px 20px' }}>
                  <div style={{ fontSize: '32px', marginBottom: '12px' }}>🎙️</div>
                  <div style={{ fontWeight: '600', fontSize: '15px', color: '#475569', marginBottom: '6px' }}>Ready for Voice Input</div>
                  <p style={{ margin: 0, fontSize: '13px' }}>
                    Connect and speak into your microphone. Try asking: <br />
                    <em>"Find me headphones under $200"</em>
                  </p>
                </div>
              )}

              {messages.map((msg) => {
                const isCurrentGen = msg.generation_id === currentGeneration;
                const isUser = msg.sender === 'user';
                return (
                  <div
                    key={msg.id}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: isUser ? 'flex-end' : 'flex-start',
                      opacity: msg.interrupted ? 0.65 : 1,
                    }}
                  >
                    <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '3px', display: 'flex', gap: '6px', alignItems: 'center' }}>
                      <span style={{ fontWeight: '600' }}>{isUser ? 'User' : 'Voice Assistant'}</span>
                      <span>•</span>
                      <span
                        style={{
                          padding: '1px 6px',
                          borderRadius: '8px',
                          fontWeight: '700',
                          background: isCurrentGen ? '#dbeafe' : '#f1f5f9',
                          color: isCurrentGen ? '#1d4ed8' : '#64748b',
                        }}
                      >
                        Gen {msg.generation_id}
                      </span>
                      {msg.interrupted && (
                        <span style={{ color: '#dc2626', fontWeight: '700', background: '#fef2f2', padding: '1px 6px', borderRadius: '8px' }}>
                          ⚡ Interrupted
                        </span>
                      )}
                      <span>• {msg.timestamp}</span>
                    </div>

                    <div
                      style={{
                        padding: '12px 16px',
                        borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                        maxWidth: '85%',
                        fontSize: '14px',
                        lineHeight: '1.5',
                        background: isUser ? '#2563eb' : '#f8fafc',
                        color: isUser ? '#ffffff' : '#0f172a',
                        border: isUser ? 'none' : '1px solid #e2e8f0',
                        boxShadow: isUser ? '0 2px 8px rgba(37,99,235,0.2)' : '0 2px 4px rgba(0,0,0,0.02)',
                        textDecoration: msg.interrupted ? 'line-through' : 'none',
                      }}
                    >
                      {msg.text}
                    </div>
                  </div>
                );
              })}

              {/* STREAMING ASSISTANT TEXT */}
              {currentStreamingAssistantText && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                  <div style={{ fontSize: '11px', color: '#2563eb', marginBottom: '3px', fontWeight: '700', display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <span>⚡ Assistant Streaming (Rime TTS)</span>
                    <span>• Gen {currentStreamingAssistantText.gen}</span>
                  </div>
                  <div
                    style={{
                      padding: '12px 16px',
                      borderRadius: '16px 16px 16px 4px',
                      maxWidth: '85%',
                      fontSize: '14px',
                      lineHeight: '1.5',
                      background: '#eff6ff',
                      color: '#1e40af',
                      border: '1px solid #bfdbfe',
                    }}
                  >
                    {currentStreamingAssistantText.text}
                    <span style={{ display: 'inline-block', width: '6px', height: '14px', background: '#2563eb', marginLeft: '4px', verticalAlign: 'middle', animation: 'pulse 1s infinite' }} />
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* SHOPPING CATALOG & PRODUCT RESULTS PANEL */}
          <section style={{ background: '#fff', borderRadius: '16px', border: '1px solid #e2e8f0', padding: '20px', boxShadow: '0 4px 16px rgba(0,0,0,0.03)', display: 'flex', flexDirection: 'column', height: '520px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #f1f5f9', paddingBottom: '12px', marginBottom: '14px' }}>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '700', color: '#0f172a', display: 'flex', alignItems: 'center', gap: '8px' }}>
                🛍️ Verified Product Results
              </h3>
              {products.length > 0 && (
                <span style={{ fontSize: '12px', background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0', padding: '3px 10px', borderRadius: '12px', fontWeight: '600' }}>
                  {products.length} Products • Gen {productsGen}
                </span>
              )}
            </div>

            {/* PRODUCT CARDS LIST */}
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px', paddingRight: '4px' }}>
              {products.length === 0 ? (
                <div style={{ textAlign: 'center', color: '#94a3b8', margin: 'auto 0', padding: '40px 20px' }}>
                  <div style={{ fontSize: '36px', marginBottom: '12px' }}>🛒</div>
                  <div style={{ fontWeight: '600', fontSize: '15px', color: '#475569', marginBottom: '4px' }}>No Active Product Search</div>
                  <p style={{ margin: 0, fontSize: '13px' }}>
                    Ask the voice assistant to search for products (e.g. <em>"Find Bose headphones under $300"</em>).
                  </p>
                </div>
              ) : (
                products.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      background: '#f8fafc',
                      border: '1px solid #e2e8f0',
                      borderRadius: '12px',
                      padding: '14px 16px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      transition: 'all 0.2s ease',
                      boxShadow: '0 2px 4px rgba(0,0,0,0.02)',
                    }}
                  >
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                        <span style={{ fontSize: '11px', fontWeight: '700', background: '#3b82f6', color: '#fff', padding: '2px 8px', borderRadius: '6px', textTransform: 'uppercase' }}>
                          {p.brand}
                        </span>
                        <span style={{ fontSize: '11px', color: '#64748b', textTransform: 'capitalize' }}>
                          {p.category}
                        </span>
                        {p.ram_gb && (
                          <span style={{ fontSize: '11px', background: '#e2e8f0', color: '#334155', padding: '2px 6px', borderRadius: '4px', fontWeight: '600' }}>
                            {p.ram_gb}GB RAM
                          </span>
                        )}
                      </div>
                      <div style={{ fontWeight: '700', fontSize: '15px', color: '#0f172a', marginBottom: '4px' }}>
                        {p.name}
                      </div>
                      <div style={{ fontSize: '12px', color: '#64748b', lineHeight: '1.4', maxWidth: '320px' }}>
                        {p.description}
                      </div>
                    </div>

                    <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px' }}>
                      <div style={{ fontSize: '20px', fontWeight: '800', color: '#059669' }}>
                        ${p.price}
                      </div>
                      <span style={{ fontSize: '11px', background: '#dcfce7', color: '#15803d', padding: '3px 8px', borderRadius: '6px', fontWeight: '600' }}>
                        In Stock
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        {/* SECONDARY COLLAPSIBLE PANEL: TECHNICAL DETAILS & LIVE TELEMETRY */}
        <section style={{ background: '#fff', borderRadius: '16px', border: '1px solid #e2e8f0', overflow: 'hidden', boxShadow: '0 4px 16px rgba(0,0,0,0.03)' }}>
          <div
            onClick={() => setShowTechnicalDetails(!showTechnicalDetails)}
            style={{
              padding: '16px 24px',
              background: '#f8fafc',
              borderBottom: showTechnicalDetails ? '1px solid #e2e8f0' : 'none',
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontWeight: '700',
              fontSize: '14px',
              color: '#334155',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              ⚙️ Technical Evidence & Live Telemetry Stream
              <span style={{ fontSize: '11px', background: '#cbd5e1', color: '#334155', padding: '2px 8px', borderRadius: '10px' }}>
                {operations.size} Operations • {eventLog.length} Events
              </span>
            </span>
            <span>{showTechnicalDetails ? '▲ Hide Telemetry' : '▼ Expand Technical Details'}</span>
          </div>

          {showTechnicalDetails && (
            <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
              
              {/* OPERATION TRACKER GRID */}
              <div>
                <h4 style={{ margin: '0 0 10px 0', fontSize: '13px', fontWeight: '700', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Active & Fenced Operation States
                </h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '10px' }}>
                  {operations.size === 0 ? (
                    <div style={{ fontSize: '12px', color: '#94a3b8' }}>No operations logged yet.</div>
                  ) : (
                    Array.from(operations.values()).map((op) => {
                      const isCurrent = op.generation_id === currentGeneration;
                      return (
                        <div
                          key={op.operation_id}
                          style={{
                            padding: '10px 14px',
                            borderRadius: '8px',
                            fontSize: '12px',
                            background: op.status === 'discarded' ? '#fef2f2' : isCurrent ? '#eff6ff' : '#f8fafc',
                            border: `1px solid ${op.status === 'discarded' ? '#fca5a5' : isCurrent ? '#bfdbfe' : '#e2e8f0'}`,
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                        >
                          <div>
                            <span style={{ fontWeight: '700', textTransform: 'uppercase' }}>{op.operation_type}</span>{' '}
                            <span style={{ fontFamily: 'monospace', color: '#64748b' }}>[{op.operation_id}]</span>{' '}
                            <span style={{ fontWeight: '700', color: isCurrent ? '#2563eb' : '#64748b' }}>Gen {op.generation_id}</span>
                            {op.details && <div style={{ fontSize: '11px', color: '#64748b', marginTop: '2px' }}>{op.details}</div>}
                          </div>
                          <span
                            style={{
                              fontSize: '10px',
                              fontWeight: '700',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              background: op.status === 'discarded' ? '#ef4444' : op.status === 'running' ? '#3b82f6' : '#10b981',
                              color: '#fff',
                            }}
                          >
                            {op.status === 'discarded' ? '🛡️ FENCED' : op.status.toUpperCase()}
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* EVENT STREAM LOG */}
              <div>
                <h4 style={{ margin: '0 0 10px 0', fontSize: '13px', fontWeight: '700', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Lifecycle Event Log
                </h4>
                <div style={{ maxHeight: '180px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px', background: '#0f172a', padding: '12px', borderRadius: '8px', fontFamily: 'monospace', fontSize: '11px' }}>
                  {eventLog.map((ev) => (
                    <div
                      key={ev.id}
                      style={{
                        color: ev.is_stale_or_discarded ? '#fb923c' : '#94a3b8',
                        display: 'flex',
                        gap: '8px',
                      }}
                    >
                      <span style={{ color: '#64748b' }}>[{ev.timestamp}]</span>
                      <span style={{ color: ev.is_stale_or_discarded ? '#f97316' : '#38bdf8', fontWeight: '700' }}>{ev.event_type}</span>
                      {ev.generation_id !== undefined && <span>(Gen {ev.generation_id})</span>}
                      {ev.details && <span>- {ev.details}</span>}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>
      </main>

      {/* FOOTER */}
      <footer style={{ marginTop: '40px', padding: '20px', textAlign: 'center', fontSize: '13px', color: '#64748b', borderTop: '1px solid #e2e8f0' }}>
        DataForge • Rime Hackathon Voice Assistant • Realtime Interruption & Generation Fencing
      </footer>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);