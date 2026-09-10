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

interface ProductComparison {
  success: boolean;
  error?: string;
  productA?: Product;
  productB?: Product;
  price_difference?: number;
  cheaper_product?: string;
  differences?: Array<{ attribute: string; productA: string | number; productB: string | number }>;
  generation_id?: number;
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

// Clean Monochrome Line Icons
const IconChat = ({ size = 18, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

const IconSearch = ({ size = 18, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const IconBookmark = ({ size = 18, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
  </svg>
);

const IconSettings = ({ size = 18, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const IconUser = ({ size = 18, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

const IconSparkle = ({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
  </svg>
);

const IconBell = ({ size = 18, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
);

const IconCart = ({ size = 18, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="21" r="1" />
    <circle cx="20" cy="21" r="1" />
    <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
  </svg>
);

const IconShoppingBag = ({ size = 18, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
    <line x1="3" y1="6" x2="21" y2="6" />
    <path d="M16 10a4 4 0 0 1-8 0" />
  </svg>
);

const IconHeadphones = ({ size = 28, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
    <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
  </svg>
);

const IconLaptop = ({ size = 28, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
    <line x1="2" y1="20" x2="22" y2="20" />
  </svg>
);

const IconPhone = ({ size = 28, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
    <line x1="12" y1="18" x2="12.01" y2="18" />
  </svg>
);

const IconMic = ({ size = 18, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="8" y1="23" x2="16" y2="23" />
  </svg>
);

const IconMicOff = ({ size = 18, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="1" y1="1" x2="23" y2="23" />
    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="8" y1="23" x2="16" y2="23" />
  </svg>
);

const IconVolume = ({ size = 18, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
  </svg>
);

const IconSend = ({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="22" y1="2" x2="11" y2="13" />
    <polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
);

const IconAlert = ({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
);

const IconCompare = ({ size = 18, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 3h5v5" />
    <path d="M4 20L21 3" />
    <path d="M21 16v5h-5" />
    <path d="M15 15l6 6" />
    <path d="M4 4l5 5" />
  </svg>
);

const IconLightbulb = ({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 18h6M10 22h4M15 10a5 5 0 0 0-6 0c0 2 1 3 1 4h4c0-1 1-2 1-4z" />
  </svg>
);

const IconPlus = ({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

function renderCategoryIcon(category: string, size = 32, color = '#0f2b48') {
  switch (category.toLowerCase()) {
    case 'headphones':
      return <IconHeadphones size={size} color={color} />;
    case 'laptops':
      return <IconLaptop size={size} color={color} />;
    case 'phones':
      return <IconPhone size={size} color={color} />;
    default:
      return <IconShoppingBag size={size} color={color} />;
  }
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
  const [currentComparison, setCurrentComparison] = useState<ProductComparison | null>(null);

  // Cart & UI Navigation State
  const [cart, setCart] = useState<Product[]>([]);
  const [activeSidebarTab, setActiveSidebarTab] = useState<'chat' | 'search' | 'saved' | 'settings'>('chat');
  const [inputText, setInputText] = useState<string>('');

  // Voice & Assistant State
  const [assistantState, setAssistantState] = useState<'idle' | 'listening' | 'user_speaking' | 'processing' | 'speaking'>('idle');
  const [isMicMuted, setIsMicMuted] = useState<boolean>(false);

  // Active operations map
  const [operations, setOperations] = useState<Map<string, OperationState>>(new Map());

  // Chat messages & streaming
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentStreamingAssistantText, setCurrentStreamingAssistantText] = useState<{ text: string; gen: number } | null>(null);

  // Synchronized refs to avoid stale closure state in long-lived LiveKit event handlers
  const currentGenerationRef = useRef<number>(1);
  const currentStreamingAssistantTextRef = useRef<{ text: string; gen: number } | null>(null);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  // Telemetry & Evidence (collapsible)
  const [eventLog, setEventLog] = useState<EventLogItem[]>([]);
  const [showTechnicalDetails, setShowTechnicalDetails] = useState<boolean>(false);

  // Auto-scroll chat area on new message or streaming delta
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, currentStreamingAssistantText, products, currentComparison]);

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
      addEventLog('token_requested', currentGenerationRef.current, undefined, undefined, 'Acquiring token from server');
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

      // Register ALL event listeners BEFORE connect() so early events/tracks are never missed
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
          el.play().catch((playErr) => console.warn('Audio play notice:', playErr));
          setAssistantState('speaking');
          addEventLog('tts_audio_playing', currentGenerationRef.current, undefined, 'tts', 'Rime Coda voice active');
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
            const gen = data.generation_id ?? currentGenerationRef.current;
            const isFinal = data.is_final !== false;
            if (data.session_id) setSessionId(data.session_id);
            if (data.generation_id) {
              currentGenerationRef.current = data.generation_id;
              setCurrentGeneration(data.generation_id);
            }

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
            const gen = data.generation_id ?? currentGenerationRef.current;
            if (gen === currentGenerationRef.current) {
              setAssistantState('speaking');
              currentStreamingAssistantTextRef.current = { text: data.text, gen };
              setCurrentStreamingAssistantText({ text: data.text, gen });
            }
          }

          // 3. Tool execution state & products
          else if (data.type === 'tool_event') {
            const gen = data.generation_id ?? currentGenerationRef.current;
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
              if (gen === currentGenerationRef.current) {
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

          // 4. Comparison Event
          else if (data.type === 'comparison_event') {
            const gen = data.generation ?? currentGenerationRef.current;
            if (gen === currentGenerationRef.current && data.comparison) {
              setActiveSearchState(null);
              setCurrentComparison({ ...data.comparison, generation_id: gen });
              addEventLog(
                'comparison_completed',
                gen,
                data.operation_id,
                'tool',
                `Compared ${data.comparison.productA?.name || 'A'} vs ${data.comparison.productB?.name || 'B'}`
              );
            }
          }

          // 5. Tracker Events (Fencing & Interruptions)
          else if (data.type === 'tracker_event') {
            const ev = data.event;
            if (ev?.session_id) setSessionId(ev.session_id);

            // Interruption handling
            if (ev?.event_type === 'interruption_detected') {
              const oldG = ev.details?.interrupted_generation ?? currentGenerationRef.current;
              const newG = ev.details?.new_generation ?? (currentGenerationRef.current + 1);

              currentGenerationRef.current = newG;
              currentStreamingAssistantTextRef.current = null;
              setCurrentGeneration(newG);
              setCurrentComparison((prev) => (prev && prev.generation_id === oldG ? null : prev));
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
              if (ev.operation_type === 'tts') {
                const streamingText = currentStreamingAssistantTextRef.current;
                if (streamingText && streamingText.gen === currentGenerationRef.current) {
                  setMessages((prev) => [
                    ...prev,
                    {
                      id: `assistant-${Date.now()}`,
                      sender: 'assistant',
                      text: streamingText.text,
                      generation_id: streamingText.gen,
                      timestamp: new Date().toLocaleTimeString(),
                    },
                  ]);
                }
                currentStreamingAssistantTextRef.current = null;
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

      // Connect to LiveKit Room
      await newRoom.connect(tokenData.url, tokenData.token);
      setConnectionState('connected');
      setAssistantState('listening');
      addEventLog('room_connected', currentGenerationRef.current, undefined, undefined, `Connected to LiveKit room: ${newRoom.name}`);

      // Unlock browser audio playback under the user click gesture
      await newRoom.startAudio().catch((err) => console.warn('startAudio notice:', err));

      // Attach any remote audio tracks already subscribed upon connecting
      newRoom.remoteParticipants.forEach((participant) => {
        participant.trackPublications.forEach((pub) => {
          if (pub.track && pub.track.kind === Track.Kind.Audio) {
            const el = pub.track.attach();
            document.body.appendChild(el);
            el.play().catch((playErr) => console.warn('Audio play notice:', playErr));
          }
        });
      });

      // Enable microphone
      if (newRoom.localParticipant) {
        try {
          await newRoom.localParticipant.setMicrophoneEnabled(true);
          setIsMicMuted(false);
          addEventLog('microphone_enabled', currentGenerationRef.current, undefined, undefined, 'Microphone active');
        } catch (micErr: any) {
          console.error('Microphone enable error:', micErr);
          setErrorMessage(`Microphone permission error: ${micErr.message}`);
        }
      }
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
      addEventLog('user_initiated_disconnect', currentGenerationRef.current);
    }
  };

  const toggleMic = async () => {
    if (connectionState !== 'connected') {
      await connectToRoom();
      return;
    }
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

  const addToCart = (product: Product) => {
    setCart((prev) => [...prev, product]);
    addEventLog('cart_item_added', currentGenerationRef.current, undefined, undefined, `Added ${product.name} ($${product.price}) to cart`);
  };

  const handleNewChat = () => {
    setMessages([]);
    setCurrentStreamingAssistantText(null);
    currentStreamingAssistantTextRef.current = null;
    setProducts([]);
    setCurrentComparison(null);
    setActiveSearchState(null);
    addEventLog('new_chat_started', currentGenerationRef.current);
  };

  const handleSendMessage = (textToSend?: string) => {
    const text = (textToSend || inputText).trim();
    if (!text) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      sender: 'user',
      text,
      generation_id: currentGenerationRef.current,
      timestamp: new Date().toLocaleTimeString(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputText('');

    if (connectionState !== 'connected') {
      connectToRoom();
    }
  };

  return (
    <div
      style={{
        fontFamily: "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        background: 'linear-gradient(135deg, #f7f4ed 0%, #fcfbf9 50%, #ede8de 100%)',
        minHeight: '100vh',
        height: '100vh',
        display: 'flex',
        overflow: 'hidden',
        color: '#1e293b',
      }}
    >
      <style>{`
        * {
          font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          box-sizing: border-box;
        }
        body, html {
          margin: 0;
          padding: 0;
          font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          background: #fcfbf9;
          color: #0f2b48;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }
      `}</style>
      {/* 1. LEFT ICON SIDEBAR (64px) */}
      <aside
        style={{
          width: '68px',
          background: 'rgba(255, 255, 255, 0.85)',
          backdropFilter: 'blur(16px)',
          borderRight: '1px solid #e8e2d5',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '20px 0',
          zIndex: 10,
          boxShadow: '2px 0 12px rgba(15, 43, 72, 0.03)',
        }}
      >
        {/* Top: New Chat + Icons */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
          {/* Circular + New Chat Button */}
          <button
            onClick={handleNewChat}
            title="New Chat"
            aria-label="New Chat"
            style={{
              width: '42px',
              height: '42px',
              borderRadius: '50%',
              background: '#ffffff',
              border: '1px solid #e8e2d5',
              boxShadow: '0 4px 12px rgba(15, 43, 72, 0.1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#0f2b48',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.06)')}
            onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
          >
            <IconPlus size={18} color="#0f2b48" />
          </button>

          {/* Navigation Icons */}
          <button
            onClick={() => setActiveSidebarTab('chat')}
            title="Conversation"
            aria-label="Conversation"
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '12px',
              border: 'none',
              background: activeSidebarTab === 'chat' ? '#e8edf4' : 'transparent',
              color: activeSidebarTab === 'chat' ? '#0f2b48' : '#64748b',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
          >
            <IconChat size={18} color="currentColor" />
          </button>

          <button
            onClick={() => setActiveSidebarTab('search')}
            title="Search Catalog"
            aria-label="Search Catalog"
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '12px',
              border: 'none',
              background: activeSidebarTab === 'search' ? '#e8edf4' : 'transparent',
              color: activeSidebarTab === 'search' ? '#0f2b48' : '#64748b',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
          >
            <IconSearch size={18} color="currentColor" />
          </button>

          <button
            onClick={() => setActiveSidebarTab('saved')}
            title="Saved Items"
            aria-label="Saved Items"
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '12px',
              border: 'none',
              background: activeSidebarTab === 'saved' ? '#e8edf4' : 'transparent',
              color: activeSidebarTab === 'saved' ? '#0f2b48' : '#64748b',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
          >
            <IconBookmark size={18} color="currentColor" />
          </button>
        </div>

        {/* Bottom: Settings & User Avatar */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
          {/* Settings / Telemetry Toggle Button */}
          <button
            onClick={() => setShowTechnicalDetails((prev) => !prev)}
            title="Telemetry & Engineering Panel"
            aria-label="Telemetry & Engineering Panel"
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '12px',
              border: 'none',
              background: showTechnicalDetails ? '#e8edf4' : 'transparent',
              color: showTechnicalDetails ? '#0f2b48' : '#64748b',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
          >
            <IconSettings size={18} color="currentColor" />
          </button>

          {/* User Avatar */}
          <div
            title="User Profile"
            aria-label="User Profile"
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #0f2b48, #1e3a5f)',
              color: '#ffffff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 2px 8px rgba(15, 43, 72, 0.25)',
            }}
          >
            <IconUser size={18} color="#ffffff" />
          </div>
        </div>
      </aside>

      {/* 2. MAIN CONTENT AREA */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          height: '100vh',
          padding: '16px 24px 20px 20px',
          boxSizing: 'border-box',
          overflow: 'hidden',
        }}
      >
        {/* TOP BAR */}
        <header
          style={{
            height: '56px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 8px',
            marginBottom: '12px',
          }}
        >
          {/* Status & Mode Chip */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                padding: '4px 12px',
                borderRadius: '20px',
                fontSize: '12px',
                fontWeight: '600',
                background: connectionState === 'connected' ? 'rgba(220, 252, 231, 0.8)' : 'rgba(241, 245, 249, 0.8)',
                color: connectionState === 'connected' ? '#15803d' : '#64748b',
                border: `1px solid ${connectionState === 'connected' ? '#86efac' : '#cbd5e1'}`,
                backdropFilter: 'blur(8px)',
              }}
            >
              <span
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  background: connectionState === 'connected' ? '#16a34a' : '#94a3b8',
                }}
              />
              <span>{connectionState === 'connected' ? 'Live Session Active' : 'Offline'}</span>
            </div>

            <div
              style={{
                padding: '4px 10px',
                borderRadius: '16px',
                fontSize: '11px',
                fontWeight: '700',
                background: '#e8edf4',
                color: '#0f2b48',
                border: '1px solid #cbd5e1',
              }}
            >
              Gen {currentGeneration}
            </div>
          </div>

          {/* Center: DataForge Wordmark */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div
              style={{
                background: 'linear-gradient(135deg, #0f2b48, #1e3a5f)',
                color: '#fff',
                padding: '6px',
                borderRadius: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 2px 8px rgba(15, 43, 72, 0.25)',
              }}
            >
              <IconSparkle size={16} color="#ffffff" />
            </div>
            <span style={{ fontSize: '18px', fontWeight: '800', color: '#0f172a', letterSpacing: '-0.02em' }}>
              DataForge
            </span>
            <span style={{ fontSize: '12px', fontWeight: '600', color: '#57534e', background: '#f7f4ed', padding: '2px 8px', borderRadius: '12px', border: '1px solid #e8e2d5' }}>
              AI Shopping Assistant
            </span>
          </div>

          {/* Right: Notifications, Cart & Connection Button */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {/* Notifications */}
            <button
              title="Notifications"
              aria-label="Notifications"
              style={{
                width: '38px',
                height: '38px',
                borderRadius: '50%',
                background: '#ffffff',
                border: '1px solid #e8e2d5',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#475569',
                cursor: 'pointer',
                boxShadow: '0 2px 6px rgba(0,0,0,0.03)',
              }}
            >
              <IconBell size={18} color="#475569" />
            </button>

            {/* Cart with Item Counter */}
            <div
              title={`Cart: ${cart.length} items`}
              aria-label={`Shopping cart with ${cart.length} items`}
              style={{
                position: 'relative',
                width: '38px',
                height: '38px',
                borderRadius: '50%',
                background: '#ffffff',
                border: '1px solid #e8e2d5',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#475569',
                cursor: 'pointer',
                boxShadow: '0 2px 6px rgba(0,0,0,0.03)',
              }}
            >
              <IconCart size={18} color="#475569" />
              {cart.length > 0 && (
                <span
                  style={{
                    position: 'absolute',
                    top: '-4px',
                    right: '-4px',
                    background: '#ef4444',
                    color: '#ffffff',
                    fontSize: '10px',
                    fontWeight: '800',
                    borderRadius: '10px',
                    padding: '2px 6px',
                    boxShadow: '0 2px 4px rgba(239, 68, 68, 0.4)',
                  }}
                >
                  {cart.length}
                </span>
              )}
            </div>

            {/* LiveKit Connect / Disconnect */}
            {connectionState === 'connected' ? (
              <button
                onClick={handleDisconnect}
                style={{
                  background: '#fef2f2',
                  border: '1px solid #fca5a5',
                  color: '#991b1b',
                  padding: '6px 14px',
                  borderRadius: '20px',
                  fontSize: '12px',
                  fontWeight: '700',
                  cursor: 'pointer',
                }}
              >
                Disconnect
              </button>
            ) : (
              <button
                onClick={connectToRoom}
                style={{
                  background: 'linear-gradient(135deg, #0f2b48, #1e3a5f)',
                  border: 'none',
                  color: '#ffffff',
                  padding: '6px 16px',
                  borderRadius: '20px',
                  fontSize: '12px',
                  fontWeight: '700',
                  cursor: 'pointer',
                  boxShadow: '0 2px 8px rgba(15, 43, 72, 0.25)',
                }}
              >
                {connectionState === 'connecting' ? 'Connecting...' : 'Connect Voice'}
              </button>
            )}
          </div>
        </header>

        {/* 3. MAIN WHITE SURFACE CARD (Chat + Products + Input) */}
        <main
          style={{
            flex: 1,
            background: '#ffffff',
            borderRadius: '24px',
            border: '1px solid #e8e2d5',
            boxShadow: '0 12px 40px rgba(15, 43, 72, 0.04)',
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          {/* SCROLLABLE CONVERSATION & PRODUCT RESULTS AREA */}
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '24px 32px 100px 32px',
              display: 'flex',
              flexDirection: 'column',
              gap: '20px',
            }}
          >
            {/* WELCOME HERO WHEN EMPTY */}
            {messages.length === 0 && !currentStreamingAssistantText && products.length === 0 && !currentComparison && (
              <div
                style={{
                  margin: 'auto 0',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  textAlign: 'center',
                  padding: '40px 20px',
                }}
              >
                <div
                  style={{
                    width: '64px',
                    height: '64px',
                    borderRadius: '20px',
                    background: 'linear-gradient(135deg, #f7f4ed, #e8edf4)',
                    color: '#0f2b48',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: '16px',
                    boxShadow: '0 4px 16px rgba(15, 43, 72, 0.08)',
                  }}
                >
                  <IconShoppingBag size={28} color="#0f2b48" />
                </div>
                <h2 style={{ margin: '0 0 8px 0', fontSize: '24px', fontWeight: '800', color: '#0f172a' }}>
                  What can I help you find today?
                </h2>
                <p style={{ margin: '0 0 24px 0', fontSize: '14px', color: '#64748b', maxWidth: '440px', lineHeight: '1.5' }}>
                  Ask with your voice or text to search headphones, laptops, and phones. Compare options side-by-side with realtime interruption safety.
                </p>

                {/* Suggested prompt chips */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', justifyContent: 'center', maxWidth: '580px' }}>
                  {[
                    'Show me headphones under $200',
                    'Find laptops with 16GB RAM',
                    'Show phones under $800',
                    'Compare Sony and Bose headphones',
                  ].map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => handleSendMessage(suggestion)}
                      style={{
                        padding: '8px 16px',
                        borderRadius: '20px',
                        background: '#f7f4ed',
                        border: '1px solid #e8e2d5',
                        fontSize: '13px',
                        fontWeight: '500',
                        color: '#1c1917',
                        cursor: 'pointer',
                        transition: 'all 0.2s ease',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = '#e8edf4';
                        e.currentTarget.style.borderColor = '#cbd5e1';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = '#f7f4ed';
                        e.currentTarget.style.borderColor = '#e8e2d5';
                      }}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* BARGE-IN INTERRUPTION ALERT NOTIFICATION */}
            {lastInterruptionNotice && (
              <div
                style={{
                  background: 'linear-gradient(90deg, #fff7ed, #ffffff)',
                  border: '1px solid #fed7aa',
                  borderLeft: '5px solid #f97316',
                  padding: '12px 18px',
                  borderRadius: '12px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: '13px',
                  color: '#9a3412',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <IconAlert size={15} color="#ea580c" />
                  <span>
                    <strong>Interruption Fenced:</strong> Inactive turn (Gen {lastInterruptionNotice.oldGen}) cancelled ➔ Switched to <strong>Gen {lastInterruptionNotice.newGen}</strong>.
                  </span>
                </span>
                <span style={{ fontSize: '11px', color: '#c2410c', fontWeight: '600' }}>
                  {lastInterruptionNotice.timestamp}
                </span>
              </div>
            )}

            {/* ACTIVE CATALOG SEARCH STATE PILL */}
            {activeSearchState && (
              <div
                style={{
                  background: activeSearchState.wasInterrupted ? '#fef2f2' : '#f0fdf4',
                  border: `1px solid ${activeSearchState.wasInterrupted ? '#fca5a5' : '#bbf7d0'}`,
                  padding: '10px 16px',
                  borderRadius: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  fontSize: '13px',
                  color: activeSearchState.wasInterrupted ? '#991b1b' : '#166534',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center' }}>
                  {activeSearchState.wasInterrupted ? <IconAlert size={15} color="#dc2626" /> : <IconSearch size={15} color="#16a34a" />}
                </span>
                <span style={{ fontWeight: '600' }}>{activeSearchState.queryText}</span>
                {activeSearchState.isSearching && (
                  <span style={{ fontSize: '11px', background: '#dcfce7', padding: '2px 8px', borderRadius: '10px', marginLeft: 'auto' }}>
                    Catalog Querying...
                  </span>
                )}
              </div>
            )}

            {/* CONVERSATION MESSAGES LIST */}
            {messages.map((msg) => {
              const isUser = msg.sender === 'user';
              return (
                <div
                  key={msg.id}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: isUser ? 'flex-end' : 'flex-start',
                    gap: '4px',
                    opacity: msg.interrupted ? 0.6 : 1,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: '8px', maxWidth: '80%' }}>
                    {!isUser && (
                      <div
                        style={{
                          width: '30px',
                          height: '30px',
                          borderRadius: '50%',
                          background: 'linear-gradient(135deg, #0f2b48, #1e3a5f)',
                          color: '#fff',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          boxShadow: '0 2px 6px rgba(15, 43, 72, 0.2)',
                        }}
                      >
                        <IconSparkle size={14} color="#ffffff" />
                      </div>
                    )}

                    <div
                      style={{
                        padding: '12px 18px',
                        borderRadius: isUser ? '20px 20px 4px 20px' : '20px 20px 20px 4px',
                        background: isUser ? '#f7f4ed' : '#ffffff',
                        color: isUser ? '#1c1917' : '#0f2b48',
                        border: '1px solid #e8e2d5',
                        fontSize: '14px',
                        lineHeight: '1.55',
                        boxShadow: isUser ? '0 1px 4px rgba(0,0,0,0.02)' : '0 2px 8px rgba(15, 43, 72, 0.03)',
                        textDecoration: msg.interrupted ? 'line-through' : 'none',
                      }}
                    >
                      {msg.text}
                    </div>

                    {isUser && (
                      <div
                        style={{
                          width: '30px',
                          height: '30px',
                          borderRadius: '50%',
                          background: '#e8e2d5',
                          color: '#57534e',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        <IconUser size={14} color="#57534e" />
                      </div>
                    )}
                  </div>

                  <div style={{ fontSize: '11px', color: '#94a3b8', margin: '0 38px', display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <span>Gen {msg.generation_id}</span>
                    <span>•</span>
                    <span>{msg.timestamp}</span>
                    {msg.interrupted && (
                      <span style={{ color: '#ef4444', fontWeight: '700', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                        <IconAlert size={11} color="#ef4444" /> Interrupted
                      </span>
                    )}
                  </div>
                </div>
              );
            })}

            {/* STREAMING ASSISTANT TEXT */}
            {currentStreamingAssistantText && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '4px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: '8px', maxWidth: '80%' }}>
                  <div
                    style={{
                      width: '30px',
                      height: '30px',
                      borderRadius: '50%',
                      background: 'linear-gradient(135deg, #0f2b48, #1e3a5f)',
                      color: '#fff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <IconSparkle size={14} color="#ffffff" />
                  </div>

                  <div
                    style={{
                      padding: '12px 18px',
                      borderRadius: '20px 20px 20px 4px',
                      background: '#f8fafc',
                      color: '#0f2b48',
                      border: '1px solid #cbd5e1',
                      fontSize: '14px',
                      lineHeight: '1.55',
                      boxShadow: '0 2px 8px rgba(15, 43, 72, 0.05)',
                    }}
                  >
                    {currentStreamingAssistantText.text}
                    <span
                      style={{
                        display: 'inline-block',
                        width: '6px',
                        height: '14px',
                        background: '#0f2b48',
                        marginLeft: '6px',
                        verticalAlign: 'middle',
                      }}
                    />
                  </div>
                </div>

                <div style={{ fontSize: '11px', color: '#0f2b48', margin: '0 38px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <IconVolume size={13} color="#0f2b48" />
                  <span>Rime Voice Streaming • Gen {currentStreamingAssistantText.gen}</span>
                </div>
              </div>
            )}

            {/* 4. PRODUCT RECOMMENDATION CAROUSEL */}
            {products.length > 0 && (
              <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={{ margin: 0, fontSize: '15px', fontWeight: '800', color: '#0f172a', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <IconShoppingBag size={18} color="#0f2b48" />
                    <span>Recommended Products</span>
                  </h3>
                  <span style={{ fontSize: '11px', color: '#64748b', background: '#f1f5f9', padding: '2px 8px', borderRadius: '10px', fontWeight: '600' }}>
                    {products.length} Items • Gen {productsGen}
                  </span>
                </div>

                {/* Horizontal Scroll Carousel */}
                <div
                  style={{
                    display: 'flex',
                    gap: '16px',
                    overflowX: 'auto',
                    scrollSnapType: 'x mandatory',
                    paddingBottom: '8px',
                    paddingTop: '2px',
                    scrollbarWidth: 'thin',
                  }}
                >
                  {products.map((p) => (
                    <div
                      key={p.id}
                      style={{
                        flex: '0 0 240px',
                        scrollSnapAlign: 'start',
                        background: '#ffffff',
                        border: '1px solid #e8e2d5',
                        borderRadius: '16px',
                        padding: '14px',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'space-between',
                        boxShadow: '0 4px 12px rgba(15, 43, 72, 0.03)',
                        transition: 'transform 0.2s ease, box-shadow 0.2s ease',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.transform = 'translateY(-2px)';
                        e.currentTarget.style.boxShadow = '0 6px 18px rgba(15, 43, 72, 0.06)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.transform = 'translateY(0)';
                        e.currentTarget.style.boxShadow = '0 4px 12px rgba(15, 43, 72, 0.03)';
                      }}
                    >
                      <div>
                        {/* Top Visual Graphic Box */}
                        <div
                          style={{
                            height: '90px',
                            borderRadius: '12px',
                            background: 'linear-gradient(135deg, #f5f0e6 0%, #e8edf4 100%)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            marginBottom: '12px',
                          }}
                        >
                          {renderCategoryIcon(p.category, 36, '#0f2b48')}
                        </div>

                        {/* Brand & Category Subtitle */}
                        <div style={{ fontSize: '11px', fontWeight: '700', color: '#1e3a5f', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '2px' }}>
                          {p.brand} • {p.category}
                        </div>

                        {/* Title */}
                        <h4 style={{ margin: '0 0 6px 0', fontSize: '14px', fontWeight: '700', color: '#0f2b48', lineHeight: '1.3' }}>
                          {p.name}
                        </h4>

                        {/* Specs / Description */}
                        <p style={{ margin: '0 0 12px 0', fontSize: '12px', color: '#64748b', lineHeight: '1.4', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                          {p.ram_gb ? `${p.ram_gb}GB RAM • ` : ''}{p.description}
                        </p>
                      </div>

                      {/* Bottom Row: Price & Circular Add to Cart Button */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #f1f5f9', paddingTop: '10px' }}>
                        <span style={{ fontSize: '16px', fontWeight: '800', color: '#0f2b48' }}>
                          ${p.price}
                        </span>

                        <button
                          onClick={() => addToCart(p)}
                          title={`Add ${p.name} to cart`}
                          aria-label={`Add ${p.name} to cart`}
                          style={{
                            width: '32px',
                            height: '32px',
                            borderRadius: '50%',
                            background: 'linear-gradient(135deg, #0f2b48, #1e3a5f)',
                            border: 'none',
                            color: '#ffffff',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            cursor: 'pointer',
                            boxShadow: '0 2px 6px rgba(15, 43, 72, 0.25)',
                            transition: 'transform 0.15s ease',
                          }}
                          onMouseDown={(e) => (e.currentTarget.style.transform = 'scale(0.92)')}
                          onMouseUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
                        >
                          <IconPlus size={16} color="#ffffff" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 5. SIDE-BY-SIDE COMPARISON CARD */}
            {currentComparison && currentComparison.productA && currentComparison.productB && (
              <div
                style={{
                  background: '#ffffff',
                  border: '2px solid #0f2b48',
                  borderRadius: '16px',
                  padding: '18px',
                  boxShadow: '0 6px 20px rgba(15, 43, 72, 0.06)',
                  marginTop: '8px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                  <span style={{ fontWeight: '800', fontSize: '15px', color: '#0f2b48', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <IconCompare size={18} color="#0f2b48" />
                    <span>Side-by-Side Product Comparison</span>
                  </span>
                  {currentComparison.generation_id && (
                    <span style={{ fontSize: '11px', background: '#e8edf4', color: '#0f2b48', padding: '2px 8px', borderRadius: '10px', fontWeight: '700' }}>
                      Gen {currentComparison.generation_id}
                    </span>
                  )}
                </div>

                {/* Comparison Table */}
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginBottom: '12px' }}>
                    <thead>
                      <tr style={{ background: '#f7f4ed', borderBottom: '2px solid #e8e2d5' }}>
                        <th style={{ padding: '8px 12px', textAlign: 'left', color: '#64748b', fontWeight: '700', width: '25%' }}>Feature</th>
                        <th style={{ padding: '8px 12px', textAlign: 'left', color: '#0f172a', fontWeight: '800', width: '37.5%' }}>
                          {currentComparison.productA.name}
                        </th>
                        <th style={{ padding: '8px 12px', textAlign: 'left', color: '#0f172a', fontWeight: '800', width: '37.5%' }}>
                          {currentComparison.productB.name}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '8px 12px', fontWeight: '600', color: '#475569' }}>Price</td>
                        <td style={{ padding: '8px 12px', fontWeight: '800', color: currentComparison.productA.price < currentComparison.productB.price ? '#16a34a' : '#0f172a' }}>
                          ${currentComparison.productA.price}
                          {currentComparison.productA.price < currentComparison.productB.price && ' (Cheaper)'}
                        </td>
                        <td style={{ padding: '8px 12px', fontWeight: '800', color: currentComparison.productB.price < currentComparison.productA.price ? '#16a34a' : '#0f172a' }}>
                          ${currentComparison.productB.price}
                          {currentComparison.productB.price < currentComparison.productA.price && ' (Cheaper)'}
                        </td>
                      </tr>
                      <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '8px 12px', fontWeight: '600', color: '#475569' }}>Brand</td>
                        <td style={{ padding: '8px 12px' }}>{currentComparison.productA.brand}</td>
                        <td style={{ padding: '8px 12px' }}>{currentComparison.productB.brand}</td>
                      </tr>
                      <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '8px 12px', fontWeight: '600', color: '#475569' }}>Category</td>
                        <td style={{ padding: '8px 12px', textTransform: 'capitalize' }}>{currentComparison.productA.category}</td>
                        <td style={{ padding: '8px 12px', textTransform: 'capitalize' }}>{currentComparison.productB.category}</td>
                      </tr>
                      {(currentComparison.productA.ram_gb || currentComparison.productB.ram_gb) && (
                        <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '8px 12px', fontWeight: '600', color: '#475569' }}>RAM</td>
                          <td style={{ padding: '8px 12px' }}>{currentComparison.productA.ram_gb ? `${currentComparison.productA.ram_gb} GB` : 'N/A'}</td>
                          <td style={{ padding: '8px 12px' }}>{currentComparison.productB.ram_gb ? `${currentComparison.productB.ram_gb} GB` : 'N/A'}</td>
                        </tr>
                      )}
                      <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '8px 12px', fontWeight: '600', color: '#475569' }}>Key Features</td>
                        <td style={{ padding: '8px 12px', fontSize: '12px', color: '#475569', lineHeight: '1.4' }}>{currentComparison.productA.description}</td>
                        <td style={{ padding: '8px 12px', fontSize: '12px', color: '#475569', lineHeight: '1.4' }}>{currentComparison.productB.description}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* Key Differences / Winner Takeaway */}
                <div style={{ background: '#f5f0e6', padding: '10px 14px', borderRadius: '10px', fontSize: '12px', color: '#0f2b48', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <IconLightbulb size={16} color="#0f2b48" />
                  <span><strong>Key Difference:</strong> {currentComparison.cheaper_product} (Price difference: ${currentComparison.price_difference})</span>
                </div>
              </div>
            )}

            <div ref={chatBottomRef} />
          </div>

          {/* 6. FLOATING PILL-SHAPED INPUT BAR (Centered at Bottom) */}
          <div
            style={{
              position: 'absolute',
              bottom: '20px',
              left: '50%',
              transform: 'translateX(-50%)',
              width: 'min(92%, 620px)',
              background: '#ffffff',
              border: '1px solid #e8e2d5',
              borderRadius: '9999px',
              boxShadow: '0 8px 30px rgba(15, 43, 72, 0.08)',
              padding: '6px 10px 6px 18px',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              zIndex: 5,
            }}
          >
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSendMessage();
              }}
              placeholder="What are you looking for?"
              style={{
                flex: 1,
                border: 'none',
                outline: 'none',
                fontSize: '14px',
                color: '#0f2b48',
                background: 'transparent',
                fontFamily: 'inherit',
              }}
            />

            {/* Send Button */}
            {inputText.trim() && (
              <button
                onClick={() => handleSendMessage()}
                title="Send Message"
                aria-label="Send Message"
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '50%',
                  background: 'linear-gradient(135deg, #0f2b48, #1e3a5f)',
                  border: 'none',
                  color: '#ffffff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  boxShadow: '0 2px 6px rgba(15, 43, 72, 0.25)',
                }}
              >
                <IconSend size={15} color="#ffffff" />
              </button>
            )}

            {/* Microphone Button */}
            <button
              onClick={toggleMic}
              title={connectionState !== 'connected' ? 'Connect Voice Assistant' : isMicMuted ? 'Unmute Microphone' : 'Mute Microphone'}
              aria-label={connectionState !== 'connected' ? 'Connect Voice Assistant' : isMicMuted ? 'Unmute Microphone' : 'Mute Microphone'}
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '50%',
                background:
                  connectionState !== 'connected'
                    ? '#f1f5f9'
                    : assistantState === 'user_speaking'
                    ? 'linear-gradient(135deg, #3b82f6, #1d4ed8)'
                    : assistantState === 'speaking'
                    ? 'linear-gradient(135deg, #10b981, #059669)'
                    : isMicMuted
                    ? '#ef4444'
                    : 'linear-gradient(135deg, #0f2b48, #1e3a5f)',
                border: 'none',
                color: connectionState !== 'connected' ? '#64748b' : '#ffffff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                boxShadow:
                  connectionState === 'connected'
                    ? '0 2px 8px rgba(15, 43, 72, 0.3)'
                    : 'none',
                transition: 'all 0.2s ease',
              }}
            >
              {connectionState !== 'connected' ? (
                <IconMic size={18} color="#64748b" />
              ) : isMicMuted ? (
                <IconMicOff size={18} color="#ffffff" />
              ) : assistantState === 'speaking' ? (
                <IconVolume size={18} color="#ffffff" />
              ) : (
                <IconMic size={18} color="#ffffff" />
              )}
            </button>
          </div>
        </main>
      </div>

      {/* 7. COLLAPSIBLE TELEMETRY / ENGINEERING OVERLAY DRAWER */}
      {showTechnicalDetails && (
        <aside
          style={{
            position: 'fixed',
            top: 0,
            right: 0,
            bottom: 0,
            width: '380px',
            background: '#ffffff',
            borderLeft: '1px solid #e8e2d5',
            boxShadow: '-4px 0 24px rgba(15, 43, 72, 0.08)',
            zIndex: 100,
            display: 'flex',
            flexDirection: 'column',
            padding: '20px',
            boxSizing: 'border-box',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', borderBottom: '1px solid #f1f5f9', paddingBottom: '10px' }}>
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '800', color: '#0f172a', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <IconSettings size={16} color="#475569" />
              <span>Generation & Telemetry</span>
            </h3>
            <button
              onClick={() => setShowTechnicalDetails(false)}
              aria-label="Close Telemetry Panel"
              style={{ border: 'none', background: 'transparent', fontSize: '18px', cursor: 'pointer', color: '#64748b' }}
            >
              ✕
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {/* Status overview */}
            <div style={{ background: '#f8fafc', padding: '12px', borderRadius: '10px', fontSize: '12px' }}>
              <div><strong>Session ID:</strong> {sessionId || 'Pending'}</div>
              <div><strong>Active Gen:</strong> {currentGeneration}</div>
              <div><strong>Interruption Count:</strong> {interruptionCount}</div>
            </div>

            {/* Active operations */}
            <div>
              <div style={{ fontSize: '13px', fontWeight: '700', marginBottom: '6px' }}>Active Operations</div>
              {Array.from(operations.values()).length === 0 ? (
                <div style={{ fontSize: '12px', color: '#94a3b8' }}>No active operations</div>
              ) : (
                Array.from(operations.values()).map((op) => (
                  <div
                    key={op.operation_id}
                    style={{
                      fontSize: '11px',
                      padding: '6px 8px',
                      borderRadius: '6px',
                      marginBottom: '4px',
                      background: op.status === 'discarded' ? '#fef2f2' : '#f8fafc',
                      border: `1px solid ${op.status === 'discarded' ? '#fca5a5' : '#e2e8f0'}`,
                      color: op.status === 'discarded' ? '#991b1b' : '#334155',
                    }}
                  >
                    <strong>{op.operation_type.toUpperCase()}</strong> ({op.operation_id.slice(0, 8)}) - {op.status}
                    {op.details && <div>{op.details}</div>}
                  </div>
                ))
              )}
            </div>

            {/* Event log */}
            <div>
              <div style={{ fontSize: '13px', fontWeight: '700', marginBottom: '6px' }}>Event Stream ({eventLog.length})</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {eventLog.map((ev) => (
                  <div
                    key={ev.id}
                    style={{
                      fontSize: '11px',
                      padding: '4px 6px',
                      borderRadius: '4px',
                      background: ev.is_stale_or_discarded ? '#fff1f2' : '#f8fafc',
                      color: ev.is_stale_or_discarded ? '#e11d48' : '#475569',
                    }}
                  >
                    <span style={{ color: '#94a3b8' }}>{ev.timestamp}</span> [Gen {ev.generation_id ?? '-'}] <strong>{ev.event_type}</strong>
                    {ev.details && <div>{ev.details}</div>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);