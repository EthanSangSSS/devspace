import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyRollbackRefusal,
  runMacosLaunchdRollout,
  runMacosLaunchdForwardPath,
  type CanonicalPlistSnapshot,
  type LaunchdObservation,
  type ListenerObservation,
  type MacosRolloutAdapters,
  type ObservedState,
  type ProcessIdentity,
  type RolloutRequest,
  type RollbackClassificationInput,
} from "./macos-launchd-rollout.js";
import { buildCandidateSlotManifest } from "./macos-launchd-rollout-manifest.js";
import type { RolloutLockLease } from "./macos-launchd-rollout-lock.js";

const rolloutTest = process.platform === "win32" ? test.skip : test;

const known = <T>(value: T): ObservedState<T> => ({ kind: "known", value });
const unproven = <T>(reason: string): ObservedState<T> => ({ kind: "unproven", reason });

function rollbackState(
  overrides: Partial<RollbackClassificationInput> = {},
): RollbackClassificationInput {
  return {
    canonical: known("expected"),
    runtime: known("expected"),
    listener: known("expected"),
    lock: known("owned"),
    ownerRecord: known("ours"),
    ...overrides,
  };
}

rolloutTest("rollback refusal taxonomy is deterministic and drift-first", async () => {
  const cases = [
    {
      name: "canonical hash drift is concrete drift",
      input: rollbackState({ canonical: known("drift") }),
      expected: "ROLLBACK_REFUSED_CONCURRENT_DRIFT",
    },
    {
      name: "valid owner nonce mismatch is concrete drift",
      input: rollbackState({ ownerRecord: known("drift") }),
      expected: "ROLLBACK_REFUSED_CONCURRENT_DRIFT",
    },
    {
      name: "unreadable owner record is unproven",
      input: rollbackState({ ownerRecord: unproven("read failed") }),
      expected: "ROLLBACK_REFUSED_UNPROVEN_STATE",
    },
    {
      name: "positive concrete drift outranks another unproven observation",
      input: rollbackState({
        canonical: known("drift"),
        ownerRecord: unproven("read failed"),
      }),
      expected: "ROLLBACK_REFUSED_CONCURRENT_DRIFT",
    },
    {
      name: "confirmed candidate absence is not a refusal",
      input: rollbackState({ runtime: known("absent"), listener: known("unowned") }),
      expected: undefined,
    },
  ] as const;

  for (const entry of cases) {
    assert.equal(classifyRollbackRefusal(entry.input), entry.expected, entry.name);
  }
});

interface ForwardFixtureOptions {
  disabled?: boolean;
  selfHosted?: boolean;
  candidatePreflightFails?: boolean;
  canonicalArgvDrift?: boolean;
  oldRuntimeDriftsBeforeStop?: boolean;
  firstCandidateListenerPid?: number;
  firstCandidateHealthy?: boolean;
  candidateCrashBackoffBeforeRecovery?: boolean;
  candidateCrashBackoffArgvDrift?: boolean;
  reloadCandidateHealthy?: boolean;
  preCommitCanonicalDrift?: boolean;
  keepAliveReplacementBeforeCommit?: boolean;
  oldStopBarrierThrows?: boolean;
  oldBootoutLeavesRuntime?: boolean;
  recoveryCanonicalDrift?: "hash" | "identity" | "unproven";
  recoveryRuntimeUnproven?: boolean;
  postCommitHealthFailure?: boolean;
  postCommitCandidateCrashBackoff?: boolean;
  postCommitRuntimeDrift?: boolean;
  postCommitRuntimeAbsent?: boolean;
  postCommitUnrelatedListener?: boolean;
  postCommitLockDrift?: boolean;
  postCommitLockUnproven?: boolean;
  rollbackFinalCanonicalDrift?: boolean;
  rollbackOldTempDrift?: boolean;
  rollbackBootstrapFails?: boolean;
  recoveryBarrier?: () => Promise<void>;
  leaseOwnershipTracksRelease?: boolean;
}

interface ForwardFixture {
  request: RolloutRequest;
  adapters: MacosRolloutAdapters;
  calls: string[];
  lease: RolloutLockLease;
  getReleaseCalls(): number;
}

