import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  openSync,
} from "node:fs";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import {
  acquireDarwinRolloutLock,
  type RolloutLockOwnerRecord,
} from "./macos-launchd-rollout-lock.js";
import { resolveCandidateSlotRoot } from "./macos-launchd-rollout-manifest.js";
import type {
  CanonicalPlistSnapshot,
  FileIdentity,
  LaunchdObservation,
  ListenerObservation,
  MacosRolloutAdapters,
  ObservedState,
  PreparedCanonicalTemp,
  ProcessIdentity,
} from "./macos-launchd-rollout.js";

const execFileAsync = promisify(execFile);
const DEVSPACE_ENTRYPOINT_SUFFIX = join(
  "node_modules",
  "@waishnav",
  "devspace",
  "dist",
  "cli.js",
);
const DEFAULT_LABEL = "com.ethan.devspace";
const DEFAULT_PORT = 7676;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_HEALTH_PATH = "/healthz";
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_STOP_POLL_MS = 50;
const DEFAULT_STABILITY_OBSERVATION_MS = 250;

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunner {
  run(executable: string, args: readonly string[]): Promise<CommandResult>;
}

export interface DurabilityPrimitives {
  fsyncFile(fd: number): void;
  fsyncDirectory(fd: number): void;
}

export interface StopBarrierProbe {
  observeExpectedProcess(): Promise<ObservedState<"alive" | "gone" | "reused">>;
  observeLaunchd(): Promise<ObservedState<LaunchdObservation>>;
  observeListener(): Promise<ObservedState<ListenerObservation>>;
}

export interface DarwinRolloutAdapterOptions {
  canonicalPath?: string;
  label?: string;
  uid?: number;
  host?: string;
  port?: number;
  healthPath?: string;
  rolloutRoot?: string;
  commandRunner?: CommandRunner;
  durability?: DurabilityPrimitives;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  stopTimeoutMs?: number;
  stopPollIntervalMs?: number;
  stabilityObservationMs?: number;
}

export function parseLaunchctlPrint(output: string): ObservedState<LaunchdObservation> {
  const lines = output.split(/\r?\n/);
  const argumentsStart = lines.findIndex((line) => line.trim() === "arguments = {");
  if (argumentsStart === -1) {
    return { kind: "unproven", reason: "launchctl print output has no arguments block" };
  }
  const normalizedArgv: string[] = [];
  let argumentsEnd = -1;
  for (let index = argumentsStart + 1; index < lines.length; index += 1) {
    const value = lines[index]!.trim();
    if (value === "}") {
      argumentsEnd = index;
      break;
    }
    if (value) normalizedArgv.push(value);
  }
  if (argumentsEnd === -1 || normalizedArgv.length === 0) {
    return { kind: "unproven", reason: "launchctl arguments block is malformed" };
  }
  const pid = parseUniqueIntegerLine(lines, "pid");
  const runCount = parseUniqueIntegerLine(lines, "runs");
  if (pid.kind === "unproven" || runCount.kind === "unproven") {
    return { kind: "unproven", reason: "launchctl pid/runs output is malformed" };
  }
  return {
    kind: "known",
    value: {
      loaded: true,
      ...(pid.value === undefined ? {} : { pid: pid.value }),
      ...(runCount.value === undefined ? {} : { runCount: runCount.value }),
      normalizedArgv,
    },
  };
}

export function parsePrintDisabled(
  output: string,
  label: string,
): ObservedState<"enabled" | "disabled"> {
  const escaped = escapeRegExp(label);
  const matches = Array.from(output.matchAll(new RegExp(`^[\\t ]*"${escaped}"[\\t ]*=>[\\t ]*(enabled|disabled)[\\t ]*$`, "gm")));
  if (matches.length !== 1) {
    return { kind: "unproven", reason: `disabled override for ${label} is missing or ambiguous` };
  }
  return { kind: "known", value: matches[0]![1] as "enabled" | "disabled" };
}

export function parseTxtLsof(output: string): ObservedState<string> {
  const paths = Array.from(new Set(
    output.split(/\r?\n/)
      .filter((line) => line.startsWith("n") && line.length > 1)
      .map((line) => line.slice(1)),
  ));
  return paths.length === 1
    ? { kind: "known", value: paths[0]! }
    : { kind: "unproven", reason: "executable lsof output is missing or ambiguous" };
}

