import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type {
  FileIdentity,
  LaunchdObservation,
  ObservedState,
  ProcessIdentity,
} from "./macos-launchd-rollout.js";
import {
  assertDarwinPlatform,
  buildProcessIdentityFromObservations,
  buildQualificationFixture,
  type CommandRunner,
  createDarwinRolloutAdapters,
  createExecFileRunner,
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
  verifyCandidateRuntimePreflight,
  waitForInactiveCandidateStoppedState,
  waitForStableState,
  waitForRuntimeReadyState,
  waitForStoppedState,
  ROLLOUT_STOP_TIMEOUT_MS,
} from "./macos-launchd-rollout-darwin.js";
import { MCP_SESSION_DRAIN_TIMEOUT_MS } from "./mcp-sessions.js";

const posixFsTest = process.platform === "win32" ? test.skip : test;
const darwinTest = process.platform === "darwin" ? test : test.skip;

const execFileAsync = promisify(execFile);

function launchctlFixture(input: {
  pid?: number;
  runs?: number;
  entrypoint?: string;
  nodeExecutable?: string;
} = {}): string {
  const pid = input.pid ?? 32479;
  const runs = input.runs ?? 2;
  const entrypoint = input.entrypoint
    ?? "/Users/ethan/Slot With Space/node_modules/@waishnav/devspace/dist/cli.js";
  const nodeExecutable = input.nodeExecutable ?? "/opt/homebrew/opt/node@24/bin/node";
  return [
    "gui/501/com.ethan.devspace = {",
    "\tactive count = 1",
    "\tstate = running",
    "",
    "\targuments = {",
    `\t\t${nodeExecutable}`,
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
  assert.equal(
    parseLaunchctlPrint(launchctlFixture().replace("pid = 32479", "pid = unavailable")).kind,
    "unproven",
    "a present but malformed pid field must not be treated as confirmed PID absence",
  );
  assert.equal(
    parseLaunchctlPrint(launchctlFixture().replace("runs = 2", "runs = many")).kind,
    "unproven",
    "a present but malformed runs field must fail closed",
  );
});

test("listener success without a valid owner record cannot prove port absence", () => {
  for (const output of ["", "garbled", "pnot-a-pid\n", "p0\n"]) {
    assert.equal(parseListenerLsof(output, 0).kind, "unproven", JSON.stringify(output));
  }
  assert.deepEqual(parseListenerLsof("", 1), { kind: "known", value: { state: "unowned" } });
});

