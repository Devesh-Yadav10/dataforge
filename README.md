# DataForge: Voice AI Shopping Assistant with Generation Fencing & Rime TTS

DataForge is a low-latency, interruption-safe conversational shopping assistant built with **LiveKit**, **Deepgram**, **Google Gemini**, **Groq**, and **Rime TTS**. It features deterministic generation fencing to guarantee that stale async results from interrupted turns never leak into speech or corrupt conversation context.

---

## Setup & Getting Started

### Prerequisites
- **Node.js:** v18.0.0+ (Tested on Node.js v20 and v24)
- **npm:** v9.0.0+

### 1. Installation
Clone the repository and install dependencies:
```bash
npm install
```

### 2. Environment Configuration
Copy the template environment file and provide your API keys:
```bash
cp .env.example .env
```

Configure the following variables in `.env`:
- `LIVEKIT_URL`: LiveKit Cloud / Server WebSocket URL (`wss://...`)
- `LIVEKIT_API_KEY`: LiveKit API Key
- `LIVEKIT_API_SECRET`: LiveKit API Secret
- `DEEPGRAM_API_KEY`: Deepgram API Key for Nova-2 Speech-to-Text
- `GEMINI_API_KEY`: Google Gemini API Key
- `GROQ_API_KEY`: Groq API Key (for Tier 3 LLM fallback)
- `RIME_API_KEY`: Rime API Key for neural voice synthesis
- `LIVEKIT_ROOM_NAME`: (Optional) Room name (defaults to `default-room`)
- `PORT`: (Optional) Backend token server port (defaults to `3000`)
- `LOG_LEVEL`: (Optional) Logger level (defaults to `info`)

### 3. Build the Project
Compile the TypeScript backend and build the React frontend:
```bash
npm run build
```

### 4. Run Tests
Execute the full test suite (tools, tracker, turn invariants, interruption fencing, baseline comparison, stress benchmark, and Rime TTS):
```bash
npm test
```

Individual test suites:
- `npm run test:shopping`: Shopping and comparison tool unit tests
- `npm run test:tracker`: GenerationTracker lifecycle and fencing invariants
- `npm run test:turn`: LiveKit turn management and barge-in invariants
- `npm run test:interruption`: Interruption fencing and abort signal tests
- `npm run test:comparison`: Fenced vs Unfenced baseline comparison
- `npm run test:stress`: 100-trial automated stress benchmark
- `npm run test:rime`: Rime TTS voice pipeline and fencing verification

### 5. Start the Voice Agent & Token Server
Start the backend agent service (includes LiveKit Agent and local token endpoint on port 3000):
```bash
npm start
```

### 6. Start the Web Client
In a separate terminal, launch the Vite client:
```bash
npm run dev:client
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## Architecture

DataForge follows an event-driven, generation-fenced pipeline:

```text
  [ User Microphone ]
          │ (WebRTC Audio)
          ▼
  [ LiveKit Room ] ──► [ Deepgram Nova-2 STT ]
                                │ (Finalized Turn Transcript)
                                ▼
                   [ GenerationTracker (Gen N) ]
                                │
                                ▼
              [ Multi-Tier LLM Pipeline ]
         ┌──────────────────────┴──────────────────────┐
         ▼                                             ▼
  [ Direct Response ]                           [ Tool Invocation ]
         │                                      • search_products
         │                                      • compare_products
         │                                             │ (Fenced Result)
         └──────────────────────┬──────────────────────┘
                                │ (Streaming Delta Tokens)
                                ▼
                     [ Rime Coda TTS (WebSocket) ]
                                │ (16kHz PCM Frames)
                                ▼
                   [ LiveKit WebRTC Audio Playout ]
                                │
                                ▼
                      [ Browser Speaker ]
