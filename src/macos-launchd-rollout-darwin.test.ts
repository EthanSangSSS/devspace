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
  assertDarwinPlatform,
  buildProcessIdentityFromObservations,
  buildQualificationFixture,
  createDarwinRolloutAdapters,
  parseLaunchctlPrint,
  parseListenerLsof,
  parseParentPid,
  parsePsCommand,
  parsePrintDisabled,
  parseQualificationProductionDisabledState,
  parseTxtLsof,
  observeFileIdentity,
  prepareCanonicalTempFile,
  readFileSha256,
  rewriteCandidatePlistBytes,
  runDarwinQualificationSequence,
  syncDirectoryDurably,
  validateCanonicalFileIdentity,
  waitForStableState,
  waitForStoppedState,
} from "./macos-launchd-rollout-darwin.js";

const posixFsTest = process.platform === "win32" ? test.skip : test;

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

test("qualification disabled-state observation is anchored to the production label", () => {
  const output = [
    "\tdisabled services = {",
    '\t\t"io.example.first" => enabled',
    '\t\t"com.ethan.devspace" => disabled',
    "\t}",
    "",
  ].join("\n");
  assert.deepEqual(parseQualificationProductionDisabledState(output), {
    kind: "known",
    value: "disabled",
  });
  assert.equal(
    parseQualificationProductionDisabledState(
      '\tdisabled services = {\n\t\t"io.example.first" => enabled\n\t}\n',
    ).kind,
    "unproven",
  );
});

posixFsTest("process and listener parsers preserve exact identity without whitespace splitting", async () => {
  const txt = [
    "p32479",
    "ftxt",
    "n/opt/homebrew/Cellar/node@24/24.19.0/bin/node",
    "ftxt",
    "n/opt/homebrew/Cellar/libuv/1.52.1/lib/libuv.1.0.0.dylib",
    "ftxt",
    "n/usr/lib/dyld",
    "",
  ].join("\n");
  assert.deepEqual(parseTxtLsof(txt), {
    kind: "known",
    value: [
      "/opt/homebrew/Cellar/node@24/24.19.0/bin/node",
      "/opt/homebrew/Cellar/libuv/1.52.1/lib/libuv.1.0.0.dylib",
      "/usr/lib/dyld",
    ],
  });
  assert.deepEqual(parsePsCommand("/opt/homebrew/opt/node@24/bin/node\n"), {
    kind: "known",
    value: "/opt/homebrew/opt/node@24/bin/node",
  });
  assert.deepEqual(parsePsCommand("/Applications/Node With Space/node\n"), {
    kind: "known",
    value: "/Applications/Node With Space/node",
  });
  assert.equal(parsePsCommand("/one\n/two\n").kind, "unproven");
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
    psCommandOutput: "/opt/homebrew/opt/node@24/bin/node\n",
    lsofTextOutput: txt,
    realpath: async (path: string) => path === "/opt/homebrew/opt/node@24/bin/node"
      ? "/opt/homebrew/Cellar/node@24/24.19.0/bin/node"
      : path,
  });
  assert.deepEqual(observed, {
    kind: "known",
    value: {
      pid: 32479,
      processStartIdentity: "2:Thu Sep 17 10:00:00 2026",
      executableRealpath: "/opt/homebrew/Cellar/node@24/24.19.0/bin/node",
      normalizedArgv: [
        "/opt/homebrew/opt/node@24/bin/node",
        "/Users/ethan/Slot With Space/node_modules/@waishnav/devspace/dist/cli.js",
        "serve",
      ],
      entrypointRealpath:
        "/Users/ethan/Slot With Space/node_modules/@waishnav/devspace/dist/cli.js",
    },
  });

  const notCorroborated = await buildProcessIdentityFromObservations({
    pid: 32479,
    launchd: launchd.value,
    psStartOutput: "Thu Sep 17 10:00:00 2026\n",
    psCommandOutput: "/opt/homebrew/opt/node@24/bin/node\n",
    lsofTextOutput: "p32479\nftxt\nn/usr/lib/dyld\n",
    realpath: async (path: string) => path,
  });
  assert.equal(notCorroborated.kind, "unproven");
  assert.match(
    notCorroborated.kind === "unproven" ? notCorroborated.reason : "",
    /not corroborated/i,
  );
});

