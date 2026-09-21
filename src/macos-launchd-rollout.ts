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
  programArguments: string[];
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
  preflightCandidateRuntime(
    plistPath: string,
    candidateEntrypoint: string,
    expectedArgv: readonly string[],
  ): Promise<void>;
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
  observeExpectedProcess(expected: ProcessIdentity): Promise<ObservedState<"alive" | "gone" | "reused">>;
  observeListener(): Promise<ObservedState<ListenerObservation>>;
  checkHealth(): Promise<ObservedState<"healthy" | "unhealthy">>;
  waitReady(expectedEntrypoint: string): Promise<ObservedState<ProcessIdentity>>;
  stopExpected(expected: ProcessIdentity): Promise<ObservedState<"stopped">>;
  bootoutInactiveCandidate(expectedArgv: readonly string[]): Promise<void>;
  bootstrap(plistPath: string): Promise<void>;
  observeDisabledOverride(): Promise<ObservedState<"enabled" | "disabled">>;
  observeAncestors(pid: number): Promise<ObservedState<number[]>>;
  waitStable(expected: ProcessIdentity): Promise<ObservedState<"stable">>;
  readFileSha256(path: string): Promise<ObservedState<string>>;
  observeFileIdentity(path: string): Promise<ObservedState<FileIdentity>>;
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
  phase: ForwardRolloutFailurePhase;
  committed: boolean;
  liveMutationStarted: boolean;
  controlledReloadVerified: boolean;
  initial?: InitialRolloutState;
  candidateProcess?: ProcessIdentity;
  candidatePlistBytes?: Buffer;
  candidatePlistSha256?: string;
  candidateCanonicalSha256?: string;
  preparedCanonicalTemp?: PreparedCanonicalTemp;
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

export interface RolloutOutcome {
  code: RolloutResultCode;
  transactionId: string;
  transactionNonce: string;
  committed: boolean;
  controlledReload: "PASS" | "FAIL" | "NOT_RUN";
  persistenceStaticContract: "PASS" | "FAIL";
  rebootRecovery: "UNVERIFIED";
  evidence: Record<string, string | number | boolean | undefined>;
}

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

interface RolloutTransactionIdentity {
  transactionId: string;
  transactionNonce: string;
}

interface RecoveryObservation {
  refusal?: RollbackRefusal;
  runtimeRole: "old" | "candidate" | "candidate-inactive" | "absent" | "drift" | "unproven";
  process?: ProcessIdentity;
  listener: ObservedState<"expected" | "unowned" | "drift">;
}

export async function runMacosLaunchdRollout(
  request: RolloutRequest,
  adapters: MacosRolloutAdapters,
): Promise<RolloutOutcome> {
  const transaction: RolloutTransactionIdentity = {
    transactionId: randomUUID(),
    transactionNonce: randomBytes(16).toString("hex"),
  };
  let forward: ForwardRolloutResult;
  try {
    forward = await runMacosLaunchdForwardPath(request, adapters, transaction);
  } catch (error) {
    return {
      code: rolloutErrorCode(error),
      transactionId: transaction.transactionId,
      transactionNonce: transaction.transactionNonce,
      committed: false,
      controlledReload: "NOT_RUN",
      persistenceStaticContract: "FAIL",
      rebootRecovery: "UNVERIFIED",
      evidence: { reason: errorMessage(error) },
    };
  }

  const context = forward.context;
  try {
    if (forward.ok) {
      return rolloutOutcome("ROLLOUT_OK", context, true, "PASS", "PASS");
    }
    if (!context.liveMutationStarted) {
      return rolloutOutcome(
        forward.code,
        context,
        forward.committed,
        context.controlledReloadVerified ? "PASS" : "NOT_RUN",
        forward.code === "PERSISTENCE_CONTRACT_INVALID" ? "FAIL" : "PASS",
        forward.reason,
      );
    }
    const recovery = forward.committed
      ? await compensateCommittedCandidate(request, forward, adapters)
      : await recoverPreCommitFailure(request, forward, adapters);
    return {
      ...recovery,
      evidence: {
        forwardPhase: forward.phase,
        forwardCode: forward.code,
        forwardReason: forward.reason,
        ...recovery.evidence,
      },
    };
  } finally {
    await context.lease.release();
  }
}