export function parseListenerLsof(
  output: string,
  exitCode: number,
): ObservedState<ListenerObservation> {
  if (exitCode === 1 && output.trim() === "") {
    return { kind: "known", value: { state: "unowned" } };
  }
  if (exitCode !== 0) {
    return { kind: "unproven", reason: `listener lsof exited with code ${exitCode}` };
  }
  const pids = Array.from(new Set(
    output.split(/\r?\n/)
      .map((line) => /^p(\d+)$/.exec(line.trim())?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number),
  ));
  if (pids.length === 0) return { kind: "known", value: { state: "unowned" } };
  if (pids.length !== 1 || !Number.isSafeInteger(pids[0]) || pids[0]! <= 0) {
    return { kind: "unproven", reason: "listener owner PID output is ambiguous" };
  }
  return { kind: "known", value: { state: "owned", ownerPid: pids[0] } };
}

export function parseParentPid(output: string): ObservedState<number> {
  const value = output.trim();
  if (!/^\d+$/.test(value)) {
    return { kind: "unproven", reason: "parent PID output is malformed" };
  }
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid >= 0
    ? { kind: "known", value: pid }
    : { kind: "unproven", reason: "parent PID is outside the supported range" };
}

export async function buildProcessIdentityFromObservations(input: {
  pid: number;
  launchd: LaunchdObservation;
  psStartOutput: string;
  executablePath: string;
  realpath?: (path: string) => Promise<string>;
}): Promise<ObservedState<ProcessIdentity>> {
  if (
    !input.launchd.loaded
    || input.launchd.pid !== input.pid
    || !Number.isSafeInteger(input.launchd.runCount)
    || !Array.isArray(input.launchd.normalizedArgv)
  ) {
    return { kind: "unproven", reason: "launchd process generation does not match requested PID" };
  }
  const argv = input.launchd.normalizedArgv;
  const entrypointIndexes = argv
    .map((argument, index) => argument.endsWith(`${sep}${DEVSPACE_ENTRYPOINT_SUFFIX}`) ? index : -1)
    .filter((index) => index >= 0);
  if (entrypointIndexes.length !== 1 || entrypointIndexes[0] !== 1 || argv.at(-1) !== "serve") {
    return { kind: "unproven", reason: "launchd arguments do not match the V1 DevSpace topology" };
  }
  const psStart = input.psStartOutput.trim();
  if (!psStart) return { kind: "unproven", reason: "process start identity is missing" };
  const resolveRealpath = input.realpath ?? realpath;
  try {
    const [executableRealpath, entrypointRealpath] = await Promise.all([
      resolveRealpath(input.executablePath),
      resolveRealpath(argv[1]!),
    ]);
    return {
      kind: "known",
      value: {
        pid: input.pid,
        processStartIdentity: `${input.launchd.runCount}:${psStart}`,
        executableRealpath,
        normalizedArgv: [...argv],
        entrypointRealpath,
      },
    };
  } catch (error) {
    return { kind: "unproven", reason: `process realpath failed: ${errorMessage(error)}` };
  }
}

export function validateCanonicalFileIdentity(
  canonical: FileIdentity,
  parent: FileIdentity,
  expected: {
    canonicalPath: string;
    parentPath: string;
    effectiveUid: number;
  },
): void {
  if (
    canonical.path !== expected.canonicalPath
    || parent.path !== expected.parentPath
    || dirname(expected.canonicalPath) !== expected.parentPath
    || canonical.kind !== "file"
    || canonical.symlink
    || canonical.uid !== expected.effectiveUid
    || (canonical.mode & 0o022) !== 0
    || parent.kind !== "directory"
    || parent.symlink
    || parent.uid !== expected.effectiveUid
    || (parent.mode & 0o022) !== 0
  ) {
    throw new Error("canonical plist or LaunchAgents parent identity is unsafe");
  }
}