async function createForwardFixture(
  t: test.TestContext,
  options: ForwardFixtureOptions = {},
): Promise<ForwardFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-rollout-forward-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidateSlot = join(root, "candidate-slot");
  const candidateEntrypoint = join(
    candidateSlot,
    "node_modules",
    "@waishnav",
    "devspace",
    "dist",
    "cli.js",
  );
  await mkdir(join(candidateSlot, "node_modules", "@waishnav", "devspace", "dist"), { recursive: true });
  await writeFile(candidateEntrypoint, "export {};\n", { mode: 0o644 });
  const candidateManifest = await buildCandidateSlotManifest(candidateSlot);

  const oldEntrypoint = "/Users/ethan/.local/opt/devspace-old/node_modules/@waishnav/devspace/dist/cli.js";
  const oldBytes = Buffer.from("old-canonical-plist\n");
  const oldSha = createHash("sha256").update(oldBytes).digest("hex");
  const candidateBytes = Buffer.from(`candidate:${candidateEntrypoint}\n`);
  const candidateSha = createHash("sha256").update(candidateBytes).digest("hex");
  const oldProcess = forwardProcess(101, oldEntrypoint, "old-generation");
  const candidateFirst = forwardProcess(201, candidateEntrypoint, "candidate-generation-1");
  const candidateReload = forwardProcess(202, candidateEntrypoint, "candidate-generation-2");
  const candidateReplacement = forwardProcess(203, candidateEntrypoint, "candidate-generation-3");
  const oldRestored = forwardProcess(102, oldEntrypoint, "old-generation-restored");
  const foreignRuntime = forwardProcess(
    909,
    "/Users/ethan/.local/opt/foreign/node_modules/@waishnav/devspace/dist/cli.js",
    "foreign-generation",
  );
  const calls: string[] = [];
  let phase:
    | "old"
    | "stopped"
    | "candidate-first"
    | "candidate-crash-backoff"
    | "candidate-first-stopped"
    | "candidate-reload"
    | "rollback-candidate-stopped"
    | "old-restored" = "old";
  let canonicalCommitted = false;
  let oldProcessReads = 0;
  let releaseCalls = 0;
  let leaseReleased = false;
  let recoveryBarrierUsed = false;
  let replacementActive = false;
  let forwardFailed = false;
  let rollbackTempPrepared = false;
  let preparedTempKind: "candidate" | "old" | undefined;
  let preparedTempPath = "/tmp/candidate.tmp";

  const canonicalIdentity = {
    path: "/Users/ethan/Library/LaunchAgents/com.ethan.devspace.plist",
    uid: 501,
    gid: 20,
    mode: 0o644,
    device: 1,
    inode: 10,
    kind: "file" as const,
    symlink: false,
  };
  const parentIdentity = {
    ...canonicalIdentity,
    path: "/Users/ethan/Library/LaunchAgents",
    inode: 9,
    mode: 0o700,
    kind: "directory" as const,
  };
  const oldCanonical: CanonicalPlistSnapshot = {
    bytes: oldBytes,
    sha256: oldSha,
    identity: canonicalIdentity,
    parentIdentity,
    entrypointRealpath: oldEntrypoint,
    programArguments: options.canonicalArgvDrift
      ? ["/opt/homebrew/bin/node-alt", oldEntrypoint, "serve"]
      : [...oldProcess.normalizedArgv],
    runAtLoad: true,
    keepAlive: true,
  };
  const candidateCanonical: CanonicalPlistSnapshot = {
    bytes: candidateBytes,
    sha256: candidateSha,
    identity: { ...canonicalIdentity, inode: 20 },
    parentIdentity,
    entrypointRealpath: candidateEntrypoint,
    programArguments: [...candidateFirst.normalizedArgv],
    runAtLoad: true,
    keepAlive: true,
  };

  const lease: RolloutLockLease = {
    fd: 99,
    owner: {
      schema_version: 1,
      pid: process.pid,
      process_start_identity: "helper-generation",
      transaction_nonce: "fake-nonce",
      transaction_id: "fake-transaction",
      created_at: "2026-09-17T00:00:00.000Z",
    },
    async assertOwned() {
      calls.push("lock.assertOwned");
      if (options.leaseOwnershipTracksRelease && leaseReleased) {
        return unproven("rollout lock was already released");
      }
      if (forwardFailed && canonicalCommitted && options.postCommitLockUnproven) {
        return unproven("rollout lock state cannot be proven");
      }
      if (forwardFailed && canonicalCommitted && options.postCommitLockDrift) {
        return known("drift");
      }
      return known("owned");
    },
    async release() {
      releaseCalls += 1;
      leaseReleased = true;
      calls.push("lock.release");
    },
  };

  const currentLaunchd = (): LaunchdObservation => {
    switch (phase) {
      case "old":
        return { loaded: true, pid: oldProcess.pid, runCount: 1, normalizedArgv: oldProcess.normalizedArgv };
      case "candidate-first":
        return { loaded: true, pid: candidateFirst.pid, runCount: 1, normalizedArgv: candidateFirst.normalizedArgv };
      case "candidate-crash-backoff":
        return {
          loaded: true,
          runCount: 64,
          normalizedArgv: options.candidateCrashBackoffArgvDrift
            ? foreignRuntime.normalizedArgv
            : candidateFirst.normalizedArgv,
        };
      case "candidate-reload":
        if (forwardFailed && options.postCommitRuntimeDrift) {
          return { loaded: true, pid: foreignRuntime.pid, runCount: 4, normalizedArgv: foreignRuntime.normalizedArgv };
        }
        return replacementActive
          ? { loaded: true, pid: candidateReplacement.pid, runCount: 3, normalizedArgv: candidateReplacement.normalizedArgv }
          : { loaded: true, pid: candidateReload.pid, runCount: 2, normalizedArgv: candidateReload.normalizedArgv };
      case "stopped":
      case "candidate-first-stopped":
      case "rollback-candidate-stopped":
        return { loaded: false };
      case "old-restored":
        return { loaded: true, pid: oldRestored.pid, runCount: 2, normalizedArgv: oldRestored.normalizedArgv };
    }
  };

  const currentProcess = (pid: number): ProcessIdentity | undefined => {
    if (phase === "old" && pid === oldProcess.pid) {
      oldProcessReads += 1;
      if (options.oldRuntimeDriftsBeforeStop && oldProcessReads >= 2) {
        return { ...oldProcess, processStartIdentity: "old-generation-drift" };
      }
      return oldProcess;
    }
    if (phase === "candidate-first" && pid === candidateFirst.pid) return candidateFirst;
    if (phase === "candidate-reload" && !replacementActive && pid === candidateReload.pid) return candidateReload;
    if (phase === "candidate-reload" && replacementActive && pid === candidateReplacement.pid) return candidateReplacement;
    if (phase === "candidate-reload" && forwardFailed && options.postCommitRuntimeDrift && pid === foreignRuntime.pid) {
      return foreignRuntime;
    }
    if (phase === "old-restored" && pid === oldRestored.pid) return oldRestored;
    return undefined;
  };

  const currentListener = (): ListenerObservation => {
    switch (phase) {
      case "old": return { state: "owned", ownerPid: oldProcess.pid };
      case "candidate-first": return {
        state: "owned",
        ownerPid: (() => {
          if (options.firstCandidateListenerPid !== undefined && options.firstCandidateListenerPid !== candidateFirst.pid) {
            forwardFailed = true;
          }
          return options.firstCandidateListenerPid ?? candidateFirst.pid;
        })(),
      };
      case "candidate-crash-backoff": return { state: "unowned" };
      case "candidate-reload": return {
        state: "owned",
        ownerPid: forwardFailed && options.postCommitUnrelatedListener
          ? 999
          : forwardFailed && options.postCommitRuntimeDrift
            ? foreignRuntime.pid
            : replacementActive ? candidateReplacement.pid : candidateReload.pid,
      };
      case "stopped":
      case "candidate-first-stopped":
      case "rollback-candidate-stopped": return { state: "unowned" };
      case "old-restored": return { state: "owned", ownerPid: oldRestored.pid };
    }
  };

  const adapters: MacosRolloutAdapters = {
    async acquireLock() {
      calls.push("LOCKED");
      return lease;
    },
    async readCanonical() {
      if (forwardFailed && options.recoveryBarrier && !recoveryBarrierUsed) {
        recoveryBarrierUsed = true;
        await options.recoveryBarrier();
      }
      calls.push(canonicalCommitted ? "canonical:candidate" : "canonical:old");
      if (forwardFailed && !canonicalCommitted) {
        if (options.recoveryCanonicalDrift === "unproven") {
          return unproven("canonical recovery observation failed");
        }
        if (options.recoveryCanonicalDrift === "hash") {
          return known({ ...oldCanonical, sha256: "e".repeat(64) });
        }
        if (options.recoveryCanonicalDrift === "identity") {
          return known({
            ...oldCanonical,
            identity: { ...oldCanonical.identity, mode: 0o600 },
          });
        }
      }
      if (canonicalCommitted && rollbackTempPrepared && options.rollbackFinalCanonicalDrift) {
        return known({ ...candidateCanonical, sha256: "d".repeat(64) });
      }
      if (options.preCommitCanonicalDrift && phase === "candidate-reload" && !canonicalCommitted) {
        return known({ ...oldCanonical, sha256: "f".repeat(64) });
      }
      if (options.keepAliveReplacementBeforeCommit && phase === "candidate-reload" && !canonicalCommitted) {
        replacementActive = true;
      }
      return known(canonicalCommitted ? candidateCanonical : oldCanonical);
    },
    async validateCandidateEntrypoint() { calls.push("candidate:entrypoint-valid"); },
    async preflightCandidateRuntime(_plistPath, _candidateEntrypoint, expectedArgv) {
      calls.push("candidate:runtime-preflight");
      assert.deepEqual(expectedArgv, candidateFirst.normalizedArgv);
      if (options.candidatePreflightFails) throw new Error("candidate sqlite native dependency is not loadable");
    },
    async createCandidatePlist() {
      calls.push("candidate:plist-created");
      return candidateBytes;
    },
    async writeOldBackup() { calls.push("BACKED_UP"); },
    async writeCandidateEvidence() { calls.push("CANDIDATE_STAGED"); },
    async prepareCanonicalTemp() {
      const isOld = arguments[0]?.expectedSha256 === oldSha;
      preparedTempKind = isOld ? "old" : "candidate";
      preparedTempPath = isOld ? "/tmp/old-restore.tmp" : "/tmp/candidate.tmp";
      if (isOld) rollbackTempPrepared = true;
      calls.push(isOld ? "rollback:old-temp-prepared" : "canonical:temp-prepared");
      return {
        path: preparedTempPath,
        sha256: isOld ? oldSha : candidateSha,
        identity: {
          ...canonicalIdentity,
          path: preparedTempPath,
          inode: isOld ? 30 : 20,
        },
      };
    },
    async atomicReplaceCanonical(tempPath) {
      if (preparedTempKind === "old" && tempPath === preparedTempPath) {
        calls.push("ROLLBACK_RESTORED_CANONICAL");
        canonicalCommitted = false;
        return;
      }
      calls.push("COMMITTED");
      canonicalCommitted = true;
    },
    async syncCanonicalParent() { calls.push("canonical:parent-synced"); },
    async observeLaunchd() {
      calls.push(`launchd:${phase}`);
      return known(currentLaunchd());
    },
    async observeProcess(pid) {
      calls.push(`process:${pid}`);
      if (forwardFailed && options.recoveryRuntimeUnproven) {
        return unproven("runtime recovery observation failed");
      }
      const processValue = currentProcess(pid);
      return processValue ? known(processValue) : unproven(`PID ${pid} is not current`);
    },
    async observeListener() {
      calls.push(`listener:${phase}`);
      return known(currentListener());
    },
    async checkHealth() {
      calls.push(`health:${phase}`);
      if (phase === "candidate-first" && options.firstCandidateHealthy === false) {
        forwardFailed = true;
        if (options.candidateCrashBackoffBeforeRecovery) phase = "candidate-crash-backoff";
        return known("unhealthy");
      }
      if (phase === "candidate-reload" && options.reloadCandidateHealthy === false) {
        forwardFailed = true;
        return known("unhealthy");
      }
      if (phase === "candidate-reload" && canonicalCommitted && options.postCommitHealthFailure && !forwardFailed) {
        forwardFailed = true;
        if (options.postCommitCandidateCrashBackoff) phase = "candidate-crash-backoff";
        else if (options.postCommitRuntimeAbsent) phase = "rollback-candidate-stopped";
        return known("unhealthy");
      }
      return known("healthy");
    },
    async waitReady(expectedEntrypoint) {
      calls.push(`ready:${phase}`);
      const launchd = await adapters.observeLaunchd();
      if (launchd.kind === "unproven" || !launchd.value.loaded || !launchd.value.pid) {
        return unproven("runtime is not ready");
      }
      const processState = await adapters.observeProcess(launchd.value.pid);
      if (processState.kind === "unproven") return processState;
      if (processState.value.entrypointRealpath !== expectedEntrypoint) {
        return unproven("runtime entrypoint mismatch");
      }
      const listener = await adapters.observeListener();
      if (
        listener.kind === "unproven"
        || listener.value.state !== "owned"
        || listener.value.ownerPid !== processState.value.pid
      ) {
        return unproven("runtime listener is not ready");
      }
      const health = await adapters.checkHealth();
      if (health.kind === "unproven" || health.value !== "healthy") {
        return unproven("runtime health is not ready");
      }
      return known(processState.value);
    },
    async bootoutExpected(expected) {
      calls.push(expected.pid === oldProcess.pid ? "OLD_STOP_REQUESTED" : "CANDIDATE_STOP_REQUESTED");
      if (expected.pid === oldProcess.pid && phase === "old") {
        if (!options.oldBootoutLeavesRuntime) phase = "stopped";
      }
      else if (expected.pid === candidateFirst.pid && phase === "candidate-first") phase = "candidate-first-stopped";
      else if (
        phase === "candidate-reload"
        && (expected.pid === candidateReload.pid || expected.pid === candidateReplacement.pid)
      ) {
        phase = "rollback-candidate-stopped";
      }
      else throw new Error("unexpected bootout target");
    },
    async bootoutInactiveCandidate(expectedArgv) {
      calls.push("INACTIVE_CANDIDATE_STOP_REQUESTED");
      if (
        phase !== "candidate-crash-backoff"
        || options.candidateCrashBackoffArgvDrift
        || expectedArgv.length !== candidateFirst.normalizedArgv.length
        || !expectedArgv.every((value, index) => value === candidateFirst.normalizedArgv[index])
      ) {
        throw new Error("inactive candidate definition mismatch");
      }
      phase = "rollback-candidate-stopped";
    },
    async bootstrap(plistPath) {
      if (forwardFailed && plistPath === canonicalIdentity.path) {
        calls.push("ROLLBACK_BOOTSTRAP_OLD");
        if (options.rollbackBootstrapFails) throw new Error("old bootstrap failed");
        phase = "old-restored";
        return;
      }
      if (phase === "stopped") {
        phase = "candidate-first";
        calls.push("CANDIDATE_STARTED");
      } else if (phase === "candidate-first-stopped") {
        phase = "candidate-reload";
        calls.push("CONTROLLED_RELOAD_STARTED");
      } else {
        throw new Error(`unexpected bootstrap phase ${phase}`);
      }
    },
    async observeDisabledOverride() {
      calls.push("persistence:disabled-override");
      return known(options.disabled ? "disabled" : "enabled");
    },
    async observeAncestors() {
      calls.push("ancestors");
      return known(options.selfHosted ? [oldProcess.pid, 1] : [1]);
    },
    async waitStopped(expected) {
      calls.push(expected.pid === oldProcess.pid ? "OLD_STOPPED_VERIFIED" : "CANDIDATE_STOPPED_VERIFIED");
      if (expected.pid === oldProcess.pid && options.oldStopBarrierThrows) {
        forwardFailed = true;
        throw new Error("stop barrier observation failed");
      }
      if (expected.pid === oldProcess.pid && options.oldBootoutLeavesRuntime) {
        forwardFailed = true;
        return unproven("old runtime remained active after bootout request");
      }
      return known("stopped");
    },
    async waitStable(expected) {
      calls.push(`stable:${expected.pid}`);
      return known("stable");
    },
    async readFileSha256(path) {
      calls.push(`file-hash:${path}`);
      if (path === canonicalIdentity.path) {
        if (forwardFailed && !canonicalCommitted && options.recoveryCanonicalDrift === "hash") {
          return known("e".repeat(64));
        }
        if (canonicalCommitted && rollbackTempPrepared && options.rollbackFinalCanonicalDrift) {
          return known("d".repeat(64));
        }
        return known(canonicalCommitted ? candidateSha : oldSha);
      }
      if (path === preparedTempPath && preparedTempKind === "old") {
        return known(options.rollbackOldTempDrift ? "c".repeat(64) : oldSha);
      }
      return known(candidateSha);
    },
    async observeFileIdentity(path) {
      calls.push(`file-identity:${path}`);
      if (path === canonicalIdentity.path) {
        if (forwardFailed && !canonicalCommitted && options.recoveryCanonicalDrift === "identity") {
          return known({ ...canonicalIdentity, mode: 0o600 });
        }
        return known(canonicalCommitted ? candidateCanonical.identity : canonicalIdentity);
      }
      if (path === parentIdentity.path) return known(parentIdentity);
      if (path === preparedTempPath && preparedTempKind === "old") {
        return known({
          ...canonicalIdentity,
          path,
          inode: 30,
          ...(options.rollbackOldTempDrift ? { mode: 0o600 } : {}),
        });
      }
      return known(canonicalIdentity);
    },
    async preflightDurability() { calls.push("durability:preflight"); },
  };

  return {
    request: {
      expectedLiveEntrypoint: oldEntrypoint,
      expectedLivePlistSha256: oldSha,
      candidateEntrypoint,
      candidateSlotManifestSha256: candidateManifest.sha256,
    },
    adapters,
    calls,
    lease,
    getReleaseCalls: () => releaseCalls,
  };
}

