import { createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RolloutLockLease } from "./macos-launchd-rollout-lock.js";
import {
  resolveCandidateSlotRoot,
  verifyCandidateSlotManifest,
} from "./macos-launchd-rollout-manifest.js";

export type RolloutResultCode =
  | "ROLLOUT_OK"
  | "PRECONDITION_FAILED"
  | "PERSISTENCE_CONTRACT_INVALID"
  | "CANDIDATE_ARTIFACT_MISMATCH"
  | "LIVE_STATE_CAS_MISMATCH"
  | "SPLIT_STATE_DETECTED"
  | "LOCK_BUSY"
  | "LOCK_AMBIGUOUS"
  | "SELF_HOSTED_ROLLOUT_REFUSED"
  | "SWITCH_FAILED_ROLLBACK_OK"
  | "SWITCH_FAILED_ROLLBACK_FAILED"
  | "ROLLBACK_REFUSED_CONCURRENT_DRIFT"
  | "ROLLBACK_REFUSED_UNPROVEN_STATE";

export interface RolloutRequest {
  expectedLiveEntrypoint: string;
  expectedLivePlistSha256: string;
  candidateEntrypoint: string;
  candidateSlotManifestSha256: string;
}

export interface LaunchdObservation {
  loaded: boolean;
  pid?: number;
  runCount?: number;
  normalizedArgv?: string[];
}

export interface ListenerObservation {
  state: "unowned" | "owned";
  ownerPid?: number;
}

export interface CanonicalPlistSnapshot {
  bytes: Buffer;
  sha256: string;
  identity: FileIdentity;
  parentIdentity: FileIdentity;
  entrypointRealpath: string;
  runAtLoad: boolean;
  keepAlive: boolean;
}

export interface PreparedCanonicalTemp {
  path: string;
  sha256: string;
  identity: FileIdentity;
}

export interface MacosRolloutAdapters {
  acquireLock(input: {
    transactionId: string;
    transactionNonce: string;
  }): Promise<RolloutLockLease>;
  readCanonical(): Promise<ObservedState<CanonicalPlistSnapshot>>;
  validateCandidateEntrypoint(path: string): Promise<void>;
  createCandidatePlist(oldBytes: Buffer, candidateEntrypoint: string): Promise<Buffer>;
  writeOldBackup(input: {
    transactionDir: string;
    bytes: Buffer;
    sha256: string;
    uid: number;
    gid: number;
    mode: number;
  }): Promise<void>;
  writeCandidateEvidence(input: {
    transactionDir: string;
    plistBytes: Buffer;
    plistSha256: string;
    manifestSha256: string;
  }): Promise<void>;
  prepareCanonicalTemp(input: {
    transactionNonce: string;
    bytes: Buffer;
    expectedSha256: string;
    uid: number;
    gid: number;
    mode: number;
  }): Promise<PreparedCanonicalTemp>;
  atomicReplaceCanonical(tempPath: string): Promise<void>;
  syncCanonicalParent(): Promise<void>;
  observeLaunchd(): Promise<ObservedState<LaunchdObservation>>;
  observeProcess(pid: number): Promise<ObservedState<ProcessIdentity>>;
  observeListener(): Promise<ObservedState<ListenerObservation>>;
  checkHealth(): Promise<ObservedState<"healthy" | "unhealthy">>;
  bootoutExpected(expected: ProcessIdentity): Promise<void>;
  bootstrap(plistPath: string): Promise<void>;
  observeDisabledOverride(): Promise<ObservedState<"enabled" | "disabled">>;
  observeAncestors(pid: number): Promise<ObservedState<number[]>>;
  waitStopped(expected: ProcessIdentity): Promise<ObservedState<"stopped">>;
  waitStable(expected: ProcessIdentity): Promise<ObservedState<"stable">>;
  readFileSha256(path: string): Promise<ObservedState<string>>;
  preflightDurability(): Promise<void>;
}

export interface ProcessIdentity {
  pid: number;
  processStartIdentity: string;
  executableRealpath: string;
  normalizedArgv: string[];
  entrypointRealpath: string;
}

export interface FileIdentity {
  path: string;
  uid: number;
  gid: number;
  mode: number;
  device: number;
  inode: number;
  kind: "file" | "directory";
  symlink: boolean;
}

export type ObservedState<T> =
  | { kind: "known"; value: T }
  | { kind: "unproven"; reason: string };

