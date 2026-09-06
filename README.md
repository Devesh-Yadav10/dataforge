# Rime Hackathon Project: Voice Shopping Assistant with Generation Fencing

This project demonstrates correct realtime voice interruption and recovery using generation fencing.

## Core Problem

When a user interrupts a voice agent while it is speaking or while asynchronous work such as a tool is running, obsolete work must not produce stale output or corrupt the current conversation.

## Solution: Generation Fencing

Each conversational session has:
- `session_id`
- `generation_id`
- `operation_id`

When the user interrupts:
- Increment `generation_id`
- Invalidate previous-generation work
- Attempt cancellation of active work
- Allow the new generation to continue
- Reject any old-generation async result that arrives later

Cancellation is best-effort. Generation fencing is the correctness mechanism.

## Project Structure

- `src/`: TypeScript source code
- `client/`: Client-side code (if any)
- `tests/`: Test files
- `docs/`: Documentation

## Pipeline Architecture & Models

- **STT (Speech-to-Text):** Deepgram Nova-2 (`deepgram/nova-2`)
- **LLM:** Together AI streaming Llama 3.1 (`meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo`)
- **TTS (Spoken Output):** Rime TTS
  - **Model ID:** `rime/coda`
  - **Speaker / Voice:** `celeste`
  - **Language:** `en` (English)
  - **Audio Format:** 16,000 Hz, 1-channel `pcm_s16le` audio frames
  - **Transport:** WebSocket streaming via LiveKit inference pipeline directly into the LiveKit agent audio track
- **Voice Connection & Data:** LiveKit Agents (`@livekit/agents`) + LiveKit Web Client (`livekit-client`)

Rime TTS is the primary spoken voice output of the assistant. Streaming LLM delta tokens are fed incrementally into Rime TTS to ensure low-latency realtime speech playback.

## Server-Side Token Endpoint & Security