export async function runMacosLaunchdForwardPath(
  request: RolloutRequest,
  adapters: MacosRolloutAdapters,
  transaction: RolloutTransactionIdentity = {
    transactionId: randomUUID(),
    transactionNonce: randomBytes(16).toString("hex"),
  },
): Promise<ForwardRolloutResult> {
  const { transactionId, transactionNonce } = transaction;
  const transactionDir = resolveTransactionDir(transactionId);
  const candidatePlistPath = join(transactionDir, "candidate.plist");
  const lease = await adapters.acquireLock({ transactionId, transactionNonce });
  const context: ForwardTransactionContext = {
    transactionId,
    transactionNonce,
    transactionDir,
    candidatePlistPath,
    lease,
    phase: "precheck",
    committed: false,
    liveMutationStarted: false,
    controlledReloadVerified: false,
  };

  try {

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
    await adapters.preflightCandidateRuntime(
      candidatePlistPath,
      request.candidateEntrypoint,
      expectedCandidateArgv(initial, request.candidateEntrypoint),
    );
  } catch (error) {
    return forwardFailure(context, "precheck", "CANDIDATE_ARTIFACT_MISMATCH", errorMessage(error), { initial });
  }

  const beforeStop = await revalidateBeforeOldStop({ initial, request, adapters });
  if (!beforeStop.ok) {
    return forwardFailure(context, "old_stop", beforeStop.code, beforeStop.reason, { initial });
  }
  context.phase = "old_stop";
  context.liveMutationStarted = true;
  let oldStopped: ObservedState<"stopped">;
  try {
    oldStopped = await adapters.stopExpected(initial.process);
  } catch (error) {
    return forwardFailure(context, "old_stop", "PRECONDITION_FAILED", errorMessage(error), { initial });
  }
  if (oldStopped.kind === "unproven") {
    return forwardFailure(context, "old_stop", "LIVE_STATE_CAS_MISMATCH", oldStopped.reason, { initial });
  }

  try {
    context.phase = "candidate_first_start";
    await adapters.bootstrap(candidatePlistPath);
  } catch (error) {
    return forwardFailure(context, "candidate_first_start", "PRECONDITION_FAILED", errorMessage(error), { initial });
  }
  context.phase = "candidate_first_verify";
  const firstCandidate = await verifyCandidateRuntime({
    candidateEntrypoint: request.candidateEntrypoint,
    candidatePlistPath,
    candidatePlistSha256,
    adapters,
    onReadyProcess: (process) => rememberCandidateProcess(context, process),
  });
  if (!firstCandidate.ok) {
    return forwardFailure(context, "candidate_first_verify", "PRECONDITION_FAILED", firstCandidate.reason, { initial });
  }
  rememberCandidateProcess(context, firstCandidate.process);

  let candidateStopped: ObservedState<"stopped">;
  try {
    context.phase = "candidate_controlled_stop";
    candidateStopped = await adapters.stopExpected(firstCandidate.process);
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

  context.phase = "candidate_reload";
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
    onReadyProcess: (process) => rememberCandidateProcess(context, process),
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
  rememberCandidateProcess(context, reloadedCandidate.process);
  context.controlledReloadVerified = true;

  context.phase = "pre_commit_revalidation";
  const preCommit = await preCommitRevalidate({
    request,
    initial,
    candidatePlistPath,
    candidatePlistSha256,
    lease,
    adapters,
    onReadyProcess: (process) => rememberCandidateProcess(context, process),
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
  rememberCandidateProcess(context, candidateForCommit);

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
    context.preparedCanonicalTemp = prepared;
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
    onReadyProcess: (process) => rememberCandidateProcess(context, process),
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
  rememberCandidateProcess(context, candidateForCommit);
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
  context.committed = true;
  context.candidateCanonicalSha256 = candidatePlistSha256;
  context.phase = "post_commit_verification";

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
    onReadyProcess: (process) => rememberCandidateProcess(context, process),
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
  rememberCandidateProcess(context, postCommit.process);

  return {
    ok: true,
    committed: true,
    context,
    candidateProcess: postCommit.process,
    candidateCanonicalSha256: candidatePlistSha256,
  };
  } catch (error) {
    return forwardFailure(
      context,
      context.phase,
      "PRECONDITION_FAILED",
      errorMessage(error),
      {
        ...(context.initial ? { initial: context.initial } : {}),
        ...(context.candidateProcess ? { candidateProcess: context.candidateProcess } : {}),
        ...(context.candidateCanonicalSha256
          ? { candidateCanonicalSha256: context.candidateCanonicalSha256 }
          : {}),
        committed: context.committed,
      },
    );
  }
}

async function recoverPreCommitFailure(
  request: RolloutRequest,
  failure: ForwardRolloutFailure,
  adapters: MacosRolloutAdapters,
): Promise<RolloutOutcome> {
  const context = failure.context;
  const initial = context.initial ?? failure.initial;
  if (!initial) {
    return rolloutOutcome(
      "SWITCH_FAILED_ROLLBACK_FAILED",
      context,
      false,
      controlledReloadStatus(context),
      "FAIL",
      "pre-commit recovery has no verified initial state",
    );
  }

  let observed = await observeRecoveryState({
    expectedCanonical: "old",
    request,
    context,
    initial,
    adapters,
  });
  if (observed.refusal) {
    return rolloutOutcome(observed.refusal, context, false, controlledReloadStatus(context), "FAIL");
  }

  if (observed.runtimeRole === "old") {
    if (isKnownUnowned(observed.listener) && observed.process) {
      const stopped = await adapters.stopExpected(observed.process);
      if (stopped.kind === "unproven") {
        return rolloutOutcome(
          "ROLLBACK_REFUSED_UNPROVEN_STATE",
          context,
          false,
          controlledReloadStatus(context),
          "FAIL",
          stopped.reason,
        );
      }
      observed = await observeRecoveryState({
        expectedCanonical: "old",
        request,
        context,
        initial,
        adapters,
      });
      if (observed.refusal) {
        return rolloutOutcome(observed.refusal, context, false, controlledReloadStatus(context), "FAIL");
      }
    } else {
      const healthy = await verifyOldRuntime(request, initial, adapters, true);
      return rolloutOutcome(
        healthy ? "SWITCH_FAILED_ROLLBACK_OK" : "SWITCH_FAILED_ROLLBACK_FAILED",
        context,
        false,
        controlledReloadStatus(context),
        healthy ? "PASS" : "FAIL",
      );
    }
  }

  if (observed.runtimeRole === "candidate" || observed.runtimeRole === "candidate-inactive") {
    const stopped = await stopRecoveryCandidate({
      expectedCanonical: "old",
      request,
      context,
      initial,
      adapters,
    });
    if (stopped) return stopped;
  } else if (observed.runtimeRole !== "absent") {
    return rolloutOutcome(
      observed.runtimeRole === "drift"
        ? "ROLLBACK_REFUSED_CONCURRENT_DRIFT"
        : "ROLLBACK_REFUSED_UNPROVEN_STATE",
      context,
      false,
      controlledReloadStatus(context),
      "FAIL",
    );
  }

  observed = await observeRecoveryState({
    expectedCanonical: "old",
    request,
    context,
    initial,
    adapters,
  });
  if (observed.refusal) {
    return rolloutOutcome(observed.refusal, context, false, controlledReloadStatus(context), "FAIL");
  }
  if (observed.runtimeRole === "old") {
    const healthy = await verifyOldRuntime(request, initial, adapters, true);
    return rolloutOutcome(
      healthy ? "SWITCH_FAILED_ROLLBACK_OK" : "SWITCH_FAILED_ROLLBACK_FAILED",
      context,
      false,
      controlledReloadStatus(context),
      healthy ? "PASS" : "FAIL",
    );
  }
  if (observed.runtimeRole !== "absent" || !isKnownUnowned(observed.listener)) {
    return rolloutOutcome(
      "ROLLBACK_REFUSED_CONCURRENT_DRIFT",
      context,
      false,
      controlledReloadStatus(context),
      "FAIL",
      "runtime was not confirmed absent before old bootstrap",
    );
  }

  try {
    await adapters.bootstrap(initial.canonical.identity.path);
  } catch (error) {
    return rolloutOutcome(
      "SWITCH_FAILED_ROLLBACK_FAILED",
      context,
      false,
      controlledReloadStatus(context),
      "FAIL",
      errorMessage(error),
    );
  }
  const healthy = await verifyOldRuntime(request, initial, adapters, false);
  return rolloutOutcome(
    healthy ? "SWITCH_FAILED_ROLLBACK_OK" : "SWITCH_FAILED_ROLLBACK_FAILED",
    context,
    false,
    controlledReloadStatus(context),
    healthy ? "PASS" : "FAIL",
  );
}

async function compensateCommittedCandidate(
  request: RolloutRequest,
  failure: ForwardRolloutFailure,
  adapters: MacosRolloutAdapters,
): Promise<RolloutOutcome> {
  const context = failure.context;
  const initial = context.initial ?? failure.initial;
  if (!initial || !context.candidatePlistSha256 || !context.preparedCanonicalTemp) {
    return rolloutOutcome(
      "ROLLBACK_REFUSED_UNPROVEN_STATE",
      context,
      true,
      controlledReloadStatus(context),
      "FAIL",
      "committed rollback context is incomplete",
    );
  }

  let observed = await observeRecoveryState({
    expectedCanonical: "candidate",
    request,
    context,
    initial,
    adapters,
  });
  if (observed.refusal) {
    return rolloutOutcome(observed.refusal, context, true, controlledReloadStatus(context), "FAIL");
  }
  if (observed.runtimeRole === "candidate" || observed.runtimeRole === "candidate-inactive") {
    const stopped = await stopRecoveryCandidate({
      expectedCanonical: "candidate",
      request,
      context,
      initial,
      adapters,
    });
    if (stopped) return { ...stopped, committed: true };
  } else if (observed.runtimeRole !== "absent") {
    return rolloutOutcome(
      observed.runtimeRole === "drift"
        ? "ROLLBACK_REFUSED_CONCURRENT_DRIFT"
        : "ROLLBACK_REFUSED_UNPROVEN_STATE",
      context,
      true,
      controlledReloadStatus(context),
      "FAIL",
    );
  }

  observed = await observeRecoveryState({
    expectedCanonical: "candidate",
    request,
    context,
    initial,
    adapters,
  });
  if (observed.refusal) {
    return rolloutOutcome(observed.refusal, context, true, controlledReloadStatus(context), "FAIL");
  }
  if (observed.runtimeRole !== "absent" || !isKnownUnowned(observed.listener)) {
    return rolloutOutcome(
      "ROLLBACK_REFUSED_CONCURRENT_DRIFT",
      context,
      true,
      controlledReloadStatus(context),
      "FAIL",
      "candidate runtime was not confirmed stopped before compensating restore",
    );
  }

  let oldTemp: PreparedCanonicalTemp;
  try {
    oldTemp = await adapters.prepareCanonicalTemp({
      transactionNonce: context.transactionNonce,
      bytes: initial.canonical.bytes,
      expectedSha256: initial.canonical.sha256,
      uid: initial.canonical.identity.uid,
      gid: initial.canonical.identity.gid,
      mode: initial.canonical.identity.mode,
    });
  } catch (error) {
    return rolloutOutcome(
      "SWITCH_FAILED_ROLLBACK_FAILED",
      context,
      true,
      controlledReloadStatus(context),
      "FAIL",
      errorMessage(error),
    );
  }

  const finalGate = await revalidateBeforeCompensatingRestore({
    request,
    context,
    initial,
    oldTemp,
    adapters,
  });
  if (finalGate) {
    return rolloutOutcome(finalGate, context, true, controlledReloadStatus(context), "FAIL");
  }

  try {
    await adapters.atomicReplaceCanonical(oldTemp.path);
    await adapters.syncCanonicalParent();
    await adapters.bootstrap(initial.canonical.identity.path);
  } catch (error) {
    return rolloutOutcome(
      "SWITCH_FAILED_ROLLBACK_FAILED",
      context,
      true,
      controlledReloadStatus(context),
      "FAIL",
      errorMessage(error),
    );
  }

  const healthy = await verifyOldRuntime(request, initial, adapters, false);
  return rolloutOutcome(
    healthy ? "SWITCH_FAILED_ROLLBACK_OK" : "SWITCH_FAILED_ROLLBACK_FAILED",
    context,
    true,
    controlledReloadStatus(context),
    healthy ? "PASS" : "FAIL",
  );
}

async function stopRecoveryCandidate(input: {
  expectedCanonical: "old" | "candidate";
  request: RolloutRequest;
  context: ForwardTransactionContext;
  initial: InitialRolloutState;
  adapters: MacosRolloutAdapters;
}): Promise<RolloutOutcome | undefined> {
  const fresh = await observeRecoveryState(input);
  if (fresh.refusal) {
    return rolloutOutcome(
      fresh.refusal,
      input.context,
      input.expectedCanonical === "candidate",
      controlledReloadStatus(input.context),
      "FAIL",
    );
  }
  if (fresh.runtimeRole === "absent") return undefined;
  if (fresh.runtimeRole === "candidate-inactive") {
    const expectedArgv = expectedCandidateArgv(input.initial, input.request.candidateEntrypoint);
    try {
      await input.adapters.bootoutInactiveCandidate(expectedArgv);
    } catch (error) {
      const afterFailure = await observeRecoveryState(input);
      if (afterFailure.refusal) {
        return rolloutOutcome(
          afterFailure.refusal,
          input.context,
          input.expectedCanonical === "candidate",
          controlledReloadStatus(input.context),
          "FAIL",
        );
      }
      return rolloutOutcome(
        "SWITCH_FAILED_ROLLBACK_FAILED",
        input.context,
        input.expectedCanonical === "candidate",
        controlledReloadStatus(input.context),
        "FAIL",
        errorMessage(error),
      );
    }
    return undefined;
  }
  if (fresh.runtimeRole !== "candidate" || !fresh.process) {
    return rolloutOutcome(
      "ROLLBACK_REFUSED_CONCURRENT_DRIFT",
      input.context,
      input.expectedCanonical === "candidate",
      controlledReloadStatus(input.context),
      "FAIL",
      "candidate ownership changed before rollback bootout",
    );
  }

  let stopped: ObservedState<"stopped">;
  try {
    stopped = await input.adapters.stopExpected(fresh.process);
  } catch (error) {
    const afterFailure = await observeRecoveryState(input);
    if (afterFailure.refusal) {
      return rolloutOutcome(
        afterFailure.refusal,
        input.context,
        input.expectedCanonical === "candidate",
        controlledReloadStatus(input.context),
        "FAIL",
      );
    }
    return rolloutOutcome(
      "SWITCH_FAILED_ROLLBACK_FAILED",
      input.context,
      input.expectedCanonical === "candidate",
      controlledReloadStatus(input.context),
      "FAIL",
      errorMessage(error),
    );
  }
  if (stopped.kind === "unproven") {
    const afterFailure = await observeRecoveryState(input);
    if (afterFailure.refusal) {
      return rolloutOutcome(
        afterFailure.refusal,
        input.context,
        input.expectedCanonical === "candidate",
        controlledReloadStatus(input.context),
        "FAIL",
      );
    }
    return rolloutOutcome(
      "ROLLBACK_REFUSED_UNPROVEN_STATE",
      input.context,
      input.expectedCanonical === "candidate",
      controlledReloadStatus(input.context),
      "FAIL",
      stopped.reason,
    );
  }
  return undefined;
}

async function observeRecoveryState(input: {
  expectedCanonical: "old" | "candidate";
  request: RolloutRequest;
  context: ForwardTransactionContext;
  initial: InitialRolloutState;
  adapters: MacosRolloutAdapters;
}): Promise<RecoveryObservation> {
  const canonical = await observeExpectedCanonical(input);
  const lockObservation = await input.context.lease.assertOwned();
  const lock: ObservedState<"owned" | "drift"> = lockObservation;
  const ownerRecord: ObservedState<"ours" | "drift"> = lockObservation.kind === "unproven"
    ? { kind: "unproven", reason: lockObservation.reason }
    : { kind: "known", value: lockObservation.value === "owned" ? "ours" : "drift" };

  const launchd = await input.adapters.observeLaunchd();
  const listenerRaw = await input.adapters.observeListener();
  let runtime: ObservedState<"expected" | "absent" | "drift"> = {
    kind: "unproven",
    reason: "runtime state has not been classified",
  };
  let listener: ObservedState<"expected" | "unowned" | "drift">;
  let runtimeRole: RecoveryObservation["runtimeRole"] = "unproven";
  let processValue: ProcessIdentity | undefined;
  let observedRuntimePid: number | undefined;

  if (launchd.kind === "unproven") {
    runtime = { kind: "unproven", reason: launchd.reason };
  } else if (!launchd.value.loaded) {
    const knownProcesses: Array<{ role: "old" | "candidate"; process: ProcessIdentity }> = [];
    if (input.context.candidateProcess) {
      knownProcesses.push({ role: "candidate", process: input.context.candidateProcess });
    }
    if (!knownProcesses.some(({ process }) => sameProcessIdentity(process, input.initial.process))) {
      knownProcesses.push({ role: "old", process: input.initial.process });
    }

    let liveKnown: { role: "old" | "candidate"; process: ProcessIdentity } | undefined;
    let detachedFailure: string | undefined;
    for (const knownProcess of knownProcesses) {
      const generation = await input.adapters.observeExpectedProcess(knownProcess.process);
      if (generation.kind === "unproven") {
        detachedFailure = generation.reason;
        break;
      }
      if (generation.value !== "alive") continue;
      if (liveKnown) {
        runtimeRole = "drift";
        runtime = { kind: "known", value: "drift" };
        detachedFailure = "multiple previously known runtime generations remain alive after launchd unload";
        break;
      }
      liveKnown = knownProcess;
    }

    if (runtimeRole === "drift") {
      // Preserve the concrete drift classification above.
    } else if (detachedFailure) {
      runtimeRole = "unproven";
      runtime = { kind: "unproven", reason: detachedFailure };
    } else if (liveKnown) {
      processValue = liveKnown.process;
      observedRuntimePid = liveKnown.process.pid;
      runtimeRole = liveKnown.role === "old"
        ? input.expectedCanonical === "old" ? "old" : "drift"
        : "candidate";
      runtime = {
        kind: "known",
        value: runtimeRole === "drift" ? "drift" : "expected",
      };
    } else {
      runtimeRole = "absent";
      runtime = { kind: "known", value: "absent" };
    }
  } else if (!launchd.value.pid) {
    const expectedArgv = expectedCandidateArgv(input.initial, input.request.candidateEntrypoint);
    if (sameArgv(launchd.value.normalizedArgv, expectedArgv)) {
      runtimeRole = "candidate-inactive";
      runtime = { kind: "known", value: "expected" };
    } else {
      runtimeRole = "drift";
      runtime = { kind: "known", value: "drift" };
    }
  } else {
    observedRuntimePid = launchd.value.pid;
    const processState = await input.adapters.observeProcess(launchd.value.pid);
    if (processState.kind === "unproven") {
      runtime = { kind: "unproven", reason: processState.reason };
    } else {
      processValue = processState.value;
      if (sameProcessIdentity(processState.value, input.initial.process)) {
        runtimeRole = input.expectedCanonical === "old" ? "old" : "drift";
      } else if (processState.value.entrypointRealpath === input.request.candidateEntrypoint) {
        runtimeRole = "candidate";
      } else {
        runtimeRole = "drift";
      }
      runtime = {
        kind: "known",
        value: runtimeRole === "drift" ? "drift" : "expected",
      };
    }
  }

  if (listenerRaw.kind === "unproven") {
    listener = { kind: "unproven", reason: listenerRaw.reason };
  } else if (listenerRaw.value.state === "unowned") {
    listener = { kind: "known", value: "unowned" };
  } else if (observedRuntimePid !== undefined && listenerRaw.value.ownerPid === observedRuntimePid) {
    listener = { kind: "known", value: "expected" };
  } else {
    listener = { kind: "known", value: "drift" };
  }

  if (runtimeRole === "absent" && listener.kind === "known" && listener.value === "expected") {
    listener = { kind: "known", value: "drift" };
  }

  const refusal = classifyRollbackRefusal({
    canonical,
    runtime,
    listener,
    lock,
    ownerRecord,
  });
  return {
    ...(refusal ? { refusal } : {}),
    runtimeRole,
    ...(processValue ? { process: processValue } : {}),
    listener,
  };
}

function expectedCandidateArgv(
  initial: InitialRolloutState,
  candidateEntrypoint: string,
): string[] {
  const argv = [...initial.canonical.programArguments];
  if (argv.length < 2) return [];
  argv[1] = candidateEntrypoint;
  return argv;
}

function sameArgv(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
  return Boolean(
    actual
    && expected.length > 0
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]),
  );
}

