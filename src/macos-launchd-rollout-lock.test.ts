import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireDarwinRolloutLock,
  validateRolloutLockIdentity,
  type LockfRunner,
  type RolloutLockOwnerRecord,
} from "./macos-launchd-rollout-lock.js";

const posixFsTest = process.platform === "win32" ? test.skip : test;

function owner(transactionId: string, nonce = `${transactionId}-nonce`): RolloutLockOwnerRecord {
  return {
    schema_version: 1 as const,
    pid: process.pid,
    process_start_identity: "test-process-start",
    transaction_nonce: nonce,
    transaction_id: transactionId,
    created_at: "2026-09-17T00:00:00.000Z",
  };
}

posixFsTest("kernel busy leaves diagnostic owner bytes untouched", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-rollout-lock-busy-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, "rollout.lock");
  const previous = `${JSON.stringify(owner("old"))}\n`;
  await writeFile(lockPath, previous, { mode: 0o600 });

  const runner: LockfRunner = { async tryExclusive() { return "busy"; } };
  await assert.rejects(
    () => acquireDarwinRolloutLock({ lockPath, owner: owner("new") }, runner),
    (error: unknown) => (error as { code?: unknown }).code === "LOCK_BUSY",
  );
  assert.equal(await readFile(lockPath, "utf8"), previous);
});

posixFsTest("unlocked stale diagnostic record is replaced only after kernel acquisition", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-rollout-lock-stale-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, "rollout.lock");
  await writeFile(lockPath, `${JSON.stringify(owner("old"))}\n`, { mode: 0o600 });
  let runnerCalled = false;
  const runner: LockfRunner = {
    async tryExclusive() {
      runnerCalled = true;
      return "acquired";
    },
  };

  const currentOwner = owner("new");
  const lease = await acquireDarwinRolloutLock({ lockPath, owner: currentOwner }, runner);
  assert.equal(runnerCalled, true);
  assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), currentOwner);
  assert.deepEqual(await lease.assertOwned(), { kind: "known", value: "owned" });
  await lease.release();
  assert.equal((await lstat(lockPath)).isFile(), true, "release must keep the fixed lock file");
  const released = JSON.parse(await readFile(lockPath, "utf8")) as { released_at?: string };
  assert.equal(typeof released.released_at, "string");
});

posixFsTest("release never overwrites another diagnostic nonce", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-rollout-lock-nonce-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, "rollout.lock");
  const runner: LockfRunner = { async tryExclusive() { return "acquired"; } };
  const lease = await acquireDarwinRolloutLock({ lockPath, owner: owner("ours") }, runner);

  const foreign = owner("foreign", "foreign-nonce");
  await writeFile(lockPath, `${JSON.stringify(foreign)}\n`, { mode: 0o600 });
  assert.deepEqual(await lease.assertOwned(), { kind: "known", value: "drift" });
  await lease.release();
  assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), foreign);
});

posixFsTest("unsafe lock identities fail closed as LOCK_AMBIGUOUS", async (t) => {
  const effectiveUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
  const safe = {
    path: "/tmp/rollout.lock",
    uid: effectiveUid,
    gid: 20,
    mode: 0o600,
    device: 1,
    inode: 2,
    kind: "file" as const,
    symlink: false,
  };
  assert.throws(
    () => validateRolloutLockIdentity(
      { ...safe, uid: effectiveUid + 1 },
      safe,
      effectiveUid,
    ),
    (error: unknown) => (error as { code?: unknown }).code === "LOCK_AMBIGUOUS",
  );

  const root = await mkdtemp(join(tmpdir(), "devspace-rollout-lock-unsafe-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner: LockfRunner = { async tryExclusive() { return "acquired"; } };

  const target = join(root, "target");
  await writeFile(target, "target", { mode: 0o600 });
  const symlinkPath = join(root, "symlink.lock");
  await symlink(target, symlinkPath);
  await assert.rejects(
    () => acquireDarwinRolloutLock({ lockPath: symlinkPath, owner: owner("symlink") }, runner),
    (error: unknown) => (error as { code?: unknown }).code === "LOCK_AMBIGUOUS",
  );

  const writablePath = join(root, "writable.lock");
  await writeFile(writablePath, "", { mode: 0o600 });
  await chmod(writablePath, 0o666);
  await assert.rejects(
    () => acquireDarwinRolloutLock({ lockPath: writablePath, owner: owner("writable") }, runner),
    (error: unknown) => (error as { code?: unknown }).code === "LOCK_AMBIGUOUS",
  );

  const directoryPath = join(root, "directory.lock");
  await mkdir(directoryPath);
  await assert.rejects(
    () => acquireDarwinRolloutLock({ lockPath: directoryPath, owner: owner("directory") }, runner),
    (error: unknown) => (error as { code?: unknown }).code === "LOCK_AMBIGUOUS",
  );
});

const darwinTest = process.platform === "darwin" ? test : test.skip;

darwinTest("descriptor-mode lockf keeps the lock while the parent fd remains open", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-rollout-lock-real-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, "rollout.lock");

  const first = await acquireDarwinRolloutLock({ lockPath, owner: owner("first") });
  await assert.rejects(
    () => acquireDarwinRolloutLock({ lockPath, owner: owner("second") }),
    (error: unknown) => (error as { code?: unknown }).code === "LOCK_BUSY",
  );
  await first.release();

  const third = await acquireDarwinRolloutLock({ lockPath, owner: owner("third") });
  await third.release();
  assert.equal((await lstat(lockPath)).isFile(), true);
});
