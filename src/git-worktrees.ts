import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, realpath, rmdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { ServerConfig } from "./config.js";
import { assertAllowedPath, isPathInsideRoot } from "./roots.js";
import { gitEnvironment } from "./git-environment.js";

const execFileAsync = promisify(execFile);

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

export interface ReservedWorktreePath {
  path: string;
  dev: number;
  ino: number;
}

/** Reserve a new, empty directory atomically. An existing candidate is never reused. */
export async function reserveManagedWorktreePath(input: {
  worktreeRoot: string;
  repoRoot: string;
  generateId?: () => string;
}): Promise<ReservedWorktreePath> {
  const repoName = sanitizePathSegment(basename(input.repoRoot)) || "repo";
  const generateId = input.generateId ?? (() => randomBytes(12).toString("hex"));
  await mkdir(input.worktreeRoot, { recursive: true });

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
    return { path, dev: identity.dev, ino: identity.ino };
  }

  throw new GitWorktreeError("GIT_WORKTREE_CREATE_FAILED", "Could not reserve a unique managed worktree path.");
}

/** Never recursively delete a failed worktree: unknown contents must survive. */
export async function releaseReservedWorktreePath(reservation: ReservedWorktreePath): Promise<boolean> {
  let identity;
  try {
    identity = await lstat(reservation.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!identity.isDirectory() || identity.isSymbolicLink()
    || identity.dev !== reservation.dev || identity.ino !== reservation.ino) {
    return false;
  }

  try {
    // rmdir removes empty directories only, even if another process races the identity check.
    await rmdir(reservation.path);
    return true;
  } catch (error) {
    if (["ENOTEMPTY", "EEXIST", "ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return false;
    }
    throw error;
  }
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
  const baseRef = input.baseRef ?? "HEAD";
  const baseSha = await resolveBaseCommit(sourceRoot, baseRef);
  const dirtySource = (await git(["status", "--porcelain=v1"], sourceRoot)).trim().length > 0;
  const reservation = await reserveManagedWorktreePath({
    worktreeRoot: input.config.worktreeRoot,
    repoRoot: sourceRoot,
  });

  try {
    await git(["worktree", "add", "--detach", reservation.path, baseSha], sourceRoot);
  } catch (error) {
    // If Git left files or another process replaced the directory, retain it for recovery.
    const removed = await releaseReservedWorktreePath(reservation).catch(() => false);
    const message = error instanceof Error ? error.message : String(error);
    throw new GitWorktreeError(
      "GIT_WORKTREE_CREATE_FAILED",
      `Git failed to create the managed worktree. ${message}`
        + (removed ? "" : ` The worktree path was retained for inspection: ${reservation.path}`),
    );
  }

  return {
    sourceRoot,
    path: reservation.path,
    baseRef,
    baseSha,
    dirtySource,
    detached: true,
    managed: true,
  };
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
