import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { lstatSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { platform } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ServerConfig } from "./config.js";
import { assertAllowedPath, isPathInsideRoot } from "./roots.js";
import { gitEnvironment } from "./git-environment.js";

const execFileAsync = promisify(execFile);

// The child checks the directory it actually entered before launching Git.
// Git then checks out "." relative to that bound cwd, never via a mutable
// absolute reservation pathname. No shell expansion or new runtime dependency.
const PINNED_WORKTREE_CHECKOUT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const [gitDir, sha, expectedDev, expectedIno, root] = process.argv.slice(1);
const current = fs.statSync(".", { bigint: true });
if (current.dev.toString() !== expectedDev || current.ino.toString() !== expectedIno
    || path.dirname(fs.realpathSync(".")) !== fs.realpathSync(root)) {
  process.stderr.write("Reserved managed worktree directory changed before checkout.\n");
  process.exit(125);
}
const result = cp.spawnSync("git", ["worktree", "add", "--detach", ".", sha], {
  encoding: "utf8",
  env: { ...process.env, GIT_DIR: gitDir },
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) {
  process.stderr.write(String(result.error) + "\n");
  process.exit(127);
}
process.exit(result.status ?? 1);
`;

export class GitWorktreeError extends Error {
  constructor(
    readonly code:
      | "GIT_NOT_AVAILABLE"
      | "GIT_REPOSITORY_NOT_FOUND"
      | "GIT_REPOSITORY_HAS_NO_COMMITS"
      | "GIT_INVALID_BASE_REF"
      | "GIT_WORKTREE_CREATE_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "GitWorktreeError";
  }
}

export interface ManagedWorktree {
  sourceRoot: string;
  path: string;
  baseRef: string;
  baseSha: string;
  dirtySource: boolean;
  detached: boolean;
  managed: boolean;
}

/** Reserve one new child atomically, after the caller has verified/prepared its root. */
export async function reserveManagedWorktreePath(input: {
  worktreeRoot: string;
  repoRoot: string;
  generateId?: () => string;
}): Promise<string> {
  const repoName = sanitizePathSegment(basename(input.repoRoot)) || "repo";
  const generateId = input.generateId ?? (() => randomBytes(12).toString("hex"));

  for (let attempt = 0; attempt < 10; attempt++) {
    const id = generateId();
    if (!/^[a-f0-9]{24}$/.test(id)) {
      throw new GitWorktreeError("GIT_WORKTREE_CREATE_FAILED", "Invalid managed worktree identifier.");
    }
    const path = join(input.worktreeRoot, `${repoName}-${id}`);
    assertAllowedPath(path, [input.worktreeRoot]);
    try {
      // Non-recursive mkdir is exclusive: EEXIST is a collision, not ownership.
      await mkdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }

    const identity = await lstat(path);
    if (!identity.isDirectory() || identity.isSymbolicLink()) {
      throw new GitWorktreeError("GIT_WORKTREE_CREATE_FAILED", "Reserved worktree path changed during creation.");
    }
    return path;
  }

  throw new GitWorktreeError("GIT_WORKTREE_CREATE_FAILED", "Could not reserve a unique managed worktree path.");
}

/** Run Git against a child cwd verified by inode, not the mutable target path. */
export async function checkoutPinnedWorktree(input: {
  sourceRoot: string;
  worktreeRoot: string;
  worktreePath: string;
  baseSha: string;
  expectedDev: string;
  expectedIno: string;
}): Promise<void> {
  const commonGitDir = (await git(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"], input.sourceRoot,
  )).trim();
  await execFileAsync(process.execPath, [
    "--input-type=commonjs", "-e", PINNED_WORKTREE_CHECKOUT,
    commonGitDir, input.baseSha, input.expectedDev, input.expectedIno, input.worktreeRoot,
  ], {
    cwd: input.worktreePath,
    env: gitEnvironment(),
    maxBuffer: 10 * 1024 * 1024,
  });
}

export async function createManagedWorktree(input: {
  sourcePath: string;
  baseRef?: string;
  config: ServerConfig;
}): Promise<ManagedWorktree> {
  const sourcePath = assertAllowedPath(input.sourcePath, input.config.allowedRoots);

  try {
    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isDirectory()) {
      throw new GitWorktreeError(
        "GIT_REPOSITORY_NOT_FOUND",
        `Cannot open workspace in worktree mode because the source path is not a directory: ${input.sourcePath}`,
      );
    }
  } catch (error) {
    if (error instanceof GitWorktreeError) throw error;
    throw new GitWorktreeError(
      "GIT_REPOSITORY_NOT_FOUND",
      `Cannot open workspace in worktree mode because the source path does not exist: ${input.sourcePath}`,
    );
  }

  const sourceRoot = await resolveGitRoot(sourcePath, input.config.allowedRoots);
  if (input.config.managedWorktreeSourceRoots.length > 0) {
    // These are exact Git repository roots, not ancestor-directory grants.
    // A Developer parent contains snapshot-only projects and must not
    // implicitly authorize them for new managed worktrees.
    const sourceCanonical = await realpath(sourceRoot);
    const authorized = await Promise.all(input.config.managedWorktreeSourceRoots.map(
      async (candidate) => {
        try {
          return (await realpath(candidate)) === sourceCanonical;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      },
    ));
    if (!authorized.includes(true)) {
      throw new GitWorktreeError(
        "GIT_WORKTREE_CREATE_FAILED",
        "Source Git repository is not an explicitly approved managed worktree source.",
      );
    }
  }
  const baseRef = input.baseRef ?? "HEAD";
  const baseSha = await resolveBaseCommit(sourceRoot, baseRef);
  const dirtySource = (await git(["status", "--porcelain=v1"], sourceRoot)).trim().length > 0;

  // Validate the opt-in mounted-volume policy before any mkdir. Even an
  // invalid configuration must not create a fallback on the internal disk.
  await verifyManagedWorktreeVolume(input.config);
  if (input.config.requireExistingWorktreeRoot) {
    // Never create a fallback directory on the host when an external
    // worktree volume is disconnected. The operator must verify the actual
    // mounted volume identity separately before enabling this policy.
    try {
      const rootStats = await lstat(input.config.worktreeRoot);
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        throw new Error("not an ordinary directory");
      }
    } catch {
      throw new GitWorktreeError(
        "GIT_WORKTREE_CREATE_FAILED",
        "Configured managed worktree root is unavailable or redirected; no fallback directory was created.",
      );
    }
  } else {
    await mkdir(input.config.worktreeRoot, { recursive: true });
  }
  // Only reserve the child after the mount and existing-root gates succeed.
  // Reserving first could create a host fallback when DevSSD is unavailable.
  const worktreePath = await reserveManagedWorktreePath({
    worktreeRoot: input.config.worktreeRoot,
    repoRoot: sourceRoot,
  });
  assertAllowedPath(worktreePath, [input.config.worktreeRoot]);

  try {
    const reserved = await lstat(worktreePath, { bigint: true });
    if (!reserved.isDirectory() || reserved.isSymbolicLink()) {
      throw new Error("Reserved managed worktree directory was replaced before checkout.");
    }
    await checkoutPinnedWorktree({
      sourceRoot,
      worktreeRoot: input.config.worktreeRoot,
      worktreePath,
      baseSha,
      expectedDev: reserved.dev.toString(),
      expectedIno: reserved.ino.toString(),
    });
    const checkedOut = await lstat(worktreePath, { bigint: true });
    if (!checkedOut.isDirectory() || checkedOut.isSymbolicLink()
        || checkedOut.dev !== reserved.dev || checkedOut.ino !== reserved.ino) {
      throw new Error("Reserved managed worktree directory changed during checkout.");
    }
  } catch (error) {
    // DevSpace never removes the reserved pathname: it may have been replaced
    // while Git ran. Git's own failed-checkout cleanup is outside our control.
    const stderr = typeof error === "object" && error && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "").trim()
      : "";
    const message = stderr || (error instanceof Error ? error.message : String(error));
    throw new GitWorktreeError(
      "GIT_WORKTREE_CREATE_FAILED",
      `Git failed to create the managed worktree. ${message}`
        + ` DevSpace did not delete the target ${worktreePath}; Git may have removed it. Inspect before recovery.`,
    );
  }

  return {
    sourceRoot,
    path: worktreePath,
    baseRef,
    baseSha,
    dirtySource,
    detached: true,
    managed: true,
  };
}

/** Opt-in macOS external-volume guard. Does not change the v1.1 default. */
export async function verifyManagedWorktreeVolume(config: ServerConfig): Promise<void> {
  const mount = config.managedWorktreeMountPoint;
  const uuid = config.managedWorktreeVolumeUuid;
  if (!mount && !uuid) return;
  const rejected = (): never => {
    throw new GitWorktreeError(
      "GIT_WORKTREE_CREATE_FAILED",
      "Managed worktree destination volume is not the configured mounted encrypted APFS volume.",
    );
  };
  if (!mount || !/^[0-9a-fA-F-]{36}$/.test(uuid)
      || !config.requireExistingWorktreeRoot || platform() !== "darwin") rejected();

  try {
    const [volume, parent, target] = await Promise.all([
      lstat(mount), stat(dirname(mount)), lstat(config.worktreeRoot),
    ]);
    if (!volume.isDirectory() || volume.isSymbolicLink()
        || !target.isDirectory() || target.isSymbolicLink()
        || volume.dev === parent.dev || target.dev !== volume.dev
        || !isPathInsideRoot(config.worktreeRoot, mount)) rejected();

    // diskutil info -plist requires the actual mount point (not a child path).
    // Parse only known scalar fields. Missing/ambiguous values fail closed.
    const { stdout } = await execFileAsync("/usr/sbin/diskutil",
      ["info", "-plist", mount], { maxBuffer: 1024 * 1024, timeout: 12000 });
    const field = (name: string): string | undefined => {
      const match = new RegExp(
        `<key>${name}</key>\\s*(?:<string>([^<]*)</string>|<(true|false)\\s*/>)`,
      ).exec(stdout);
      return match?.[1] ?? match?.[2];
    };
    if (field("VolumeUUID")?.toUpperCase() !== uuid.toUpperCase()
        || field("MountPoint") !== mount
        || field("FilesystemName") !== "APFS"
        || field("Writable") !== "true"
        || field("FileVault") !== "true") rejected();
  } catch {
    rejected();
  }
}

/** Recheck the encrypted volume before *synchronous* persisted-session recovery.
 *  This is deliberately independent of the new-worktree creation check: a
 *  session may be restored long after its original mount has disappeared.
 */
export function verifyManagedWorktreeVolumeSync(config: ServerConfig): void {
  const mount = config.managedWorktreeMountPoint;
  const uuid = config.managedWorktreeVolumeUuid;
  if (!mount && !uuid) return;
  const rejected = (): never => {
    throw new GitWorktreeError(
      "GIT_WORKTREE_CREATE_FAILED",
      "Managed worktree destination volume is not the configured mounted encrypted APFS volume.",
    );
  };
  if (!mount || !/^[0-9a-fA-F-]{36}$/.test(uuid)
      || !config.requireExistingWorktreeRoot || platform() !== "darwin") rejected();

  try {
    const volume = lstatSync(mount);
    const parent = statSync(dirname(mount));
    const target = lstatSync(config.worktreeRoot);
    if (!volume.isDirectory() || volume.isSymbolicLink()
        || !target.isDirectory() || target.isSymbolicLink()
        || volume.dev === parent.dev || target.dev !== volume.dev
        || !isPathInsideRoot(config.worktreeRoot, mount)) rejected();
    const xml = execFileSync("/usr/sbin/diskutil", ["info", "-plist", mount], {
      encoding: "utf8", timeout: 12000, maxBuffer: 1024 * 1024,
    });
    const field = (name: string): string | undefined => {
      const match = new RegExp(
        `<key>${name}</key>\\s*(?:<string>([^<]*)</string>|<(true|false)\\s*/>)`,
      ).exec(xml);
      return match?.[1] ?? match?.[2];
    };
    if (field("VolumeUUID")?.toUpperCase() !== uuid.toUpperCase()
        || field("MountPoint") !== mount
        || field("FilesystemName") !== "APFS"
        || field("Writable") !== "true"
        || field("FileVault") !== "true") rejected();
  } catch {
    rejected();
  }
}

async function resolveGitRoot(path: string, allowedRoots: string[]): Promise<string> {
  try {
    const output = await git(["rev-parse", "--show-toplevel"], path);
    return await assertGitRootAllowed(output.trim(), allowedRoots);
  } catch (error) {
    if (isGitUnavailable(error)) {
      throw new GitWorktreeError(
        "GIT_NOT_AVAILABLE",
        "Cannot open workspace in worktree mode because Git is not available on this machine.",
      );
    }

    throw new GitWorktreeError(
      "GIT_REPOSITORY_NOT_FOUND",
      `Cannot open workspace in worktree mode because this path is not inside a Git repository: ${path}. Use mode=\"checkout\" to work directly in this directory, or initialize Git and create an initial commit first.`,
    );
  }
}