function forwardProcess(pid: number, entrypoint: string, generation: string): ProcessIdentity {
  return {
    pid,
    processStartIdentity: generation,
    executableRealpath: "/opt/homebrew/bin/node",
    normalizedArgv: ["/opt/homebrew/bin/node", entrypoint, "serve"],
    entrypointRealpath: entrypoint,
  };
}

rolloutTest("forward rollout verifies twice and commits only after pre-commit revalidation", async (t) => {
  const fixture = await createForwardFixture(t);
  const result = await runMacosLaunchdForwardPath(fixture.request, fixture.adapters);
  assert.equal(result.ok, true);
  assert.equal(result.committed, true);
  assert.equal(result.context.lease, fixture.lease, "forward result must retain the same kernel lease for Task 6");
  assert.equal(fixture.getReleaseCalls(), 0, "forward path must not release the transaction lock");
  assert.ok(fixture.calls.indexOf("OLD_STOPPED_VERIFIED") < fixture.calls.indexOf("CANDIDATE_STARTED"));
  assert.ok(fixture.calls.includes("ready:candidate-first"));
  assert.ok(fixture.calls.indexOf("CANDIDATE_STOPPED_VERIFIED") < fixture.calls.indexOf("CONTROLLED_RELOAD_STARTED"));
  assert.ok(fixture.calls.includes("ready:candidate-reload"));
  assert.ok(fixture.calls.indexOf("canonical:temp-prepared") < fixture.calls.indexOf("COMMITTED"));
  const commitIndex = fixture.calls.indexOf("COMMITTED");
  assert.ok(fixture.calls.slice(0, commitIndex).includes("health:candidate-reload"));
  assert.ok(fixture.calls.slice(0, commitIndex).includes("lock.assertOwned"));
  assert.ok(fixture.calls.includes("canonical:parent-synced"));
});