export async function prepareCanonicalTempFile(input: {
  canonicalPath: string;
  transactionNonce: string;
  bytes: Buffer;
  expectedSha256: string;
  uid: number;
  gid: number;
  mode: number;
  durability?: DurabilityPrimitives;
}): Promise<PreparedCanonicalTemp> {
  if (!/^[A-Za-z0-9._-]+$/.test(input.transactionNonce)) {
    throw new Error("transaction nonce contains unsupported path characters");
  }
  const durability = input.durability ?? defaultDurabilityPrimitives;
  const parent = dirname(input.canonicalPath);
  const base = basename(input.canonicalPath).replace(/\.plist$/i, "");
  const tempPath = join(parent, `.${base}.rollout-${input.transactionNonce}.tmp`);
  if (tempPath.endsWith(".plist")) throw new Error("canonical temp must not use a .plist suffix");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    handle = await open(
      tempPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | noFollow,
      0o600,
    );
    await handle.writeFile(input.bytes);
    await handle.chmod(input.mode);
    if (process.platform !== "win32") await handle.chown(input.uid, input.gid);
    durability.fsyncFile(handle.fd);
    await handle.close();
    handle = undefined;

    const actualBytes = await readFile(tempPath);
    const sha256 = createHash("sha256").update(actualBytes).digest("hex");
    if (sha256 !== input.expectedSha256) {
      throw new Error(`canonical temp SHA-256 mismatch: expected ${input.expectedSha256}, got ${sha256}`);
    }
    const identity = await fileIdentity(tempPath);
    if (
      identity.kind !== "file"
      || identity.symlink
      || identity.uid !== input.uid
      || identity.gid !== input.gid
      || identity.mode !== (input.mode & 0o7777)
    ) {
      throw new Error("canonical temp file identity does not match expected uid/gid/mode");
    }
    return { path: tempPath, sha256, identity };
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function syncDirectoryDurably(
  path: string,
  durability: DurabilityPrimitives = defaultDurabilityPrimitives,
): Promise<void> {
  const fd = openSync(path, fsConstants.O_RDONLY);
  try {
    durability.fsyncDirectory(fd);
  } finally {
    closeSync(fd);
  }
}

export async function readFileSha256(path: string): Promise<ObservedState<string>> {
  try {
    return {
      kind: "known",
      value: createHash("sha256").update(await readFile(path)).digest("hex"),
    };
  } catch (error) {
    return { kind: "unproven", reason: `unable to read file digest: ${errorMessage(error)}` };
  }
}

export async function rewriteCandidatePlistBytes(
  oldBytes: Buffer,
  candidateEntrypoint: string,
): Promise<Buffer> {
  if (process.platform !== "darwin") throw new Error("candidate plist rewrite requires macOS plutil");
  const root = await mkdtemp(join(tmpdir(), "devspace-rollout-plist-rewrite-"));
  const plistPath = join(root, "candidate.plist");
  try {
    await writeFile(plistPath, oldBytes, { mode: 0o600 });
    await execFileAsync("/usr/bin/plutil", [
      "-remove",
      "ProgramArguments.1",
      plistPath,
    ]);
    await execFileAsync("/usr/bin/plutil", [
      "-insert",
      "ProgramArguments.1",
      "-string",
      candidateEntrypoint,
      plistPath,
    ]);
    await execFileAsync("/usr/bin/plutil", ["-lint", plistPath]);
    return await readFile(plistPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function waitForStoppedState(
  expected: ProcessIdentity,
  probe: StopBarrierProbe,
  options: {
    timeoutMs: number;
    pollIntervalMs: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<ObservedState<"stopped">> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const deadline = now() + options.timeoutMs;
  while (true) {
    const [processState, launchd, listener] = await Promise.all([
      probe.observeExpectedProcess(),
      probe.observeLaunchd(),
      probe.observeListener(),
    ]);
    if (processState.kind === "unproven") return processState;
    if (launchd.kind === "unproven") return launchd;
    if (listener.kind === "unproven") return listener;

    if (launchd.value.loaded) {
      if (launchd.value.pid !== expected.pid) {
        return { kind: "unproven", reason: "incompatible same-label runtime appeared during stop barrier" };
      }
    }
    if (listener.value.state === "owned" && listener.value.ownerPid !== expected.pid) {
      return { kind: "unproven", reason: "unrelated listener owner appeared during stop barrier" };
    }

    const processGone = processState.value !== "alive";
    const serviceGone = !launchd.value.loaded;
    const listenerGone = listener.value.state === "unowned";
    if (processGone && serviceGone && listenerGone) {
      return { kind: "known", value: "stopped" };
    }
    if (now() >= deadline) {
      return { kind: "unproven", reason: "stop barrier timed out before expected runtime fully disappeared" };
    }
    await sleep(options.pollIntervalMs);
  }
}

export async function waitForStableState(
  expected: ProcessIdentity,
  probe: {
    observeProcess(pid: number): Promise<ObservedState<ProcessIdentity>>;
    observeListener(): Promise<ObservedState<ListenerObservation>>;
    checkHealth(): Promise<ObservedState<"healthy" | "unhealthy">>;
  },
  options: {
    observationMs: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<ObservedState<"stable">> {
  const sleep = options.sleep ?? delay;
  await sleep(options.observationMs);
  const [processState, listener, health] = await Promise.all([
    probe.observeProcess(expected.pid),
    probe.observeListener(),
    probe.checkHealth(),
  ]);
  if (processState.kind === "unproven") return processState;
  if (listener.kind === "unproven") return listener;
  if (health.kind === "unproven") return health;
  if (!sameProcessIdentity(processState.value, expected)) {
    return { kind: "unproven", reason: "process generation changed during stability observation" };
  }
  if (listener.value.state !== "owned" || listener.value.ownerPid !== expected.pid) {
    return { kind: "unproven", reason: "listener ownership changed during stability observation" };
  }
  if (health.value !== "healthy") {
    return { kind: "unproven", reason: "health became unhealthy during stability observation" };
  }
  return { kind: "known", value: "stable" };
}

export function createDarwinRolloutAdapters(
  options: DarwinRolloutAdapterOptions = {},
): MacosRolloutAdapters {
  const uid = options.uid ?? requireEffectiveUid();
  const label = options.label ?? DEFAULT_LABEL;
  const canonicalPath = options.canonicalPath
    ?? join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const canonicalParent = dirname(canonicalPath);
  const domain = `gui/${uid}`;
  const serviceTarget = `${domain}/${label}`;
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const healthPath = options.healthPath ?? DEFAULT_HEALTH_PATH;
  const rolloutRoot = options.rolloutRoot ?? join(homedir(), ".devspace", "rollout");
  const runner = options.commandRunner ?? createExecFileRunner();
  const durability = options.durability ?? defaultDurabilityPrimitives;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const stopPollIntervalMs = options.stopPollIntervalMs ?? DEFAULT_STOP_POLL_MS;
  const stabilityObservationMs = options.stabilityObservationMs ?? DEFAULT_STABILITY_OBSERVATION_MS;

  const observeLaunchd = async (): Promise<ObservedState<LaunchdObservation>> => {
    const result = await runner.run("/bin/launchctl", ["print", serviceTarget]);
    if (result.exitCode !== 0) {
      const combined = `${result.stdout}\n${result.stderr}`;
      if (/could not find service|service not found/i.test(combined)) {
        return { kind: "known", value: { loaded: false } };
      }
      return { kind: "unproven", reason: `launchctl print exited with code ${result.exitCode}` };
    }
    return parseLaunchctlPrint(result.stdout);
  };

  const observeListener = async (): Promise<ObservedState<ListenerObservation>> => {
    const result = await runner.run("/usr/sbin/lsof", [
      "-nP",
      "-a",
      `-iTCP@${host}:${port}`,
      "-sTCP:LISTEN",
      "-Fp",
    ]);
    return parseListenerLsof(result.stdout, result.exitCode);
  };

  const observeProcess = async (pid: number): Promise<ObservedState<ProcessIdentity>> => {
    const launchd = await observeLaunchd();
    if (launchd.kind === "unproven") return launchd;
    if (!launchd.value.loaded || launchd.value.pid !== pid) {
      return { kind: "unproven", reason: "launchd does not currently own the requested PID" };
    }
    const [start, executable] = await Promise.all([
      runner.run("/bin/ps", ["-p", String(pid), "-o", "lstart="]),
      runner.run("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"]),
    ]);
    if (start.exitCode !== 0) return { kind: "unproven", reason: `ps exited with code ${start.exitCode}` };
    const executablePath = parseTxtLsof(executable.stdout);
    if (executable.exitCode !== 0 || executablePath.kind === "unproven") {
      return { kind: "unproven", reason: executablePath.kind === "unproven" ? executablePath.reason : `lsof exited with code ${executable.exitCode}` };
    }
    return buildProcessIdentityFromObservations({
      pid,
      launchd: launchd.value,
      psStartOutput: start.stdout,
      executablePath: executablePath.value,
    });
  };

  const adapters: MacosRolloutAdapters = {
    async acquireLock(input) {
      const start = await runner.run("/bin/ps", ["-p", String(process.pid), "-o", "lstart="]);
      if (start.exitCode !== 0 || !start.stdout.trim()) {
        throw new Error("unable to establish rollout helper process-start identity");
      }
      const owner: RolloutLockOwnerRecord = {
        schema_version: 1,
        pid: process.pid,
        process_start_identity: start.stdout.trim(),
        transaction_nonce: input.transactionNonce,
        transaction_id: input.transactionId,
        created_at: new Date(now()).toISOString(),
      };
      return acquireDarwinRolloutLock({
        lockPath: join(rolloutRoot, "rollout.lock"),
        owner,
      });
    },

    async readCanonical() {
      try {
        const [identity, parentIdentity, bytes] = await Promise.all([
          fileIdentity(canonicalPath),
          fileIdentity(canonicalParent),
          readFile(canonicalPath),
        ]);
        validateCanonicalFileIdentity(identity, parentIdentity, {
          canonicalPath,
          parentPath: canonicalParent,
          effectiveUid: uid,
        });
        const fields = await readCanonicalPlistFields(canonicalPath, runner);
        if (
          fields.label !== label
          || fields.runAtLoad !== true
          || fields.keepAlive !== true
          || fields.programArguments.at(-1) !== "serve"
          || !fields.stdoutPath
          || !fields.stderrPath
        ) {
          return { kind: "unproven", reason: "canonical plist semantic contract is invalid" };
        }
        const entrypoints = fields.programArguments.filter((value) => value.endsWith(`${sep}${DEVSPACE_ENTRYPOINT_SUFFIX}`));
        if (entrypoints.length !== 1 || fields.programArguments[1] !== entrypoints[0]) {
          return { kind: "unproven", reason: "canonical plist has an ambiguous DevSpace entrypoint" };
        }
        const entrypointRealpath = await realpath(entrypoints[0]!);
        return {
          kind: "known",
          value: {
            bytes,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            identity,
            parentIdentity,
            entrypointRealpath,
            runAtLoad: true,
            keepAlive: true,
          },
        };
      } catch (error) {
        return { kind: "unproven", reason: errorMessage(error) };
      }
    },

    async validateCandidateEntrypoint(path) {
      const root = resolveCandidateSlotRoot(path);
      const [entryStat, entryRealpath, rootRealpath] = await Promise.all([
        lstat(path),
        realpath(path),
        realpath(root),
      ]);
      if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
        throw new Error("candidate entrypoint must be a non-symlink regular file");
      }
      const relationship = relative(rootRealpath, entryRealpath);
      if (relationship === ".." || relationship.startsWith(`..${sep}`) || isAbsolute(relationship)) {
        throw new Error("candidate entrypoint escapes candidate slot root");
      }
    },

    createCandidatePlist(oldBytes, candidateEntrypoint) {
      return rewriteCandidatePlistBytes(oldBytes, candidateEntrypoint);
    },

    async writeOldBackup(input) {
      await mkdir(input.transactionDir, { recursive: true, mode: 0o700 });
      const plistPath = join(input.transactionDir, "old.plist");
      await writeFile(plistPath, input.bytes, { mode: input.mode });
      await chmod(plistPath, input.mode);
      if (process.platform !== "win32") await chown(plistPath, input.uid, input.gid);
      const actual = createHash("sha256").update(await readFile(plistPath)).digest("hex");
      if (actual !== input.sha256) throw new Error("old plist backup hash mismatch");
      await writeFile(join(input.transactionDir, "old.plist.sha256"), `${input.sha256}\n`, { mode: 0o600 });
    },

    async writeCandidateEvidence(input) {
      await mkdir(input.transactionDir, { recursive: true, mode: 0o700 });
      await Promise.all([
        writeFile(join(input.transactionDir, "candidate.plist"), input.plistBytes, { mode: 0o600 }),
        writeFile(join(input.transactionDir, "candidate.plist.sha256"), `${input.plistSha256}\n`, { mode: 0o600 }),
        writeFile(join(input.transactionDir, "candidate-slot.manifest.sha256"), `${input.manifestSha256}\n`, { mode: 0o600 }),
      ]);
    },

    prepareCanonicalTemp(input) {
      return prepareCanonicalTempFile({
        canonicalPath,
        transactionNonce: input.transactionNonce,
        bytes: input.bytes,
        expectedSha256: input.expectedSha256,
        uid: input.uid,
        gid: input.gid,
        mode: input.mode,
        durability,
      });
    },

    async atomicReplaceCanonical(tempPath) {
      if (dirname(tempPath) !== canonicalParent || !basename(tempPath).startsWith(`.${basename(canonicalPath).replace(/\.plist$/i, "")}.rollout-`)) {
        throw new Error("canonical replacement temp is outside the qualified LaunchAgents parent");
      }
      await rename(tempPath, canonicalPath);
    },

    syncCanonicalParent() {
      return syncDirectoryDurably(canonicalParent, durability);
    },

    observeLaunchd,
    observeProcess,
    observeListener,

    async checkHealth() {
      try {
        const response = await fetch(`http://${host}:${port}${healthPath}`);
        if (!response.ok) return { kind: "known", value: "unhealthy" };
        const body = await response.json() as { ok?: unknown; name?: unknown };
        return body.ok === true && body.name === "devspace"
          ? { kind: "known", value: "healthy" }
          : { kind: "known", value: "unhealthy" };
      } catch {
        return { kind: "known", value: "unhealthy" };
      }
    },

    async bootoutExpected(expected) {
      const observed = await observeProcess(expected.pid);
      if (observed.kind !== "known" || !sameProcessIdentity(observed.value, expected)) {
        throw new Error("refusing bootout because expected process ownership is not proven");
      }
      const result = await runner.run("/bin/launchctl", ["bootout", serviceTarget]);
      if (result.exitCode !== 0) throw new Error(`launchctl bootout failed with code ${result.exitCode}`);
    },

    async bootstrap(plistPath) {
      const result = await runner.run("/bin/launchctl", ["bootstrap", domain, plistPath]);
      if (result.exitCode !== 0) throw new Error(`launchctl bootstrap failed with code ${result.exitCode}`);
    },

    async observeDisabledOverride() {
      const result = await runner.run("/bin/launchctl", ["print-disabled", domain]);
      return result.exitCode === 0
        ? parsePrintDisabled(result.stdout, label)
        : { kind: "unproven", reason: `launchctl print-disabled failed with code ${result.exitCode}` };
    },

    async observeAncestors(pid) {
      const ancestors: number[] = [];
      const seen = new Set<number>([pid]);
      let current = pid;
      for (let depth = 0; depth < 64; depth += 1) {
        const result = await runner.run("/bin/ps", ["-p", String(current), "-o", "ppid="]);
        if (result.exitCode !== 0) return { kind: "unproven", reason: `ps parent lookup failed for PID ${current}` };
        const parent = parseParentPid(result.stdout);
        if (parent.kind === "unproven") return parent;
        if (parent.value <= 1) {
          if (parent.value === 1) ancestors.push(1);
          return { kind: "known", value: ancestors };
        }
        if (seen.has(parent.value)) return { kind: "unproven", reason: "ancestor process chain contains a cycle" };
        seen.add(parent.value);
        ancestors.push(parent.value);
        current = parent.value;
      }
      return { kind: "unproven", reason: "ancestor process chain exceeded depth limit" };
    },

    waitStopped(expected) {
      const expectedPsStart = startIdentityTimestamp(expected.processStartIdentity);
      return waitForStoppedState(expected, {
        async observeExpectedProcess() {
          const result = await runner.run("/bin/ps", ["-p", String(expected.pid), "-o", "lstart="]);
          if (result.exitCode !== 0 || !result.stdout.trim()) return { kind: "known", value: "gone" };
          return result.stdout.trim() === expectedPsStart
            ? { kind: "known", value: "alive" }
            : { kind: "known", value: "reused" };
        },
        observeLaunchd,
        observeListener,
      }, {
        timeoutMs: stopTimeoutMs,
        pollIntervalMs: stopPollIntervalMs,
        now,
        sleep,
      });
    },

    waitStable(expected) {
      return waitForStableState(expected, {
        observeProcess,
        observeListener,
        checkHealth: adapters.checkHealth,
      }, {
        observationMs: stabilityObservationMs,
        sleep,
      });
    },

    readFileSha256,

    async preflightDurability() {
      const nonce = randomBytes(8).toString("hex");
      const first = join(canonicalParent, `.${label}.rollout-preflight-${nonce}.tmp`);
      const second = `${first}.renamed`;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        const noFollow = fsConstants.O_NOFOLLOW ?? 0;
        handle = await open(first, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | noFollow, 0o600);
        await handle.writeFile(Buffer.from("devspace-rollout-preflight\n"));
        durability.fsyncFile(handle.fd);
        await handle.close();
        handle = undefined;
        await rename(first, second);
        await syncDirectoryDurably(canonicalParent, durability);
      } finally {
        if (handle) await handle.close().catch(() => undefined);
        await Promise.all([
          rm(first, { force: true }).catch(() => undefined),
          rm(second, { force: true }).catch(() => undefined),
        ]);
      }
    },
  };

  return adapters;
}

const defaultDurabilityPrimitives: DurabilityPrimitives = {
  fsyncFile: fsyncSync,
  fsyncDirectory: fsyncSync,
};

function createExecFileRunner(): CommandRunner {
  return {
    async run(executable, args) {
      try {
        const result = await execFileAsync(executable, [...args], {
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
        });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
      } catch (error) {
        const record = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
        if (typeof record.code !== "number") throw error;
        return {
          stdout: typeof record.stdout === "string" ? record.stdout : Buffer.isBuffer(record.stdout) ? record.stdout.toString("utf8") : "",
          stderr: typeof record.stderr === "string" ? record.stderr : Buffer.isBuffer(record.stderr) ? record.stderr.toString("utf8") : "",
          exitCode: record.code,
        };
      }
    },
  };
}

async function readCanonicalPlistFields(path: string, runner: CommandRunner): Promise<{
  label: string;
  runAtLoad: boolean;
  keepAlive: boolean;
  programArguments: string[];
  stdoutPath: string;
  stderrPath: string;
}> {
  const extract = async (key: string, format: "raw" | "json"): Promise<string> => {
    const result = await runner.run("/usr/bin/plutil", ["-extract", key, format, "-o", "-", path]);
    if (result.exitCode !== 0) throw new Error(`plutil failed to extract ${key}`);
    return result.stdout.trim();
  };
  const [label, runAtLoad, keepAlive, argsJson, stdoutPath, stderrPath] = await Promise.all([
    extract("Label", "raw"),
    extract("RunAtLoad", "raw"),
    extract("KeepAlive", "raw"),
    extract("ProgramArguments", "json"),
    extract("StandardOutPath", "raw"),
    extract("StandardErrorPath", "raw"),
  ]);
  const programArguments = JSON.parse(argsJson) as unknown;
  if (!Array.isArray(programArguments) || programArguments.some((value) => typeof value !== "string")) {
    throw new Error("ProgramArguments is not a string array");
  }
  return {
    label,
    runAtLoad: parsePlutilBoolean(runAtLoad, "RunAtLoad"),
    keepAlive: parsePlutilBoolean(keepAlive, "KeepAlive"),
    programArguments: programArguments as string[],
    stdoutPath,
    stderrPath,
  };
}

async function fileIdentity(path: string): Promise<FileIdentity> {
  const stats = await lstat(path);
  return {
    path,
    uid: stats.uid,
    gid: stats.gid,
    mode: stats.mode & 0o7777,
    device: stats.dev,
    inode: stats.ino,
    kind: stats.isDirectory() ? "directory" : "file",
    symlink: stats.isSymbolicLink(),
  };
}

function parseUniqueIntegerLine(
  lines: readonly string[],
  key: string,
): ObservedState<number | undefined> {
  const values = lines
    .map((line) => new RegExp(`^${escapeRegExp(key)}\\s*=\\s*(\\d+)\\s*$`).exec(line.trim())?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  if (values.length === 0) return { kind: "known", value: undefined };
  if (values.length !== 1 || !Number.isSafeInteger(values[0]) || values[0]! < 0) {
    return { kind: "unproven", reason: `${key} output is ambiguous` };
  }
  return { kind: "known", value: values[0] };
}

function parsePlutilBoolean(value: string, key: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${key} is not a boolean`);
}

function sameProcessIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid
    && left.processStartIdentity === right.processStartIdentity
    && left.executableRealpath === right.executableRealpath
    && left.entrypointRealpath === right.entrypointRealpath
    && left.normalizedArgv.length === right.normalizedArgv.length
    && left.normalizedArgv.every((value, index) => value === right.normalizedArgv[index]);
}

function startIdentityTimestamp(identity: string): string {
  const separator = identity.indexOf(":");
  return separator === -1 ? identity : identity.slice(separator + 1);
}

function requireEffectiveUid(): number {
  const uid = process.geteuid?.() ?? process.getuid?.();
  if (uid === undefined) throw new Error("macOS rollout requires a POSIX effective uid");
  return uid;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