export type RollbackRefusal =
  | "ROLLBACK_REFUSED_CONCURRENT_DRIFT"
  | "ROLLBACK_REFUSED_UNPROVEN_STATE";

export interface RollbackClassificationInput {
  canonical: ObservedState<"expected" | "drift">;
  runtime: ObservedState<"expected" | "absent" | "drift">;
  listener: ObservedState<"expected" | "unowned" | "drift">;
  lock: ObservedState<"owned" | "drift">;
  ownerRecord: ObservedState<"ours" | "drift">;
}

export interface InitialRolloutState {
  canonical: CanonicalPlistSnapshot;
  launchd: LaunchdObservation;
  process: ProcessIdentity;
}

export interface ForwardTransactionContext {
  transactionId: string;
  transactionNonce: string;
  transactionDir: string;
  candidatePlistPath: string;
  lease: RolloutLockLease;
  initial?: InitialRolloutState;
  candidatePlistBytes?: Buffer;
  candidatePlistSha256?: string;
}

export type ForwardRolloutFailurePhase =
  | "precheck"
  | "old_stop"
  | "candidate_first_start"
  | "candidate_first_verify"
  | "candidate_controlled_stop"
  | "candidate_reload"
  | "pre_commit_revalidation"
  | "post_commit_verification";

export interface ForwardRolloutFailure {
  ok: false;
  phase: ForwardRolloutFailurePhase;
  code:
    | "PRECONDITION_FAILED"
    | "PERSISTENCE_CONTRACT_INVALID"
    | "CANDIDATE_ARTIFACT_MISMATCH"
    | "LIVE_STATE_CAS_MISMATCH"
    | "SPLIT_STATE_DETECTED"
    | "SELF_HOSTED_ROLLOUT_REFUSED";
  committed: boolean;
  context: ForwardTransactionContext;
  initial?: InitialRolloutState;
  candidateProcess?: ProcessIdentity;
  candidateCanonicalSha256?: string;
  reason: string;
}

export interface ForwardRolloutSuccess {
  ok: true;
  committed: true;
  context: ForwardTransactionContext;
  candidateProcess: ProcessIdentity;
  candidateCanonicalSha256: string;
}

export type ForwardRolloutResult = ForwardRolloutSuccess | ForwardRolloutFailure;

export function classifyRollbackRefusal(
  input: RollbackClassificationInput,
): RollbackRefusal | undefined {
  if (
    (input.canonical.kind === "known" && input.canonical.value === "drift")
    || (input.runtime.kind === "known" && input.runtime.value === "drift")
    || (input.listener.kind === "known" && input.listener.value === "drift")
    || (input.lock.kind === "known" && input.lock.value === "drift")
    || (input.ownerRecord.kind === "known" && input.ownerRecord.value === "drift")
  ) {
    return "ROLLBACK_REFUSED_CONCURRENT_DRIFT";
  }
  if (
    input.canonical.kind === "unproven"
    || input.runtime.kind === "unproven"
    || input.listener.kind === "unproven"
    || input.lock.kind === "unproven"
    || input.ownerRecord.kind === "unproven"
  ) {
    return "ROLLBACK_REFUSED_UNPROVEN_STATE";
  }
  return undefined;
}

