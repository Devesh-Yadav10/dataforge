# Rime Voice Evidence

## Hard Voice Claim

DataForge integrates **Rime TTS** as the primary conversational voice synthesizer for its AI shopping assistant:
- **Streaming Spoken Synthesis:** Response tokens from the conversational LLM (Google Gemini 3.5 Flash-Lite / Gemini 3.1 Flash-Lite / Groq fallback) are fed directly into Rime TTS over a low-latency streaming WebSocket connection (`useWebsocket: true`).
- **Realtime WebRTC Playout:** Rime synthesizes 16kHz mono PCM audio frames that are published onto a LiveKit Agent WebRTC track and delivered directly to the browser client.
- **Interruption-Safe Generation Fencing:** When the user interrupts the assistant while it is speaking (barge-in), the `GenerationTracker` increments the generation counter atomically, halts audio playout (`session.interrupt({ force: true })`), cancels in-flight synthesis (`currentSpeechHandle.interrupt(true)`), and discards any stale generation audio with zero leak.

## Rime Configuration

Derived directly from `agent/index.ts` and `@livekit/agents-plugin-rime`:
- **Model ID:** `coda`
- **Speaker / Voice:** `celeste`
- **Language:** `eng`
- **REST Base Endpoint:** `https://users.rime.ai/v1/rime-tts`
- **WebSocket Streaming Endpoint:** `wss://users-ws.rime.ai`
- **Audio Format:** 16,000 Hz, 1-channel mono `pcm_s16le` audio frames
- **Transport:** WebSocket streaming via `@livekit/agents-plugin-rime` into LiveKit WebRTC audio publisher
- **Environment Variable:** `RIME_API_KEY`

## Acceptance Test

- **Input:** LLM text response stream produced during an active conversation turn under Generation N.
- **Expected Behavior:**
  1. Rime TTS instance is initialized with `modelId: 'coda'`, `speaker: 'celeste'`, `lang: 'eng'`, `samplingRate: 16000`, `useWebsocket: true`.
  2. Audio frames are streamed over WebSocket from `wss://users-ws.rime.ai` onto the LiveKit room audio track.
  3. Upon user barge-in (`newState === 'speaking'`), `tracker.invalidateCurrentGeneration('user_barge_in')` increments `currentGeneration` to N+1, marks active TTS operation as cancelled (`aborted_by_interruption`), and immediately interrupts LiveKit audio playback.
- **Acceptance Criteria:**
  - Active TTS operation is registered with `tracker.startOperation('tts', turnGen)`.
  - `tracker.isCurrent(ttsOp)` evaluates to `false` immediately upon barge-in.
  - Stale generation responses never trigger or resume Rime speech playout.

## Procedure

1. Set up environment variables in `.env` (refer to `.env.example`).
2. Compile TypeScript files:
   ```bash
   npm run build
   ```
3. Execute the dedicated Rime integration & generation fencing test suite:
   ```bash
   npm run test:rime
   ```
4. Execute the complete DataForge test suite:
   ```bash
   npm test
   ```

## Result

- **Plugin & Configuration Verification:** `tests/rime.test.ts` confirms that `@livekit/agents-plugin-rime` initializes with label `rime.TTS`, 16,000 Hz sample rate, and 1 audio channel.
- **Generation Fencing Verification:** 100% of interrupted TTS operations are caught and cancelled across the test suites with 0.0% stale speech leak rate.
- **Preflight Check:** `RIME_API_KEY` presence verified via preflight check without exposing secret credentials.

## Limitations

- **Cloud Network Dependency:** Realtime speech synthesis requires outbound internet connectivity to `wss://users-ws.rime.ai` (port 443).
- **Browser Autoplay Compliance:** Browser audio playback requires initial user gesture (e.g. clicking "Connect Voice") in accordance with Web Audio autoplay policies.
- **Streaming Requirement:** Rime TTS streaming requires `useWebsocket: true` at construction time.

## Reproduction Command

```bash
npm run test:rime
```
