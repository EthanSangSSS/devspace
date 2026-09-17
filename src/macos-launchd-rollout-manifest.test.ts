import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  buildCandidateSlotManifest,
  resolveCandidateSlotRoot,
  verifyCandidateSlotManifest,
} from "./macos-launchd-rollout-manifest.js";

const execFileAsync = promisify(execFile);
const posixFsTest = process.platform === "win32" ? test.skip : test;

async function createSlot(root: string, reverseCreationOrder = false): Promise<string> {
  const slot = join(root, reverseCreationOrder ? "slot-reverse" : "slot-forward");
  await mkdir(slot);
  const directories = reverseCreationOrder ? ["lib", "bin"] : ["bin", "lib"];
  for (const directory of directories) {
    await mkdir(join(slot, directory));
    await chmod(join(slot, directory), 0o755);
  }
  if (reverseCreationOrder) {
    await writeFile(join(slot, "lib", "entry.js"), "export {};\n");
    await writeFile(join(slot, "bin", "devspace"), "#!/bin/sh\n");
  } else {
    await writeFile(join(slot, "bin", "devspace"), "#!/bin/sh\n");
    await writeFile(join(slot, "lib", "entry.js"), "export {};\n");
  }
  await chmod(join(slot, "bin", "devspace"), 0o755);
  await chmod(join(slot, "lib", "entry.js"), 0o644);
  await symlink("../lib/entry.js", join(slot, "bin", "entry-link"));
  return slot;
}

posixFsTest("candidate manifest is deterministic and encodes the entire slot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-rollout-manifest-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const forward = await createSlot(root, false);
  const reverse = await createSlot(root, true);

  const first = await buildCandidateSlotManifest(forward);
  const second = await buildCandidateSlotManifest(reverse);

  const devspaceHash = createHash("sha256").update("#!/bin/sh\n").digest("hex");
  const entryHash = createHash("sha256").update("export {};\n").digest("hex");
  const expected = [
    "D\t755\tbin\n",
    `F\t755\t${devspaceHash}\tbin/devspace\n`,
    "L\t../lib/entry.js\tbin/entry-link\n",
    "D\t755\tlib\n",
    `F\t644\t${entryHash}\tlib/entry.js\n`,
  ].join("");

  assert.equal(first.bytes.toString("utf8"), expected);
  assert.equal(second.bytes.toString("utf8"), expected);
  assert.equal(first.sha256, createHash("sha256").update(expected).digest("hex"));
  assert.equal(second.sha256, first.sha256, "directory creation order must not affect digest");
});

posixFsTest("candidate manifest rejects escaping symlinks and ambiguous paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-rollout-manifest-invalid-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const escaping = join(root, "escaping");
  await mkdir(join(escaping, "bin"), { recursive: true });
  await symlink("../../outside.js", join(escaping, "bin", "escape"));
  await assert.rejects(
    () => buildCandidateSlotManifest(escaping),
    /escapes candidate slot/,
  );

  const ambiguous = join(root, "ambiguous");
  await mkdir(ambiguous);
  await writeFile(join(ambiguous, "bad\tname"), "x");
  await assert.rejects(
    () => buildCandidateSlotManifest(ambiguous),
    /unsupported manifest path/,
  );
});

posixFsTest("candidate manifest rejects unsupported filesystem entry types", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-rollout-manifest-fifo-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fifo = join(root, "runtime.fifo");
  try {
    await execFileAsync("/usr/bin/mkfifo", [fifo]);
  } catch (error) {
    t.skip(`/usr/bin/mkfifo unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  await assert.rejects(
    () => buildCandidateSlotManifest(root),
    /unsupported candidate slot entry type/,
  );
});

test("candidate slot root is derived only from the exact V1 package suffix", async () => {
  assert.equal(
    resolveCandidateSlotRoot(
      "/Users/ethan/.local/opt/devspace-1.1.0-candidate/node_modules/@waishnav/devspace/dist/cli.js",
    ),
    "/Users/ethan/.local/opt/devspace-1.1.0-candidate",
  );
  assert.throws(
    () => resolveCandidateSlotRoot("/tmp/devspace/dist/cli.js"),
    /candidate entrypoint must end with/,
  );
});

test("candidate manifest verification requires the exact digest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-rollout-manifest-verify-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const slot = await createSlot(root);
  const built = await buildCandidateSlotManifest(slot);
  const verified = await verifyCandidateSlotManifest(slot, built.sha256);
  assert.equal(verified.sha256, built.sha256);
  assert.deepEqual(verified.bytes, built.bytes);
  await assert.rejects(
    () => verifyCandidateSlotManifest(slot, "0".repeat(64)),
    /candidate slot manifest SHA-256 mismatch/,
  );
});