export async function runMacosLaunchdForwardPath(
  request: RolloutRequest,
  adapters: MacosRolloutAdapters,
): Promise<ForwardRolloutResult> {
  const transactionId = randomUUID();
  const transactionNonce = randomBytes(16).toString("hex");
  const transactionDir = resolveTransactionDir(transactionId);
  const candidatePlistPath = join(transactionDir, "candidate.plist");
  const lease = await adapters.acquireLock({ transactionId, transactionNonce });
  const context: ForwardTransactionContext = {
    transactionId,
    transactionNonce,
    transactionDir,
    candidatePlistPath,
    lease,
  };

  const initialResult = await readAndValidateInitialState({ request, adapters });
  if (!initialResult.ok) {
    return forwardFailure(context, "precheck", initialResult.code, initialResult.reason);
  }
  const initial = initialResult.value;
  context.initial = initial;

  const ancestry = await adapters.observeAncestors(process.pid);
  if (ancestry.kind === "unproven") {
    return forwardFailure(context, "precheck", "PRECONDITION_FAILED", ancestry.reason, { initial });
  }
  if (ancestry.value.includes(initial.process.pid)) {
    return forwardFailure(
      context,
      "precheck",
      "SELF_HOSTED_ROLLOUT_REFUSED",
      "live DevSpace is an ancestor of the rollout helper",
      { initial },
    );
  }

  try {
    await adapters.preflightDurability();
  } catch (error) {
    return forwardFailure(context, "precheck", "PRECONDITION_FAILED", errorMessage(error), { initial });
  }

  try {
    await adapters.validateCandidateEntrypoint(request.candidateEntrypoint);
    const candidateSlotRoot = resolveCandidateSlotRoot(request.candidateEntrypoint);
    await verifyCandidateSlotManifest(candidateSlotRoot, request.candidateSlotManifestSha256);
  } catch (error) {
    return forwardFailure(context, "precheck", "CANDIDATE_ARTIFACT_MISMATCH", errorMessage(error), { initial });
  }

  try {
    await adapters.writeOldBackup({
      transactionDir,
      bytes: initial.canonical.bytes,
      sha256: initial.canonical.sha256,
      uid: initial.canonical.identity.uid,
      gid: initial.canonical.identity.gid,
      mode: initial.canonical.identity.mode,
    });
  } catch (error) {
    return forwardFailure(context, "precheck", "PRECONDITION_FAILED", errorMessage(error), { initial });
  }

  let candidatePlistBytes: Buffer;
  let candidatePlistSha256: string;
  try {
    candidatePlistBytes = await adapters.createCandidatePlist(
      initial.canonical.bytes,
      request.candidateEntrypoint,
    );
    candidatePlistSha256 = createHash("sha256").update(candidatePlistBytes).digest("hex");
    context.candidatePlistBytes = candidatePlistBytes;
    context.candidatePlistSha256 = candidatePlistSha256;
    await adapters.writeCandidateEvidence({
      transactionDir,
      plistBytes: candidatePlistBytes,
      plistSha256: candidatePlistSha256,
      manifestSha256: request.candidateSlotManifestSha256,
    });
    const stagedHash = await adapters.readFileSha256(candidatePlistPath);
    if (stagedHash.kind === "unproven" || stagedHash.value !== candidatePlistSha256) {
      return forwardFailure(
        context,
        "precheck",
        "CANDIDATE_ARTIFACT_MISMATCH",
        stagedHash.kind === "unproven" ? stagedHash.reason : "staged candidate plist hash mismatch",
        { initial },
      );
    }
  } catch (error) {
    return forwardFailure(context, "precheck", "CANDIDATE_ARTIFACT_MISMATCH", errorMessage(error), { initial });
  }

  const beforeStop = await revalidateBeforeOldStop({ initial, request, adapters });
  if (!beforeStop.ok) {
    return forwardFailure(context, "old_stop", beforeStop.code, beforeStop.reason, { initial });
  }
  try {
    await adapters.bootoutExpected(initial.process);
  } catch (error) {
    return forwardFailure(context, "old_stop", "LIVE_STATE_CAS_MISMATCH", errorMessage(error), { initial });
  }
  let oldStopped: ObservedState<"stopped">;
  try {
    oldStopped = await adapters.waitStopped(initial.process);
  } catch (error) {
    return forwardFailure(context, "old_stop", "PRECONDITION_FAILED", errorMessage(error), { initial });
  }
  if (oldStopped.kind === "unproven") {
    return forwardFailure(context, "old_stop", "LIVE_STATE_CAS_MISMATCH", oldStopped.reason, { initial });
  }

  try {
    await adapters.bootstrap(candidatePlistPath);
  } catch (error) {
    return forwardFailure(context, "candidate_first_start", "PRECONDITION_FAILED", errorMessage(error), { initial });
  }
  const firstCandidate = await verifyCandidateRuntime({
    candidateEntrypoint: request.candidateEntrypoint,
    candidatePlistPath,
    candidatePlistSha256,
    adapters,
  });
  if (!firstCandidate.ok) {
    return forwardFailure(context, "candidate_first_verify", "PRECONDITION_FAILED", firstCandidate.reason, { initial });
  }

  try {
    await adapters.bootoutExpected(firstCandidate.process);
  } catch (error) {
    return forwardFailure(
      context,
      "candidate_controlled_stop",
      "PRECONDITION_FAILED",
      errorMessage(error),
      { initial, candidateProcess: firstCandidate.process },
    );
  }
  let candidateStopped: ObservedState<"stopped">;
  try {
    candidateStopped = await adapters.waitStopped(firstCandidate.process);
  } catch (error) {
    return forwardFailure(
      context,
      "candidate_controlled_stop",
      "PRECONDITION_FAILED",
      errorMessage(error),
      { initial, candidateProcess: firstCandidate.process },
    );
  }
  if (candidateStopped.kind === "unproven") {
    return forwardFailure(
      context,
      "candidate_controlled_stop",
      "PRECONDITION_FAILED",
      candidateStopped.reason,
      { initial, candidateProcess: firstCandidate.process },
    );
  }

  const stagedBeforeReload = await adapters.readFileSha256(candidatePlistPath);
  if (stagedBeforeReload.kind === "unproven" || stagedBeforeReload.value !== candidatePlistSha256) {
    return forwardFailure(
      context,
      "candidate_reload",
      "CANDIDATE_ARTIFACT_MISMATCH",
      stagedBeforeReload.kind === "unproven" ? stagedBeforeReload.reason : "candidate plist changed before controlled reload",
      { initial, candidateProcess: firstCandidate.process },
    );
  }
  try {
    await adapters.bootstrap(candidatePlistPath);
  } catch (error) {
    return forwardFailure(
      context,
      "candidate_reload",
      "PRECONDITION_FAILED",
      errorMessage(error),
      { initial, candidateProcess: firstCandidate.process },
    );
  }
  const reloadedCandidate = await verifyCandidateRuntime({
    candidateEntrypoint: request.candidateEntrypoint,
    candidatePlistPath,
    candidatePlistSha256,
    adapters,
  });
  if (!reloadedCandidate.ok) {
    return forwardFailure(
      context,
      "candidate_reload",
      "PRECONDITION_FAILED",
      reloadedCandidate.reason,
      { initial, candidateProcess: firstCandidate.process },
    );
  }

  const preCommit = await preCommitRevalidate({
    request,
    initial,
    candidatePlistPath,
    candidatePlistSha256,
    lease,
    adapters,
  });
  if (!preCommit.ok) {
    return forwardFailure(
      context,
      "pre_commit_revalidation",
      preCommit.code,
      preCommit.reason,
      { initial, candidateProcess: reloadedCandidate.process },
    );
  }
  let candidateForCommit = preCommit.process;

  let prepared: PreparedCanonicalTemp;
  try {
    prepared = await adapters.prepareCanonicalTemp({
      transactionNonce,
      bytes: candidatePlistBytes,
      expectedSha256: candidatePlistSha256,
      uid: initial.canonical.identity.uid,
      gid: initial.canonical.identity.gid,
      mode: initial.canonical.identity.mode,
    });
  } catch (error) {
    return forwardFailure(
      context,
      "pre_commit_revalidation",
      "PRECONDITION_FAILED",
      errorMessage(error),
      { initial, candidateProcess: reloadedCandidate.process },
    );
  }
  if (prepared.sha256 !== candidatePlistSha256) {
    return forwardFailure(
      context,
      "pre_commit_revalidation",
      "CANDIDATE_ARTIFACT_MISMATCH",
      "prepared canonical temp does not match candidate plist hash",
      { initial, candidateProcess: reloadedCandidate.process },
    );
  }

  const immediatelyBeforeCommit = await preCommitRevalidate({
    request,
    initial,
    candidatePlistPath,
    candidatePlistSha256,
    lease,
    adapters,
  });
  if (!immediatelyBeforeCommit.ok) {
    return forwardFailure(
      context,
      "pre_commit_revalidation",
      immediatelyBeforeCommit.code,
      immediatelyBeforeCommit.reason,
      { initial, candidateProcess: reloadedCandidate.process },
    );
  }
  candidateForCommit = immediatelyBeforeCommit.process;
  try {
    await adapters.atomicReplaceCanonical(prepared.path);
  } catch (error) {
    return forwardFailure(
      context,
      "pre_commit_revalidation",
      "PRECONDITION_FAILED",
      errorMessage(error),
      { initial, candidateProcess: reloadedCandidate.process },
    );
  }

  try {
    await adapters.syncCanonicalParent();
  } catch (error) {
    return forwardFailure(
      context,
      "post_commit_verification",
      "PRECONDITION_FAILED",
      errorMessage(error),
      {
        initial,
        candidateProcess: candidateForCommit,
        candidateCanonicalSha256: candidatePlistSha256,
        committed: true,
      },
    );
  }
  const postCommit = await postCommitVerify({
    candidateEntrypoint: request.candidateEntrypoint,
    candidateCanonicalSha256: candidatePlistSha256,
    initial,
    adapters,
  });
  if (!postCommit.ok) {
    return forwardFailure(
      context,
      "post_commit_verification",
      "PRECONDITION_FAILED",
      postCommit.reason,
      {
        initial,
        candidateProcess: candidateForCommit,
        candidateCanonicalSha256: candidatePlistSha256,
        committed: true,
      },
    );
  }

  return {
    ok: true,
    committed: true,
    context,
    candidateProcess: postCommit.process,
    candidateCanonicalSha256: candidatePlistSha256,
  };
}