rolloutTest("forward rollout pre-commit failures never publish canonical and retain the lease", async (t) => {
  const cases: Array<{
    name: string;
    fixture: ForwardFixture;
    mutate?: (request: RolloutRequest) => RolloutRequest;
    expectedCode: string;
  }> = [];

  cases.push({
    name: "whole-plist mismatch",
    fixture: await createForwardFixture(t),
    mutate: (request) => ({ ...request, expectedLivePlistSha256: "0".repeat(64) }),
    expectedCode: "LIVE_STATE_CAS_MISMATCH",
  });
  cases.push({
    name: "disabled override",
    fixture: await createForwardFixture(t, { disabled: true }),
    expectedCode: "PERSISTENCE_CONTRACT_INVALID",
  });
  cases.push({
    name: "self hosted",
    fixture: await createForwardFixture(t, { selfHosted: true }),
    expectedCode: "SELF_HOSTED_ROLLOUT_REFUSED",
  });
  cases.push({
    name: "manifest mismatch",
    fixture: await createForwardFixture(t),
    mutate: (request) => ({ ...request, candidateSlotManifestSha256: "0".repeat(64) }),
    expectedCode: "CANDIDATE_ARTIFACT_MISMATCH",
  });
  cases.push({
    name: "candidate runtime preflight failure",
    fixture: await createForwardFixture(t, { candidatePreflightFails: true }),
    expectedCode: "CANDIDATE_ARTIFACT_MISMATCH",
  });
  cases.push({
    name: "old runtime generation drift",
    fixture: await createForwardFixture(t, { oldRuntimeDriftsBeforeStop: true }),
    expectedCode: "LIVE_STATE_CAS_MISMATCH",
  });
  cases.push({
    name: "wrong first candidate listener",
    fixture: await createForwardFixture(t, { firstCandidateListenerPid: 999 }),
    expectedCode: "PRECONDITION_FAILED",
  });
  cases.push({
    name: "first candidate health failure",
    fixture: await createForwardFixture(t, { firstCandidateHealthy: false }),
    expectedCode: "PRECONDITION_FAILED",
  });
  cases.push({
    name: "controlled reload health failure",
    fixture: await createForwardFixture(t, { reloadCandidateHealthy: false }),
    expectedCode: "PRECONDITION_FAILED",
  });
  cases.push({
    name: "pre-commit canonical drift",
    fixture: await createForwardFixture(t, { preCommitCanonicalDrift: true }),
    expectedCode: "LIVE_STATE_CAS_MISMATCH",
  });

  for (const entry of cases) {
    const request = entry.mutate ? entry.mutate(entry.fixture.request) : entry.fixture.request;
    const result = await runMacosLaunchdForwardPath(request, entry.fixture.adapters);
    assert.equal(result.ok, false, entry.name);
    assert.equal(result.code, entry.expectedCode, entry.name);
    assert.equal(result.committed, false, entry.name);
    assert.equal(entry.fixture.calls.includes("COMMITTED"), false, entry.name);
    assert.equal(result.context.lease, entry.fixture.lease, entry.name);
    assert.equal(entry.fixture.getReleaseCalls(), 0, `${entry.name}: forward path must retain the lock`);
  }
});

