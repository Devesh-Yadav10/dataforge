# Rime Hackathon: Live Demo Script

**Project:** Voice Shopping Assistant with Generation Fencing  
**Problem Focus:** Realtime Interruption + Asynchronous Recovery  
**Primary Voice Pipeline:** Deepgram Nova-2 (STT) ➔ Together Llama 3.1 8B (LLM) ➔ Deterministic Tool (Catalog) ➔ Rime Coda TTS (Celeste) ➔ LiveKit WebRTC

---

## 1. Problem Statement (Opening Hook)
> *"In voice AI, interruption isn't just about cutting off audio—it's an asynchronous concurrency challenge. When a user interrupts while a slow background tool or LLM is executing, an old result arriving seconds later will corrupt the active conversation unless protected by **Generation Fencing**."*

---

## 2. Architecture Overview
- **Session:** Unique ID for the conversation session (`session_id`).
- **Generation:** Monotonically increasing turn generation counter (`generation_id`).
- **Operations:** Every async task (`llm`, `tool`, `tts`) captures an immutable generation number at launch.
- **Invariant:** Stale operations (`op.generation_id !== currentGeneration`) are discarded at async boundaries, preventing obsolete responses from reaching the user or triggering Rime TTS.

---

## 3. Starting the Application
1. **Server (Fenced Agent):**
   ```bash
   npm start
   ```
2. **Client (Observability Dashboard):**
   ```bash
   npm run dev:client
   ```
3. Open browser at `http://localhost:5173` and click **"Connect to Assistant"**.

---

## 4. Scenario A: Speech Barge-In Interruption
*Demonstrates speech interruption and immediate generation progression.*

1. **Speak Initial Query:**
   > *"Find me headphones under 200 dollars."*
2. **Observe:**
   - Generation counter displays `Gen 1`.
   - Rime Coda begins speaking recommendations (*Bose QC45, Sony XM4*).
3. **Interrupt While Agent is Speaking:**
   > *"Actually, show me only Bose."*
4. **Observe:**
   - Active generation immediately increments to `Gen 2`.
   - Rime speech is cleanly interrupted.
   - Agent synthesizes and speaks only the Bose headphones (*Bose QC45, Bose 700*).

---

## 5. Scenario B: Asynchronous Tool Race Interruption
*Demonstrates the core engineering problem: an async tool with ~4s delay is interrupted mid-flight.*

1. **Speak Initial Query:**
   > *"Find me a laptop under 1000 dollars."*
2. **Observe:**
   - Agent displays `⏳ Running: search_products (4s latency simulated) [op-X, Gen 1]`.
3. **Interrupt During the 4-Second Tool Delay (at ~2 seconds):**
   > *"Actually, under 800 dollars with 16GB of RAM."*
4. **Observe in Dashboard:**
   - **Generation Transition:** Immediately shifts from `Gen 1` ➔ `Gen 2`.
   - **Cancellation Attempted:** `op-X` receives an abort signal.
   - **Late Tool Completion:** If `op-X` finishes late, the generation fence intercepts it:
     ```
     🛡️ DISCARDED: tool [op-X] from stale Gen 1 discarded! (Reason: STALE_GENERATION)
     ```
   - **Correct Spoken Output:** Only the `Gen 2` laptops (*Acer Swift Go 14, Lenovo ThinkPad E14*) are spoken by Rime TTS.

---

## 6. Stage 10 Benchmark Evidence Walkthrough
*Open the collapsible benchmark panel on the dashboard:*

| Benchmark Metric | Fenced Implementation | Unfenced Baseline | Engineering Takeaway |
| :--- | :--- | :--- | :--- |
| **Total Stale Operations** | 100 | 100 | 100-trial deterministic race |
| **Stale Results Accepted** | **0 / 100** | **50 / 100** | Fencing guarantees 0% leak |
| **Stale Result Leak Rate** | **0.0%** | **50.0%** | Cancellation alone fails when tool completes |
| **Generation Fence Catches** | **50 / 50 (100%)** | **0 (No Fence)** | Catches 100% of cancellation-raced tools |
| **Recovery Success Rate** | **100.0%** | **50.0%** | Clean recovery without stale speech |
| **Invalidation Latency** | **0ms (Atomic)** | 0ms | Instantaneous state transition |

---

## 7. Key Engineering Takeaway (Closing)
> *"Cancellation is best-effort optimization. Generation fencing is the correctness guarantee. By coupling LiveKit speech interruption with atomic generation fencing, our voice assistant guarantees zero stale output leaks under arbitrary async races."*

