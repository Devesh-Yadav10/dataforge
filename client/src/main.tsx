import React, { useEffect, useState, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client';

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
}

function App() {
  const [room, setRoom] = useState<Room | null>(null);
  const [connectionState, setConnectionState] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Generation & Session tracking
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [currentGeneration, setCurrentGeneration] = useState<number>(1);
  const [interruptionCount, setInterruptionCount] = useState<number>(0);
  const [lastInterruptionNotice, setLastInterruptionNotice] = useState<{ oldGen: number; newGen: number; timestamp: string } | null>(null);

  // Active operations & Discards
  const [operations, setOperations] = useState<Map<string, OperationState>>(new Map());
  const [activeToolStatus, setActiveToolStatus] = useState<string | null>(null);

  // Chat & Speech
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentStreamingAssistantText, setCurrentStreamingAssistantText] = useState<{ text: string; gen: number } | null>(null);

  // Lifecycle Event Log (latest 50)
  const [eventLog, setEventLog] = useState<EventLogItem[]>([]);
  const [showEvidence, setShowEvidence] = useState<boolean>(true);
  const [isMicMuted, setIsMicMuted] = useState<boolean>(false);

  const eventLogEndRef = useRef<HTMLDivElement>(null);

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
      // 1. Fetch short-lived participant token and LiveKit URL from backend
      addEventLog('token_requested', currentGeneration, undefined, undefined, 'Requesting short-lived participant token from /token');
      const tokenRes = await fetch('/token');
      if (!tokenRes.ok) {
        const errData = await tokenRes.json().catch(() => ({}));
        throw new Error(errData.error || `Server returned status ${tokenRes.status}`);
      }

      const tokenData: { url: string; token: string } = await tokenRes.json();
      if (!tokenData.url || !tokenData.token) {
        throw new Error('Invalid token response from server');
      }

      console.log(`[LiveKit Client] Token received. Connecting to LiveKit URL: ${tokenData.url}...`);
      addEventLog('token_received', currentGeneration, undefined, undefined, 'Acquired short-lived participant token');

      // 2. Connect to LiveKit using server-provided URL and token
      const newRoom = new Room();
      setRoom(newRoom);

      // Diagnostic event listeners on client Room
      newRoom.on(RoomEvent.Connected, () => {
        console.log(`[LiveKit Client] Room Connected! Room: "${newRoom.name}", Local Participant: "${newRoom.localParticipant.identity}" (state: ${newRoom.state})`);
      });

      newRoom.on(RoomEvent.LocalTrackPublished, (pub) => {
        console.log(`[LiveKit Client] LocalTrackPublished: sid=${pub.trackSid}, kind=${pub.kind}, source=${pub.source}, muted=${pub.isMuted}, trackLabel="${pub.track?.mediaStreamTrack?.label}"`);
      });

      newRoom.on(RoomEvent.LocalTrackUnpublished, (pub) => {
        console.log(`[LiveKit Client] LocalTrackUnpublished: sid=${pub.trackSid}, kind=${pub.kind}`);
      });

      await newRoom.connect(tokenData.url, tokenData.token);
      setConnectionState('connected');
      addEventLog('room_connected', currentGeneration, undefined, undefined, `Connected to LiveKit room: ${newRoom.name}`);

      // Enable microphone
      if (newRoom.localParticipant) {
        try {
          console.log('[LiveKit Client] Enabling microphone via setMicrophoneEnabled(true)...');
          await newRoom.localParticipant.setMicrophoneEnabled(true);
          setIsMicMuted(false);
          console.log(`[LiveKit Client] Microphone enabled! isMicrophoneEnabled=${newRoom.localParticipant.isMicrophoneEnabled}, publicationsCount=${newRoom.localParticipant.trackPublications.size}`);
          newRoom.localParticipant.trackPublications.forEach((pub) => {
            console.log(` - Publication [${pub.trackSid}]: kind=${pub.kind}, source=${pub.source}, isMuted=${pub.isMuted}, track=${pub.track?.mediaStreamTrack?.label}`);
          });
          addEventLog('microphone_enabled', currentGeneration, undefined, undefined, 'Microphone active for voice');
        } catch (micErr: any) {
          console.error('[LiveKit Client] Microphone enable error:', micErr);
          setErrorMessage(`Microphone permission error: ${micErr.message}`);
        }
      }

      // Sync local microphone mute state with LiveKit events
      newRoom.on(RoomEvent.TrackMuted, (pub, participant) => {
        console.log(`[LiveKit Client] TrackMuted: ${pub.trackSid} from ${participant?.identity} (isLocal=${participant?.isLocal})`);
        if (participant?.isLocal && pub.kind === Track.Kind.Audio) {
          setIsMicMuted(true);
          addEventLog('microphone_muted', currentGeneration, undefined, undefined, 'Local microphone track muted');
        }
      });

      newRoom.on(RoomEvent.TrackUnmuted, (pub, participant) => {
        console.log(`[LiveKit Client] TrackUnmuted: ${pub.trackSid} from ${participant?.identity} (isLocal=${participant?.isLocal})`);
        if (participant?.isLocal && pub.kind === Track.Kind.Audio) {
          setIsMicMuted(false);
          addEventLog('microphone_unmuted', currentGeneration, undefined, undefined, 'Local microphone track unmuted');
        }
      });

      // Audio track subscription (Rime TTS playback)
      newRoom.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        console.log(`[LiveKit Client] Remote TrackSubscribed: ${track.sid}, kind=${track.kind}`);
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          document.body.appendChild(el);
          addEventLog('tts_audio_track_attached', currentGeneration, undefined, 'tts', 'Rime Coda audio track playing');
        }
      });

      newRoom.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        console.log(`[LiveKit Client] Remote TrackUnsubscribed: ${track.sid}`);
        track.detach().forEach((el) => el.remove());
      });

      newRoom.on('disconnected', (reason) => {
        setConnectionState('disconnected');
        addEventLog('room_disconnected', currentGeneration, undefined, undefined, `Reason: ${reason || 'normal'}`);
      });

      // Listen for data packets from the agent
      newRoom.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
        try {
          const str = new TextDecoder().decode(payload);
          const data = JSON.parse(str);

          // 1. User Transcript
          if (data.type === 'transcript' && typeof data.text === 'string') {
            const gen = data.generation_id ?? currentGeneration;
            const isFinal = data.is_final !== false;
            if (data.session_id) setSessionId(data.session_id);
            if (data.generation_id) setCurrentGeneration(data.generation_id);

            setMessages((prev) => {
              const lastMsg = prev[prev.length - 1];
              // If the previous message was an interim transcript for this generation, update it
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

          // 2. Assistant Text Stream
          else if (data.type === 'assistant_text' && typeof data.text === 'string') {
            const gen = data.generation_id ?? currentGeneration;
            setCurrentStreamingAssistantText({ text: data.text, gen });
          }

          // 3. Tool Events
          else if (data.type === 'tool_event') {
            const gen = data.generation_id ?? currentGeneration;
            if (data.event === 'tool_started') {
              setActiveToolStatus(`⏳ Running: ${data.tool} (4s latency simulated) [${data.operation_id ?? 'op'}, Gen: ${gen}]`);
              setOperations((prev) => {
                const next = new Map(prev);
                next.set(data.operation_id ?? `tool-${Date.now()}`, {
                  operation_id: data.operation_id ?? 'tool',
                  operation_type: 'tool',
                  generation_id: gen,
                  status: 'running',
                  details: `Query: ${JSON.stringify(data.arguments ?? {})}`,
                });
                return next;
              });
              addEventLog('tool_started', gen, data.operation_id, 'tool', `${data.tool} started`);
            } else if (data.event === 'tool_completed') {
              setActiveToolStatus(`✅ Finished: ${data.tool} (${data.result_count} items matched)`);
              setOperations((prev) => {
                const next = new Map(prev);
                if (data.operation_id && next.has(data.operation_id)) {
                  const existing = next.get(data.operation_id)!;
                  next.set(data.operation_id, {
                    ...existing,
                    status: 'completed',
                    details: `Matched ${data.result_count} products`,
                  });
                }
                return next;
              });
              addEventLog('tool_completed', gen, data.operation_id, 'tool', `Matched ${data.result_count} products`);
            }
          }

          // 4. Tracker Events
          else if (data.type === 'tracker_event') {
            const ev = data.event;
            if (ev?.session_id) setSessionId(ev.session_id);
            if (ev?.generation_id) setCurrentGeneration(ev.generation_id);

            // Interruption detected
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
              setActiveToolStatus(null);
              setCurrentStreamingAssistantText(null);

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

              // If final TTS completed, commit streaming text to messages
              if (ev.operation_type === 'tts' && currentStreamingAssistantText) {
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
                setCurrentStreamingAssistantText(null);
              }
            }

            // Operation discarded by generation fence
            else if (ev?.event_type === 'operation_discarded') {
              setOperations((prev) => {
                const next = new Map(prev);
                next.set(ev.operation_id, {
                  operation_id: ev.operation_id,
                  operation_type: ev.operation_type,
                  generation_id: ev.generation_id,
                  status: 'discarded',
                  details: `Discard Reason: ${ev.details?.reason ?? 'STALE_GENERATION'}`,
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
                    details: 'Aborted by signal',
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
      addEventLog('user_initiated_disconnect', currentGeneration);
    }
  };

  const toggleMic = async () => {
    if (room?.localParticipant) {
      try {
        const currentlyEnabled = room.localParticipant.isMicrophoneEnabled;
        const targetEnabled = !currentlyEnabled;
        await room.localParticipant.setMicrophoneEnabled(targetEnabled);
        setIsMicMuted(!targetEnabled);
        console.log(`[Microphone Toggle] Changed isMicrophoneEnabled to: ${targetEnabled}`);
      } catch (err: any) {
        console.error('Failed to toggle microphone:', err);
        setErrorMessage(`Microphone toggle error: ${err.message}`);
      }
    }
  };

  return (
    <div style={{ fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', maxWidth: '1080px', margin: '0 auto', padding: '20px', color: '#1a1a1a' }}>
      
      {/* HEADER */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid #e0e0e0', paddingBottom: '16px', marginBottom: '20px' }}>
        <div>
          <h1 style={{ margin: '0 0 6px 0', fontSize: '24px', fontWeight: '700' }}>
            🎙️ Voice Shopping Assistant <span style={{ fontSize: '14px', background: '#0066cc', color: '#fff', padding: '2px 8px', borderRadius: '12px', verticalAlign: 'middle' }}>Rime Coda</span>
          </h1>
          <p style={{ margin: 0, color: '#666', fontSize: '14px' }}>
            Demonstrating <strong>Generation Fencing</strong> for Realtime Interruption & Async Recovery
          </p>
        </div>

        {/* CONNECTION BUTTONS */}
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          {connectionState === 'connected' ? (
            <>
              <button
                onClick={toggleMic}
                style={{
                  padding: '8px 14px',
                  background: isMicMuted ? '#d32f2f' : '#2e7d32',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontWeight: '600',
                  fontSize: '13px',
                }}
              >
                {isMicMuted ? '🔇 Microphone Muted (Click to Unmute)' : '🎙️ Microphone Active (Click to Mute)'}
              </button>
              <button
                onClick={handleDisconnect}
                style={{
                  padding: '8px 14px',
                  background: '#d32f2f',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '6px',
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
                padding: '10px 18px',
                background: connectionState === 'connecting' ? '#999' : '#0066cc',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                cursor: connectionState === 'connecting' ? 'not-allowed' : 'pointer',
                fontWeight: '600',
                fontSize: '14px',
              }}
            >
              {connectionState === 'connecting' ? 'Connecting to Room...' : 'Connect to Assistant'}
            </button>
          )}
        </div>
      </header>

      {/* ERROR NOTICE */}
      {errorMessage && (
        <div style={{ background: '#ffebee', color: '#c62828', padding: '12px', borderRadius: '6px', marginBottom: '16px', border: '1px solid #ef9a9a' }}>
          <strong>Error:</strong> {errorMessage}
        </div>
      )}

      {/* GENERATION & SESSION TELEMETRY BAR */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px', background: '#f8f9fa', padding: '14px', borderRadius: '8px', border: '1px solid #e9ecef', marginBottom: '20px' }}>
        <div>
          <div style={{ fontSize: '11px', textTransform: 'uppercase', color: '#6c757d', fontWeight: '700' }}>Active Generation</div>
          <div style={{ fontSize: '20px', fontWeight: '800', color: '#0066cc' }}>
            Gen {currentGeneration} <span style={{ fontSize: '12px', fontWeight: 'normal', color: '#28a745' }}>(Active Owner)</span>
          </div>
        </div>
        <div>
          <div style={{ fontSize: '11px', textTransform: 'uppercase', color: '#6c757d', fontWeight: '700' }}>Session Identifier</div>
          <div style={{ fontSize: '13px', fontWeight: '600', fontFamily: 'monospace', color: '#333' }}>
            {sessionId ?? 'Awaiting Connection...'}
          </div>
        </div>
        <div>
          <div style={{ fontSize: '11px', textTransform: 'uppercase', color: '#6c757d', fontWeight: '700' }}>Connection State</div>
          <div style={{ fontSize: '14px', fontWeight: '600', color: connectionState === 'connected' ? '#2e7d32' : '#d32f2f' }}>
            ● {connectionState.toUpperCase()}
          </div>
        </div>
        <div>
          <div style={{ fontSize: '11px', textTransform: 'uppercase', color: '#6c757d', fontWeight: '700' }}>Total Interruptions</div>
          <div style={{ fontSize: '18px', fontWeight: '700', color: interruptionCount > 0 ? '#e65100' : '#666' }}>
            {interruptionCount} {interruptionCount > 0 && '⚡'}
          </div>
        </div>
      </section>

      {/* RECENT BARGE-IN ALERT BANNER */}
      {lastInterruptionNotice && (
        <div style={{ background: '#fff3e0', border: '1px solid #ffe0b2', borderLeft: '5px solid #ff9800', padding: '12px 16px', borderRadius: '6px', marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <strong>⚡ Barge-In Interruption Handled:</strong> Obsoleted <strong>Gen {lastInterruptionNotice.oldGen}</strong> ➔ Switched to <strong>Gen {lastInterruptionNotice.newGen}</strong>. Stale operations fenced.
          </div>
          <span style={{ fontSize: '12px', color: '#888' }}>{lastInterruptionNotice.timestamp}</span>
        </div>
      )}

      {/* MAIN TWO-COLUMN WORKSPACE: LEFT (CONVERSATION & TOOLS) / RIGHT (OPERATIONS & EVENT TIMELINE) */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '20px' }}>
        
        {/* LEFT COLUMN: CONVERSATION & DEMO SCENARIOS */}
        <div>
          
          {/* DEMO PROMPT HELPER CARDS */}
          <div style={{ background: '#e8f4fd', border: '1px solid #b6e0fe', padding: '12px', borderRadius: '8px', marginBottom: '16px' }}>
            <div style={{ fontWeight: '700', fontSize: '13px', color: '#004085', marginBottom: '6px' }}>
              💡 Live Demo Scenarios (Speak or Test Barge-in):
            </div>
            <div style={{ fontSize: '12px', lineHeight: '1.5', color: '#004085' }}>
              <div><strong>Scenario A (Speech Barge-In):</strong> Say <em>"Find me headphones under $200"</em> ➔ Interrupt while speaking with <em>"Actually, show me only Bose."</em></div>
              <div style={{ marginTop: '4px' }}><strong>Scenario B (Async Tool Race):</strong> Say <em>"Find me a laptop under $1000"</em> ➔ Interrupt during the 4s tool delay with <em>"Actually, under $800 with 16GB RAM."</em></div>
            </div>
          </div>

          {/* ACTIVE TOOL STATUS BAR */}
          {activeToolStatus && (
            <div style={{ background: '#fff8e1', border: '1px solid #ffe57f', padding: '10px 14px', borderRadius: '6px', marginBottom: '16px', fontSize: '13px', fontWeight: '600', color: '#ff6f00' }}>
              {activeToolStatus}
            </div>
          )}

          {/* CONVERSATION TRANSCRIPTS */}
          <div style={{ border: '1px solid #dee2e6', borderRadius: '8px', padding: '16px', minHeight: '340px', maxHeight: '480px', overflowY: 'auto', background: '#fff' }}>
            <div style={{ fontSize: '13px', fontWeight: '700', borderBottom: '1px solid #eee', paddingBottom: '8px', marginBottom: '12px', color: '#555' }}>
              💬 Live Turn Transcript
            </div>

            {messages.length === 0 && !currentStreamingAssistantText && (
              <div style={{ textAlign: 'center', color: '#888', marginTop: '60px', fontSize: '14px' }}>
                {connectionState === 'connected' ? '🎙️ Speak into microphone to start conversation...' : 'Click "Connect to Assistant" above to begin.'}
              </div>
            )}

            {messages.map((msg) => (
              <div
                key={msg.id}
                style={{
                  marginBottom: '14px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: msg.sender === 'user' ? 'flex-end' : 'flex-start',
                }}
              >
                <div style={{ fontSize: '11px', color: '#888', marginBottom: '2px' }}>
                  {msg.sender === 'user' ? 'User' : 'Rime Coda Assistant'} • <span style={{ fontWeight: '600', color: msg.generation_id === currentGeneration ? '#0066cc' : '#999' }}>Gen {msg.generation_id}</span> • {msg.timestamp}
                </div>
                <div
                  style={{
                    padding: '10px 14px',
                    borderRadius: '10px',
                    maxWidth: '85%',
                    fontSize: '14px',
                    lineHeight: '1.4',
                    background: msg.sender === 'user' ? '#e3f2fd' : '#f1f8e9',
                    color: msg.sender === 'user' ? '#0d47a1' : '#1b5e20',
                    border: msg.generation_id !== currentGeneration ? '1px dashed #bbb' : 'none',
                  }}
                >
                  {msg.text}
                </div>
              </div>
            ))}

            {/* LIVE STREAMING RESPONSE */}
            {currentStreamingAssistantText && (
              <div style={{ marginBottom: '14px', display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                <div style={{ fontSize: '11px', color: '#0066cc', marginBottom: '2px', fontWeight: '700' }}>
                  ⚡ Streaming Assistant (Gen {currentStreamingAssistantText.gen}) • Speaking via Rime...
                </div>
                <div
                  style={{
                    padding: '10px 14px',
                    borderRadius: '10px',
                    maxWidth: '85%',
                    fontSize: '14px',
                    lineHeight: '1.4',
                    background: '#f1f8e9',
                    color: '#1b5e20',
                    border: '1px solid #c8e6c9',
                  }}
                >
                  {currentStreamingAssistantText.text}
                  <span style={{ display: 'inline-block', width: '6px', height: '14px', background: '#2e7d32', marginLeft: '4px', verticalAlign: 'middle', animation: 'blink 1s infinite' }} />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN: OPERATIONS & FENCING VISIBILITY */}
        <div>
          
          {/* OPERATION TRACKER PANEL */}
          <div style={{ border: '1px solid #dee2e6', borderRadius: '8px', padding: '14px', background: '#fff', marginBottom: '16px' }}>
            <div style={{ fontSize: '13px', fontWeight: '700', borderBottom: '1px solid #eee', paddingBottom: '6px', marginBottom: '10px', color: '#333', display: 'flex', justifyContent: 'space-between' }}>
              <span>⚙️ Operation Tracking & Fencing</span>
              <span style={{ fontSize: '11px', color: '#666' }}>Active Gen: {currentGeneration}</span>
            </div>

            {operations.size === 0 ? (
              <div style={{ fontSize: '12px', color: '#999', padding: '10px 0', textAlign: 'center' }}>
                No active operations yet.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '180px', overflowY: 'auto' }}>
                {Array.from(operations.values()).slice(-6).map((op) => {
                  const isCurrent = op.generation_id === currentGeneration;
                  return (
                    <div
                      key={op.operation_id}
                      style={{
                        padding: '8px 10px',
                        borderRadius: '6px',
                        fontSize: '12px',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        background: op.status === 'discarded' ? '#ffebee' : isCurrent ? '#f0f9ff' : '#f5f5f5',
                        borderLeft: `4px solid ${
                          op.status === 'discarded' ? '#d32f2f' : op.status === 'running' ? '#0066cc' : '#2e7d32'
                        }`,
                      }}
                    >
                      <div>
                        <span style={{ fontWeight: '700', textTransform: 'uppercase' }}>{op.operation_type}</span>{' '}
                        <span style={{ fontFamily: 'monospace', color: '#555' }}>[{op.operation_id}]</span>{' '}
                        <span style={{ fontWeight: '600', color: isCurrent ? '#0066cc' : '#999' }}>Gen {op.generation_id}</span>
                        {op.details && <div style={{ fontSize: '11px', color: '#666', marginTop: '2px' }}>{op.details}</div>}
                      </div>
                      <span
                        style={{
                          fontSize: '10px',
                          fontWeight: '700',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          background:
                            op.status === 'discarded'
                              ? '#d32f2f'
                              : op.status === 'running'
                              ? '#0066cc'
                              : '#2e7d32',
                          color: '#fff',
                        }}
                      >
                        {op.status === 'discarded' ? '🛡️ DISCARDED' : op.status.toUpperCase()}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* REALTIME EVENT LOG */}
          <div style={{ border: '1px solid #dee2e6', borderRadius: '8px', padding: '14px', background: '#fff' }}>
            <div style={{ fontSize: '13px', fontWeight: '700', borderBottom: '1px solid #eee', paddingBottom: '6px', marginBottom: '8px', color: '#333' }}>
              📜 Lifecycle Event Stream (Latest 50)
            </div>
            <div style={{ maxHeight: '220px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {eventLog.length === 0 ? (
                <div style={{ fontSize: '12px', color: '#999', textAlign: 'center', padding: '10px 0' }}>
                  No lifecycle events recorded yet.
                </div>
              ) : (
                eventLog.map((ev) => (
                  <div
                    key={ev.id}
                    style={{
                      fontSize: '11px',
                      fontFamily: 'monospace',
                      padding: '4px 8px',
                      borderRadius: '4px',
                      background: ev.is_stale_or_discarded ? '#fff3e0' : '#fafafa',
                      color: ev.is_stale_or_discarded ? '#d84315' : '#333',
                      borderLeft: ev.is_stale_or_discarded ? '3px solid #ff5722' : '1px solid #eee',
                    }}
                  >
                    <span style={{ color: '#888' }}>[{ev.timestamp}]</span>{' '}
                    <span style={{ fontWeight: '700' }}>{ev.event_type}</span>{' '}
                    {ev.generation_id !== undefined && ev.generation_id !== null && <span>(Gen {ev.generation_id})</span>}{' '}
                    {ev.details && <span style={{ color: '#555' }}>- {ev.details}</span>}
                  </div>
                ))
              )}
              <div ref={eventLogEndRef} />
            </div>
          </div>
        </div>
      </div>

      {/* COLLAPSIBLE EMPIRICAL BENCHMARK EVIDENCE (STAGE 10 DATA) */}
      <section style={{ marginTop: '24px', border: '1px solid #e0e0e0', borderRadius: '8px', overflow: 'hidden', background: '#fff' }}>
        <div
          onClick={() => setShowEvidence(!showEvidence)}
          style={{
            padding: '12px 16px',
            background: '#f1f3f5',
            cursor: 'pointer',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontWeight: '700',
            fontSize: '14px',
          }}
        >
          <span>📊 Stage 10 — 100-Trial Deterministic Interruption Benchmark (Persisted Evidence)</span>
          <span>{showEvidence ? '▲ Hide' : '▼ Expand'}</span>
        </div>

        {showEvidence && (
          <div style={{ padding: '16px', fontSize: '13px', lineHeight: '1.6' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '12px' }}>
              <thead>
                <tr style={{ background: '#f8f9fa', borderBottom: '2px solid #dee2e6', textAlign: 'left' }}>
                  <th style={{ padding: '8px' }}>Benchmark Metric</th>
                  <th style={{ padding: '8px', color: '#0066cc' }}>Fenced Implementation</th>
                  <th style={{ padding: '8px', color: '#d32f2f' }}>Unfenced Baseline</th>
                  <th style={{ padding: '8px' }}>Engineering Significance</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: '8px' }}><strong>Stale Results Accepted</strong></td>
                  <td style={{ padding: '8px', fontWeight: '700', color: '#2e7d32' }}>0 / 100</td>
                  <td style={{ padding: '8px', fontWeight: '700', color: '#d32f2f' }}>50 / 100</td>
                  <td style={{ padding: '8px' }}>Zero stale leaks with generation fencing</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: '8px' }}><strong>Stale Result Leak Rate</strong></td>
                  <td style={{ padding: '8px', fontWeight: '700', color: '#2e7d32' }}>0.0%</td>
                  <td style={{ padding: '8px', fontWeight: '700', color: '#d32f2f' }}>50.0%</td>
                  <td style={{ padding: '8px' }}>Cancellation alone fails whenever tool completes</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: '8px' }}><strong>Generation Fence Catch Rate</strong></td>
                  <td style={{ padding: '8px', fontWeight: '700', color: '#2e7d32' }}>100.0% (50/50)</td>
                  <td style={{ padding: '8px', color: '#666' }}>0.0% (No Fence)</td>
                  <td style={{ padding: '8px' }}>Catches 100% of cancellation-raced completions</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: '8px' }}><strong>Recovery Success Rate</strong></td>
                  <td style={{ padding: '8px', fontWeight: '700', color: '#2e7d32' }}>100.0%</td>
                  <td style={{ padding: '8px', color: '#d32f2f' }}>50.0%</td>
                  <td style={{ padding: '8px' }}>Clean user turn recovery on every interruption</td>
                </tr>
                <tr>
                  <td style={{ padding: '8px' }}><strong>Invalidation Latency (Median)</strong></td>
                  <td style={{ padding: '8px' }}>0ms (Atomic)</td>
                  <td style={{ padding: '8px' }}>0ms</td>
                  <td style={{ padding: '8px' }}>Instantaneous generation invalidation</td>
                </tr>
              </tbody>
            </table>
            <div style={{ fontSize: '11px', color: '#666', fontStyle: 'italic' }}>
              Note: Deterministic concurrency simulation data from <code>tests/results/stage10-results.json</code>; reflects asynchronous state fencing and containment, not live network transit.
            </div>
          </div>
        )}
      </section>

      {/* FOOTER */}
      <footer style={{ marginTop: '24px', textAlign: 'center', fontSize: '12px', color: '#888' }}>
        Rime Hackathon Challenge by DataForge • Realtime Voice Assistant with Generation Fencing
      </footer>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);