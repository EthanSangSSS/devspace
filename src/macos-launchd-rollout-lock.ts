import { spawn } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname } from "node:path";
import type { FileIdentity, ObservedState } from "./macos-launchd-rollout.js";

const EX_TEMPFAIL = 75;

export interface RolloutLockOwnerRecord {
  schema_version: 1;
  pid: number;
  process_start_identity: string;
  transaction_nonce: string;
  transaction_id: string;
  created_at: string;
  released_at?: string;
}

export interface RolloutLockLease {
  readonly fd: number;
  readonly owner: RolloutLockOwnerRecord;
  assertOwned(): Promise<ObservedState<"owned" | "drift">>;
  release(): Promise<void>;
}

export interface LockfRunner {
  tryExclusive(fd: number): Promise<"acquired" | "busy">;
}

export class RolloutLockError extends Error {
  constructor(
    readonly code: "LOCK_BUSY" | "LOCK_AMBIGUOUS",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RolloutLockError";
  }
}

export async function acquireDarwinRolloutLock(
  input: {
    lockPath: string;
    owner: RolloutLockOwnerRecord;
  },
  runner: LockfRunner = createDarwinLockfRunner(),
): Promise<RolloutLockLease> {
  mkdirSync(dirname(input.lockPath), { recursive: true, mode: 0o700 });
  let fd: number | undefined;
  try {
    rejectExistingSymlink(input.lockPath);
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    fd = openSync(
      input.lockPath,
      fsConstants.O_RDWR | fsConstants.O_CREAT | noFollow,
      0o600,
    );
    const pathIdentity = identityFromStats(input.lockPath, lstatSync(input.lockPath), false);
    const descriptorIdentity = identityFromStats(input.lockPath, fstatSync(fd), false);
    const effectiveUid = process.geteuid?.() ?? process.getuid?.() ?? pathIdentity.uid;
    validateRolloutLockIdentity(pathIdentity, descriptorIdentity, effectiveUid);

    let lockResult: "acquired" | "busy";
    try {
      lockResult = await runner.tryExclusive(fd);
    } catch (cause) {
      throw cause instanceof RolloutLockError
        ? cause
        : new RolloutLockError("LOCK_AMBIGUOUS", "Unable to determine rollout kernel-lock state.", { cause });
    }
    if (lockResult === "busy") {
      throw new RolloutLockError("LOCK_BUSY", "Another rollout transaction holds the kernel lock.");
    }

    writeOwnerRecord(fd, input.owner);
    const lease = createLease({
      fd,
      lockPath: input.lockPath,
      owner: input.owner,
      identity: descriptorIdentity,
    });
    fd = undefined;
    return lease;
  } catch (cause) {
    if (fd !== undefined) closeSync(fd);
    if (cause instanceof RolloutLockError) throw cause;
    throw new RolloutLockError("LOCK_AMBIGUOUS", `Unable to acquire rollout lock at ${input.lockPath}.`, { cause });
  }
}

export function validateRolloutLockIdentity(
  pathIdentity: FileIdentity,
  descriptorIdentity: FileIdentity,
  effectiveUid: number,
): void {
  if (
    pathIdentity.kind !== "file"
    || pathIdentity.symlink
    || descriptorIdentity.kind !== "file"
    || descriptorIdentity.symlink
    || pathIdentity.uid !== effectiveUid
    || (pathIdentity.mode & 0o022) !== 0
    || pathIdentity.device !== descriptorIdentity.device
    || pathIdentity.inode !== descriptorIdentity.inode
  ) {
    throw new RolloutLockError("LOCK_AMBIGUOUS", "Rollout lock file identity is unsafe or ambiguous.");
  }
}

