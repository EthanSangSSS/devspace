import type { RolloutLockLease } from "./macos-launchd-rollout-lock.js";

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