async function observeExpectedCanonical(input: {
  expectedCanonical: "old" | "candidate";
  request: RolloutRequest;
  context: ForwardTransactionContext;
  initial: InitialRolloutState;
  adapters: MacosRolloutAdapters;
}): Promise<ObservedState<"expected" | "drift">> {
  const expectedSha = input.expectedCanonical === "old"
    ? input.initial.canonical.sha256
    : input.context.candidatePlistSha256;
  if (!expectedSha) return { kind: "unproven", reason: "expected canonical hash is unavailable" };

  const canonicalPath = input.initial.canonical.identity.path;
  const parentPath = input.initial.canonical.parentIdentity.path;
  const [hash, identity, parentIdentity, semantic] = await Promise.all([
    input.adapters.readFileSha256(canonicalPath),
    input.adapters.observeFileIdentity(canonicalPath),
    input.adapters.observeFileIdentity(parentPath),
    input.adapters.readCanonical(),
  ]);

  const identityDrift = identity.kind === "known" && (
    input.expectedCanonical === "old"
      ? !sameFileIdentity(identity.value, input.initial.canonical.identity)
      : !input.context.preparedCanonicalTemp
        || !samePublishedIdentity(identity.value, input.context.preparedCanonicalTemp.identity, canonicalPath)
  );
  const parentDrift = parentIdentity.kind === "known"
    && !sameFileIdentity(parentIdentity.value, input.initial.canonical.parentIdentity);
  const semanticDrift = semantic.kind === "known" && (
    semantic.value.sha256 !== expectedSha
    || semantic.value.entrypointRealpath !== (
      input.expectedCanonical === "old"
        ? input.request.expectedLiveEntrypoint
        : input.request.candidateEntrypoint
    )
    || !semantic.value.runAtLoad
    || !semantic.value.keepAlive
  );
  if (
    (hash.kind === "known" && hash.value !== expectedSha)
    || identityDrift
    || parentDrift
    || semanticDrift
  ) {
    return { kind: "known", value: "drift" };
  }
  const unprovenObservation = [hash, identity, parentIdentity, semantic].find((value) => value.kind === "unproven");
  if (unprovenObservation?.kind === "unproven") {
    return { kind: "unproven", reason: unprovenObservation.reason };
  }
  return { kind: "known", value: "expected" };
}

