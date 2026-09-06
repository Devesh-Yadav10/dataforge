"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tracker_1 = require("../agent/tracker");
const shopping_1 = require("../agent/tools/shopping");
async function runTrackerTests() {
    console.log('Running GenerationTracker Unit Tests...\n');
    const tracker = new tracker_1.GenerationTracker('test-session-123', 1);
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
    const test5Pass = op1.session_id === 'test-session-123' &&
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
    const searchPromise = (0, shopping_1.searchProducts)({ category: 'laptops', delayMs: 2000 }, { signal: toolOp.abortController.signal });
    setTimeout(() => {
        toolOp.abortController.abort();
    }, 100);
    try {
        await searchPromise;
    }
    catch (err) {
        if (err.message === 'Operation aborted') {
            abortedCaught = true;
        }
    }
    const test6Pass = abortedCaught === true;
    console.log(` - AbortSignal properly aborted searchProducts: ${abortedCaught}`);
    console.log(`Test 6 Passed: ${test6Pass}\n`);
    // TEST 7: Stale Discard Recording
    console.log('Test 7: Complete operation verifies isCurrent and records discard if stale');
    let discardEventRecorded = false;
    tracker.addEventListener((ev) => {
        if (ev.event_type === 'operation_discarded' && ev.operation_id === op1.operation_id) {
            discardEventRecorded = true;
        }
    });
    const completed = tracker.completeOperation(op1, { note: 'late completion test' });
    const test7Pass = completed === false && discardEventRecorded === true && op1.status === 'discarded';
    console.log(` - completeOperation returned false for stale op: ${!completed}`);
    console.log(` - discard event emitted with reason STALE_GENERATION: ${discardEventRecorded}`);
    console.log(`Test 7 Passed: ${test7Pass}\n`);
    if (test1Pass && test2Pass && test3Pass && test4Pass && test5Pass && test6Pass && test7Pass) {
        console.log('ALL GENERATION & TRACKING UNIT TESTS PASSED SUCCESSFULLY!');
    }
    else {
        throw new Error('Some tracker tests failed!');
    }
}
runTrackerTests().catch((err) => {
    console.error('Tracker tests failed:', err);
    process.exit(1);
});