```

- **React/Vite Frontend (`client/`):** Realtime web interface with Inter typography, monochrome SVG icons, Navy Blue & Beige palette, conversation chat history, side-by-side comparison cards, and engineering telemetry drawer.
- **LiveKit Agents (`@livekit/agents`):** Manages WebRTC audio publishing, participant sessions, and event-driven voice turn dispatch.
- **Deepgram Nova-2 STT (`@livekit/agents-plugin-deepgram`):** Fast, streaming speech-to-text transcript generation with turn endpointing.
- **Multi-Tier LLM Pipeline:**
  1. **Primary:** Google Gemini 3.5 Flash-Lite (`gemini-3.5-flash-lite`)
  2. **Tier 2 Fallback:** Google Gemini 3.1 Flash-Lite (`gemini-3.1-flash-lite`)
  3. **Tier 3 Provider Fallback:** Groq `openai/gpt-oss-20b`
- **Deterministic Shopping Catalog (`agent/tools/shopping.ts`):** In-memory catalog of 16 curated products supporting `search_products` and `compare_products`.
- **Rime TTS (`@livekit/agents-plugin-rime`):** Low-latency neural speech synthesis over WebSocket using the `coda` model and `celeste` voice.
- **GenerationTracker (`agent/tracker.ts`):** Generation counter and operation registry enforcing the `tracker.isCurrent(op)` invariant.
- **Token Server (`agent/token_server.ts`):** Server-side HTTP endpoint on port 3000 issuing short-lived participant JWTs.
- **Data Channel Telemetry:** Realtime telemetry and structured product/comparison data broadcast via LiveKit reliable data channels.

---

## Third-Party Services

1. **LiveKit Cloud / Server:** Realtime WebRTC audio transport, agent session management, and data channels.
2. **Deepgram:** Streaming speech-to-text transcription using the Nova-2 model (`nova-2-general`).
3. **Google Gemini:** Primary LLM intelligence and function calling via the official `@google/genai` SDK.
4. **Groq:** High-speed cloud LLM inference provider for tertiary fallback using `openai/gpt-oss-20b`.
5. **Rime:** Expressive, low-latency neural text-to-speech voice synthesis.

---

## Exact Rime Configuration

Derived directly from the codebase (`agent/index.ts` and `@livekit/agents-plugin-rime`):

| Parameter | Configured Value | Description |
|:---|:---|:---|
| **Model ID** | `coda` | Rime Coda neural voice synthesis model |
| **Speaker / Voice** | `celeste` | Expressive conversational speaker voice |
| **Language** | `eng` | English language synthesis |
| **REST Base Endpoint** | `https://users.rime.ai/v1/rime-tts` | Rime standard REST API endpoint |
| **WebSocket Streaming Endpoint** | `wss://users-ws.rime.ai` | Realtime low-latency WebSocket endpoint |
| **Audio Format** | 16,000 Hz, 1-channel mono `pcm_s16le` | Raw 16kHz PCM audio frames |
| **Transport** | WebSocket streaming (`useWebsocket: true`) | Direct streaming to LiveKit agent audio publisher |
| **Environment Variable** | `RIME_API_KEY` | Authentication key for Rime Cloud API |

---

## Failure & Interruption Behavior

### 1. 3-Level LLM Fallback Cascade
When an LLM request fails specifically due to quota or rate limits (HTTP 429 / `RESOURCE_EXHAUSTED`):
1. **Primary Failure:** If `gemini-3.5-flash-lite` encounters a 429, DataForge automatically transitions to `gemini-3.1-flash-lite`.
2. **Secondary Failure:** If `gemini-3.1-flash-lite` also encounters a 429, DataForge falls back to Groq `openai/gpt-oss-20b`.
3. **Groq API Key Unset:** If `GROQ_API_KEY` is not configured, the system cleanly logs the fallback boundary and surfaces a structured error without crashing.

### 2. Barge-In Interruption Handling
When the user speaks while the assistant is responding (TTS speaking or tool running):
1. `tracker.invalidateCurrentGeneration('user_barge_in')` advances the generation counter from `Gen N` to `Gen N+1`.
2. Running operations in `Gen N` receive an abort signal via their dedicated `AbortController`.
3. Speech playback is immediately halted using `session.interrupt({ force: true })` and `currentSpeechHandle.interrupt(true)`.
4. Stale operations completing late are caught by `!tracker.isCurrent(op)` and discarded (`STALE_GENERATION`).
5. The replacement turn is processed under `Gen N+1`.

### 3. Rime TTS Error Handling
- Rime synthesis is monitored via `currentSpeechHandle.waitForPlayout()`.
- If network synthesis is interrupted or encounters an error, the error is safely caught and logged without destabilizing the session.

---

## Known Limitations

1. **Cloud Network Dependency:** Realtime STT, LLM, and TTS require outbound internet connectivity to Deepgram, Gemini/Groq, and Rime servers.
2. **Browser Autoplay Compliance:** Browsers require an initial user click (e.g. "Connect Voice") before WebRTC audio playout can begin.
3. **Deterministic Catalog Scope:** The shopping catalog is currently an in-memory dataset of 16 products designed for deterministic benchmarking.
4. **Provider Quotas:** Free-tier API keys may hit rate limits; the multi-tier fallback architecture mitigates provider-specific rate limits.

---

## License

ISC