function resolveTransactionDir(transactionId: string): string {
  return join(homedir(), ".devspace", "rollout", "transactions", transactionId);
}

async function readAndValidateInitialState(input: {
  request: RolloutRequest;
  adapters: MacosRolloutAdapters;
}): Promise<
  | { ok: true; value: InitialRolloutState }
  | { ok: false; code: ForwardRolloutFailure["code"]; reason: string }
> {
  const canonical = await input.adapters.readCanonical();
  if (canonical.kind === "unproven") {
    return { ok: false, code: "PRECONDITION_FAILED", reason: canonical.reason };
  }
  if (canonical.value.sha256 !== input.request.expectedLivePlistSha256) {
    return { ok: false, code: "LIVE_STATE_CAS_MISMATCH", reason: "canonical plist hash differs from expected live hash" };
  }
  if (canonical.value.entrypointRealpath !== input.request.expectedLiveEntrypoint) {
    return { ok: false, code: "LIVE_STATE_CAS_MISMATCH", reason: "canonical entrypoint differs from expected live entrypoint" };
  }
  if (!canonical.value.runAtLoad || !canonical.value.keepAlive) {
    return { ok: false, code: "PERSISTENCE_CONTRACT_INVALID", reason: "canonical persistence flags are not enabled" };
  }

  const disabled = await input.adapters.observeDisabledOverride();
  if (disabled.kind === "unproven") {
    return { ok: false, code: "PRECONDITION_FAILED", reason: disabled.reason };
  }
  if (disabled.value === "disabled") {
    return { ok: false, code: "PERSISTENCE_CONTRACT_INVALID", reason: "launchd service has a persistent disabled override" };
  }

  const launchd = await input.adapters.observeLaunchd();
  if (launchd.kind === "unproven") return { ok: false, code: "PRECONDITION_FAILED", reason: launchd.reason };
  if (!launchd.value.loaded || !launchd.value.pid) {
    return { ok: false, code: "SPLIT_STATE_DETECTED", reason: "canonical old definition exists but launchd service is not loaded" };
  }
  const processState = await input.adapters.observeProcess(launchd.value.pid);
  if (processState.kind === "unproven") return { ok: false, code: "PRECONDITION_FAILED", reason: processState.reason };
  if (processState.value.entrypointRealpath !== input.request.expectedLiveEntrypoint) {
    return { ok: false, code: "SPLIT_STATE_DETECTED", reason: "loaded runtime entrypoint differs from canonical expected entrypoint" };
  }
  const listener = await input.adapters.observeListener();
  if (listener.kind === "unproven") return { ok: false, code: "PRECONDITION_FAILED", reason: listener.reason };
  if (listener.value.state !== "owned" || listener.value.ownerPid !== processState.value.pid) {
    return { ok: false, code: "SPLIT_STATE_DETECTED", reason: "live listener is not owned by the expected old runtime" };
  }
  const health = await input.adapters.checkHealth();
  if (health.kind === "unproven") return { ok: false, code: "PRECONDITION_FAILED", reason: health.reason };
  if (health.value !== "healthy") return { ok: false, code: "PRECONDITION_FAILED", reason: "old live runtime is unhealthy" };
  return {
    ok: true,
    value: {
      canonical: canonical.value,
      launchd: launchd.value,
      process: processState.value,
    },
  };
}

