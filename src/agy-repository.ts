import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { AgyDelegationError } from "./agy-delegation-types.js";
import { gitEnvironment } from "./git-environment.js";

const execFileAsync = promisify(execFile);
const SENSITIVE_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".env",
  "auth.json",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
]);

export interface PrepareAgyRepositorySnapshotInput {
  repositoryRoot: string;
  expectedSourceHead: string;
  allowedReadPaths: string[];
  gitleaksPath: string;
}

export interface AgyRepositorySnapshot {
  root: string;
  taskRoot: string;
  repositoryRoot: string;
  sourceHead: string;
  sourceFingerprintBefore: string;
  allowedReadPaths: string[];
}

export async function prepareAgyRepositorySnapshot(
  input: PrepareAgyRepositorySnapshotInput,
): Promise<AgyRepositorySnapshot> {
  const repositoryRoot = await resolveRepositoryRoot(input.repositoryRoot);
  const allowedReadPaths = input.allowedReadPaths.map(validateRequestedPath);
  if (allowedReadPaths.length === 0) {
    throw new AgyDelegationError("SCOPE_VIOLATION", "At least one repository read path is required.");
  }

  const sourceHead = await gitText(repositoryRoot, ["rev-parse", "HEAD"]);
  if (sourceHead !== input.expectedSourceHead) {
    throw new AgyDelegationError(
      "SOURCE_HEAD_MISMATCH",
      `Repository HEAD ${sourceHead} does not match expected ${input.expectedSourceHead}.`,
    );
  }
  const sourceFingerprintBefore = await fingerprintRepository(repositoryRoot);

  const taskRoot = await mkdtemp(join(tmpdir(), "devspace-agy-repo-"));
  const snapshotRoot = join(taskRoot, "snapshot");
  const archivePath = join(taskRoot, "snapshot.tar");
  await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });

  try {
    await execGitArchive(repositoryRoot, sourceHead, allowedReadPaths, archivePath);
    await execFileAsync("/usr/bin/tar", ["-xf", archivePath, "-C", snapshotRoot], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    await validateSnapshotTree(snapshotRoot);
    await runGitleaks(input.gitleaksPath, snapshotRoot);
    return {
      root: snapshotRoot,
      taskRoot,
      repositoryRoot,
      sourceHead,
      sourceFingerprintBefore,
      allowedReadPaths,
    };
  } catch (error) {
    await rm(taskRoot, { recursive: true, force: true });
    if (error instanceof AgyDelegationError) throw error;
    throw new AgyDelegationError(
      "SCOPE_VIOLATION",
      `Unable to prepare bounded repository snapshot: ${errorMessage(error)}`,
    );
  }
}

export async function fingerprintRepository(repositoryRoot: string): Promise<string> {
  const root = await resolveRepositoryRoot(repositoryRoot);
  const [head, status] = await Promise.all([
    gitText(root, ["rev-parse", "HEAD"]),
    execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: root,
      env: gitEnvironment(),
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    }).then(({ stdout }) => stdout),
  ]);
  return createHash("sha256")
    .update(head)
    .update("\0")
    .update(status)
    .digest("hex");
}

export async function verifySourceUnchanged(snapshot: AgyRepositorySnapshot): Promise<void> {
  const after = await fingerprintRepository(snapshot.repositoryRoot);
  if (after !== snapshot.sourceFingerprintBefore) {
    throw new AgyDelegationError(
      "EVIDENCE_INCOMPLETE",
      "Repository source state changed during delegated execution.",
    );
  }
}

export async function disposeAgyRepositorySnapshot(snapshot: AgyRepositorySnapshot): Promise<void> {
  await rm(snapshot.taskRoot, { recursive: true, force: true });
}

async function resolveRepositoryRoot(repositoryRoot: string): Promise<string> {
  const requested = resolve(repositoryRoot);
  const actual = await realpath(requested).catch((error: unknown) => {
    throw new AgyDelegationError(
      "SCOPE_VIOLATION",
      `Repository root cannot be resolved: ${errorMessage(error)}`,
    );
  });
  const topLevel = await gitText(actual, ["rev-parse", "--show-toplevel"]).catch(() => {
    throw new AgyDelegationError("SCOPE_VIOLATION", "Target workspace is not a Git repository.");
  });
  if (resolve(topLevel) !== actual) {
    throw new AgyDelegationError("SCOPE_VIOLATION", "Delegation requires the exact Git repository root.");
  }
  return actual;
}

function validateRequestedPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed.includes("\0") || isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new AgyDelegationError("SCOPE_VIOLATION", `Invalid repository read path: ${path}`);
  }
  const segments = trimmed.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.some((segment) => segment === ".." || isSensitiveSegment(segment))) {
    throw new AgyDelegationError("SCOPE_VIOLATION", `Sensitive or escaping repository read path: ${path}`);
  }
  return segments.length === 0 ? "." : segments.join("/");
}

async function execGitArchive(
  repositoryRoot: string,
  sourceHead: string,
  allowedReadPaths: string[],
  archivePath: string,
): Promise<void> {
  try {
    await execFileAsync(
      "git",
      ["archive", "--format=tar", `--output=${archivePath}`, sourceHead, "--", ...allowedReadPaths],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  } catch (error) {
    throw new AgyDelegationError(
      "SCOPE_VIOLATION",
      `One or more requested paths are not present in the reviewed committed HEAD: ${errorMessage(error)}`,
    );
  }
}

async function validateSnapshotTree(root: string): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const rel = relative(root, path);
      const segments = rel.split(/[\\/]+/);
      if (segments.some(isSensitiveSegment)) {
        throw new AgyDelegationError("SCOPE_VIOLATION", `Snapshot contains a sensitive path: ${rel}`);
      }
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new AgyDelegationError("SCOPE_VIOLATION", `Snapshot contains a symbolic link: ${rel}`);
      }
      if (metadata.isDirectory()) await visit(path);
    }
  };
  await visit(root);
}

async function runGitleaks(gitleaksPath: string, snapshotRoot: string): Promise<void> {
  try {
    await execFileAsync(
      gitleaksPath,
      ["detect", "--no-git", "--source", snapshotRoot, "--exit-code", "1", "--no-banner", "--redact=100"],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (error) {
    const code = childExitCode(error);
    if (code === 1) {
      throw new AgyDelegationError("POLICY_DENIED", "Gitleaks rejected the bounded repository snapshot.");
    }
    throw new AgyDelegationError(
      "EXECUTOR_FAILURE",
      `Gitleaks preflight failed: ${errorMessage(error)}`,
    );
  }
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: gitEnvironment(),
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

function isSensitiveSegment(segment: string): boolean {
  const lower = basename(segment).toLowerCase();
  return SENSITIVE_SEGMENTS.has(lower) || lower.startsWith(".env.");
}

function childExitCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
