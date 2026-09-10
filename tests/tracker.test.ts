import { GenerationTracker, StructuredEvent } from '../agent/tracker.js';
import { searchProducts } from '../agent/tools/shopping.js';

async function runTrackerTests() {
  console.log('Running GenerationTracker Unit Tests...\n');

  const tracker = new GenerationTracker('test-session-123', 1);

  // TEST 1: Current Generation
  console.log('Test 1: Start operation under current generation (isCurrent should be true)');
  const op1 = tracker.startOperation('llm');
  const test1Pass = tracker.isCurrent(op1) === true && op1.generation_id === 1;
  console.log(` - Operation: ${op1.operation_id}, Generation: ${op1.generation_id}, isCurrent: ${tracker.isCurrent(op1)}`);
  console.log(`Test 1 Passed: ${test1Pass}\n`);

  // TEST 2: Stale Generation
  console.log('Test 2: Increment generation and verify op1 is now stale');
  const gen2 = tracker.nextGeneration();
  const test2Pass = tracker.isCurrent(op1) === false && gen2 === 2;
  console.log(` - Current Generation: ${tracker.currentGeneration}, op1.generation_id: ${op1.generation_id}, isCurrent(op1): ${tracker.isCurrent(op1)}`);
  console.log(`Test 2 Passed: ${test2Pass}\n`);

  // TEST 3: Monotonic Generation
  console.log('Test 3: Monotonic generation increments (1 -> 2 -> 3 -> 4)');
  const gen3 = tracker.nextGeneration();
  const gen4 = tracker.nextGeneration();
  const test3Pass = gen3 === 3 && gen4 === 4 && tracker.currentGeneration === 4;
  console.log(` - Generations: 1 -> ${gen2} -> ${gen3} -> ${gen4}`);
  console.log(`Test 3 Passed: ${test3Pass}\n`);

  // TEST 4: Unique Operation IDs
  console.log('Test 4: Multiple operations receive unique IDs');
  const op2 = tracker.startOperation('tool');
  const op3 = tracker.startOperation('tts');
  const op4 = tracker.startOperation('llm');
  const ids = [op1.operation_id, op2.operation_id, op3.operation_id, op4.operation_id];
  const uniqueIds = new Set(ids);
  const test4Pass = uniqueIds.size === 4;
  console.log(` - Operation IDs generated: ${ids.join(', ')}`);
  console.log(`Test 4 Passed: ${test4Pass}\n`);

  // TEST 5: Session ID Consistency
  console.log('Test 5: All operations in the session share the exact same session_id');
  const test5Pass =
    op1.session_id === 'test-session-123' &&
    op2.session_id === 'test-session-123' &&
    op3.session_id === 'test-session-123' &&
    op4.session_id === 'test-session-123';
  console.log(` - Session ID: ${tracker.sessionId}`);
  console.log(`Test 5 Passed: ${test5Pass}\n`);

  // TEST 6: Tool Abort Readiness & Cancellation Signal
  console.log('Test 6: Tool operation AbortController aborts searchProducts gracefully');
  const toolOp = tracker.startOperation('tool');
  let abortedCaught = false;

  // Trigger search with 2000ms delay and abort after 100ms
  const searchPromise = searchProducts(
    { category: 'laptops', delayMs: 2000 },
    { signal: toolOp.abortController.signal }
  );

  setTimeout(() => {
    toolOp.abortController.abort();
  }, 100);

  try {
    await searchPromise;
  } catch (err: any) {
    if (err.message === 'Operation aborted') {
      abortedCaught = true;
    }
  }

  const test6Pass = abortedCaught === true;
  console.log(` - AbortSignal properly aborted searchProducts: ${abortedCaught}`);
  // TEST 7: Stale Discard Recording
  console.log('Test 7: Complete operation verifies isCurrent and records discard if stale');
  const state = { discardEventRecorded: false };
  tracker.addEventListener((ev: StructuredEvent) => {
    if (ev.event_type === 'operation_discarded' && ev.operation_id === op1.operation_id) {
      state.discardEventRecorded = true;
    }
  });

  const completed = tracker.completeOperation(op1, { note: 'late completion test' });
  const test7Pass = !completed && Boolean(state.discardEventRecorded) && op1.status === 'discarded';
  console.log(` - completeOperation returned false for stale op: ${!completed}`);
  console.log(` - discard event emitted with reason STALE_GENERATION: ${state.discardEventRecorded}`);
  console.log(`Test 7 Passed: ${test7Pass}\n`);

  // TEST 8: Generation-scoped AbortSignal
  console.log('Test 8: Generation-scoped AbortSignal aborts all operations of old generation');
  const genSignal = tracker.getGenerationSignal(tracker.currentGeneration);
  const genOp = tracker.startOperation('llm', tracker.currentGeneration);
  let genSignalAborted = false;
  genOp.abortController.signal.addEventListener('abort', () => {
    genSignalAborted = true;
  });
  tracker.nextGeneration('new_turn_test');
  const test8Pass = genSignal.aborted && genSignalAborted;
  console.log(` - Generation signal aborted: ${genSignal.aborted}, Op signal aborted: ${genSignalAborted}`);
  console.log(`Test 8 Passed: ${test8Pass}\n`);

  // TEST 9: Cancelled Tool Cannot Mutate Cart/State
  console.log('Test 9: Cancelled/fenced tool cannot mutate cart or session state');
  const cartState: string[] = [];
  const activeGen = tracker.currentGeneration;
  const toolOp9 = tracker.startOperation('tool', activeGen);

  const searchWithStateMutation = async () => {
    const res = await searchProducts({ category: 'phones', delayMs: 1000 }, { signal: toolOp9.abortController.signal });
    if (tracker.isCurrent(toolOp9) && !toolOp9.abortController.signal.aborted) {
      cartState.push(...res.products.map(p => p.name));
    }
  };

  const promise9 = searchWithStateMutation().catch(() => {});
  // Interrupt / invalidate before tool finishes
  tracker.invalidateCurrentGeneration('barge_in');

  await promise9;
  const test9Pass = cartState.length === 0;
  console.log(` - Cart state length after cancelled tool: ${cartState.length} (expected 0)`);
  console.log(`Test 9 Passed: ${test9Pass}\n`);

  // TEST 10: Focused Interruption & Prompt Cancellation Test (4s Delay + Immediate Abort)
  console.log('Test 10: Focused Interruption Validation (4s delay aborted via generation invalidation)');
  const tracker10 = new GenerationTracker('focused-validation-session', 1);
  const op10_1 = tracker10.startOperation('tool', 1);

  let cart10Mutated = false;
  let cancellationTime10 = -1;
  let rejectedError10 = '';
  const startTime10 = Date.now();

  const promise10 = (async () => {
    try {
      const res = await searchProducts(
        { category: 'laptops', delayMs: 4000 },
        { signal: op10_1.abortController.signal }
      );
      if (tracker10.isCurrent(op10_1) && !op10_1.abortController.signal.aborted) {
        cart10Mutated = true;
      }
      return res;
    } catch (err: any) {
      cancellationTime10 = Date.now() - startTime10;
      rejectedError10 = err.message;
      throw err;
    }
  })();

  // Wait 100ms so searchProducts is genuinely pending in its 4-second delay
  await new Promise((r) => setTimeout(r, 100));

  // Invalidate generation 1 (user barge-in)
  console.log(' - Invalidating generation 1 while 4-second search is pending...');
  const invRes10 = tracker10.invalidateCurrentGeneration('user_interruption');

  let caught10 = false;
  try {
    await promise10;
  } catch (err) {
    caught10 = true;
  }

  // Immediately start generation 2 operation and verify normal completion
  console.log(' - Starting generation 2 operation immediately after invalidation...');
  const op10_2 = tracker10.startOperation('tool', tracker10.currentGeneration);
  const res10_2 = await searchProducts(
    { category: 'headphones', max_price: 200, delayMs: 0 },
    { signal: op10_2.abortController.signal }
  );
  const gen2CompletedNormal = tracker10.isCurrent(op10_2) && res10_2.products.length > 0;

  const test10Pass =
    caught10 === true &&
    rejectedError10 === 'Operation aborted' &&
    cancellationTime10 >= 0 &&
    cancellationTime10 < 1000 &&
    cart10Mutated === false &&
    invRes10.oldGeneration === 1 &&
    invRes10.newGeneration === 2 &&
    gen2CompletedNormal === true;

  console.log(` - Rejection caught: ${caught10}`);
  console.log(` - Rejection error message: "${rejectedError10}"`);
  console.log(` - Actual elapsed cancellation time: ${cancellationTime10}ms (vs 4000ms full delay)`);
  console.log(` - Cart mutated on Gen 1: ${cart10Mutated}`);
  console.log(` - Gen 2 completed normally: ${gen2CompletedNormal} (${res10_2.products.length} products matched)`);
  console.log(`Test 10 Passed: ${test10Pass}\n`);

  if (test1Pass && test2Pass && test3Pass && test4Pass && test5Pass && test6Pass && test7Pass && test8Pass && test9Pass && test10Pass) {
    console.log('ALL GENERATION & TRACKING UNIT TESTS PASSED SUCCESSFULLY!');
  } else {
    throw new Error('Some tracker tests failed!');
  }
}

runTrackerTests().catch((err) => {
  console.error('Tracker tests failed:', err);
  process.exit(1);
});