async function revalidateBeforeOldStop(input: {
  initial: InitialRolloutState;
  request: RolloutRequest;
  adapters: MacosRolloutAdapters;
}): Promise<{ ok: true } | { ok: false; code: "LIVE_STATE_CAS_MISMATCH"; reason: string }> {
  const canonical = await input.adapters.readCanonical();
  if (canonical.kind === "unproven") return { ok: false, code: "LIVE_STATE_CAS_MISMATCH", reason: canonical.reason };
  if (
    canonical.value.sha256 !== input.request.expectedLivePlistSha256
    || canonical.value.sha256 !== input.initial.canonical.sha256
    || canonical.value.entrypointRealpath !== input.initial.canonical.entrypointRealpath
  ) {
    return { ok: false, code: "LIVE_STATE_CAS_MISMATCH", reason: "canonical state changed before old-service stop" };
  }
  const launchd = await input.adapters.observeLaunchd();
  if (launchd.kind === "unproven" || !launchd.value.loaded || launchd.value.pid !== input.initial.process.pid) {
    return { ok: false, code: "LIVE_STATE_CAS_MISMATCH", reason: launchd.kind === "unproven" ? launchd.reason : "launchd generation changed before old-service stop" };
  }
  const processState = await input.adapters.observeProcess(input.initial.process.pid);
  if (processState.kind === "unproven" || !sameProcessIdentity(processState.value, input.initial.process)) {
    return { ok: false, code: "LIVE_STATE_CAS_MISMATCH", reason: processState.kind === "unproven" ? processState.reason : "process generation changed before old-service stop" };
  }
  const listener = await input.adapters.observeListener();
  if (listener.kind === "unproven" || listener.value.state !== "owned" || listener.value.ownerPid !== input.initial.process.pid) {
    return { ok: false, code: "LIVE_STATE_CAS_MISMATCH", reason: listener.kind === "unproven" ? listener.reason : "listener ownership changed before old-service stop" };
  }
  return { ok: true };
}