function createDarwinLockfRunner(): LockfRunner {
  return {
    async tryExclusive(fd: number): Promise<"acquired" | "busy"> {
      if (process.platform !== "darwin") {
        throw new RolloutLockError("LOCK_AMBIGUOUS", "Darwin rollout locking requires macOS.");
      }
      return new Promise((resolve, reject) => {
        const child = spawn("/usr/bin/lockf", ["-s", "-t", "0", "3"], {
          stdio: ["ignore", "ignore", "ignore", fd],
        });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, 5_000);
        child.once("error", (cause) => {
          clearTimeout(timer);
          reject(new RolloutLockError("LOCK_AMBIGUOUS", "Unable to execute /usr/bin/lockf.", { cause }));
        });
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          if (timedOut) {
            reject(new RolloutLockError("LOCK_AMBIGUOUS", "lockf exceeded its execution deadline."));
            return;
          }
          if (code === 0) {
            resolve("acquired");
            return;
          }
          if (code === EX_TEMPFAIL) {
            resolve("busy");
            return;
          }
          reject(new RolloutLockError(
            "LOCK_AMBIGUOUS",
            `lockf exited unexpectedly (code=${String(code)}, signal=${String(signal)}).`,
          ));
        });
      });
    },
  };
}

function createLease(input: {
  fd: number;
  lockPath: string;
  owner: RolloutLockOwnerRecord;
  identity: FileIdentity;
}): RolloutLockLease {
  let released = false;
  return {
    fd: input.fd,
    owner: input.owner,
    async assertOwned(): Promise<ObservedState<"owned" | "drift">> {
      if (released) return { kind: "unproven", reason: "rollout lock lease has been released" };
      let pathIdentity: FileIdentity;
      let descriptorIdentity: FileIdentity;
      try {
        pathIdentity = identityFromStats(input.lockPath, lstatSync(input.lockPath), false);
        descriptorIdentity = identityFromStats(input.lockPath, fstatSync(input.fd), false);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { kind: "known", value: "drift" };
        }
        return { kind: "unproven", reason: errorMessage(error) };
      }
      if (
        pathIdentity.symlink
        || pathIdentity.kind !== "file"
        || pathIdentity.device !== input.identity.device
        || pathIdentity.inode !== input.identity.inode
        || descriptorIdentity.device !== input.identity.device
        || descriptorIdentity.inode !== input.identity.inode
      ) {
        return { kind: "known", value: "drift" };
      }
      const record = readOwnerRecord(input.fd);
      if (!record) return { kind: "unproven", reason: "rollout lock owner record is unreadable" };
      if (
        record.transaction_nonce !== input.owner.transaction_nonce
        || record.transaction_id !== input.owner.transaction_id
        || record.pid !== input.owner.pid
        || record.process_start_identity !== input.owner.process_start_identity
      ) {
        return { kind: "known", value: "drift" };
      }
      return { kind: "known", value: "owned" };
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        const record = readOwnerRecord(input.fd);
        if (record?.transaction_nonce === input.owner.transaction_nonce) {
          writeOwnerRecord(input.fd, {
            ...record,
            released_at: new Date().toISOString(),
          });
        }
      } finally {
        closeSync(input.fd);
      }
    },
  };
}

function rejectExistingSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new RolloutLockError("LOCK_AMBIGUOUS", "Rollout lock path must not be a symlink.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function identityFromStats(
  path: string,
  stats: Stats,
  symlink: boolean,
): FileIdentity {
  return {
    path,
    uid: stats.uid,
    gid: stats.gid,
    mode: stats.mode & 0o7777,
    device: stats.dev,
    inode: stats.ino,
    kind: stats.isDirectory() ? "directory" : "file",
    symlink: symlink || stats.isSymbolicLink(),
  };
}

function writeOwnerRecord(fd: number, owner: RolloutLockOwnerRecord): void {
  const bytes = Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
  ftruncateSync(fd, 0);
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
  }
}

function readOwnerRecord(fd: number): RolloutLockOwnerRecord | undefined {
  try {
    const size = fstatSync(fd).size;
    if (size <= 0 || size > 64 * 1024) return undefined;
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, buffer, offset, size - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const value = JSON.parse(buffer.subarray(0, offset).toString("utf8")) as Partial<RolloutLockOwnerRecord>;
    if (
      value.schema_version !== 1
      || typeof value.pid !== "number"
      || typeof value.process_start_identity !== "string"
      || typeof value.transaction_nonce !== "string"
      || typeof value.transaction_id !== "string"
      || typeof value.created_at !== "string"
      || (value.released_at !== undefined && typeof value.released_at !== "string")
    ) return undefined;
    return value as RolloutLockOwnerRecord;
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
