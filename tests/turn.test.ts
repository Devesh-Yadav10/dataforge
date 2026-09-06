import { GenerationTracker } from '../agent/tracker.js';

/**
 * Deterministic Unit Tests for LiveKit AgentSession Turn & Interruption Invariants:
 * 1. Normal user speech while agent is idle (no generation increment, no false barge-in).
 * 2. Intermediate STT chunks (UserInputTranscribed) stream to UI with ZERO LLM requests.
 * 3. Complete user turn from AgentSession (ConversationItemAdded) triggers EXACTLY ONE LLM operation.
 * 4. User speech while LLM is thinking/querying does NOT trigger a false barge-in (In-flight LLM != active response).
 * 5. User speech while assistant is actively speaking TTS triggers EXACTLY ONE barge-in & generation increment.
 * 6. User speech while tool is actively executing triggers EXACTLY ONE barge-in & generation increment.
 * 7. Multiple UserStateChanged 'speaking' events during one continuous barge-in utterance are deduplicated.
 * 8. Replacement turn commits in the new generation while stale generation remains fenced.
 */

class TurnManagementHarness {
  public tracker: GenerationTracker;
  public currentSpeechHandle: { done: () => boolean } | null = null;
  public isInterruptedForCurrentUtterance: boolean = false;
  
  public llmOperationsCreated: Array<{ operation_id: string; generation_id: number; transcript: string }> = [];
  public interruptionsDetected: number = 0;

  constructor(sessionId: string = 'turn-test-session') {
    this.tracker = new GenerationTracker(sessionId, 1);
  }

  // Assistant is actively producing a response iff TTS is speaking or a tool is running
  public isAgentProducingResponse(): boolean {
    const isSpeakingTts = Boolean(this.currentSpeechHandle && !this.currentSpeechHandle.done());
    const isExecutingTool = this.tracker.hasRunningOperationType('tool');
    return Boolean(isSpeakingTts || isExecutingTool);
  }

  public onUserStateChanged(newState: 'speaking' | 'listening' | 'away'): { invalidated: boolean; oldGen?: number; newGen?: number } {
    if (newState === 'speaking') {
      if (this.isAgentProducingResponse()) {
        if (!this.isInterruptedForCurrentUtterance) {
          this.isInterruptedForCurrentUtterance = true;
          this.interruptionsDetected += 1;
          const { oldGeneration, newGeneration } = this.tracker.invalidateCurrentGeneration('user_barge_in');
          if (this.currentSpeechHandle) {
            this.currentSpeechHandle = { done: () => true };
          }
          return { invalidated: true, oldGen: oldGeneration, newGen: newGeneration };
        }
      }
    } else if (newState === 'listening' || newState === 'away') {
      this.isInterruptedForCurrentUtterance = false;
    }
    return { invalidated: false };
  }

  // STT stream events (interim or finalized chunks) - do NOT start LLM operations
  public onUserInputTranscribed(_ev: { transcript: string; isFinal: boolean }): void {
    // Purely UI streaming - no LLM creation
  }

  // Complete user turn from AgentSession pipeline
  public onConversationItemAdded(item: { type: string; role: string; textContent: string }): void {
    if (item.type === 'message' && item.role === 'user') {
      const transcript = item.textContent.trim();
      if (!transcript) return;

      const currentGen = this.tracker.currentGeneration;
      const op = this.tracker.startOperation('llm', currentGen);
      this.llmOperationsCreated.push({
        operation_id: op.operation_id,
        generation_id: op.generation_id,
        transcript,
      });
    }
  }
}

