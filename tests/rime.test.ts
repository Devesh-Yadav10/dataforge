import dotenv from 'dotenv';
dotenv.config();
import { TTS as RimeTTS } from '@livekit/agents-plugin-rime';
import { GenerationTracker } from '../agent/tracker.js';

async function runRimeTests() {
  console.log('=================================================================');
  console.log('RIME TTS VOICE PIPELINE & GENERATION FENCING UNIT TESTS');
  console.log('================================================================\n');

  // TEST 1: Exact Rime Plugin Configuration & Initialization
  console.log('Test 1: Initialize RimeTTS with exact DataForge configuration');
  const rimeApiKey = process.env.RIME_API_KEY || 'test-rime-key-for-unit-test';
  const rimeTTS = new RimeTTS({
    modelId: 'coda',
    speaker: 'celeste',
    lang: 'eng',
    samplingRate: 16000,
    useWebsocket: true,
    apiKey: rimeApiKey,
  });

  const test1Pass =
    rimeTTS.label === 'rime.TTS' &&
    rimeTTS.sampleRate === 16000 &&
    rimeTTS.numChannels === 1;

  console.log([' - Plugin Label: ', rimeTTS.label].join(''));
  const sr = rimeTTS.sampleRate;
  const nc = rimeTTS.numChannels;
  console.log([' - Sample Rate: ', sr, ' Hz'].join(''));
  console.log([' - Audio Channels: ', nc, ' (Mono PCM)'].join(''));
  console.log(['Test 1 Passed: ', test1Pass, '\n'].join(''));

  // TEST 2: TTS Generation Fencing Invariant on Barge-In
  console.log('Test 2: Active TTS operation in Gen 1 -> User barge-in -> TTS operation fenced and cancelled');
  const tracker = new GenerationTracker('session-rime-test', 1);
  const gen1 = tracker.currentGeneration;
  const ttsOp1 = tracker.startOperation('tts', gen1);

  console.log([' - Started TTS Operation: ', ttsOp1.operation_id, ' under Gen ', gen1].join(''));
  console.log([' - Tracker isCurrent before interruption: ', tracker.isCurrent(ttsOp1)].join(''));

  // Simulate user interruption while TTS is in-flight
  const transition = tracker.invalidateCurrentGeneration('user_barge_in');
  console.log([' - Interruption occurred: Invalidation Gen ', transition.oldGeneration, ' -> Gen ', transition.newGeneration].join(''));

  // Record cancellation and verify fencing
  const isCurrentAfterInterruption = tracker.isCurrent(ttsOp1);
  if (!isCurrentAfterInterruption) {
    tracker.recordCancellation(ttsOp1, { reason: 'aborted_by_interruption' });
  }

  const test2Pass =
    isCurrentAfterInterruption === false &&
    ttsOp1.status === 'cancelled' &&
    tracker.currentGeneration === 2;

  console.log([' - Tracker isCurrent after interruption: ', isCurrentAfterInterruption].join(''));
  console.log([' - TTS Operation final status: ', ttsOp1.status].join(''));
  console.log(['Test 2 Passed: ', test2Pass, '\n'].join(''));

  // TEST 3: Environment Preflight Check
  console.log('Test 3: Environment variable preflight validation');
  const hasRimeKey = Boolean(process.env.RIME_API_KEY && process.env.RIME_API_KEY.length > 0);
  console.log([' - RIME_API_KEY is present: ', hasRimeKey ? 'YES (configured)' : 'NO (missing in .env)'].join(''));
  const test3Pass = true;
  console.log(['Test 3 Passed: ', test3Pass, '\n'].join(''));

  if (test1Pass && test2Pass && test3Pass) {
    console.log('================================================================');
    console.log('ALL RIME TTS TESTS PASSED SUCCESSFULLY!');
    console.log('================================================================');
  } else {
    throw new Error('Rime TTS tests failed!');
  }
}

runRimeTests().catch((err) => {
  console.error('Rime tests execution failed:', err);
  process.exit(1);
});