rolloutTest("candidate runtime preflight fails before the old production stop barrier", async (t) => {
  const fixture = await createForwardFixture(t, { candidatePreflightFails: true });
  const result = await runMacosLaunchdForwardPath(fixture.request, fixture.adapters);

  assert.equal(result.ok, false);
  assert.equal(result.phase, "precheck");
  assert.equal(result.code, "CANDIDATE_ARTIFACT_MISMATCH");
  assert.equal(result.context.liveMutationStarted, false);
  assert.equal(fixture.calls.includes("candidate:runtime-preflight"), true);
  assert.equal(fixture.calls.includes("OLD_STOP_REQUESTED"), false);
});

rolloutTest("initial state rejects a loaded runtime whose argv differs from canonical ProgramArguments", async (t) => {
  const fixture = await createForwardFixture(t, { canonicalArgvDrift: true });
  const result = await runMacosLaunchdForwardPath(fixture.request, fixture.adapters);

  assert.equal(result.ok, false);
  assert.equal(result.phase, "precheck");
  assert.equal(result.code, "SPLIT_STATE_DETECTED");
  assert.match(result.reason, /argv differs from canonical ProgramArguments/);
  assert.equal(fixture.calls.includes("candidate:runtime-preflight"), false);
  assert.equal(fixture.calls.includes("OLD_STOP_REQUESTED"), false);
});

