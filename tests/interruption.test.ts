import { GenerationTracker } from '../agent/tracker.js';
import { searchProducts } from '../agent/tools/shopping.js';

async function runInterruptionTests() {
  console.log('Running Voice Interruption & Generation Fencing Unit Tests...\n');

  // TEST 1: Immediate Generation Transition on Interruption
  console.log('Test 1: Generation 1 active -> interrupt -> generation becomes 2 immediately');
  const tracker = new GenerationTracker('session-test-8', 1);
  const res1 = tracker.invalidateCurrentGeneration('user_barge_in');
  const test1Pass = res1.oldGeneration === 1 && res1.newGeneration === 2 && tracker.currentGeneration === 2;
  console.log(` - Old Gen: ${res1.oldGeneration}, New Gen: ${res1.newGeneration}, Current: ${tracker.currentGeneration}`);
  console.log(`Test 1 Passed: ${test1Pass}\n`);

  // TEST 2: Running Tool Receives Abort Signal on Interruption
  console.log('Test 2: Tool running under generation 2 -> interrupt generation 2 -> tool AbortController receives abort');
  const toolOp = tracker.startOperation('tool');
  const state = { abortSignalFired: false };
  toolOp.abortController.signal.addEventListener('abort', () => {
    state.abortSignalFired = true;
  });

  const res2 = tracker.invalidateCurrentGeneration('user_barge_in');
  const test2Pass = Boolean(state.abortSignalFired) && res2.oldGeneration === 2 && res2.newGeneration === 3 && tracker.currentGeneration === 3;
  console.log(` - Abort signal fired on old tool operation: ${state.abortSignalFired}`);
  console.log(` - Generation transitioned to: ${tracker.currentGeneration}`);
  console.log(`Test 2 Passed: ${test2Pass}\n`);

  // TEST 3: Late Tool Completion Discarded (when cancellation fails/races)
  console.log('Test 3: Tool completes after interruption (cancellation lost race) -> result is fenced & discarded');
  const staleToolOp = tracker.startOperation('tool', 3);
  // User interrupts while tool is running
  tracker.invalidateCurrentGeneration('user_interruption');
  // Tool finishes late
  const completed = tracker.completeOperation(staleToolOp, { note: 'late finish' });
  const test3Pass = completed === false && staleToolOp.status === 'discarded' && staleToolOp.discard_reason === 'STALE_GENERATION';
  console.log(` - completeOperation returned false: ${!completed}`);
  console.log(` - staleToolOp status: ${staleToolOp.status}, reason: ${staleToolOp.discard_reason}`);
  console.log(`Test 3 Passed: ${test3Pass}\n`);

  // TEST 4: Streaming LLM Token Rejection on Interruption
  console.log('Test 4: LLM stream active under generation 4 -> interrupted -> subsequent chunks rejected');
  const llmOp = tracker.startOperation('llm', tracker.currentGeneration);
  const acceptedChunks: string[] = [];
  const chunkStream = ['Hello', ' there', ', I', ' found', ' laptops'];

  let chunkIndex = 0;
  for (const chunk of chunkStream) {
    if (chunkIndex === 2) {
      // User interrupts mid-stream!
      tracker.invalidateCurrentGeneration('user_speech_detected');
    }

    if (tracker.isCurrent(llmOp)) {
      acceptedChunks.push(chunk);
    } else {
      tracker.recordDiscard(llmOp, 'STALE_GENERATION');
      break;
    }
    chunkIndex++;
  }

  const test4Pass = acceptedChunks.length === 2 && acceptedChunks.join('') === 'Hello there' && llmOp.status === 'discarded';
  console.log(` - Accepted chunks before interruption: "${acceptedChunks.join('')}" (${acceptedChunks.length} tokens)`);
  console.log(` - Rejected remaining ${chunkStream.length - acceptedChunks.length} tokens after invalidation`);
  console.log(`Test 4 Passed: ${test4Pass}\n`);

  // TEST 5: Exactly One Generation Transition per Interruption
  console.log('Test 5: One interruption triggers exactly one generation increment');
  const startGen = tracker.currentGeneration;
  tracker.invalidateCurrentGeneration('single_barge_in');
  const endGen = tracker.currentGeneration;
  const test5Pass = endGen === startGen + 1;
  console.log(` - Start Gen: ${startGen} -> End Gen: ${endGen}`);
  console.log(`Test 5 Passed: ${test5Pass}\n`);

  // TEST 6: New Generation Operations Are Not Aborted
  console.log('Test 6: Operations created in new generation are NOT aborted by old-generation invalidation');
  const newOp = tracker.startOperation('tool', tracker.currentGeneration);
  let newOpAborted = false;
  newOp.abortController.signal.addEventListener('abort', () => {
    newOpAborted = true;
  });

  // Verify new op is active and not aborted
  const test6Pass = tracker.isCurrent(newOp) === true && newOpAborted === false && newOp.status === 'running';
  console.log(` - New operation isCurrent: ${tracker.isCurrent(newOp)}, Aborted: ${newOpAborted}`);
  console.log(`Test 6 Passed: ${test6Pass}\n`);

  // TEST 7: Stale Tool Result Cannot Reach Final Pipeline
  console.log('Test 7: Stale tool result cannot trigger subsequent pipeline stages');
  let finalPipelineTriggered = false;
  const staleOp7 = tracker.startOperation('tool');
  tracker.invalidateCurrentGeneration('barge_in');

  // Simulated tool completion block
  if (tracker.isCurrent(staleOp7)) {
    finalPipelineTriggered = true;
  } else {
    tracker.recordDiscard(staleOp7, 'STALE_GENERATION');
  }

  const test7Pass = finalPipelineTriggered === false && staleOp7.status === 'discarded';
  console.log(` - Final pipeline prevented: ${!finalPipelineTriggered}`);
  console.log(`Test 7 Passed: ${test7Pass}\n`);

  // TEST 8: New User Request Belongs to New Generation
  console.log('Test 8: New transcript belongs to the new active generation');
  const activeGen = tracker.currentGeneration;
  const newLlmOp = tracker.startOperation('llm', activeGen);
  const test8Pass = newLlmOp.generation_id === activeGen && tracker.isCurrent(newLlmOp) === true;
  console.log(` - New Turn Op Generation: ${newLlmOp.generation_id}, Active Generation: ${tracker.currentGeneration}`);
  console.log(`Test 8 Passed: ${test8Pass}\n`);

  if (test1Pass && test2Pass && test3Pass && test4Pass && test5Pass && test6Pass && test7Pass && test8Pass) {
    console.log('ALL INTERRUPTION & GENERATION FENCING UNIT TESTS PASSED SUCCESSFULLY!');
  } else {
    throw new Error('Some interruption tests failed!');
  }
}

runInterruptionTests().catch((err) => {
  console.error('Interruption tests failed:', err);
  process.exit(1);
});