async function revalidateBeforeCompensatingRestore(input: {
  request: RolloutRequest;
  context: ForwardTransactionContext;
  initial: InitialRolloutState;
  oldTemp: PreparedCanonicalTemp;
  adapters: MacosRolloutAdapters;
}): Promise<RollbackRefusal | undefined> {
  const observed = await observeRecoveryState({
    expectedCanonical: "candidate",
    request: input.request,
    context: input.context,
    initial: input.initial,
    adapters: input.adapters,
  });
  if (observed.refusal) return observed.refusal;
  if (observed.runtimeRole !== "absent" || !isKnownUnowned(observed.listener)) {
    return "ROLLBACK_REFUSED_CONCURRENT_DRIFT";
  }

  const [hash, identity] = await Promise.all([
    input.adapters.readFileSha256(input.oldTemp.path),
    input.adapters.observeFileIdentity(input.oldTemp.path),
  ]);
  if (hash.kind === "known" && hash.value !== input.initial.canonical.sha256) {
    return "ROLLBACK_REFUSED_CONCURRENT_DRIFT";
  }
  if (identity.kind === "known" && (
    !sameFileIdentity(identity.value, input.oldTemp.identity)
    || identity.value.uid !== input.initial.canonical.identity.uid
    || identity.value.gid !== input.initial.canonical.identity.gid
    || identity.value.mode !== input.initial.canonical.identity.mode
    || identity.value.kind !== "file"
    || identity.value.symlink
  )) {
    return "ROLLBACK_REFUSED_CONCURRENT_DRIFT";
  }
  if (hash.kind === "unproven" || identity.kind === "unproven") {
    return "ROLLBACK_REFUSED_UNPROVEN_STATE";
  }
  return undefined;
}