rolloutTest("forward rollout re-qualifies a same-slot KeepAlive replacement before commit", async (t) => {
  const fixture = await createForwardFixture(t, { keepAliveReplacementBeforeCommit: true });
  const result = await runMacosLaunchdForwardPath(fixture.request, fixture.adapters);
  assert.equal(result.ok, true);
  assert.equal(result.committed, true);
  assert.equal(result.candidateProcess?.pid, 203);
  assert.equal(fixture.calls.includes("COMMITTED"), true);
});

rolloutTest("forward rollout preserves the lease when an adapter throws after old bootout", async (t) => {
  const fixture = await createForwardFixture(t, { oldStopBarrierThrows: true });
  const result = await runMacosLaunchdForwardPath(fixture.request, fixture.adapters);
  assert.equal(result.ok, false);
  assert.equal(result.phase, "old_stop");
  assert.equal(result.code, "PRECONDITION_FAILED");
  assert.equal(result.committed, false);
  assert.equal(result.context.lease, fixture.lease);
  assert.equal(fixture.getReleaseCalls(), 0);
});

rolloutTest("pre-commit recovery reuses an exact old runtime that survived the stop request", async (t) => {
  const fixture = await createForwardFixture(t, { oldBootoutLeavesRuntime: true });
  const outcome = await runMacosLaunchdRollout(fixture.request, fixture.adapters);

  assert.equal(outcome.code, "SWITCH_FAILED_ROLLBACK_OK");
  assert.equal(outcome.committed, false);
  assert.equal(fixture.calls.includes("ROLLBACK_BOOTSTRAP_OLD"), false);
  assert.equal(fixture.getReleaseCalls(), 1);
});

rolloutTest("pre-commit recovery stops an owned candidate then bootstraps the unchanged old canonical", async (t) => {
  const fixture = await createForwardFixture(t, { firstCandidateHealthy: false });
  const outcome = await runMacosLaunchdRollout(fixture.request, fixture.adapters);

  assert.equal(outcome.code, "SWITCH_FAILED_ROLLBACK_OK");
  assert.equal(outcome.committed, false);
  assert.equal(fixture.calls.includes("CANDIDATE_STOP_REQUESTED"), true);
  assert.equal(fixture.calls.includes("ROLLBACK_BOOTSTRAP_OLD"), true);
  assert.equal(fixture.calls.includes("ready:old-restored"), true);
  assert.equal(fixture.getReleaseCalls(), 1);
});

rolloutTest("pre-commit recovery unloads an exact crash-backoff candidate with no PID and restores old production", async (t) => {
  const fixture = await createForwardFixture(t, {
    firstCandidateHealthy: false,
    candidateCrashBackoffBeforeRecovery: true,
  });
  const outcome = await runMacosLaunchdRollout(fixture.request, fixture.adapters);

  assert.equal(outcome.code, "SWITCH_FAILED_ROLLBACK_OK");
  assert.equal(outcome.committed, false);
  assert.equal(fixture.calls.includes("INACTIVE_CANDIDATE_STOP_REQUESTED"), true);
  assert.equal(fixture.calls.includes("ROLLBACK_BOOTSTRAP_OLD"), true);
  assert.equal(fixture.calls.includes("ready:old-restored"), true);
  assert.equal(fixture.getReleaseCalls(), 1);
});

rolloutTest("pre-commit recovery refuses a no-PID launchd definition whose argv is not the exact candidate", async (t) => {
  const fixture = await createForwardFixture(t, {
    firstCandidateHealthy: false,
    candidateCrashBackoffBeforeRecovery: true,
    candidateCrashBackoffArgvDrift: true,
  });
  const outcome = await runMacosLaunchdRollout(fixture.request, fixture.adapters);

  assert.equal(outcome.code, "ROLLBACK_REFUSED_CONCURRENT_DRIFT");
  assert.equal(fixture.calls.includes("INACTIVE_CANDIDATE_STOP_REQUESTED"), false);
  assert.equal(fixture.calls.includes("ROLLBACK_BOOTSTRAP_OLD"), false);
  assert.equal(fixture.getReleaseCalls(), 1);
});

rolloutTest("pre-commit recovery retains the kernel lease until recovery completes", async (t) => {
  let enterRecovery!: () => void;
  let resumeRecovery!: () => void;
  const entered = new Promise<void>((resolve) => { enterRecovery = resolve; });
  const resume = new Promise<void>((resolve) => { resumeRecovery = resolve; });
  const fixture = await createForwardFixture(t, {
    firstCandidateHealthy: false,
    leaseOwnershipTracksRelease: true,
    recoveryBarrier: async () => {
      enterRecovery();
      await resume;
    },
  });

  const outcomePromise = runMacosLaunchdRollout(fixture.request, fixture.adapters);
  await entered;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const releaseCallsWhileRecoveryBlocked = fixture.getReleaseCalls();
  resumeRecovery();
  const outcome = await outcomePromise;

  assert.equal(releaseCallsWhileRecoveryBlocked, 0, "lease must remain held while pre-commit recovery is blocked");
  assert.equal(outcome.code, "SWITCH_FAILED_ROLLBACK_OK");
  assert.equal(fixture.getReleaseCalls(), 1);
  assert.ok(fixture.calls.indexOf("ROLLBACK_BOOTSTRAP_OLD") < fixture.calls.indexOf("lock.release"));
});