async function verifyCandidateRuntime(input: {
  candidateEntrypoint: string;
  candidatePlistPath: string;
  candidatePlistSha256: string;
  adapters: MacosRolloutAdapters;
}): Promise<{ ok: true; process: ProcessIdentity } | { ok: false; reason: string }> {
  const stagedHash = await input.adapters.readFileSha256(input.candidatePlistPath);
  if (stagedHash.kind === "unproven") return { ok: false, reason: stagedHash.reason };
  if (stagedHash.value !== input.candidatePlistSha256) return { ok: false, reason: "staged candidate plist hash changed" };
  const qualified = await observeHealthyCandidateRuntime(input.candidateEntrypoint, input.adapters);
  if (!qualified.ok) return qualified;
  const hashAfterStability = await input.adapters.readFileSha256(input.candidatePlistPath);
  if (hashAfterStability.kind === "unproven") return { ok: false, reason: hashAfterStability.reason };
  if (hashAfterStability.value !== input.candidatePlistSha256) {
    return { ok: false, reason: "candidate plist changed during stability observation" };
  }
  return qualified;
}

async function preCommitRevalidate(input: {
  request: RolloutRequest;
  initial: InitialRolloutState;
  candidatePlistPath: string;
  candidatePlistSha256: string;
  lease: RolloutLockLease;
  adapters: MacosRolloutAdapters;
}): Promise<
  | { ok: true; process: ProcessIdentity }
  | { ok: false; code: "LIVE_STATE_CAS_MISMATCH" | "CANDIDATE_ARTIFACT_MISMATCH" | "PRECONDITION_FAILED"; reason: string }
> {
  const lock = await input.lease.assertOwned();
  if (lock.kind === "unproven") {
    return { ok: false, code: "PRECONDITION_FAILED", reason: lock.reason };
  }
  if (lock.value !== "owned") {
    return { ok: false, code: "LIVE_STATE_CAS_MISMATCH", reason: "rollout kernel lock ownership changed before commit" };
  }
  const canonical = await input.adapters.readCanonical();
  if (canonical.kind === "unproven") return { ok: false, code: "LIVE_STATE_CAS_MISMATCH", reason: canonical.reason };
  if (
    canonical.value.sha256 !== input.request.expectedLivePlistSha256
    || canonical.value.sha256 !== input.initial.canonical.sha256
    || canonical.value.entrypointRealpath !== input.initial.canonical.entrypointRealpath
  ) {
    return { ok: false, code: "LIVE_STATE_CAS_MISMATCH", reason: "old canonical changed before commit" };
  }
  const stagedHash = await input.adapters.readFileSha256(input.candidatePlistPath);
  if (stagedHash.kind === "unproven") return { ok: false, code: "CANDIDATE_ARTIFACT_MISMATCH", reason: stagedHash.reason };
  if (stagedHash.value !== input.candidatePlistSha256) return { ok: false, code: "CANDIDATE_ARTIFACT_MISMATCH", reason: "staged candidate plist changed before commit" };
  const qualified = await observeHealthyCandidateRuntime(input.request.candidateEntrypoint, input.adapters);
  if (!qualified.ok) {
    return { ok: false, code: "LIVE_STATE_CAS_MISMATCH", reason: qualified.reason };
  }
  return { ok: true, process: qualified.process };
}