async function verifyOldRuntime(
  request: RolloutRequest,
  initial: InitialRolloutState,
  adapters: MacosRolloutAdapters,
  requireExactInitialGeneration: boolean,
): Promise<boolean> {
  const [canonicalHash, canonicalIdentity, parentIdentity, semantic, disabled] = await Promise.all([
    adapters.readFileSha256(initial.canonical.identity.path),
    adapters.observeFileIdentity(initial.canonical.identity.path),
    adapters.observeFileIdentity(initial.canonical.parentIdentity.path),
    adapters.readCanonical(),
    adapters.observeDisabledOverride(),
  ]);
  if (
    canonicalHash.kind !== "known"
    || canonicalHash.value !== initial.canonical.sha256
    || canonicalIdentity.kind !== "known"
    || !sameOldDefinitionIdentity(canonicalIdentity.value, initial.canonical.identity)
    || parentIdentity.kind !== "known"
    || !sameFileIdentity(parentIdentity.value, initial.canonical.parentIdentity)
    || semantic.kind !== "known"
    || semantic.value.sha256 !== initial.canonical.sha256
    || semantic.value.entrypointRealpath !== request.expectedLiveEntrypoint
    || !semantic.value.runAtLoad
    || !semantic.value.keepAlive
    || disabled.kind !== "known"
    || disabled.value !== "enabled"
  ) return false;

  const processState = await adapters.waitReady(request.expectedLiveEntrypoint);
  if (
    processState.kind !== "known"
    || (requireExactInitialGeneration && !sameProcessIdentity(processState.value, initial.process))
  ) return false;
  const stable = await adapters.waitStable(processState.value);
  return stable.kind === "known" && stable.value === "stable";
}