rolloutTest("pre-commit recovery skips bootout for confirmed candidate absence", async (t) => {
  const fixture = await createForwardFixture(t, { oldStopBarrierThrows: true });
  const outcome = await runMacosLaunchdRollout(fixture.request, fixture.adapters);

  assert.equal(outcome.code, "SWITCH_FAILED_ROLLBACK_OK");
  assert.equal(fixture.calls.includes("CANDIDATE_STOP_REQUESTED"), false);
  assert.equal(fixture.calls.includes("ROLLBACK_BOOTSTRAP_OLD"), true);
  assert.equal(fixture.getReleaseCalls(), 1);
});

rolloutTest("pre-commit recovery classifies concrete canonical/runtime drift separately from unproven state", async (t) => {
  const cases = [
    {
      name: "canonical hash drift",
      fixture: await createForwardFixture(t, {
        firstCandidateHealthy: false,
        recoveryCanonicalDrift: "hash",
      }),
      code: "ROLLBACK_REFUSED_CONCURRENT_DRIFT",
    },
    {
      name: "canonical file identity drift",
      fixture: await createForwardFixture(t, {
        firstCandidateHealthy: false,
        recoveryCanonicalDrift: "identity",
      }),
      code: "ROLLBACK_REFUSED_CONCURRENT_DRIFT",
    },
    {
      name: "canonical state unproven",
      fixture: await createForwardFixture(t, {
        firstCandidateHealthy: false,
        recoveryCanonicalDrift: "unproven",
      }),
      code: "ROLLBACK_REFUSED_UNPROVEN_STATE",
    },
    {
      name: "runtime state unproven",
      fixture: await createForwardFixture(t, {
        firstCandidateHealthy: false,
        recoveryRuntimeUnproven: true,
      }),
      code: "ROLLBACK_REFUSED_UNPROVEN_STATE",
    },
    {
      name: "unrelated listener owner",
      fixture: await createForwardFixture(t, { firstCandidateListenerPid: 999 }),
      code: "ROLLBACK_REFUSED_CONCURRENT_DRIFT",
    },
  ] as const;

  for (const entry of cases) {
    const outcome = await runMacosLaunchdRollout(entry.fixture.request, entry.fixture.adapters);
    assert.equal(outcome.code, entry.code, entry.name);
    assert.equal(entry.fixture.calls.includes("ROLLBACK_RESTORED_CANONICAL"), false, entry.name);
    assert.equal(entry.fixture.getReleaseCalls(), 1, entry.name);
  }
});

rolloutTest("post-commit qualification failure performs runtime-aware compensating rollback", async (t) => {
  const fixture = await createForwardFixture(t, { postCommitHealthFailure: true });
  const outcome = await runMacosLaunchdRollout(fixture.request, fixture.adapters);

  assert.equal(outcome.code, "SWITCH_FAILED_ROLLBACK_OK");
  assert.equal(outcome.committed, true, "candidate commit occurred before compensation");
  assert.equal(fixture.calls.includes("ROLLBACK_RESTORED_CANONICAL"), true);
  assert.equal(fixture.calls.includes("ROLLBACK_BOOTSTRAP_OLD"), true);
  assert.equal(fixture.getReleaseCalls(), 1);
});

rolloutTest("post-commit compensation unloads an exact crash-backoff candidate with no PID before restoring old canonical", async (t) => {
  const fixture = await createForwardFixture(t, {
    postCommitHealthFailure: true,
    postCommitCandidateCrashBackoff: true,
  });
  const outcome = await runMacosLaunchdRollout(fixture.request, fixture.adapters);

  assert.equal(outcome.code, "SWITCH_FAILED_ROLLBACK_OK");
  assert.equal(outcome.committed, true);
  assert.equal(fixture.calls.includes("INACTIVE_CANDIDATE_STOP_REQUESTED"), true);
  assert.equal(fixture.calls.includes("ROLLBACK_RESTORED_CANONICAL"), true);
  assert.equal(fixture.calls.includes("ROLLBACK_BOOTSTRAP_OLD"), true);
  assert.equal(fixture.getReleaseCalls(), 1);
});

rolloutTest("post-commit compensation retains the kernel lease until rollback completes", async (t) => {
  let enterRecovery!: () => void;
  let resumeRecovery!: () => void;
  const entered = new Promise<void>((resolve) => { enterRecovery = resolve; });
  const resume = new Promise<void>((resolve) => { resumeRecovery = resolve; });
  const fixture = await createForwardFixture(t, {
    postCommitHealthFailure: true,
    leaseOwnershipTracksRelease: true,
    recoveryBarrier: async () => {
      enterRecovery();
      await resume;
    },
  });

  const outcomePromise = runMacosLaunchdRollout(fixture.request, fixture.adapters);
  await entered;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const releaseCallsWhileRecoveryBlocked = fixture.getReleaseCalls();
  resumeRecovery();
  const outcome = await outcomePromise;

  assert.equal(releaseCallsWhileRecoveryBlocked, 0, "lease must remain held while post-commit compensation is blocked");
  assert.equal(outcome.code, "SWITCH_FAILED_ROLLBACK_OK");
  assert.equal(fixture.calls.includes("ROLLBACK_RESTORED_CANONICAL"), true);
  assert.equal(fixture.getReleaseCalls(), 1);
  assert.ok(fixture.calls.indexOf("ROLLBACK_BOOTSTRAP_OLD") < fixture.calls.indexOf("lock.release"));
});

