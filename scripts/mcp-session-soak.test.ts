import assert from "node:assert/strict";
import {
  MEMORY_IDLE_SAMPLE_COUNT,
  MEMORY_RUNTIME_SNAPSHOT_INTERVAL_MS,
  MEMORY_SAMPLE_COLLECTION_DEADLINE_MS,
  MEMORY_SAMPLE_INTERVAL_TOLERANCE_MS,
  memoryPlateauLimit,
  median,
  retainedHeapFloor,
  rollingMedian,
  runGateOrchestration,
  runStockControlWithDependencies,
  validateIdleHeapWindow,
  type ActiveCanaryEvidence,
  type CandidateSoakEvidence,
  type StockControlDependencies,
  type TimedHeapSample,
} from "./mcp-session-soak.js";

assert.equal(MEMORY_IDLE_SAMPLE_COUNT, 60);
assert.equal(MEMORY_RUNTIME_SNAPSHOT_INTERVAL_MS, 1_000);
assert.equal(MEMORY_SAMPLE_INTERVAL_TOLERANCE_MS, 250);
assert.equal(MEMORY_SAMPLE_COLLECTION_DEADLINE_MS, 76_000);

assert.equal(median([1, 3, 2]), 2);
assert.equal(median([1, 4, 2, 3]), 2.5);
assert.deepEqual(rollingMedian([1, 2, 100, 3, 4, 5], 5), [3, 4]);
assert.equal(
  retainedHeapFloor(Array.from({ length: 60 }, (_, index) => 100 + index)),
  102,
);
assert.equal(
  memoryPlateauLimit(128 * 1024 * 1024),
  64 * 1024 * 1024,
);
assert.throws(
  () => retainedHeapFloor(new Array(59).fill(1)),
  /exactly 60/,
);
assert.throws(
  () => retainedHeapFloor([...new Array(59).fill(1), Number.NaN]),
  /finite/,
);

const stop = 100_000;
const anchor: TimedHeapSample = {
  timestampMs: stop,
  heapUsedBytes: 999,
};
const validTimedSamples: TimedHeapSample[] = Array.from(
  { length: 60 },
  (_, index) => ({
    timestampMs: stop + 1_000 * (index + 1),
    heapUsedBytes: 1_000 + index,
  }),
);

assert.deepEqual(
  validateIdleHeapWindow(anchor, validTimedSamples, stop),
  validTimedSamples.map((sample) => sample.heapUsedBytes),
);

// Missing first tick: first post-stop sample arrives at +2s.
assert.throws(
  () =>
    validateIdleHeapWindow(
      anchor,
      validTimedSamples.map((sample) => ({
        ...sample,
        timestampMs: sample.timestampMs + 1_000,
      })),
      stop,
    ),
  /snapshot interval/,
);

// Internal missing tick: one discontinuity becomes 2s and is INCONCLUSIVE.
assert.throws(
  () =>
    validateIdleHeapWindow(
      anchor,
      validTimedSamples.map((sample, index) =>
        index >= 20
          ? { ...sample, timestampMs: sample.timestampMs + 1_000 }
          : sample,
      ),
      stop,
    ),
  /snapshot interval/,
);

assert.throws(
  () => validateIdleHeapWindow(anchor, validTimedSamples.slice(0, 59), stop),
  /exactly 60/,
);
assert.throws(
  () => validateIdleHeapWindow(undefined, validTimedSamples, stop),
  /anchor/,
);
assert.throws(
  () =>
    validateIdleHeapWindow(
      { timestampMs: stop + 1, heapUsedBytes: 999 },
      validTimedSamples,
      stop,
    ),
  /after traffic stop/,
);
assert.throws(
  () =>
    validateIdleHeapWindow(
      anchor,
      validTimedSamples.map((sample, index) =>
        index === 10 ? { ...sample, heapUsedBytes: Number.NaN } : sample,
      ),
      stop,
    ),
  /finite/,
);