function rolloutOutcome(
  code: RolloutResultCode,
  context: ForwardTransactionContext,
  committed: boolean,
  controlledReload: "PASS" | "FAIL" | "NOT_RUN",
  persistenceStaticContract: "PASS" | "FAIL",
  reason?: string,
): RolloutOutcome {
  return {
    code,
    transactionId: context.transactionId,
    transactionNonce: context.transactionNonce,
    committed,
    controlledReload,
    persistenceStaticContract,
    rebootRecovery: "UNVERIFIED",
    evidence: { ...(reason ? { reason } : {}) },
  };
}

function controlledReloadStatus(
  context: ForwardTransactionContext,
): "PASS" | "FAIL" | "NOT_RUN" {
  if (context.controlledReloadVerified) return "PASS";
  return context.liveMutationStarted ? "FAIL" : "NOT_RUN";
}

function rolloutErrorCode(error: unknown): RolloutResultCode {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "LOCK_BUSY" || code === "LOCK_AMBIGUOUS") return code;
  }
  return "PRECONDITION_FAILED";
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.path === right.path
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode
    && left.device === right.device
    && left.inode === right.inode
    && left.kind === right.kind
    && left.symlink === right.symlink;
}

function samePublishedIdentity(
  canonical: FileIdentity,
  prepared: FileIdentity,
  canonicalPath: string,
): boolean {
  return canonical.path === canonicalPath
    && canonical.uid === prepared.uid
    && canonical.gid === prepared.gid
    && canonical.mode === prepared.mode
    && canonical.device === prepared.device
    && canonical.inode === prepared.inode
    && canonical.kind === "file"
    && !canonical.symlink;
}