rolloutTest("post-commit rollback accepts confirmed candidate absence without bootout", async (t) => {
  const fixture = await createForwardFixture(t, {
    postCommitHealthFailure: true,
    postCommitRuntimeAbsent: true,
  });
  const outcome = await runMacosLaunchdRollout(fixture.request, fixture.adapters);

  assert.equal(outcome.code, "SWITCH_FAILED_ROLLBACK_OK");
  const candidateStops = fixture.calls.filter((call) => call === "CANDIDATE_STOP_REQUESTED");
  assert.equal(candidateStops.length, 1, "only the controlled-reload stop should occur");
  assert.equal(fixture.calls.includes("ROLLBACK_RESTORED_CANONICAL"), true);
  assert.equal(fixture.getReleaseCalls(), 1);
});

rolloutTest("post-commit rollback refuses concrete drift and distinguishes unproven lock state", async (t) => {
  const cases = [
    {
      name: "unexpected same-label runtime",
      fixture: await createForwardFixture(t, { postCommitHealthFailure: true, postCommitRuntimeDrift: true }),
      code: "ROLLBACK_REFUSED_CONCURRENT_DRIFT",
    },
    {
      name: "unrelated listener",
      fixture: await createForwardFixture(t, { postCommitHealthFailure: true, postCommitUnrelatedListener: true }),
      code: "ROLLBACK_REFUSED_CONCURRENT_DRIFT",
    },
    {
      name: "lock or owner nonce drift",
      fixture: await createForwardFixture(t, { postCommitHealthFailure: true, postCommitLockDrift: true }),
      code: "ROLLBACK_REFUSED_CONCURRENT_DRIFT",
    },
    {
      name: "lock state unproven",
      fixture: await createForwardFixture(t, { postCommitHealthFailure: true, postCommitLockUnproven: true }),
      code: "ROLLBACK_REFUSED_UNPROVEN_STATE",
    },
  ] as const;

  for (const entry of cases) {
    const outcome = await runMacosLaunchdRollout(entry.fixture.request, entry.fixture.adapters);
    assert.equal(outcome.code, entry.code, entry.name);
    assert.equal(entry.fixture.calls.includes("ROLLBACK_RESTORED_CANONICAL"), false, entry.name);
    assert.equal(entry.fixture.getReleaseCalls(), 1, entry.name);
  }
});

rolloutTest("rollback final revalidation refuses drift after initial eligibility and before restore rename", async (t) => {
  const canonicalDrift = await createForwardFixture(t, {
    postCommitHealthFailure: true,
    rollbackFinalCanonicalDrift: true,
  });
  const canonicalOutcome = await runMacosLaunchdRollout(canonicalDrift.request, canonicalDrift.adapters);
  assert.equal(canonicalOutcome.code, "ROLLBACK_REFUSED_CONCURRENT_DRIFT");
  assert.equal(canonicalDrift.calls.includes("rollback:old-temp-prepared"), true);
  assert.equal(canonicalDrift.calls.includes("ROLLBACK_RESTORED_CANONICAL"), false);
  assert.equal(canonicalDrift.getReleaseCalls(), 1);

  const tempDrift = await createForwardFixture(t, {
    postCommitHealthFailure: true,
    rollbackOldTempDrift: true,
  });
  const tempOutcome = await runMacosLaunchdRollout(tempDrift.request, tempDrift.adapters);
  assert.equal(tempOutcome.code, "ROLLBACK_REFUSED_CONCURRENT_DRIFT");
  assert.equal(tempDrift.calls.includes("rollback:old-temp-prepared"), true);
  assert.equal(tempDrift.calls.includes("ROLLBACK_RESTORED_CANONICAL"), false);
  assert.equal(tempDrift.getReleaseCalls(), 1);
});

rolloutTest("rollback reports failure when old canonical cannot be bootstrapped after an eligible recovery", async (t) => {
  const fixture = await createForwardFixture(t, {
    firstCandidateHealthy: false,
    rollbackBootstrapFails: true,
  });
  const outcome = await runMacosLaunchdRollout(fixture.request, fixture.adapters);

  assert.equal(outcome.code, "SWITCH_FAILED_ROLLBACK_FAILED");
  assert.equal(fixture.getReleaseCalls(), 1);
});

rolloutTest("public rollout acknowledges a verified candidate and releases the kernel lease", async (t) => {
  const fixture = await createForwardFixture(t);
  const outcome = await runMacosLaunchdRollout(fixture.request, fixture.adapters);
  assert.equal(outcome.code, "ROLLOUT_OK");
  assert.equal(outcome.committed, true);
  assert.equal(outcome.controlledReload, "PASS");
  assert.equal(outcome.persistenceStaticContract, "PASS");
  assert.equal(fixture.getReleaseCalls(), 1);
});

rolloutTest("public rollout preserves typed lock acquisition failures", async (t) => {
  for (const code of ["LOCK_BUSY", "LOCK_AMBIGUOUS"] as const) {
    const fixture = await createForwardFixture(t);
    fixture.adapters.acquireLock = async () => {
      const error = new Error(code) as Error & { code: typeof code };
      error.code = code;
      throw error;
    };
    const outcome = await runMacosLaunchdRollout(fixture.request, fixture.adapters);
    assert.equal(outcome.code, code);
    assert.equal(outcome.committed, false);
    assert.equal(fixture.getReleaseCalls(), 0);
  }
});