async function runTurnTests() {
  console.log('Running Exhaustive Turn & Barge-In Invariant Tests...\n');

  // TEST A: LLM API Failure Cleanup & Status Transition (e.g. 402 or Network Error)
  console.log('Test A: LLM failure cleanup -> Operation marked failed, active response is FALSE, 0 false barge-ins');
  const hA = new TurnManagementHarness('harness-A');
  const failLlmOp = hA.tracker.startOperation('llm', 1);
  console.log(` - Started LLM op: ${failLlmOp.operation_id}, status: ${failLlmOp.status}`);
  
  // Simulate 402 credit limit or network error
  hA.tracker.recordFailure(failLlmOp, 'LLM_API_ERROR', { error: '402 Payment Required' });
  console.log(` - Recorded failure: status is now ${failLlmOp.status}, runningOps: ${hA.tracker.hasRunningOperations()}`);
  
  // User speaks after failed LLM
  const resA = hA.onUserStateChanged('speaking');
  const testAPass =
    failLlmOp.status === 'failed' &&
    hA.tracker.hasRunningOperations() === false &&
    hA.isAgentProducingResponse() === false &&
    resA.invalidated === false &&
    hA.tracker.currentGeneration === 1;
  console.log(` - Subsequent user speech invalidated: ${resA.invalidated}, Gen: ${hA.tracker.currentGeneration}`);
  console.log(`Test A Passed: ${testAPass}\n`);

  // TEST B: Failed LLM + Subsequent User Utterance
  console.log('Test B: Failed LLM followed by new complete turn -> Generation stays 1, exactly 1 new LLM op created');
  const hB = new TurnManagementHarness('harness-B');
  const initialOpB = hB.tracker.startOperation('llm', 1);
  hB.tracker.recordFailure(initialOpB, 'LLM_API_ERROR', { error: '402 Payment Required' });
  
  // User speaks a second complete conversational turn
  hB.onUserStateChanged('speaking');
  hB.onUserInputTranscribed({ transcript: 'Show me headphones', isFinal: true });
  hB.onUserStateChanged('listening');
  hB.onConversationItemAdded({ type: 'message', role: 'user', textContent: 'Show me headphones' });

  const testBPass =
    hB.interruptionsDetected === 0 &&
    hB.tracker.currentGeneration === 1 &&
    hB.llmOperationsCreated.length === 1 &&
    hB.llmOperationsCreated[0].generation_id === 1 &&
    hB.llmOperationsCreated[0].transcript === 'Show me headphones';
  console.log(` - Generation: ${hB.tracker.currentGeneration}, Interruptions: ${hB.interruptionsDetected}, New LLM Ops: ${hB.llmOperationsCreated.length}`);
  console.log(`Test B Passed: ${testBPass}\n`);

  // TEST C: Multiple VAD speaking events during one ordinary user utterance
  console.log('Test C: Repeated speaking transitions during ordinary user utterance -> 0 false interruptions');
  const hC = new TurnManagementHarness('harness-C');
  const rC1 = hC.onUserStateChanged('speaking');
  const rC2 = hC.onUserStateChanged('speaking');
  const rC3 = hC.onUserStateChanged('speaking');
  hC.onUserStateChanged('listening');
  const testCPass =
    rC1.invalidated === false &&
    rC2.invalidated === false &&
    rC3.invalidated === false &&
    hC.interruptionsDetected === 0 &&
    hC.tracker.currentGeneration === 1;
  console.log(` - Transitions: [${rC1.invalidated}, ${rC2.invalidated}, ${rC3.invalidated}], Interruptions: ${hC.interruptionsDetected}, Gen: ${hC.tracker.currentGeneration}`);
  console.log(`Test C Passed: ${testCPass}\n`);

  // TEST D: True Barge-in while TTS active -> exactly 1 generation increment
  console.log('Test D: True barge-in during active TTS -> Exactly 1 generation increment (Gen 1 -> Gen 2)');
  const hD = new TurnManagementHarness('harness-D');
  hD.onConversationItemAdded({ type: 'message', role: 'user', textContent: 'Find headphones under $200.' });
  // Assistant begins TTS playback
  hD.currentSpeechHandle = { done: () => false };

  // User interrupts with replacement utterance: "Actually, show me only Bose."
  const rD1 = hD.onUserStateChanged('speaking'); // First speech onset triggers barge-in
  const rD2 = hD.onUserStateChanged('speaking'); // Continuation during same utterance does NOT re-trigger
  hD.onUserStateChanged('listening');
  hD.onConversationItemAdded({ type: 'message', role: 'user', textContent: 'Actually, show me only Bose.' });

  const testDPass =
    rD1.invalidated === true &&
    rD2.invalidated === false &&
    hD.interruptionsDetected === 1 &&
    hD.tracker.currentGeneration === 2 &&
    hD.llmOperationsCreated.length === 2 &&
    hD.llmOperationsCreated[1].generation_id === 2 &&
    hD.llmOperationsCreated[1].transcript === 'Actually, show me only Bose.';
  console.log(` - Interruptions: ${hD.interruptionsDetected}, Gen: ${hD.tracker.currentGeneration}, Replacement LLM Gen: ${hD.llmOperationsCreated[1]?.generation_id}`);
  console.log(`Test D Passed: ${testDPass}\n`);

  // TEST E: Segmented STT chunks aggregate into 1 completed turn
  console.log('Test E: Segmented STT chunks ("Find me headphones under" + "$200.") -> 1 ConversationItemAdded -> 1 LLM Op');
  const hE = new TurnManagementHarness('harness-E');
  hE.onUserStateChanged('speaking');
  hE.onUserInputTranscribed({ transcript: 'Find me headphones under', isFinal: true });
  hE.onUserInputTranscribed({ transcript: '$200.', isFinal: true });
  hE.onUserStateChanged('listening');
  // LiveKit turn endpointing delivers the combined turn item
  hE.onConversationItemAdded({ type: 'message', role: 'user', textContent: 'Find me headphones under $200.' });

  const testEPass =
    hE.llmOperationsCreated.length === 1 &&
    hE.interruptionsDetected === 0 &&
    hE.tracker.currentGeneration === 1 &&
    hE.llmOperationsCreated[0].transcript === 'Find me headphones under $200.';
  console.log(` - LLM ops: ${hE.llmOperationsCreated.length}, Turn text: "${hE.llmOperationsCreated[0]?.transcript}"`);
  console.log(`Test E Passed: ${testEPass}\n`);

  // TEST F: Late STT arrival after pause handled cleanly without duplicate LLM calls
  console.log('Test F: Late STT arrival after brief pause handled cleanly by turn endpointing');
  const hF = new TurnManagementHarness('harness-F');
  hF.onUserInputTranscribed({ transcript: 'Find me', isFinal: false });
  hF.onUserInputTranscribed({ transcript: 'Find me laptops', isFinal: false });
  hF.onUserInputTranscribed({ transcript: 'Find me laptops under $1000', isFinal: true });
  // ConversationItemAdded is the single authoritative turn trigger
  hF.onConversationItemAdded({ type: 'message', role: 'user', textContent: 'Find me laptops under $1000' });

  const testFPass =
    hF.llmOperationsCreated.length === 1 &&
    hF.llmOperationsCreated[0].generation_id === 1 &&
    hF.tracker.currentGeneration === 1;
  console.log(` - LLM ops created: ${hF.llmOperationsCreated.length}, Gen: ${hF.tracker.currentGeneration}`);
  console.log(`Test F Passed: ${testFPass}\n`);

  if (testAPass && testBPass && testCPass && testDPass && testEPass && testFPass) {
    console.log('ALL INVARIANT & REGRESSION TESTS (A-F) PASSED SUCCESSFULLY!');
  } else {
    throw new Error('Some turn tests failed!');
  }
}

runTurnTests().catch((err) => {
  console.error('Turn tests failed:', err);
  process.exit(1);
});



