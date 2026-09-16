import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import {
  disposeAgyRepositorySnapshot,
  fingerprintRepository,
  prepareAgyRepositorySnapshot,
  verifySourceUnchanged,
} from "./agy-repository.js";
import { AgyDelegationError } from "./agy-delegation-types.js";

const execFileAsync = promisify(execFile);

test("exports only declared committed scopes without .git", async (t) => {
  const fixture = await repositoryFixture(t);
  const snapshot = await prepareAgyRepositorySnapshot({
    repositoryRoot: fixture.repo,
    expectedSourceHead: fixture.head,
    allowedReadPaths: ["README.md", "src"],
    gitleaksPath: fixture.gitleaksPass,
  });
  t.after(() => disposeAgyRepositorySnapshot(snapshot));

  assert.equal(snapshot.sourceHead, fixture.head);
  assert.equal(await exists(join(snapshot.root, "README.md")), true);
  assert.equal(await exists(join(snapshot.root, "src", "app.ts")), true);
  assert.equal(await exists(join(snapshot.root, "private.txt")), false);
  assert.equal(await exists(join(snapshot.root, ".git")), false);
  assert.equal(await readFile(join(snapshot.root, "README.md"), "utf8"), "hello\n");
  assert.match(snapshot.sourceFingerprintBefore, /^[0-9a-f]{64}$/);
});

test("fails before export when reviewed HEAD moved", async (t) => {
  const fixture = await repositoryFixture(t);
  await assert.rejects(
    () => prepareAgyRepositorySnapshot({
      repositoryRoot: fixture.repo,
      expectedSourceHead: "0".repeat(40),
      allowedReadPaths: ["README.md"],
      gitleaksPath: fixture.gitleaksPass,
    }),
    isCode("SOURCE_HEAD_MISMATCH"),
  );
});

test("rejects traversal, git metadata, sensitive paths, missing paths, and symlinks", async (t) => {
  const fixture = await repositoryFixture(t, { includeSymlink: true });
  for (const path of ["../README.md", ".git/config", ".env", "/tmp/file", "missing.txt", "outside-link"]) {
    await assert.rejects(
      () => prepareAgyRepositorySnapshot({
        repositoryRoot: fixture.repo,
        expectedSourceHead: fixture.head,
        allowedReadPaths: [path],
        gitleaksPath: fixture.gitleaksPass,
      }),
      isCode("SCOPE_VIOLATION"),
      path,
    );
  }
});

test("blocks provider export when Gitleaks reports a finding", async (t) => {
  const fixture = await repositoryFixture(t);
  await assert.rejects(
    () => prepareAgyRepositorySnapshot({
      repositoryRoot: fixture.repo,
      expectedSourceHead: fixture.head,
      allowedReadPaths: ["README.md"],
      gitleaksPath: fixture.gitleaksFail,
    }),
    isCode("POLICY_DENIED"),
  );
});

test("source fingerprint detects repository changes after snapshot preparation", async (t) => {
  const fixture = await repositoryFixture(t);
  const before = await fingerprintRepository(fixture.repo);
  const snapshot = await prepareAgyRepositorySnapshot({
    repositoryRoot: fixture.repo,
    expectedSourceHead: fixture.head,
    allowedReadPaths: ["README.md"],
    gitleaksPath: fixture.gitleaksPass,
  });
  t.after(() => disposeAgyRepositorySnapshot(snapshot));
  assert.equal(snapshot.sourceFingerprintBefore, before);

  await writeFile(join(fixture.repo, "README.md"), "changed\n");
  await assert.rejects(() => verifySourceUnchanged(snapshot), isCode("EVIDENCE_INCOMPLETE"));
});

async function repositoryFixture(
  t: TestContext,
  options: { includeSymlink?: boolean } = {},
): Promise<{
  repo: string;
  head: string;
  gitleaksPass: string;
  gitleaksFail: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "devspace-agy-repo-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "README.md"), "hello\n");
  await writeFile(join(repo, "src", "app.ts"), "export const value = 1;\n");
  await writeFile(join(repo, "private.txt"), "not exported\n");
  await writeFile(join(repo, ".env"), "EXAMPLE=not-a-secret\n");
  if (options.includeSymlink) {
    await symlink("/etc/hosts", join(repo, "outside-link"));
  }
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "devspace@example.com"]);
  await git(repo, ["config", "user.name", "DevSpace Test"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "Initial commit"]);
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });

  const gitleaksPass = join(root, "gitleaks-pass");
  const gitleaksFail = join(root, "gitleaks-fail");
  await writeFile(gitleaksPass, "#!/bin/sh\nexit 0\n");
  await writeFile(gitleaksFail, "#!/bin/sh\nexit 1\n");
  await chmod(gitleaksPass, 0o700);
  await chmod(gitleaksFail, 0o700);
  return { repo, head: stdout.trim(), gitleaksPass, gitleaksFail };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
      ? false
      : Promise.reject(error);
  }
}

function isCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof AgyDelegationError && error.code === code;
}
