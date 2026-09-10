# Stage 10 Automated Stress Test & Benchmark Results

**Execution Timestamp:** 2026-09-10T06:54:06.360Z  
**Total Trials per Implementation:** 100

---

## 1. Summary Comparison

| Metric | Fenced Implementation | Unfenced Baseline | Analysis |
| :--- | :--- | :--- | :--- |
| **Total Stale Operations** | 100 | 100 | Total interrupted operations tested |
| **Stale Results Accepted** | **0** | **50** | 0 leaks in Fenced vs 50 in Unfenced |
| **Stale Result Leak Rate** | **0.0%** | **50.0%** | Fencing guarantees 0% leak |
| **Cancellation Success Rate** | 50.0% | 50.0% | Inherent cancellation race budget |
| **Generation Fence Catches** | **50 / 50** | **0 (No Fence)** | Catches when cancellation lost race |
| **Fence Catch Rate** | **100.0%** | **0.0%** | 100% of raced tools caught |
| **Recovery Success Rate** | **100.0%** | **50.0%** | Complete turn recovery |
| **Invalidation Latency (Median / P95)** | 0ms / 1ms | 0ms / 1ms | Immediate atomic transition |
| **New-Response Latency (Median / P95)** | 15ms / 16ms | 16ms / 17ms | Low recovery turn latency |

---

## 2. Core Correctness Invariant Verification
- **Fenced Leak Rate = 0%:** Verified across all 100 trials. No stale result was ever accepted downstream.
- **Fence vs Cancellation Independence:** When cancellation lost the race (50 times), generation fencing caught and discarded 100% of stale results.
- **Rapid Multi-Interruption Stability:** Verified monotonic generation increments under rapid back-to-back interruptions.
- **Concurrent Task Invalidation:** Verified that overlapping LLM, Tool, and TTS tasks are all invalidated together upon generation transition.
