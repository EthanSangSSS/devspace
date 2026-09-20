import assert from "node:assert/strict";
import {
  McpSessionAdmissionError,
  McpSessionRegistry,
  type McpSessionLifecycleEvent,
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

// Bounded admission must reserve capacity before any asynchronous transport
// creation can oversubscribe the configured session cap.
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

// Ordinary request activity uses the same opaque lease accounting as
// initialization. Idle ordering is established when the final lease releases.
now = 0;
const leaseRegistry = new McpSessionRegistry<FakeTransport>({
  maxSessions: 2,
  now: () => now,
});
const older = createTransport();
const newer = createTransport();
const olderReservation = await leaseRegistry.reserve();
const olderInitializationLease = await leaseRegistry.commit(
  olderReservation,
  "older",
  older,
);
assert.ok(olderInitializationLease);
assert.equal(leaseRegistry.release(olderInitializationLease), true);

now = 1_000;
const newerReservation = await leaseRegistry.reserve();
const newerInitializationLease = await leaseRegistry.commit(
  newerReservation,
  "newer",
  newer,
);
assert.ok(newerInitializationLease);
assert.equal(leaseRegistry.release(newerInitializationLease), true);

const newerLease = leaseRegistry.acquire("newer");
assert.ok(newerLease);
assert.equal(leaseRegistry.snapshot().active, 1);
now = 5_000;
assert.equal(leaseRegistry.release(newerLease), true);
assert.equal(leaseRegistry.snapshot().active, 0);

const evictionReservation = await leaseRegistry.reserve();
assert.equal(older.closeCalls, 1);
assert.equal(leaseRegistry.acquire("older"), undefined);
const survivingNewerLease = leaseRegistry.acquire("newer");
assert.ok(survivingNewerLease);
assert.equal(leaseRegistry.release(survivingNewerLease), true);
assert.equal(leaseRegistry.snapshot().pendingReservations, 1);
assert.equal(leaseRegistry.cancel(evictionReservation), true);

// Disposal removes ownership before awaiting close and is idempotent. A
// transport_close callback converges on ownership removal without closing the
// already-closed transport recursively.
const disposeRegistry = new McpSessionRegistry<FakeTransport>();
const disposedTransport = createTransport();
const disposedReservation = await disposeRegistry.reserve();
const disposedInitializationLease = await disposeRegistry.commit(
  disposedReservation,
  "dispose-me",
  disposedTransport,
);
assert.ok(disposedInitializationLease);
assert.equal(disposeRegistry.release(disposedInitializationLease), true);
assert.deepEqual(
  await disposeRegistry.dispose("dispose-me", "capacity_eviction"),
  { sessionId: "dispose-me" },
);
assert.equal(disposedTransport.closeCalls, 1);
assert.equal(
  await disposeRegistry.dispose("dispose-me", "capacity_eviction"),
  undefined,
);
assert.equal(disposedTransport.closeCalls, 1);

const onCloseTransport = createTransport();
const onCloseReservation = await disposeRegistry.reserve();
const onCloseInitializationLease = await disposeRegistry.commit(
  onCloseReservation,
  "already-closed",
  onCloseTransport,
);
assert.ok(onCloseInitializationLease);
assert.equal(disposeRegistry.release(onCloseInitializationLease), true);
assert.deepEqual(
  await disposeRegistry.dispose("already-closed", "transport_close"),
  { sessionId: "already-closed" },
);
assert.equal(onCloseTransport.closeCalls, 0);

// Shutdown fences new work synchronously, then drains active leases before
// closing transports when requests finish within the bounded drain window.
let finishGracefulTimeout: (() => void) | undefined;
const gracefulRegistry = new McpSessionRegistry<FakeTransport>({
  waitForTimeout: () =>
    new Promise<void>((resolve) => {
      finishGracefulTimeout = resolve;
    }),
});
const gracefulTransport = createTransport();
const gracefulReservation = await gracefulRegistry.reserve();
const gracefulInitializationLease = await gracefulRegistry.commit(
  gracefulReservation,
  "graceful",
  gracefulTransport,
);
assert.ok(gracefulInitializationLease);
assert.equal(gracefulRegistry.release(gracefulInitializationLease), true);
const gracefulLease = gracefulRegistry.acquire("graceful");
assert.ok(gracefulLease);

let gracefulCloseSettled = false;
const gracefulClose = gracefulRegistry
  .closeAll({ drainTimeoutMs: 35_000 })
  .finally(() => {
    gracefulCloseSettled = true;
  });
await Promise.resolve();
assert.equal(gracefulRegistry.snapshot().state, "closing");
assert.equal(gracefulTransport.closeCalls, 0);
assert.equal(gracefulCloseSettled, false);
await assert.rejects(
  gracefulRegistry.reserve(),
  (error: unknown) =>
    error instanceof McpSessionAdmissionError && error.reason === "closing",
);
assert.equal(gracefulRegistry.acquire("graceful"), undefined);
assert.equal(gracefulRegistry.release(gracefulLease), true);
await gracefulClose;
assert.equal(gracefulTransport.closeCalls, 1);
assert.equal(gracefulRegistry.snapshot().state, "closed");
finishGracefulTimeout?.();

// If the drain deadline wins, shutdown detaches/closes active sessions and
// clears lease bookkeeping so a late release is harmless.
let finishForcedTimeout: (() => void) | undefined;
const forcedRegistry = new McpSessionRegistry<FakeTransport>({
  waitForTimeout: () =>
    new Promise<void>((resolve) => {
      finishForcedTimeout = resolve;
    }),
});
const forcedTransport = createTransport();
const forcedReservation = await forcedRegistry.reserve();
const forcedInitializationLease = await forcedRegistry.commit(
  forcedReservation,
  "forced",
  forcedTransport,
);
assert.ok(forcedInitializationLease);
assert.equal(forcedRegistry.release(forcedInitializationLease), true);
const forcedLease = forcedRegistry.acquire("forced");
assert.ok(forcedLease);
const forcedClose = forcedRegistry.closeAll({ drainTimeoutMs: 35_000 });
await Promise.resolve();
assert.equal(forcedRegistry.snapshot().state, "closing");
assert.equal(forcedTransport.closeCalls, 0);
finishForcedTimeout?.();
await forcedClose;
assert.equal(forcedTransport.closeCalls, 1);
assert.equal(forcedRegistry.snapshot().state, "closed");
assert.equal(forcedRegistry.release(forcedLease), false);

// A reservation obtained before shutdown cannot commit afterward. The
// uncommitted transport is closed exactly once and never enters the registry.
let finishCommitRaceTimeout: (() => void) | undefined;
const commitRaceRegistry = new McpSessionRegistry<FakeTransport>({
  waitForTimeout: () =>
    new Promise<void>((resolve) => {
      finishCommitRaceTimeout = resolve;
    }),
});
const commitRaceReservation = await commitRaceRegistry.reserve();
const commitRaceClose = commitRaceRegistry.closeAll({ drainTimeoutMs: 35_000 });
const lateTransport = createTransport();
assert.equal(
  await commitRaceRegistry.commit(
    commitRaceReservation,
    "late",
    lateTransport,
  ),
  false,
);
assert.equal(lateTransport.closeCalls, 1);
finishCommitRaceTimeout?.();
await commitRaceClose;
assert.equal(commitRaceRegistry.snapshot().current, 0);
assert.equal(commitRaceRegistry.snapshot().pendingReservations, 0);
assert.equal(commitRaceRegistry.snapshot().state, "closed");

// Active execution must not inherit a stale idle timestamp. If a session is
// force-detached while a request lease is active, idleForMs is intentionally
// absent and the event reports the active request count instead.
now = 0;
const lifecycleEvents: McpSessionLifecycleEvent[] = [];
const telemetryRegistry = new McpSessionRegistry<FakeTransport>({
  now: () => now,
  onEvent: (event) => lifecycleEvents.push(event),
});
const telemetryTransport = createTransport();
const telemetryReservation = await telemetryRegistry.reserve();
const telemetryInitializationLease = await telemetryRegistry.commit(
  telemetryReservation,
  "telemetry",
  telemetryTransport,
);
assert.ok(telemetryInitializationLease);
assert.equal(telemetryRegistry.release(telemetryInitializationLease), true);

now = 1_000;
const telemetryLease = telemetryRegistry.acquire("telemetry", {
  requestId: "request-active",
});
assert.ok(telemetryLease);
now = 5_000;
assert.deepEqual(
  await telemetryRegistry.dispose("telemetry", "server_shutdown"),
  { sessionId: "telemetry" },
);
const telemetryClosed = lifecycleEvents.find(
  (event) => event.type === "closed" && event.sessionId === "telemetry",
);
assert.ok(telemetryClosed);
assert.equal(telemetryClosed.sessionAgeMs, 5_000);
assert.equal(telemetryClosed.idleForMs, undefined);
assert.equal(telemetryClosed.activeRequests, 1);
assert.equal(telemetryClosed.closeInitiator, "server_policy");

// transport_close must carry bounded lifecycle context even though the SDK has
// already closed the underlying transport and the registry must not close it
// recursively.
now = 10_000;
const transportCloseEvents: McpSessionLifecycleEvent[] = [];
const transportCloseRegistry = new McpSessionRegistry<FakeTransport>({
  now: () => now,
  onEvent: (event) => transportCloseEvents.push(event),
});
const transportClosedTransport = createTransport();
const transportCloseReservation = await transportCloseRegistry.reserve();
const transportCloseInitializationLease = await transportCloseRegistry.commit(
  transportCloseReservation,
  "transport-closed",
  transportClosedTransport,
);
assert.ok(transportCloseInitializationLease);
assert.equal(
  transportCloseRegistry.release(transportCloseInitializationLease),
  true,
);
now = 13_500;
assert.deepEqual(
  await transportCloseRegistry.dispose(
    "transport-closed",
    "transport_close",
    { closeInitiator: "explicit_delete", requestId: "request-delete" },
  ),
  { sessionId: "transport-closed" },
);
assert.equal(transportClosedTransport.closeCalls, 0);
const transportClosedEvent = transportCloseEvents.find(
  (event) => event.type === "closed" && event.sessionId === "transport-closed",
);
assert.ok(transportClosedEvent);
assert.equal(transportClosedEvent.sessionAgeMs, 3_500);
assert.equal(transportClosedEvent.idleForMs, 3_500);
assert.equal(transportClosedEvent.activeRequests, 0);
assert.equal(transportClosedEvent.closeInitiator, "explicit_delete");
assert.equal(transportClosedEvent.requestId, "request-delete");

const sdkCallbackEvents: McpSessionLifecycleEvent[] = [];
const sdkCallbackRegistry = new McpSessionRegistry<FakeTransport>({
  onEvent: (event) => sdkCallbackEvents.push(event),
});
const sdkCallbackTransport = createTransport();
const sdkCallbackReservation = await sdkCallbackRegistry.reserve();
const sdkCallbackInitializationLease = await sdkCallbackRegistry.commit(
  sdkCallbackReservation,
  "sdk-callback",
  sdkCallbackTransport,
);
assert.ok(sdkCallbackInitializationLease);
assert.equal(
  sdkCallbackRegistry.release(sdkCallbackInitializationLease),
  true,
);
assert.deepEqual(
  await sdkCallbackRegistry.dispose("sdk-callback", "transport_close"),
  { sessionId: "sdk-callback" },
);
const sdkCallbackClosed = sdkCallbackEvents.find(
  (event) => event.type === "closed" && event.sessionId === "sdk-callback",
);
assert.ok(sdkCallbackClosed);
assert.equal(sdkCallbackClosed.closeInitiator, "sdk_callback");
assert.equal(sdkCallbackTransport.closeCalls, 0);

// Unknown-session accounting remains exact even if the server chooses to
// rate-limit detailed miss logs.
const missEvents: McpSessionLifecycleEvent[] = [];
const missRegistry = new McpSessionRegistry<FakeTransport>({
  onEvent: (event) => missEvents.push(event),
});
for (let index = 0; index < 1_000; index += 1) {
  assert.equal(
    missRegistry.acquire("missing-session", { requestId: `miss-${index}` }),
    undefined,
  );
}
assert.equal(missRegistry.snapshot().unknownSessionTotal, 1_000);
assert.equal(missEvents.filter((event) => event.type === "miss").length, 1_000);
