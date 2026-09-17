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