function stockDependencies(
  overrides: Partial<StockControlDependencies> = {},
): StockControlDependencies {
  return {
    createControlRoot: async () => "/tmp/devspace-stock-test",
    createOwnerToken: () => "owner-token",
    assertLiveRuntimeIdentity: async () => {},
    prepareRuntimeClone: async () => ({
      root: "/tmp/devspace-stock-test/runtime",
      packageRoot: "/tmp/devspace-stock-test/runtime/package",
      cliPath: "/tmp/devspace-stock-test/runtime/package/dist/cli.js",
      wrapperLockSha256: "lock",
      mcpSdkVersion: "1.30.0",
    }),
    assertCandidateStateIsolation: () => {},
    startCandidateProcess: async () => ({ fake: true }),
    attachRuntimeObservers: () => ({
      snapshots: [],
      createdEvents: 0,
      closedEvents: 0,
      oomEvidence: 0,
      unhandledRejectionEvidence: 0,
      telemetryErrors: 0,
    }),
    waitForCandidateHealth: async () => {},
    bootstrapOAuth: async () => "access-token",
    initializeAndAbandon: async () => "session",
    stopCandidateProcess: async () => {},
    ...overrides,
  };
}

// Blocking identity checks must remain outside the stock diagnostic catch.
let preIdentityCalls = 0;
await assert.rejects(
  runStockControlWithDependencies(
    stockDependencies({
      assertLiveRuntimeIdentity: async () => {
        preIdentityCalls += 1;
        if (preIdentityCalls === 1) throw new Error("baseline drift before stock");
      },
    }),
  ),
  /baseline drift before stock/,
);
assert.equal(preIdentityCalls, 1);

let postIdentityCalls = 0;
await assert.rejects(
  runStockControlWithDependencies(
    stockDependencies({
      assertLiveRuntimeIdentity: async () => {
        postIdentityCalls += 1;
        if (postIdentityCalls === 2) throw new Error("baseline drift after stock");
      },
    }),
  ),
  /baseline drift after stock/,
);
assert.equal(postIdentityCalls, 2);

// A stock-only observation failure is diagnostic and cannot stop candidate
// canary/soak execution or affect their final verdict.
const diagnosticStock = await runStockControlWithDependencies(
  stockDependencies({
    waitForCandidateHealth: async () => {
      throw new Error("stock health diagnostic unavailable");
    },
  }),
);
assert.equal(diagnosticStock.status, "INCONCLUSIVE");

const passingCanary: ActiveCanaryEvidence = {
  pass: true,
  idleSessionEvicted: true,
  activeSessionWronglyEvicted: false,
  allActiveStatus: 503,
  allActiveJsonRpcCode: -32001,
  wrapperLockSha256: "lock",
  mcpSdkVersion: "1.30.0",
};
const passingSoak: CandidateSoakEvidence = {
  verdict: "PASS",
  candidateRoot: "/tmp/candidate",
  wrapperLockSha256: "lock",
  mcpSdkVersion: "1.30.0",
  hA: 100,
  hB: 101,
  deltaBA: 1,
  memoryLimit: 64 * 1024 * 1024,
  maxObservedCurrent: 64,
  maxObservedOccupiedCapacity: 64,
  createdEvents: 10_000,
  telemetryErrors: 0,
};
let canaryCalls = 0;
let soakCalls = 0;
const diagnosticOrchestration = await runGateOrchestration({
  runStockControl: async () => diagnosticStock,
  runActiveProtectionCanary: async () => {
    canaryCalls += 1;
    return passingCanary;
  },
  runCandidateSoak: async () => {
    soakCalls += 1;
    return passingSoak;
  },
});
assert.equal(diagnosticOrchestration.verdict, "PASS");
assert.equal(diagnosticOrchestration.control.status, "INCONCLUSIVE");
assert.equal(canaryCalls, 1);
assert.equal(soakCalls, 1);

// Blocking stock rejection stops orchestration before either candidate stage.
canaryCalls = 0;
soakCalls = 0;
await assert.rejects(
  runGateOrchestration({
    runStockControl: async () => {
      throw new Error("blocking live identity drift");
    },
    runActiveProtectionCanary: async () => {
      canaryCalls += 1;
      return passingCanary;
    },
    runCandidateSoak: async () => {
      soakCalls += 1;
      return passingSoak;
    },
  }),
  /blocking live identity drift/,
);
assert.equal(canaryCalls, 0);
assert.equal(soakCalls, 0);

console.log("MCP_SOAK_METRICS_TEST=PASS");
