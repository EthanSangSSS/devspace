import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { FileIdentity, ProcessIdentity } from "./macos-launchd-rollout.js";
import {
  buildProcessIdentityFromObservations,
  parseLaunchctlPrint,
  parseListenerLsof,
  parseParentPid,
  parsePrintDisabled,
  parseTxtLsof,
  prepareCanonicalTempFile,
  rewriteCandidatePlistBytes,
  syncDirectoryDurably,
  validateCanonicalFileIdentity,
  waitForStoppedState,
} from "./macos-launchd-rollout-darwin.js";

const execFileAsync = promisify(execFile);

function launchctlFixture(input: { pid?: number; runs?: number; entrypoint?: string } = {}): string {
  const pid = input.pid ?? 32479;
  const runs = input.runs ?? 2;
  const entrypoint = input.entrypoint
    ?? "/Users/ethan/Slot With Space/node_modules/@waishnav/devspace/dist/cli.js";
  return [
    "gui/501/com.ethan.devspace = {",
    "\tactive count = 1",
    "\tstate = running",
    "",
    "\targuments = {",
    "\t\t/opt/homebrew/opt/node@24/bin/node",
    `\t\t${entrypoint}`,
    "\t\tserve",
    "\t}",
    "",
    `\truns = ${runs}`,
    `\tpid = ${pid}`,
    "}",
    "",
  ].join("\n");
}

function identity(overrides: Partial<FileIdentity> = {}): FileIdentity {
  return {
    path: "/Users/ethan/Library/LaunchAgents/com.ethan.devspace.plist",
    uid: 501,
    gid: 20,
    mode: 0o644,
    device: 1,
    inode: 2,
    kind: "file",
    symlink: false,
    ...overrides,
  };
}

function processIdentity(overrides: Partial<ProcessIdentity> = {}): ProcessIdentity {
  return {
    pid: 123,
    processStartIdentity: "2:Thu Sep 17 10:00:00 2026",
    executableRealpath: "/opt/homebrew/bin/node",
    normalizedArgv: [
      "/opt/homebrew/bin/node",
      "/Users/ethan/slot/node_modules/@waishnav/devspace/dist/cli.js",
      "serve",
    ],
    entrypointRealpath: "/Users/ethan/slot/node_modules/@waishnav/devspace/dist/cli.js",
    ...overrides,
  };
}

test("launchctl print parser preserves arguments and process generation evidence", async () => {
  assert.deepEqual(parseLaunchctlPrint(launchctlFixture()), {
    kind: "known",
    value: {
      loaded: true,
      pid: 32479,
      runCount: 2,
      normalizedArgv: [
        "/opt/homebrew/opt/node@24/bin/node",
        "/Users/ethan/Slot With Space/node_modules/@waishnav/devspace/dist/cli.js",
        "serve",
      ],
    },
  });
  assert.equal(parseLaunchctlPrint("garbled output").kind, "unproven");
});

test("disabled-service parser is exact and fails closed on unknown output", async () => {
  const enabled = '\tdisabled services = {\n\t\t"com.ethan.devspace" => enabled\n\t}\n';
  const disabled = '\tdisabled services = {\n\t\t"com.ethan.devspace" => disabled\n\t}\n';
  assert.deepEqual(parsePrintDisabled(enabled, "com.ethan.devspace"), {
    kind: "known",
    value: "enabled",
  });
  assert.deepEqual(parsePrintDisabled(disabled, "com.ethan.devspace"), {
    kind: "known",
    value: "disabled",
  });
  assert.equal(parsePrintDisabled(enabled, "missing.label").kind, "unproven");
});

test("process and listener parsers preserve exact identity without whitespace splitting", async () => {
  assert.deepEqual(parseTxtLsof("p32479\nftxt\nn/opt/homebrew/bin/node\n"), {
    kind: "known",
    value: "/opt/homebrew/bin/node",
  });
  assert.deepEqual(parseListenerLsof("p32479\n", 0), {
    kind: "known",
    value: { state: "owned", ownerPid: 32479 },
  });
  assert.deepEqual(parseListenerLsof("", 1), {
    kind: "known",
    value: { state: "unowned" },
  });
  assert.equal(parseListenerLsof("p1\np2\n", 0).kind, "unproven");
  assert.deepEqual(parseParentPid("  42\n"), { kind: "known", value: 42 });
  assert.equal(parseParentPid("not-a-pid").kind, "unproven");

  const launchd = parseLaunchctlPrint(launchctlFixture());
  assert.equal(launchd.kind, "known");
  if (launchd.kind !== "known") return;
  const observed = await buildProcessIdentityFromObservations({
    pid: 32479,
    launchd: launchd.value,
    psStartOutput: "Thu Sep 17 10:00:00 2026\n",
    executablePath: "/opt/homebrew/bin/node",
    realpath: async (path: string) => path,
  });
  assert.deepEqual(observed, {
    kind: "known",
    value: {
      pid: 32479,
      processStartIdentity: "2:Thu Sep 17 10:00:00 2026",
      executableRealpath: "/opt/homebrew/bin/node",
      normalizedArgv: [
        "/opt/homebrew/opt/node@24/bin/node",
        "/Users/ethan/Slot With Space/node_modules/@waishnav/devspace/dist/cli.js",
        "serve",
      ],
      entrypointRealpath:
        "/Users/ethan/Slot With Space/node_modules/@waishnav/devspace/dist/cli.js",
    },
  });
});