async function postCommitVerify(input: {
  candidateEntrypoint: string;
  candidateCanonicalSha256: string;
  initial: InitialRolloutState;
  adapters: MacosRolloutAdapters;
}): Promise<{ ok: true; process: ProcessIdentity } | { ok: false; reason: string }> {
  const canonical = await input.adapters.readCanonical();
  if (canonical.kind === "unproven") return { ok: false, reason: canonical.reason };
  if (
    canonical.value.sha256 !== input.candidateCanonicalSha256
    || canonical.value.entrypointRealpath !== input.candidateEntrypoint
    || !canonical.value.runAtLoad
    || !canonical.value.keepAlive
    || canonical.value.identity.uid !== input.initial.canonical.identity.uid
    || canonical.value.identity.gid !== input.initial.canonical.identity.gid
    || canonical.value.identity.mode !== input.initial.canonical.identity.mode
  ) {
    return { ok: false, reason: "committed canonical definition does not match the verified candidate contract" };
  }
  const disabled = await input.adapters.observeDisabledOverride();
  if (disabled.kind === "unproven") return { ok: false, reason: disabled.reason };
  if (disabled.value === "disabled") return { ok: false, reason: "committed service became persistently disabled" };
  return observeHealthyCandidateRuntime(input.candidateEntrypoint, input.adapters);
}

async function observeHealthyCandidateRuntime(
  candidateEntrypoint: string,
  adapters: MacosRolloutAdapters,
): Promise<{ ok: true; process: ProcessIdentity } | { ok: false; reason: string }> {
  const launchd = await adapters.observeLaunchd();
  if (launchd.kind === "unproven") return { ok: false, reason: launchd.reason };
  if (!launchd.value.loaded || !launchd.value.pid) return { ok: false, reason: "candidate launchd job is not loaded" };
  const processState = await adapters.observeProcess(launchd.value.pid);
  if (processState.kind === "unproven") return { ok: false, reason: processState.reason };
  if (processState.value.entrypointRealpath !== candidateEntrypoint) {
    return { ok: false, reason: "candidate process entrypoint does not match requested candidate" };
  }
  const listener = await adapters.observeListener();
  if (listener.kind === "unproven") return { ok: false, reason: listener.reason };
  if (listener.value.state !== "owned" || listener.value.ownerPid !== processState.value.pid) {
    return { ok: false, reason: "candidate listener is not owned by the candidate PID" };
  }
  const health = await adapters.checkHealth();
  if (health.kind === "unproven") return { ok: false, reason: health.reason };
  if (health.value !== "healthy") return { ok: false, reason: "candidate health check failed" };
  const stable = await adapters.waitStable(processState.value);
  if (stable.kind === "unproven") return { ok: false, reason: stable.reason };
  return { ok: true, process: processState.value };
}

function forwardFailure(
  context: ForwardTransactionContext,
  phase: ForwardRolloutFailurePhase,
  code: ForwardRolloutFailure["code"],
  reason: string,
  extra: {
    initial?: InitialRolloutState;
    candidateProcess?: ProcessIdentity;
    candidateCanonicalSha256?: string;
    committed?: boolean;
  } = {},
): ForwardRolloutFailure {
  return {
    ok: false,
    phase,
    code,
    committed: extra.committed ?? false,
    context,
    ...(extra.initial ? { initial: extra.initial } : {}),
    ...(extra.candidateProcess ? { candidateProcess: extra.candidateProcess } : {}),
    ...(extra.candidateCanonicalSha256 ? { candidateCanonicalSha256: extra.candidateCanonicalSha256 } : {}),
    reason,
  };
}

function sameProcessIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid
    && left.processStartIdentity === right.processStartIdentity
    && left.executableRealpath === right.executableRealpath
    && left.entrypointRealpath === right.entrypointRealpath
    && left.normalizedArgv.length === right.normalizedArgv.length
    && left.normalizedArgv.every((value, index) => value === right.normalizedArgv[index]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
