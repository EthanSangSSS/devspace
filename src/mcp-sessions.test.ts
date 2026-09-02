import assert from "node:assert/strict";
import {
  McpSessionAdmissionError,
  McpSessionRegistry,
} from "./mcp-sessions.js";

interface FakeTransport {
  closeCalls: number;
  close(): Promise<void>;
}

function createTransport(closeError?: Error): FakeTransport {
  return {
    closeCalls: 0,
    async close() {
      this.closeCalls += 1;
      if (closeError) throw closeError;
    },
  };
}

let now = 0;
const registry = new McpSessionRegistry<FakeTransport>({ now: () => now });
const staleTransport = createTransport();
const activeTransport = createTransport();

registry.register("stale", staleTransport);
now = 1_000;
registry.register("active", activeTransport);
now = 1_500;
assert.equal(registry.get("active"), activeTransport);
now = 2_000;

const idleResults = await registry.closeIdle(1_500);
assert.deepEqual(idleResults, [{ sessionId: "stale" }]);
assert.equal(staleTransport.closeCalls, 1);
assert.equal(activeTransport.closeCalls, 0);
assert.equal(registry.size, 1);
assert.equal(registry.get("stale"), undefined);
assert.equal(registry.get("active"), activeTransport);

const closeError = new Error("close failed");
const failingTransport = createTransport(closeError);
registry.register("failing", failingTransport);
now = 10_000;

const failingResults = await registry.closeIdle(1);
assert.equal(failingResults.length, 2);
assert.deepEqual(failingResults.map((result) => result.sessionId).sort(), ["active", "failing"]);
assert.equal(failingResults.find((result) => result.sessionId === "failing")?.error, closeError);
assert.equal(failingTransport.closeCalls, 1);
assert.equal(registry.size, 0);

const first = createTransport();
const second = createTransport();
registry.register("first", first);
registry.register("second", second);
registry.remove("first");

const shutdownResults = await registry.closeAll();
assert.deepEqual(shutdownResults, [{ sessionId: "second" }]);
assert.equal(first.closeCalls, 0);
assert.equal(second.closeCalls, 1);
assert.equal(registry.size, 0);

let finishDelayedClose: (() => void) | undefined;
let delayedCloseResolved = false;
const delayedTransport: FakeTransport = {
  closeCalls: 0,
  close() {
    this.closeCalls += 1;
    return new Promise<void>((resolve) => {
      finishDelayedClose = resolve;
    });
  },
};
const delayedRegistry = new McpSessionRegistry<FakeTransport>();
delayedRegistry.register("delayed", delayedTransport);
const delayedClose = delayedRegistry.closeAll();
void delayedClose.then(() => {
  delayedCloseResolved = true;
});

await Promise.resolve();
assert.equal(delayedCloseResolved, false);
assert.equal(delayedTransport.closeCalls, 1);
finishDelayedClose?.();
await delayedClose;
assert.equal(delayedCloseResolved, true);
assert.equal(delayedRegistry.size, 0);

// Bounded admission is reserved synchronously so concurrent initializations
// cannot oversubscribe the configured session cap.
now = 0;
const bounded = new McpSessionRegistry<FakeTransport>({
  maxSessions: 2,
  now: () => now,
});
const r1 = await bounded.reserve({ requestId: "r1" });
const r2 = await bounded.reserve({ requestId: "r2" });
assert.equal(bounded.snapshot().pendingReservations, 2);
await assert.rejects(
  bounded.reserve({ requestId: "r3" }),
  (error: unknown) =>
    error instanceof McpSessionAdmissionError && error.reason === "capacity",
);
assert.equal(
  bounded.snapshot().current + bounded.snapshot().pendingReservations,
  2,
);
assert.equal(bounded.cancel(r1), true);
assert.equal(bounded.cancel(r2), true);

// A committed-but-still-initializing session owns an initialization lease and
// is therefore active/protected at capacity until the outer initialize request
// releases that lease.
const initRegistry = new McpSessionRegistry<FakeTransport>({
  maxSessions: 1,
  now: () => now,
});
const initAReservation = await initRegistry.reserve();
const initATransport = createTransport();
const initA = await initRegistry.commit(
  initAReservation,
  "a",
  initATransport,
);
assert.ok(initA);
assert.equal(initRegistry.snapshot().active, 1);

await assert.rejects(
  initRegistry.reserve(),
  (error: unknown) =>
    error instanceof McpSessionAdmissionError && error.reason === "capacity",
);
assert.equal(initRegistry.snapshot().current, 1);
assert.equal(initRegistry.snapshot().active, 1);
assert.equal(initATransport.closeCalls, 0);

now = 1_000;
assert.equal(initRegistry.release(initA), true);
assert.equal(initRegistry.release(initA), false);
assert.equal(initRegistry.snapshot().active, 0);
const afterInitialize = await initRegistry.reserve();
assert.equal(initRegistry.snapshot().current, 0);
assert.equal(initRegistry.snapshot().pendingReservations, 1);
assert.equal(initATransport.closeCalls, 1);
assert.equal(initRegistry.cancel(afterInitialize), true);

// If an idle eviction close is still in flight when shutdown begins, the
// pending reservation must be fenced and never returned to its caller.
let finishEvictionClose: (() => void) | undefined;
const raceRegistry = new McpSessionRegistry<FakeTransport>({
  maxSessions: 1,
  now: () => now,
});
const raceAReservation = await raceRegistry.reserve();
const raceATransport: FakeTransport = {
  closeCalls: 0,
  close() {
    this.closeCalls += 1;
    return new Promise<void>((resolve) => {
      finishEvictionClose = resolve;
    });
  },
};
const raceALease = await raceRegistry.commit(
  raceAReservation,
  "race-a",
  raceATransport,
);
assert.ok(raceALease);
assert.equal(raceRegistry.release(raceALease), true);

let reserveSettled = false;
const pendingReserve = raceRegistry.reserve().finally(() => {
  reserveSettled = true;
});
await Promise.resolve();
assert.equal(raceATransport.closeCalls, 1);
assert.equal(reserveSettled, false);

const shutdownDuringReserve = raceRegistry.closeAll();
finishEvictionClose?.();
await assert.rejects(
  pendingReserve,
  (error: unknown) =>
    error instanceof McpSessionAdmissionError && error.reason === "closing",
);
await shutdownDuringReserve;
assert.equal(raceRegistry.snapshot().state, "closed");
assert.equal(raceRegistry.snapshot().current, 0);
assert.equal(raceRegistry.snapshot().pendingReservations, 0);