test("canonical file identity validation rejects symlink, unsafe mode, owner, and parent drift", async () => {
  const parent = identity({
    path: "/Users/ethan/Library/LaunchAgents",
    inode: 1,
    kind: "directory",
    mode: 0o700,
  });
  assert.doesNotThrow(() => validateCanonicalFileIdentity(
    identity(),
    parent,
    {
      canonicalPath: "/Users/ethan/Library/LaunchAgents/com.ethan.devspace.plist",
      parentPath: "/Users/ethan/Library/LaunchAgents",
      effectiveUid: 501,
    },
  ));
  for (const bad of [
    identity({ symlink: true }),
    identity({ mode: 0o666 }),
    identity({ uid: 502 }),
  ]) {
    assert.throws(() => validateCanonicalFileIdentity(bad, parent, {
      canonicalPath: identity().path,
      parentPath: parent.path,
      effectiveUid: 501,
    }));
  }
  assert.throws(() => validateCanonicalFileIdentity(identity(), {
    ...parent,
    path: "/tmp",
  }, {
    canonicalPath: identity().path,
    parentPath: parent.path,
    effectiveUid: 501,
  }));
});

test("same-directory canonical temp preserves bytes and file identity, and fsync failures propagate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-rollout-durability-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalPath = join(root, "com.ethan.devspace.plist");
  const bytes = Buffer.from("candidate-bytes\n");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const uid = process.geteuid?.() ?? process.getuid?.() ?? 0;
  const gid = process.getegid?.() ?? process.getgid?.() ?? 0;

  const prepared = await prepareCanonicalTempFile({
    canonicalPath,
    transactionNonce: "abc123",
    bytes,
    expectedSha256: sha256,
    uid,
    gid,
    mode: 0o640,
  });
  assert.equal(dirname(prepared.path), root);
  assert.equal(basename(prepared.path).startsWith(".com.ethan.devspace.rollout-"), true);
  assert.equal(prepared.path.endsWith(".plist"), false);
  assert.equal(await readFile(prepared.path, "utf8"), bytes.toString("utf8"));
  const stat = await lstat(prepared.path);
  assert.equal(stat.mode & 0o7777, 0o640);
  assert.equal(stat.uid, uid);
  assert.equal(stat.gid, gid);

  await assert.rejects(
    () => prepareCanonicalTempFile({
      canonicalPath,
      transactionNonce: "fsync-fail",
      bytes,
      expectedSha256: sha256,
      uid,
      gid,
      mode: 0o640,
      durability: {
        fsyncFile() { throw new Error("file fsync failed"); },
        fsyncDirectory() {},
      },
    }),
    /file fsync failed/,
  );
  await assert.rejects(
    () => syncDirectoryDurably(root, {
      fsyncFile() {},
      fsyncDirectory() { throw new Error("directory fsync failed"); },
    }),
    /directory fsync failed/,
  );
});

test("stop barrier accepts only a fully stopped service and rejects incompatible runtime or listener", async () => {
  const expected = processIdentity();
  const known = <T>(value: T) => ({ kind: "known" as const, value });

  const stopped = await waitForStoppedState(expected, {
    observeExpectedProcess: async () => known("gone" as const),
    observeLaunchd: async () => known({ loaded: false }),
    observeListener: async () => known({ state: "unowned" as const }),
  }, { timeoutMs: 0, pollIntervalMs: 0 });
  assert.deepEqual(stopped, { kind: "known", value: "stopped" });

  const unrelatedListener = await waitForStoppedState(expected, {
    observeExpectedProcess: async () => known("gone" as const),
    observeLaunchd: async () => known({ loaded: false }),
    observeListener: async () => known({ state: "owned" as const, ownerPid: 999 }),
  }, { timeoutMs: 0, pollIntervalMs: 0 });
  assert.equal(unrelatedListener.kind, "unproven");
  assert.match(unrelatedListener.kind === "unproven" ? unrelatedListener.reason : "", /unrelated listener owner/);

  const incompatibleService = await waitForStoppedState(expected, {
    observeExpectedProcess: async () => known("gone" as const),
    observeLaunchd: async () => known({ loaded: true, pid: 999, runCount: 1, normalizedArgv: [] }),
    observeListener: async () => known({ state: "unowned" as const }),
  }, { timeoutMs: 0, pollIntervalMs: 0 });
  assert.equal(incompatibleService.kind, "unproven");
  assert.match(incompatibleService.kind === "unproven" ? incompatibleService.reason : "", /incompatible same-label runtime/);
});

const darwinTest = process.platform === "darwin" ? test : test.skip;

darwinTest("candidate plist rewrite changes only ProgramArguments[1] semantically", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-rollout-plist-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldPath = join(root, "old.plist");
  const newPath = join(root, "new.plist");
  const oldBytes = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.ethan.devspace</string>
<key>ProgramArguments</key><array><string>/opt/homebrew/bin/node</string><string>/old/node_modules/@waishnav/devspace/dist/cli.js</string><string>serve</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>/tmp/out.log</string><key>StandardErrorPath</key><string>/tmp/err.log</string>
<key>EnvironmentVariables</key><dict><key>EXAMPLE</key><string>unchanged</string></dict>
</dict></plist>\n`);
  const candidate = "/candidate with space/node_modules/@waishnav/devspace/dist/cli.js";
  const newBytes = await rewriteCandidatePlistBytes(oldBytes, candidate);
  await Promise.all([writeFile(oldPath, oldBytes), writeFile(newPath, newBytes)]);
  const [oldJson, newJson] = await Promise.all([
    execFileAsync("/usr/bin/plutil", ["-convert", "json", "-o", "-", oldPath]),
    execFileAsync("/usr/bin/plutil", ["-convert", "json", "-o", "-", newPath]),
  ]);
  const oldValue = JSON.parse(oldJson.stdout) as Record<string, unknown>;
  const newValue = JSON.parse(newJson.stdout) as Record<string, unknown>;
  assert.deepEqual(newValue, {
    ...oldValue,
    ProgramArguments: ["/opt/homebrew/bin/node", candidate, "serve"],
  });
});
