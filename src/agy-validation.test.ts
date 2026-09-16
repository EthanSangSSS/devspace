import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  runValidationCommands,
  validateValidationCommand,
  writeValidationSandbox,
} from "./agy-validation.js";
import { AgyDelegationError } from "./agy-delegation-types.js";

const macTest = process.platform === "darwin" ? test : test.skip;

macTest("validation policy allows bounded package validators and denies arbitrary execution surfaces", () => {
  const root = "/tmp/repo";
  assert.equal(validateValidationCommand(["npm", "test"], root).argv[0], "npm");
  assert.equal(validateValidationCommand(["npm", "run", "build"], root).argv[2], "build");

  for (const argv of [
    ["bash", "-c", "npm test"],
    ["sh", "-c", "npm test"],
    ["git", "push"],
    ["gh", "pr", "create"],
    ["curl", "https://example.com"],
    ["python", "-c", "print(1)"],
    ["node", "-e", "console.log(1)"],
    ["npm", "install"],
    ["npm", "run", "publish"],
  ]) {
    assert.throws(
      () => validateValidationCommand(argv, root),
      (error: unknown) => error instanceof AgyDelegationError && error.code === "POLICY_DENIED",
      argv.join(" "),
    );
  }
});

macTest("sandbox profile denies network and limits writable paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-agy-validation-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const tmp = join(home, "tmp");
  const sandboxPath = join(root, "validation.sb");
  await Promise.all([mkdir(workspace), mkdir(home)]);
  await mkdir(tmp);

  await writeValidationSandbox({ workspace, home, tmp, output: sandboxPath });
  const sandbox = await readFile(sandboxPath, "utf8");
  assert.match(sandbox, /\(deny network\*\)/);
  assert.match(sandbox, new RegExp(escapeRegExp(workspace)));
  assert.match(sandbox, new RegExp(escapeRegExp(home)));
  assert.match(sandbox, new RegExp(escapeRegExp(tmp)));
  assert.doesNotMatch(sandbox, /allow network/);
});

test("validation runner executes declared npm test in isolated writable state and records a receipt", {
  skip: process.platform !== "darwin" ? "authoritative validation isolation is macOS-only in V1" : false,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-agy-validation-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const artifacts = join(root, "artifacts");
  await Promise.all([mkdir(workspace), mkdir(home), mkdir(artifacts)]);
  await writeFile(join(workspace, "package.json"), JSON.stringify({
    scripts: { test: "printf validation-ok" },
  }));

  const receipts = await runValidationCommands(
    [{ argv: ["npm", "test"] }],
    { workspace, home, artifacts, timeoutMs: 15_000 },
  );

  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.exitCode, 0);
  assert.equal(receipts[0]?.sandboxed, true);
  assert.deepEqual(receipts[0]?.argv, ["npm", "test"]);
  assert.match(await readFile(join(artifacts, receipts[0]!.stdoutArtifact), "utf8"), /validation-ok/);
});

test("validation runner fails closed when authoritative macOS isolation is unavailable", async () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(platformDescriptor);
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
  try {
    await assert.rejects(
      runValidationCommands(
        [{ argv: ["npm", "test"] }],
        {
          workspace: "/tmp/devspace-validation-non-darwin",
          home: "/tmp/devspace-validation-non-darwin-home",
          artifacts: "/tmp/devspace-validation-non-darwin-artifacts",
          timeoutMs: 1_000,
        },
      ),
      (error: unknown) => error instanceof AgyDelegationError && error.code === "NETWORK_POLICY_DENIED",
    );
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