test("Darwin adapter platform guard fails closed outside macOS", () => {
  assert.doesNotThrow(() => assertDarwinPlatform("darwin"));
  assert.throws(() => assertDarwinPlatform("linux"), /require(?:s)? Darwin/i);
  assert.throws(() => assertDarwinPlatform("win32"), /require(?:s)? Darwin/i);
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

posixFsTest("same-directory canonical temp preserves bytes and file identity, and fsync failures propagate", async (t) => {
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

test("stability gate requires the same process generation, listener owner, and health after the observation window", async () => {
  const expected = processIdentity();
  const known = <T>(value: T) => ({ kind: "known" as const, value });
  let slept = false;
  const stable = await waitForStableState(expected, {
    observeProcess: async () => known(expected),
    observeListener: async () => known({ state: "owned" as const, ownerPid: expected.pid }),
    checkHealth: async () => known("healthy" as const),
  }, {
    observationMs: 25,
    sleep: async (ms) => { slept = ms === 25; },
  });
  assert.equal(slept, true);
  assert.deepEqual(stable, { kind: "known", value: "stable" });

  const replaced = await waitForStableState(expected, {
    observeProcess: async () => known({ ...expected, processStartIdentity: "replacement" }),
    observeListener: async () => known({ state: "owned" as const, ownerPid: expected.pid }),
    checkHealth: async () => known("healthy" as const),
  }, {
    observationMs: 0,
    sleep: async () => undefined,
  });
  assert.equal(replaced.kind, "unproven");
  assert.match(replaced.kind === "unproven" ? replaced.reason : "", /process generation changed/);
});

test("file digest observation hashes exact bytes and fails closed on read errors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-rollout-file-hash-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "candidate.plist");
  await writeFile(path, "candidate\n");
  assert.deepEqual(await readFileSha256(path), {
    kind: "known",
    value: createHash("sha256").update("candidate\n").digest("hex"),
  });
  assert.equal((await readFileSha256(join(root, "missing.plist"))).kind, "unproven");
});

posixFsTest("file identity observation fresh-reads uid/gid/mode and fails closed on missing paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-rollout-file-identity-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "old-restore.tmp");
  await writeFile(path, "old", { mode: 0o640 });

  const observed = await observeFileIdentity(path);
  assert.equal(observed.kind, "known");
  if (observed.kind === "known") {
    assert.equal(observed.value.path, path);
    assert.equal(observed.value.kind, "file");
    assert.equal(observed.value.symlink, false);
    assert.equal(observed.value.mode, 0o640);
  }

  assert.equal((await observeFileIdentity(join(root, "missing.tmp"))).kind, "unproven");
});

test("qualification orchestration is ordered, bounded, and always cleans up", async () => {
  const calls: string[] = [];
  const result = await runDarwinQualificationSequence({
    async macosVersion() { calls.push("version"); return "27.0"; },
    async qualifyLock() { calls.push("lock"); },
    async qualifyDurability() { calls.push("durability"); },
    async bootstrap() { calls.push("bootstrap"); },
    async verifyLaunchd() { calls.push("launchd"); },
    async verifyPrintDisabled() { calls.push("print-disabled"); },
    async verifyProcess() { calls.push("process"); },
    async verifyListener() { calls.push("listener"); },
    async verifyHealth() { calls.push("health"); },
    async verifyStopBarrier() { calls.push("stop-barrier"); },
    async cleanup() { calls.push("cleanup"); },
    label: "com.ethan.devspace.rollout-qualification.test",
    port: 49123,
  });
  assert.deepEqual(calls, [
    "version",
    "lock",
    "durability",
    "bootstrap",
    "launchd",
    "print-disabled",
    "process",
    "listener",
    "health",
    "stop-barrier",
    "cleanup",
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.macosVersion, "27.0");
  assert.equal(result.cleanup, "PASS");

  const failedCalls: string[] = [];
  await assert.rejects(() => runDarwinQualificationSequence({
    async macosVersion() { failedCalls.push("version"); return "27.0"; },
    async qualifyLock() { failedCalls.push("lock"); },
    async qualifyDurability() { failedCalls.push("durability"); throw new Error("fsync unavailable"); },
    async bootstrap() { failedCalls.push("bootstrap"); },
    async verifyLaunchd() { failedCalls.push("launchd"); },
    async verifyPrintDisabled() { failedCalls.push("print-disabled"); },
    async verifyProcess() { failedCalls.push("process"); },
    async verifyListener() { failedCalls.push("listener"); },
    async verifyHealth() { failedCalls.push("health"); },
    async verifyStopBarrier() { failedCalls.push("stop-barrier"); },
    async cleanup() { failedCalls.push("cleanup"); },
    label: "com.ethan.devspace.rollout-qualification.test",
    port: 49123,
  }), /fsync unavailable/);
  assert.deepEqual(failedCalls, ["version", "lock", "durability", "cleanup"]);
});

posixFsTest("qualification fixture is disposable, non-production, and exercises an argv path with spaces", () => {
  const fixture = buildQualificationFixture({
    nonce: "abc123",
    port: 49123,
    homeDir: "/Users/test",
    tempRoot: "/tmp",
    nodeExecutable: "/opt/homebrew/bin/node",
  });
  assert.equal(fixture.label, "com.ethan.devspace.rollout-qualification.abc123");
  assert.notEqual(fixture.label, "com.ethan.devspace");
  assert.equal(fixture.port, 49123);
  assert.equal(
    fixture.plistPath,
    "/Users/test/Library/LaunchAgents/com.ethan.devspace.rollout-qualification.abc123.plist",
  );
  assert.match(fixture.entrypointPath, /Qualification Slot With Space/);
  assert.match(fixture.entrypointPath, /node_modules\/@waishnav\/devspace\/dist\/cli\.js$/);
  assert.match(fixture.plistBytes.toString("utf8"), /DEVSPACE_QUALIFICATION_PORT/);
  assert.match(fixture.plistBytes.toString("utf8"), /49123/);
  assert.throws(() => buildQualificationFixture({
    nonce: "bad",
    port: 7676,
    homeDir: "/Users/test",
    tempRoot: "/tmp",
    nodeExecutable: "/opt/homebrew/bin/node",
  }), /production port/i);
});

const darwinTest = process.platform === "darwin" ? test : test.skip;

darwinTest("health check uses a bounded timeout signal and classifies timeout as unhealthy", async () => {
  const originalFetch = globalThis.fetch;
  let observedSignal: AbortSignal | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    observedSignal = init?.signal ?? undefined;
    assert.ok(observedSignal, "health fetch must receive an AbortSignal");
    return await new Promise<Response>((_resolve, reject) => {
      if (observedSignal!.aborted) {
        reject(observedSignal!.reason);
        return;
      }
      observedSignal!.addEventListener("abort", () => reject(observedSignal!.reason), { once: true });
    });
  }) as typeof fetch;
  try {
    const options = { port: 49123, healthTimeoutMs: 20 };
    const adapters = createDarwinRolloutAdapters(options);
    const result = await adapters.checkHealth();
    assert.deepEqual(result, { kind: "known", value: "unhealthy" });
    assert.equal(observedSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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
