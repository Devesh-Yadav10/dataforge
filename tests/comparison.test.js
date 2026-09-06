"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tracker_1 = require("../agent/tracker");
const shopping_1 = require("../agent/tools/shopping");
/**
 * Deterministic Comparison Harness:
 * Runs the exact same async race against Fenced vs Unfenced pipelines:
 *
 * 1. User: "Find me a laptop under $1000." (Tool begins with delay)
 * 2. User interrupts: "Actually, under $800 with 16GB RAM."
 * 3. Old tool completes late.
 */
async function runComparisonTests() {
    console.log('================================================================');
    console.log('STAGE 9: FENCED VS UNFENCED BASELINE COMPARISON TEST');
    console.log('================================================================\n');
    // -------------------------------------------------------------
    // PART 1: FENCED IMPLEMENTATION
    // -------------------------------------------------------------
    console.log('--- RUNNING FENCED IMPLEMENTATION ---');
    const fencedEvents = [];
    const tracker = new tracker_1.GenerationTracker('session-fenced', 1);
    // Turn 1 (Gen 1)
    const gen1 = tracker.currentGeneration;
    const toolOp1 = tracker.startOperation('tool', gen1);
    fencedEvents.push({
        timestamp: Date.now(),
        implementation: 'fenced',
        event_type: 'tool_started',
        generation_id: gen1,
        operation_id: toolOp1.operation_id,
        tool: 'search_products (laptops under $1000)',
        result_accepted: false,
    });
    // Start old tool with controlled delay (300ms)
    let oldToolFinished = false;
    const oldToolPromise = (async () => {
        try {
            const res = await (0, shopping_1.searchProducts)({ category: 'laptops', max_price: 1000, delayMs: 300 }, { signal: toolOp1.abortController.signal });
            oldToolFinished = true;
            // Fenced generation check:
            if (!tracker.isCurrent(toolOp1)) {
                tracker.recordDiscard(toolOp1, 'STALE_GENERATION');
                fencedEvents.push({
                    timestamp: Date.now(),
                    implementation: 'fenced',
                    event_type: 'tool_result_discarded',
                    generation_id: toolOp1.generation_id,
                    operation_id: toolOp1.operation_id,
                    result_accepted: false,
                    discard_reason: 'STALE_GENERATION',
                });
                return null;
            }
            tracker.completeOperation(toolOp1);
            fencedEvents.push({
                timestamp: Date.now(),
                implementation: 'fenced',
                event_type: 'tool_result_accepted',
                generation_id: toolOp1.generation_id,
                operation_id: toolOp1.operation_id,
                result_accepted: true,
            });
            return res;
        }
        catch (err) {
            if (err.message === 'Operation aborted' || toolOp1.abortController.signal.aborted) {
                tracker.recordCancellation(toolOp1);
                fencedEvents.push({
                    timestamp: Date.now(),
                    implementation: 'fenced',
                    event_type: 'tool_cancelled',
                    generation_id: toolOp1.generation_id,
                    operation_id: toolOp1.operation_id,
                    result_accepted: false,
                    discard_reason: 'ABORTED',
                });
            }
            return null;
        }
    })();
    // Simulate user barge-in after 100ms
    await new Promise((r) => setTimeout(r, 100));
    console.log('[Fenced] User barge-in detected! Invalidating generation 1...');
    const transition = tracker.invalidateCurrentGeneration('user_barge_in');
    fencedEvents.push({
        timestamp: Date.now(),
        implementation: 'fenced',
        event_type: 'interruption_detected',
        generation_id: transition.newGeneration,
        result_accepted: false,
    });
    // Turn 2 (Gen 2)
    const gen2 = tracker.currentGeneration;
    const toolOp2 = tracker.startOperation('tool', gen2);
    fencedEvents.push({
        timestamp: Date.now(),
        implementation: 'fenced',
        event_type: 'tool_started',
        generation_id: gen2,
        operation_id: toolOp2.operation_id,
        tool: 'search_products (laptops under $800, 16GB)',
        result_accepted: false,
    });
    const newToolRes = await (0, shopping_1.searchProducts)({ category: 'laptops', max_price: 800, min_ram_gb: 16, delayMs: 50 }, { signal: toolOp2.abortController.signal });
    if (tracker.isCurrent(toolOp2)) {
        tracker.completeOperation(toolOp2);
        fencedEvents.push({
            timestamp: Date.now(),
            implementation: 'fenced',
            event_type: 'tool_result_accepted',
            generation_id: toolOp2.generation_id,
            operation_id: toolOp2.operation_id,
            result_accepted: true,
        });
    }
    // Await old tool finish
    await oldToolPromise;
    console.log('Fenced Events:');
    fencedEvents.forEach((e) => console.log(`  - [${e.event_type}] Gen: ${e.generation_id ?? 'N/A'}, Op: ${e.operation_id ?? 'N/A'}, Accepted: ${e.result_accepted}, DiscardReason: ${e.discard_reason ?? 'none'}`));
    const fencedOldResultAccepted = fencedEvents.some((e) => e.operation_id === toolOp1.operation_id && e.event_type === 'tool_result_accepted');
    const fencedNewResultAccepted = fencedEvents.some((e) => e.operation_id === toolOp2.operation_id && e.event_type === 'tool_result_accepted');
    const fencedOldResultDiscarded = fencedEvents.some((e) => e.operation_id === toolOp1.operation_id && (e.event_type === 'tool_result_discarded' || e.event_type === 'tool_cancelled'));
    console.log(`Fenced Validation: Old Result Accepted = ${fencedOldResultAccepted}, New Result Accepted = ${fencedNewResultAccepted}, Old Result Discarded = ${fencedOldResultDiscarded}\n`);
    // -------------------------------------------------------------
    // PART 2: UNFENCED BASELINE IMPLEMENTATION
    // -------------------------------------------------------------
    console.log('--- RUNNING UNFENCED BASELINE IMPLEMENTATION ---');
    const unfencedEvents = [];
    // Turn 1 (No generation tracking)
    const baselineAbortController1 = new AbortController();
    unfencedEvents.push({
        timestamp: Date.now(),
        implementation: 'unfenced',
        event_type: 'tool_started',
        generation_id: null,
        operation_id: 'baseline-op-1',
        tool: 'search_products (laptops under $1000)',
        result_accepted: false,
    });
    // In baseline, even if abort is requested, suppose cancellation lost race or tool completes:
    const baselineOldToolPromise = (async () => {
        // Simulate non-fatal / raced delay
        await new Promise((r) => setTimeout(r, 300));
        const res = await (0, shopping_1.searchProducts)({ category: 'laptops', max_price: 1000, delayMs: 0 });
        // In UNFENCED baseline, there is NO isCurrent check!
        // Result is directly accepted and passed to LLM/TTS:
        unfencedEvents.push({
            timestamp: Date.now(),
            implementation: 'unfenced',
            event_type: 'tool_result_accepted',
            generation_id: null,
            operation_id: 'baseline-op-1',
            result_accepted: true,
        });
        return res;
    })();
    // User barge-in after 100ms
    await new Promise((r) => setTimeout(r, 100));
    console.log('[Unfenced Baseline] User barge-in detected! (Audio interrupted, but NO generation fencing)');
    unfencedEvents.push({
        timestamp: Date.now(),
        implementation: 'unfenced',
        event_type: 'interruption_detected',
        generation_id: null,
        result_accepted: false,
    });
    // Turn 2
    unfencedEvents.push({
        timestamp: Date.now(),
        implementation: 'unfenced',
        event_type: 'tool_started',
        generation_id: null,
        operation_id: 'baseline-op-2',
        tool: 'search_products (laptops under $800, 16GB)',
        result_accepted: false,
    });
    const baselineNewRes = await (0, shopping_1.searchProducts)({
        category: 'laptops',
        max_price: 800,
        min_ram_gb: 16,
        delayMs: 50,
    });
    unfencedEvents.push({
        timestamp: Date.now(),
        implementation: 'unfenced',
        event_type: 'tool_result_accepted',
        generation_id: null,
        operation_id: 'baseline-op-2',
        result_accepted: true,
    });
    // Await old tool finish in baseline
    await baselineOldToolPromise;
    console.log('Unfenced Baseline Events:');
    unfencedEvents.forEach((e) => console.log(`  - [${e.event_type}] Gen: ${e.generation_id ?? 'N/A'}, Op: ${e.operation_id ?? 'N/A'}, Accepted: ${e.result_accepted}`));
    const unfencedOldResultAccepted = unfencedEvents.some((e) => e.operation_id === 'baseline-op-1' && e.event_type === 'tool_result_accepted');
    const unfencedNewResultAccepted = unfencedEvents.some((e) => e.operation_id === 'baseline-op-2' && e.event_type === 'tool_result_accepted');
    console.log(`Unfenced Validation: Old Result Accepted = ${unfencedOldResultAccepted} (BUG DEMONSTRATED), New Result Accepted = ${unfencedNewResultAccepted}\n`);
    // -------------------------------------------------------------
    // ASSERTIONS & VERIFICATION
    // -------------------------------------------------------------
    const passFenced = !fencedOldResultAccepted && fencedNewResultAccepted && fencedOldResultDiscarded;
    const passUnfenced = unfencedOldResultAccepted && unfencedNewResultAccepted;
    if (passFenced && passUnfenced) {
        console.log('================================================================');
        console.log('COMPARISON TEST PASSED SUCCESSFULLY!');
        console.log(' - Fenced Implementation successfully rejected stale old result.');
        console.log(' - Unfenced Baseline demonstrated the async race bug (stale result accepted).');
        console.log('================================================================');
    }
    else {
        throw new Error('Comparison test failed assertions!');
    }
}
runComparisonTests().catch((err) => {
    console.error('Comparison tests failed:', err);
    process.exit(1);
});