async function assertGitRootAllowed(gitRoot: string, allowedRoots: string[]): Promise<string> {
  if (allowedRoots.some((root) => isPathInsideRoot(gitRoot, root))) {
    return assertAllowedPath(gitRoot, allowedRoots);
  }
  const canonicalGitRoot = await realpath(gitRoot);
  for (const allowedRoot of allowedRoots) {
    const canonicalAllowedRoot = await realpath(allowedRoot).catch(() => undefined);
    if (!canonicalAllowedRoot || !isPathInsideRoot(canonicalGitRoot, canonicalAllowedRoot)) {
      continue;
    }
    const logicalGitRoot = resolve(allowedRoot, relative(canonicalAllowedRoot, canonicalGitRoot));
    return assertAllowedPath(logicalGitRoot, allowedRoots);
  }
  return assertAllowedPath(canonicalGitRoot, allowedRoots);
}

async function resolveBaseCommit(sourceRoot: string, baseRef: string): Promise<string> {
  try {
    return (await git(["rev-parse", "--verify", `${baseRef}^{commit}`], sourceRoot)).trim();
  } catch (error) {
    if (baseRef === "HEAD") {
      throw new GitWorktreeError(
        "GIT_REPOSITORY_HAS_NO_COMMITS",
        "Cannot open workspace in worktree mode because the repository has no commits yet. Create an initial commit first, or use mode=\"checkout\".",
      );
    }

    throw new GitWorktreeError(
      "GIT_INVALID_BASE_REF",
      `Cannot open workspace in worktree mode because baseRef ${JSON.stringify(baseRef)} does not resolve to a commit.`,
    );
  }
}

function sanitizePathSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: gitEnvironment(),
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (isGitUnavailable(error)) throw error;

    const stderr = typeof error === "object" && error && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "").trim()
      : "";
    const stdout = typeof error === "object" && error && "stdout" in error
      ? String((error as { stdout?: unknown }).stdout ?? "").trim()
      : "";
    const details = stderr || stdout || (error instanceof Error ? error.message : String(error));
    throw new Error(details);
  }
}

function isGitUnavailable(error: unknown): boolean {
  return Boolean(
    typeof error === "object" &&
      error &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT",
  );
}