To ensure strict credential isolation:
- **No Client Secrets:** `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and external AI provider keys remain strictly server-side.
- **Short-Lived Tokens:** When the browser connects, it requests `GET /token` from the backend service. The server mints a single-use, 15-minute TTL LiveKit participant token with minimal permissions (`roomJoin`, `canPublish`, `canPublishData`, `canSubscribe`).
- **No Long-Lived Token Storage:** The client requires no `VITE_LIVEKIT_TOKEN` or `VITE_LIVEKIT_URL`.
- **Intended Use:** The token endpoint is built for local hackathon demonstration and does not provide production-grade authentication.

## Environment Variables

Server-side (`.env` — never committed to Git):
- `LIVEKIT_URL`: LiveKit server WebSocket URL
- `LIVEKIT_API_KEY`: LiveKit project API key
- `LIVEKIT_API_SECRET`: LiveKit project API secret
- `DEEPGRAM_API_KEY`: Deepgram API key for Nova-2 STT
- `TOGETHER_API_KEY`: Together AI API key for streaming LLM
- `RIME_API_KEY`: Rime API key for Coda TTS synthesis
- `PORT`: Optional server port for the token endpoint (defaults to `3000`)

Client-side:
- No client `.env` required. The browser fetches connection parameters dynamically from the backend `/token` service.

## Deterministic Shopping Tools & Latency Simulation

- **Tool:** `search_products` (`agent/tools/shopping.ts`)
- **Dataset:** 16 hardcoded deterministic products across headphones, laptops, and phones.
- **Filtering Parameters:** `query`, `category`, `brand`, `max_price`, `min_ram_gb`.
- **Artificial Delay:** Default ~4,000 ms delay with `AbortSignal` cancellation support to enable reproducible async race conditions for upcoming interruption and generation-fencing stages.
- **Function Calling:** Together AI tool-calling (`tools` / `tool_choice: 'auto'`) -> `searchProducts` execution -> streaming spoken response through Rime TTS.

## Generation & Operation Tracking Architecture

- **Session Tracking (`session_id`):** Stable session identifier generated per active AgentSession instance.
- **Generation Tracking (`generation_id`):** Monotonically increasing counter representing coherent user turns and active conversational generation.
- **Operation Tracking (`operation_id`):** Every async task (`stt`, `llm`, `tool`, `tts`) is assigned a unique operation ID capturing its start generation, timestamp, and dedicated `AbortController`.
- **Generation Fencing:** Centralized invariant `tracker.isCurrent(operation)` checks if an operation's captured generation matches `currentGeneration`. If false, async results are discarded with structured reason `STALE_GENERATION` and prevented from corrupting the conversation state or triggering audio output.

## Voice Interruption & Barge-In Handling

- **Barge-In Detection:** Listens on LiveKit's `AgentSessionEventTypes.UserStateChanged` (`newState === 'speaking'`).
- **Generation Invalidation Sequence:**
  1. Atomic `tracker.invalidateCurrentGeneration('user_barge_in')` advances the generation counter **first**, immediately obsoleting all active work.
  2. Abort requests (`op.abortController.abort()`) are dispatched to running operations belonging to the old generation.
  3. LiveKit agent speech and Rime audio playback are immediately interrupted via `session.interrupt({ force: true })` and `speechHandle.interrupt(true)`.
  4. Any in-flight tool, LLM chunk, or TTS stream belonging to the previous generation is fenced by `!tracker.isCurrent(op)` and safely discarded (`operation_discarded`).
  5. The incoming new user transcript is routed and processed under the new active generation.

## Unfenced Baseline Comparison

To demonstrate why generation fencing is necessary, an unfenced baseline is provided at [`agent/baseline/index.ts`](agent/baseline/index.ts):
- **Identical Setup:** Uses the exact same Deepgram Nova-2 STT, Together Llama 3.1 LLM, Rime Coda TTS, dataset, and shopping tools.
- **Key Difference:** The unfenced baseline has **no generation tracking or fencing** (`isCurrent`, `generation_id`).
- **The Failure Mode Exposed:** When a user interrupts an async tool operation ("Find me a laptop under $1000" -> interrupted with "under $800 with 16GB RAM"), cancellation alone may lose the race. In the unfenced baseline, the old completed tool result is erroneously accepted and fed into the LLM/TTS pipeline, speaking the stale answer over the active conversation. In the fenced implementation, the stale result is immediately discarded by generation fencing.

## Benchmark & Stress Testing Evidence (Stage 10)

A 100-trial automated stress suite ([`tests/stress.test.ts`](tests/stress.test.ts)) evaluates the interruption race condition comparing the Fenced implementation against the Unfenced Baseline:

| Metric | Fenced Implementation | Unfenced Baseline | Meaning / Impact |
| :--- | :--- | :--- | :--- |
| **Total Interrupted Operations** | 100 | 100 | Total interrupted operations tested |
| **Stale Results Accepted** | **0** | **50** | Zero stale output leaks with fencing |
| **Stale Result Leak Rate** | **0.0%** | **50.0%** | Cancellation alone leaks whenever tool completes |
| **Cancellation Success Rate** | 50.0% | 50.0% | Inherent cancellation race conditions |
| **Generation Fence Catches** | **50 / 50** | **0 (No Fence)** | Catches 100% of raced completions |
| **Fence Catch Rate** | **100.0%** | **0.0%** | Guarantees correctness when cancellation loses race |
| **Recovery Success Rate** | **100.0%** | **50.0%** | Clean recovery without stale speech |
| **Invalidation Latency (Median)** | **0ms (Atomic)** | 0ms | Immediate generation transition |
| **New Response Latency (Median)** | ~5ms | ~5ms | Fast turnaround for new turn |

*Raw data and detailed breakdowns are persisted in [`tests/results/stage10-results.json`](tests/results/stage10-results.json) and [`tests/results/stage10-summary.md`](tests/results/stage10-summary.md).*

## Demo-Ready Observability UI (Stage 11)

The React web client provides a realtime observability dashboard tailored for reviewing voice interruption and recovery:
- **Generation & Session Telemetry:** Live indicators for `session_id`, `generation_id`, and total barge-in counters.
- **Visual Turn History:** User and assistant speech bubbles tagged with their generation ownership (`Gen N`).
- **Operation Tracker:** Status cards for active and completed `llm`, `tool`, and `tts` tasks, highlighting discarded tasks in red (`🛡️ DISCARDED`).
- **Lifecycle Event Stream:** Chronological event feed (latest 50 events) displaying speech detection, generation invalidation, tool executions, and discard events.
- **Collapsible Stage 10 Benchmark Panel:** Summary table of the 100-trial deterministic interruption benchmark.
- **Interactive Voice Controls:** Connect/Disconnect buttons, live microphone toggle, and scenario test guides.

## Current Stage

Stage 11 Completed: Minimal, Demo-Ready UI with generation visibility, active operation tracking, live event log stream, and persisted benchmark evidence.

## Getting Started

1. Install dependencies: `npm install`
2. Build the project: `npm run build`
3. Run the agent: `npm start`
4. Run the client: `npm run dev --prefix client` (or `npx vite client`)

## License

ISC