function sameOldDefinitionIdentity(actual: FileIdentity, old: FileIdentity): boolean {
  return actual.path === old.path
    && actual.uid === old.uid
    && actual.gid === old.gid
    && actual.mode === old.mode
    && actual.kind === "file"
    && !actual.symlink;
}

function isKnownUnowned(
  listener: ObservedState<"expected" | "unowned" | "drift">,
): boolean {
  return listener.kind === "known" && listener.value === "unowned";
}

function unproven<T>(reason: string): ObservedState<T> {
  return { kind: "unproven", reason };
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
  if (!sameArgv(processState.value.normalizedArgv, canonical.value.programArguments)) {
    return { ok: false, code: "SPLIT_STATE_DETECTED", reason: "loaded runtime argv differs from canonical ProgramArguments" };
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
  onReadyProcess?: (process: ProcessIdentity) => void;
}): Promise<{ ok: true; process: ProcessIdentity } | { ok: false; reason: string }> {
  const stagedHash = await input.adapters.readFileSha256(input.candidatePlistPath);
  if (stagedHash.kind === "unproven") return { ok: false, reason: stagedHash.reason };
  if (stagedHash.value !== input.candidatePlistSha256) return { ok: false, reason: "staged candidate plist hash changed" };
  const qualified = await observeHealthyCandidateRuntime(
    input.candidateEntrypoint,
    input.adapters,
    input.onReadyProcess,
  );
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
  onReadyProcess?: (process: ProcessIdentity) => void;
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
  const qualified = await observeHealthyCandidateRuntime(
    input.request.candidateEntrypoint,
    input.adapters,
    input.onReadyProcess,
  );
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
  onReadyProcess?: (process: ProcessIdentity) => void;
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
  return observeHealthyCandidateRuntime(
    input.candidateEntrypoint,
    input.adapters,
    input.onReadyProcess,
  );
}

async function observeHealthyCandidateRuntime(
  candidateEntrypoint: string,
  adapters: MacosRolloutAdapters,
  onReadyProcess?: (process: ProcessIdentity) => void,
): Promise<{ ok: true; process: ProcessIdentity } | { ok: false; reason: string }> {
  const processState = await adapters.waitReady(candidateEntrypoint);
  if (processState.kind === "unproven") return { ok: false, reason: processState.reason };
  onReadyProcess?.(processState.value);
  const stable = await adapters.waitStable(processState.value);
  if (stable.kind === "unproven") return { ok: false, reason: stable.reason };
  return { ok: true, process: processState.value };
}

function rememberCandidateProcess(
  context: ForwardTransactionContext,
  process: ProcessIdentity,
): void {
  context.candidateProcess = process;
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
  context.phase = phase;
  if (extra.initial) context.initial = extra.initial;
  if (extra.candidateProcess && !context.candidateProcess) {
    rememberCandidateProcess(context, extra.candidateProcess);
  }
  if (extra.candidateCanonicalSha256) {
    context.candidateCanonicalSha256 = extra.candidateCanonicalSha256;
  }
  if (extra.committed === true) context.committed = true;
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