posixFsTest("canonical temp collision preserves an existing file owned by another operation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-temp-collision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const existing = join(root, ".service.rollout-collision.tmp");
  await writeFile(existing, "preserve-existing\n", { mode: 0o600 });
  const bytes = Buffer.from("candidate\n");
  await assert.rejects(prepareCanonicalTempFile({
    canonicalPath: join(root, "service.plist"),
    transactionNonce: "collision",
    bytes,
    expectedSha256: createHash("sha256").update(bytes).digest("hex"),
    uid: process.getuid!(),
    gid: process.getgid!(),
    mode: 0o600,
  }), { code: "EEXIST" });
  assert.equal(await readFile(existing, "utf8"), "preserve-existing\n");
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
  assert.equal(parseListenerLsof("p123\npbroken\n", 0).kind, "unproven");
  assert.deepEqual(parseListenerLsof("p78407\nf19\n", 0), {
    kind: "known", value: { state: "owned", ownerPid: 78407 },
  }, "Darwin -Fp output includes a numeric file-descriptor field");
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

test("candidate runtime preflight uses the staged Node/environment and rejects a broken SQLite native binding", async () => {
  const candidate = "/Users/ethan/.local/opt/devspace-candidate/node_modules/@waishnav/devspace/dist/cli.js";
  const plist = "/tmp/candidate.plist";
  const node = "/opt/homebrew/opt/node@24/bin/node";
  const calls: Array<{ executable: string; args: readonly string[]; cwd?: string; home?: string }> = [];
  const runner = (sqliteLine: string): CommandRunner => ({
    async run(executable, args, options) {
      calls.push({ executable, args, cwd: options?.cwd, home: options?.env?.HOME });
      if (executable === "/usr/bin/plutil") {
        assert.deepEqual(args, ["-convert", "json", "-o", "-", plist]);
        return {
          stdout: JSON.stringify({
            ProgramArguments: [node, candidate, "serve"],
            WorkingDirectory: "/Users/ethan",
            EnvironmentVariables: { HOME: "/Users/ethan", PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (executable === node) {
        return {
          stdout: [
            "Node: v24.19.0 (supported)",
            "Node ABI: 137",
            "Platform: darwin arm64",
            sqliteLine,
            "Local MCP URL: http://127.0.0.1:7676/mcp",
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`unexpected executable ${executable}`);
    },
  });

  await verifyCandidateRuntimePreflight(
    plist,
    candidate,
    [node, candidate, "serve"],
    runner("SQLite native dependency: ok"),
  );
  const preflightCall = calls.find((call) => call.executable === node);
  assert.deepEqual(preflightCall?.args, [candidate, "rollout-preflight"]);
  assert.equal(preflightCall?.cwd, "/Users/ethan");
  assert.equal(preflightCall?.home, "/Users/ethan");

  await assert.rejects(
    () => verifyCandidateRuntimePreflight(
      plist,
      candidate,
      [node, candidate, "serve"],
      runner("SQLite native dependency: Could not locate the bindings file for node-v137-darwin-arm64"),
    ),
    /SQLite native dependency/,
  );
  await assert.rejects(
    () => verifyCandidateRuntimePreflight(
      plist,
      candidate,
      ["/opt/homebrew/opt/node@22/bin/node", candidate, "serve"],
      runner("SQLite native dependency: ok"),
    ),
    /plist argv does not match/,
  );
});

darwinTest("inactive candidate bootout requires exact candidate argv and an unowned production listener", async () => {
  const candidate = "/candidate/node_modules/@waishnav/devspace/dist/cli.js";
  const expectedArgv = ["/opt/homebrew/opt/node@24/bin/node", candidate, "serve"];
  let bootoutCalls = 0;
  let stopped = false;
  const loadedNoPid = [
    "gui/501/com.ethan.devspace = {",
    "\tstate = spawn scheduled",
    "\targuments = {",
    `\t\t${expectedArgv[0]}`,
    `\t\t${expectedArgv[1]}`,
    `\t\t${expectedArgv[2]}`,
    "\t}",
    "\truns = 64",
    "}",
    "",
  ].join("\n");
  const commandRunner: CommandRunner = {
    async run(executable, args) {
      if (executable === "/bin/launchctl" && args[0] === "print") {
        return stopped
          ? { stdout: "", stderr: "Could not find service", exitCode: 113 }
          : { stdout: loadedNoPid, stderr: "", exitCode: 0 };
      }
      if (executable === "/usr/sbin/lsof") {
        return { stdout: "", stderr: "", exitCode: 1 };
      }
      if (executable === "/bin/launchctl" && args[0] === "bootout") {
        bootoutCalls += 1;
        stopped = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected command ${executable} ${args.join(" ")}`);
    },
  };
  const adapters = createDarwinRolloutAdapters({
    uid: 501,
    commandRunner,
    stopTimeoutMs: 50,
    stopPollIntervalMs: 1,
    sleep: async () => undefined,
  });

  await adapters.bootoutInactiveCandidate(expectedArgv);
  assert.equal(bootoutCalls, 1);

  stopped = false;
  bootoutCalls = 0;
  await assert.rejects(
    () => adapters.bootoutInactiveCandidate([
      "/opt/homebrew/opt/node@24/bin/node",
      "/different/node_modules/@waishnav/devspace/dist/cli.js",
      "serve",
    ]),
    /loaded definition is not the expected candidate/,
  );
  assert.equal(bootoutCalls, 0);
});

test("inactive candidate stop barrier bounds hanging probes and rejects success observed after the deadline", async () => {
  const expectedArgv = ["/opt/homebrew/bin/node", "/candidate/cli.js", "serve"];

  let nowValue = 0;
  const lateSuccess = await waitForInactiveCandidateStoppedState(expectedArgv, {
    async observeLaunchd() {
      nowValue = 100;
      return { kind: "known", value: { loaded: false } };
    },
    async observeListener() {
      return { kind: "known", value: { state: "unowned" } };
    },
  }, {
    timeoutMs: 5,
    pollIntervalMs: 1,
    now: () => nowValue,
    sleep: async () => undefined,
  });
  assert.equal(lateSuccess.kind, "unproven");
  assert.match(lateSuccess.kind === "unproven" ? lateSuccess.reason : "", /timed out/);

  let sawAbortSignal = false;
  const hanging = waitForInactiveCandidateStoppedState(expectedArgv, {
    async observeLaunchd(signal) {
      sawAbortSignal = Boolean(signal);
      return await new Promise<ObservedState<LaunchdObservation>>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    async observeListener() {
      return { kind: "known", value: { state: "unowned" } };
    },
  }, {
    timeoutMs: 10,
    pollIntervalMs: 1,
  });
  const result = await hanging;
  assert.equal(sawAbortSignal, true);
  assert.equal(result.kind, "unproven");
  assert.match(result.kind === "unproven" ? result.reason : "", /timed out/);
});

test("inactive candidate stop barrier inherits an outer cancellation signal", async () => {
  const expectedArgv = ["/opt/homebrew/bin/node", "/candidate/cli.js", "serve"];
  const controller = new AbortController();
  controller.abort();
  let probeCalls = 0;
  const result = await waitForInactiveCandidateStoppedState(expectedArgv, {
    async observeLaunchd() {
      probeCalls += 1;
      return { kind: "known", value: { loaded: false } };
    },
    async observeListener() {
      probeCalls += 1;
      return { kind: "known", value: { state: "unowned" } };
    },
  }, {
    deadline: Date.now() + 1_000,
    signal: controller.signal,
    pollIntervalMs: 1,
  });
  assert.equal(result.kind, "unproven");
  assert.match(result.kind === "unproven" ? result.reason : "", /timed out/);
  assert.equal(probeCalls, 0, "an inherited outer abort must prevent new stop-barrier probes");
});

darwinTest("inactive candidate bootout preserves the outer absolute deadline across barrier handoff", async () => {
  const candidate = "/candidate/node_modules/@waishnav/devspace/dist/cli.js";
  const expectedArgv = ["/opt/homebrew/opt/node@24/bin/node", candidate, "serve"];
  const loadedNoPid = [
    "gui/501/com.ethan.devspace = {",
    "\tstate = spawn scheduled",
    "\targuments = {",
    `\t\t${expectedArgv[0]}`,
    `\t\t${expectedArgv[1]}`,
    `\t\t${expectedArgv[2]}`,
    "\t}",
    "\truns = 64",
    "}",
    "",
  ].join("\n");
  let stopped = false;
  let postBootoutNowReads = 0;
  let bootoutCalls = 0;
  const now = () => {
    if (!stopped) return 0;
    postBootoutNowReads += 1;
    return postBootoutNowReads <= 2 ? 9 : 11;
  };
  const commandRunner: CommandRunner = {
    async run(executable, args) {
      if (executable === "/bin/launchctl" && args[0] === "print") {
        return stopped
          ? { stdout: "", stderr: "Could not find service", exitCode: 113 }
          : { stdout: loadedNoPid, stderr: "", exitCode: 0 };
      }
      if (executable === "/usr/sbin/lsof") {
        return { stdout: "", stderr: "", exitCode: 1 };
      }
      if (executable === "/bin/launchctl" && args[0] === "bootout") {
        bootoutCalls += 1;
        stopped = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected command ${executable} ${args.join(" ")}`);
    },
  };
  const adapters = createDarwinRolloutAdapters({
    uid: 501,
    commandRunner,
    stopTimeoutMs: 10,
    stopPollIntervalMs: 1,
    now,
    sleep: async () => undefined,
  });

  await assert.rejects(
    () => adapters.bootoutInactiveCandidate(expectedArgv),
    /timed out|deadline expired/,
  );
  assert.equal(bootoutCalls, 1);
  assert.ok(postBootoutNowReads >= 3, "test must cross the original absolute deadline during handoff");
});

test("inactive candidate stop barrier preserves observed foreign-state refusal", async () => {
  const expectedArgv = ["/opt/homebrew/bin/node", "/candidate/cli.js", "serve"];
  let listenerReads = 0;
  const result = await waitForInactiveCandidateStoppedState(expectedArgv, {
    async observeLaunchd() {
      return { kind: "known", value: { loaded: true, normalizedArgv: expectedArgv } };
    },
    async observeListener() {
      listenerReads += 1;
      return listenerReads === 1
        ? { kind: "known", value: { state: "owned", ownerPid: 999 } }
        : { kind: "known", value: { state: "unowned" } };
    },
  }, {
    timeoutMs: 50,
    pollIntervalMs: 1,
    sleep: async () => undefined,
  });
  assert.equal(result.kind, "unproven");
  assert.match(result.kind === "unproven" ? result.reason : "", /listener owner appeared/);
  assert.equal(listenerReads, 1, "foreign listener must fail closed immediately");
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
  }, { timeoutMs: 100, pollIntervalMs: 0 });
  assert.deepEqual(stopped, { kind: "known", value: "stopped" });

  const unrelatedListener = await waitForStoppedState(expected, {
    observeExpectedProcess: async () => known("gone" as const),
    observeLaunchd: async () => known({ loaded: false }),
    observeListener: async () => known({ state: "owned" as const, ownerPid: 999 }),
  }, { timeoutMs: 100, pollIntervalMs: 0 });
  assert.equal(unrelatedListener.kind, "unproven");
  assert.match(unrelatedListener.kind === "unproven" ? unrelatedListener.reason : "", /unrelated listener owner/);

  const incompatibleService = await waitForStoppedState(expected, {
    observeExpectedProcess: async () => known("gone" as const),
    observeLaunchd: async () => known({ loaded: true, pid: 999, runCount: 1, normalizedArgv: [] }),
    observeListener: async () => known({ state: "unowned" as const }),
  }, { timeoutMs: 100, pollIntervalMs: 0 });
  assert.equal(incompatibleService.kind, "unproven");
  assert.match(incompatibleService.kind === "unproven" ? incompatibleService.reason : "", /incompatible same-label runtime/);
});

test("default rollout stop budget covers the MCP drain contract plus margin", () => {
  assert.equal(ROLLOUT_STOP_TIMEOUT_MS, MCP_SESSION_DRAIN_TIMEOUT_MS + 5_000);
  assert.ok(ROLLOUT_STOP_TIMEOUT_MS > MCP_SESSION_DRAIN_TIMEOUT_MS);
});

test("normal stop barrier aborts a pending probe at its shared deadline", async () => {
  const expected = processIdentity();
  let aborted = false;
  const result = await Promise.race([
    waitForStoppedState(expected, {
      async observeExpectedProcess(signal) {
        signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
        return await new Promise<ObservedState<"alive" | "gone" | "reused">>(() => undefined);
      },
      async observeLaunchd() {
        throw new Error("launchd probe must not run");
      },
      async observeListener() {
        throw new Error("listener probe must not run");
      },
    }, {
      timeoutMs: 15,
      pollIntervalMs: 1,
    }),
    new Promise<"guard">((resolve) => setTimeout(() => resolve("guard"), 200)),
  ]);
  assert.notEqual(result, "guard");
  assert.equal(aborted, true);
  if (result !== "guard") {
    assert.equal(result.kind, "unproven");
    assert.match(result.kind === "unproven" ? result.reason : "", /timed out/);
  }
});

darwinTest("normal stop adapter preserves one absolute deadline across ownership, bootout, and barrier", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-normal-stop-deadline-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidateEntrypoint = join(
    root,
    "node_modules",
    "@waishnav",
    "devspace",
    "dist",
    "cli.js",
  );
  await mkdir(dirname(candidateEntrypoint), { recursive: true });
  await writeFile(candidateEntrypoint, "export {};\n");
  const nodeExecutable = process.execPath;
  const nodeRealpath = await realpath(nodeExecutable);
  const expected = processIdentity({
    pid: 777,
    processStartIdentity: "1:Mon Sep 21 07:30:00 2026",
    executableRealpath: nodeRealpath,
    normalizedArgv: [
      nodeExecutable,
      candidateEntrypoint,
      "serve",
    ],
    entrypointRealpath: await realpath(candidateEntrypoint),
  });
  let stopped = false;
  let bootoutCompleted = false;
  let postBootoutNowReads = 0;
  let bootoutCalls = 0;
  const now = () => {
    if (!bootoutCompleted) return 0;
    postBootoutNowReads += 1;
    return postBootoutNowReads <= 2 ? 999 : 1_001;
  };
  const runner: CommandRunner = {
    async run(executable, args) {
      if (executable === "/bin/launchctl" && args[0] === "print") {
        if (stopped) return { stdout: "", stderr: "Could not find service", exitCode: 113 };
        return {
          stdout: launchctlFixture({
            pid: expected.pid,
            runs: 1,
            entrypoint: candidateEntrypoint,
            nodeExecutable,
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (executable === "/bin/ps" && args.includes("lstart=")) {
        return { stdout: "Mon Sep 21 07:30:00 2026\n", stderr: "", exitCode: stopped ? 1 : 0 };
      }
      if (executable === "/bin/ps" && args.includes("comm=")) {
        return { stdout: `${nodeExecutable}\n`, stderr: "", exitCode: 0 };
      }
      if (executable === "/usr/sbin/lsof" && args.includes("-d")) {
        return {
          stdout: `p777\nftxt\nn${nodeRealpath}\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      if (executable === "/usr/sbin/lsof") {
        return { stdout: stopped ? "" : "p777\n", stderr: "", exitCode: stopped ? 1 : 0 };
      }
      if (executable === "/bin/launchctl" && args[0] === "bootout") {
        bootoutCalls += 1;
        stopped = true;
        bootoutCompleted = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected command ${executable} ${args.join(" ")}`);
    },
  };
  const adapters = createDarwinRolloutAdapters({
    uid: 501,
    commandRunner: runner,
    stopTimeoutMs: 1_000,
    stopPollIntervalMs: 1,
    now,
    sleep: async () => undefined,
  });
  const observedBeforeStop = await adapters.observeProcess(expected.pid);
  assert.deepEqual(observedBeforeStop, { kind: "known", value: expected });
  const result = await adapters.stopExpected(expected);
  assert.equal(result.kind, "unproven");
  assert.match(result.kind === "unproven" ? result.reason : "", /deadline expired|timed out/);
  assert.equal(bootoutCalls, 1);
  assert.ok(postBootoutNowReads >= 3, "test must cross the original absolute deadline after bootout");
});

darwinTest("normal stop treats ps observation failure as unproven rather than process absence", async () => {
  let bootoutCalls = 0;
  const runner: CommandRunner = {
    async run(executable, args) {
      if (executable === "/bin/launchctl" && args[0] === "print") {
        return { stdout: "", stderr: "Could not find service", exitCode: 113 };
      }
      if (executable === "/bin/ps" && args.includes("lstart=")) {
        return { stdout: "", stderr: "ps observation failed", exitCode: 2 };
      }
      if (executable === "/bin/launchctl" && args[0] === "bootout") {
        bootoutCalls += 1;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected command ${executable} ${args.join(" ")}`);
    },
  };
  const adapters = createDarwinRolloutAdapters({
    uid: 501,
    commandRunner: runner,
    stopTimeoutMs: 1_000,
  });

  const result = await adapters.stopExpected(processIdentity());
  assert.equal(result.kind, "unproven");
  assert.match(result.kind === "unproven" ? result.reason : "", /ps process-generation probe exited with code 2/);
  assert.equal(bootoutCalls, 0);
});

darwinTest("normal stop treats malformed ps start identity as unproven rather than PID reuse", async () => {
  let bootoutCalls = 0;
  const runner: CommandRunner = {
    async run(executable, args) {
      if (executable === "/bin/launchctl" && args[0] === "print") {
        return { stdout: "", stderr: "Could not find service", exitCode: 113 };
      }
      if (executable === "/bin/ps" && args.includes("lstart=")) {
        return { stdout: "truncated-or-invalid-row\n", stderr: "", exitCode: 0 };
      }
      if (executable === "/bin/launchctl" && args[0] === "bootout") {
        bootoutCalls += 1;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected command ${executable} ${args.join(" ")}`);
    },
  };
  const adapters = createDarwinRolloutAdapters({
    uid: 501,
    commandRunner: runner,
    stopTimeoutMs: 1_000,
  });

  const result = await adapters.stopExpected(processIdentity());
  assert.equal(result.kind, "unproven");
  assert.match(result.kind === "unproven" ? result.reason : "", /process start identity is malformed/);
  assert.equal(bootoutCalls, 0);
});

test("stability gate cancels a hanging probe and a hanging sleep at its deadline", async () => {
  for (const hang of ["probe", "sleep"] as const) {
    let receivedSignal: AbortSignal | undefined;
    const result = await waitForStableState(processIdentity(), {
      observeProcess: async (_pid, signal) => {
        receivedSignal = signal;
        return hang === "probe" ? new Promise(() => {}) : { kind: "known", value: processIdentity() };
      },
      observeListener: async () => ({ kind: "known", value: { state: "owned", ownerPid: 123 } }),
      checkHealth: async () => ({ kind: "known", value: "healthy" }),
    }, {
      observationMs: 0,
      timeoutMs: 15,
      sleep: hang === "sleep" ? async () => new Promise(() => {}) : async () => undefined,
    });
    assert.equal(result.kind, "unproven", hang);
    if (hang === "probe") assert.equal(receivedSignal?.aborted, true);
  }
});

test("default command runner terminates an unresponsive subprocess within its budget", async () => {
  const started = Date.now();
  await assert.rejects(createExecFileRunner(50).run(process.execPath, [
    "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
  ]));
  assert.ok(Date.now() - started < 2_000);
});

darwinTest("process-generation matrix never treats malformed observations as disappearance or reuse", async () => {
  const cases = [
    [0, "Thu Sep 17 10:00:00 2026", "alive"],
    [0, "Thu Sep 17 10:00:01 2026", "reused"],
    [1, "", "gone"],
    [2, "", "unproven"],
    [0, "", "unproven"],
    [0, "garbled", "unproven"],
    [0, "Bad Sep 17 10:00:00 2026", "unproven"],
    [0, "Thu Bad 17 10:00:00 2026", "unproven"],
    [0, "Thu Sep 00 10:00:00 2026", "unproven"],
    [0, "Thu Sep 17 25:00:00 2026", "unproven"],
    [0, "Thu Feb 30 10:00:00 2026", "unproven"],
    [0, "Fri Sep 17 10:00:00 2026", "unproven"],
    [1, "Thu Sep 17 10:00:00 2026", "unproven"],
  ] as const;
  for (const [exitCode, stdout, expected] of cases) {
    const adapters = createDarwinRolloutAdapters({
      uid: 501,
      commandRunner: { run: async () => ({ exitCode, stdout, stderr: "" }) },
    });
    const observed = await adapters.observeExpectedProcess(processIdentity());
    assert.equal(observed.kind === "known" ? observed.value : observed.kind, expected, stdout);
  }
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

test("runtime readiness gate tolerates delayed listener and health, then times out when readiness never arrives", async () => {
  const expected = processIdentity();
  const known = <T>(value: T) => ({ kind: "known" as const, value });
  let attempt = 0;
  let nowMs = 0;

  const delayed = await waitForRuntimeReadyState(expected.entrypointRealpath, {
    observeLaunchd: async () => known({
      loaded: true,
      pid: expected.pid,
      runCount: 2,
      normalizedArgv: expected.normalizedArgv,
    }),
    observeProcess: async () => known(expected),
    observeListener: async () => attempt === 0
      ? known({ state: "unowned" as const })
      : known({ state: "owned" as const, ownerPid: expected.pid }),
    checkHealth: async () => attempt < 2
      ? known("unhealthy" as const)
      : known("healthy" as const),
  }, {
    timeoutMs: 500,
    pollIntervalMs: 50,
    now: () => nowMs,
    sleep: async (ms) => {
      attempt += 1;
      nowMs += ms;
    },
  });
  assert.deepEqual(delayed, { kind: "known", value: expected });
  assert.equal(attempt, 2, "readiness should retry transient startup observations");

  let timeoutNow = 0;
  const timedOut = await waitForRuntimeReadyState(expected.entrypointRealpath, {
    observeLaunchd: async () => known({
      loaded: true,
      pid: expected.pid,
      runCount: 2,
      normalizedArgv: expected.normalizedArgv,
    }),
    observeProcess: async () => known(expected),
    observeListener: async () => known({ state: "unowned" as const }),
    checkHealth: async () => known("unhealthy" as const),
  }, {
    timeoutMs: 100,
    pollIntervalMs: 50,
    now: () => timeoutNow,
    sleep: async (ms) => { timeoutNow += ms; },
  });
  assert.equal(timedOut.kind, "unproven");
  assert.match(timedOut.kind === "unproven" ? timedOut.reason : "", /readiness.*timed out/i);
  assert.equal(timeoutNow, 100, "readiness timeout must be bounded by the configured deadline");
});

test("runtime readiness rejects a healthy observation that completes after the deadline", async () => {
  const expected = processIdentity();
  const known = <T>(value: T) => ({ kind: "known" as const, value });
  let nowMs = 0;

  const result = await waitForRuntimeReadyState(expected.entrypointRealpath, {
    observeLaunchd: async () => known({
      loaded: true,
      pid: expected.pid,
      runCount: 2,
      normalizedArgv: expected.normalizedArgv,
    }),
    observeProcess: async () => known(expected),
    observeListener: async () => known({ state: "owned" as const, ownerPid: expected.pid }),
    checkHealth: async () => {
      nowMs = 16_000;
      return known("healthy" as const);
    },
  }, {
    timeoutMs: 15_000,
    pollIntervalMs: 100,
    now: () => nowMs,
    sleep: async (ms) => { nowMs += ms; },
  });

  assert.equal(result.kind, "unproven");
  assert.match(result.kind === "unproven" ? result.reason : "", /readiness.*timed out/i);
});

test("runtime readiness aborts a pending probe at the shared deadline", async () => {
  let probeAborted = false;
  const pendingProbe = (signal?: AbortSignal): Promise<ObservedState<LaunchdObservation>> => {
    signal?.addEventListener("abort", () => { probeAborted = true; }, { once: true });
    return new Promise(() => undefined);
  };

  const guarded = await Promise.race([
    waitForRuntimeReadyState("/expected/node_modules/@waishnav/devspace/dist/cli.js", {
      observeLaunchd: pendingProbe,
      observeProcess: async () => { throw new Error("process probe must not run"); },
      observeListener: async () => { throw new Error("listener probe must not run"); },
      checkHealth: async () => { throw new Error("health probe must not run"); },
    }, {
      timeoutMs: 20,
      pollIntervalMs: 5,
    }),
    new Promise<"guard">((resolve) => setTimeout(() => resolve("guard"), 200)),
  ]);

  assert.notEqual(guarded, "guard", "a pending readiness probe must not outlive the shared deadline");
  assert.equal(probeAborted, true, "the readiness deadline must abort the in-flight probe");
  if (guarded !== "guard") {
    assert.equal(guarded.kind, "unproven");
    assert.match(guarded.kind === "unproven" ? guarded.reason : "", /readiness.*timed out/i);
  }
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

darwinTest("health check uses a bounded timeout signal and classifies timeout as unhealthy", async () => {
  const originalFetch = globalThis.fetch;
  let observedSignal: AbortSignal | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    observedSignal = init?.signal ?? undefined;
    assert.ok(observedSignal, "health fetch must receive an AbortSignal");
    return await new Promise<Response>((_resolve, reject) => {
      const guard = setTimeout(() => {
        reject(new Error("health timeout signal did not abort before the guard deadline"));
      }, 250);
      if (observedSignal!.aborted) {
        clearTimeout(guard);
        reject(observedSignal!.reason);
        return;
      }
      observedSignal!.addEventListener("abort", () => {
        clearTimeout(guard);
        reject(observedSignal!.reason);
      }, { once: true });
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
