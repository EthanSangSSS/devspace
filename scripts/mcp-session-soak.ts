import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

export const MEMORY_IDLE_SAMPLE_COUNT = 60;
export const MEMORY_RUNTIME_SNAPSHOT_INTERVAL_MS = 1_000;
export const MEMORY_SAMPLE_INTERVAL_TOLERANCE_MS = 250;
export const MEMORY_SAMPLE_COLLECTION_DEADLINE_MS = 76_000;
export const SOAK_PHASE_A_INITIALIZES = 5_000;
export const SOAK_PHASE_B_INITIALIZES = 5_000;
export const SOAK_TOTAL_INITIALIZES =
  SOAK_PHASE_A_INITIALIZES + SOAK_PHASE_B_INITIALIZES;

const execFileAsync = promisify(execFile);
const SOURCE_ROOT = resolve(".");
const V1_0_8_BASE_SHA = "69a00ee4b90fb6966100b0247d39569f4d4ca08d";
const SOURCE_LOCK_MCP_SDK_VERSION = "1.29.0";
const EXPECTED_PACKAGE_VERSION = "1.0.8";
const DEPLOYED_RUNTIME_ROOT = "/Users/ethan/.local/opt/devspace-1.0.7";
const DEPLOYED_PACKAGE_RELATIVE = join("node_modules", "@waishnav", "devspace");
const EXPECTED_DEPLOYED_WRAPPER_LOCK_SHA256 =
  "3422a3141d78f628d0309ddb42f71ec784d0928792cd9d44c3029374dd033428";
const EXPECTED_DEPLOYED_PACKAGE_VERSION = "1.0.7";
const EXPECTED_DEPLOYED_MCP_SDK_VERSION = "1.30.0";
const EXPECTED_DEPLOYED_DIRECT_DEPENDENCY_COUNT = 19;
type CandidateProcess = ChildProcessByStdio<null, Readable, Readable>;

export class InconclusiveMeasurementError extends Error {}

export interface TimedHeapSample {
  timestampMs: number;
  heapUsedBytes: number;
}

export interface PackagedRuntime {
  root: string;
  packageVersion: string;
  wrapperLockSha256: string;
  dependencyGraphSha256: string;
  mcpSdkVersion: string;
  directRuntimeDependencies: number;
  runnerPath: string;
}

export interface RuntimeSnapshotLog {
  ts: string;
  event: "mcp_runtime_snapshot";
  sessions: {
    current: number;
    active: number;
    pendingReservations: number;
    max: number;
  };
  memory: {
    heapUsedBytes: number;
    heapTotalBytes: number;
    rssBytes: number;
  };
  uptimeSeconds: number;
}

export interface RuntimeObservers {
  snapshots: RuntimeSnapshotLog[];
  readonly createdEvents: number;
  readonly closedEvents: number;
  readonly oomEvidence: number;
  readonly unhandledRejectionEvidence: number;
  readonly telemetryErrors: number;
}

export interface StockControlEvidence {
  status: "PASS" | "FAIL_DIAGNOSTIC" | "INCONCLUSIVE";
  created?: number;
  closed?: number;
  packageVersion?: string;
  wrapperLockSha256?: string;
  dependencyGraphSha256?: string;
  mcpSdkVersion?: string;
}

export interface ActiveCanaryEvidence {
  pass: boolean;
  idleSessionEvicted: boolean;
  activeSessionWronglyEvicted: boolean;
  allActiveStatus: number;
  allActiveJsonRpcCode: number;
  childProxyInvariant: boolean;
  packageVersion: string;
  wrapperLockSha256: string;
  dependencyGraphSha256: string;
  mcpSdkVersion: string;
}

export interface CandidateSoakEvidence {
  verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  candidateRoot: string;
  packageVersion: string;
  wrapperLockSha256: string;
  dependencyGraphSha256: string;
  mcpSdkVersion: string;
  hA: number;
  hB: number;
  deltaBA: number;
  memoryLimit: number;
  maxObservedCurrent: number;
  maxObservedOccupiedCapacity: number;
  createdEvents: number;
  telemetryErrors: number;
}

export interface StockControlDependencies {
  createControlRoot(): Promise<string>;
  createOwnerToken(): string;
  assertProductionBaselineIdentity(): Promise<void>;
  prepareStockPackagedRuntime(root: string): Promise<PackagedRuntime>;
  assertCandidateStateIsolation(root: string): void;
  startCandidateProcess(
    root: string,
    runtime: PackagedRuntime,
    ownerToken: string,
    maxSessions: number,
  ): Promise<unknown>;
  attachRuntimeObservers(processHandle: unknown): RuntimeObservers;
  waitForCandidateHealth(baseUrl: string): Promise<void>;
  bootstrapOAuth(baseUrl: string, ownerToken: string): Promise<string>;
  initializeAndAbandon(
    baseUrl: string,
    accessToken: string,
    id: number,
  ): Promise<string>;
  stopCandidateProcess(processHandle: unknown): Promise<void>;
}

export interface GateOrchestrationDependencies {
  runStockControl(): Promise<StockControlEvidence>;
  runActiveProtectionCanary(): Promise<ActiveCanaryEvidence>;
  runCandidateSoak(): Promise<CandidateSoakEvidence>;
}

export interface GateOrchestrationEvidence {
  verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  control: StockControlEvidence;
  canary: ActiveCanaryEvidence;
  soak: CandidateSoakEvidence;
}

export function median(values: number[]): number {
  if (values.length === 0) throw new Error("Median requires at least one value");
  if (!values.every(Number.isFinite)) throw new Error("Median values must be finite");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function rollingMedian(values: number[], windowSize: number): number[] {
  if (!Number.isInteger(windowSize) || windowSize < 1) {
    throw new Error("Rolling median window size must be a positive integer");
  }
  if (values.length < windowSize) return [];
  const result: number[] = [];
  for (let index = 0; index <= values.length - windowSize; index += 1) {
    result.push(median(values.slice(index, index + windowSize)));
  }
  return result;
}

export function retainedHeapFloor(samples: number[]): number {
  if (samples.length !== MEMORY_IDLE_SAMPLE_COUNT) {
    throw new Error("Retained heap floor requires exactly 60 samples");
  }
  if (!samples.every(Number.isFinite)) {
    throw new Error("Retained heap samples must be finite");
  }
  return Math.min(...rollingMedian(samples, 5));
}

export function memoryPlateauLimit(hA: number): number {
  if (!Number.isFinite(hA) || hA < 0) {
    throw new Error("H_A must be a finite non-negative number");
  }
  return Math.max(64 * 1024 * 1024, 0.15 * hA);
}

export function validateIdleHeapWindow(
  anchor: TimedHeapSample | undefined,
  samples: TimedHeapSample[],
  trafficStopTimestampMs: number,
): number[] {
  if (!anchor) throw new Error("Idle heap cadence anchor is required");
  if (!Number.isFinite(anchor.timestampMs) || !Number.isFinite(anchor.heapUsedBytes)) {
    throw new Error("Idle heap cadence anchor fields must be finite");
  }
  if (anchor.timestampMs > trafficStopTimestampMs) {
    throw new Error("Idle heap cadence anchor is after traffic stop");
  }
  if (samples.length !== MEMORY_IDLE_SAMPLE_COUNT) {
    throw new Error("Idle heap window must contain exactly 60 samples");
  }
  for (const sample of samples) {
    if (!Number.isFinite(sample.timestampMs) || !Number.isFinite(sample.heapUsedBytes)) {
      throw new Error("Idle heap sample fields must be finite");
    }
    if (sample.timestampMs <= trafficStopTimestampMs) {
      throw new Error("Idle heap sample is not after traffic stop");
    }
  }

  const minDelta =
    MEMORY_RUNTIME_SNAPSHOT_INTERVAL_MS - MEMORY_SAMPLE_INTERVAL_TOLERANCE_MS;
  const maxDelta =
    MEMORY_RUNTIME_SNAPSHOT_INTERVAL_MS + MEMORY_SAMPLE_INTERVAL_TOLERANCE_MS;
  let previous = anchor;
  for (const sample of samples) {
    const delta = sample.timestampMs - previous.timestampMs;
    if (delta < minDelta || delta > maxDelta) {
      throw new Error(`Idle heap snapshot interval out of range: ${delta}ms`);
    }
    previous = sample;
  }
  return samples.map((sample) => sample.heapUsedBytes);
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function command(
  file: string,
  args: string[],
  cwd: string,
): Promise<string> {
  const result = await execFileAsync(file, args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout;
}

export async function assertProductionBaselineIdentity(): Promise<void> {
  const liveRoot = await realpath(DEPLOYED_RUNTIME_ROOT);
  const lockSha = await sha256File(join(liveRoot, "package-lock.json"));
  if (lockSha !== EXPECTED_DEPLOYED_WRAPPER_LOCK_SHA256) {
    throw new InconclusiveMeasurementError("Production DevSpace wrapper lock drifted");
  }

  const packageJson = await readJson(
    join(liveRoot, DEPLOYED_PACKAGE_RELATIVE, "package.json"),
  );
  if (packageJson.version !== EXPECTED_DEPLOYED_PACKAGE_VERSION) {
    throw new InconclusiveMeasurementError("Production DevSpace package version drifted");
  }
  const dependencies = packageJson.dependencies as Record<string, string> | undefined;
  if (!dependencies || Object.keys(dependencies).length !== EXPECTED_DEPLOYED_DIRECT_DEPENDENCY_COUNT) {
    throw new InconclusiveMeasurementError("Production direct dependency set drifted");
  }
  const sdkJson = await readJson(
    join(liveRoot, "node_modules", "@modelcontextprotocol", "sdk", "package.json"),
  );
  if (sdkJson.version !== EXPECTED_DEPLOYED_MCP_SDK_VERSION) {
    throw new InconclusiveMeasurementError("Production MCP SDK version drifted");
  }
}

async function stockSourceRoot(root: string): Promise<string> {
  const sourceRoot = join(root, "source-main");
  const archivePath = join(root, "source-main.tar");
  await mkdir(sourceRoot, { recursive: true });
  await command(
    "git",
    ["archive", "--format=tar", `--output=${archivePath}`, V1_0_8_BASE_SHA],
    SOURCE_ROOT,
  );
  await command("tar", ["-xf", archivePath, "-C", sourceRoot], SOURCE_ROOT);
  await symlink(join(SOURCE_ROOT, "node_modules"), join(sourceRoot, "node_modules"), "dir");
  return sourceRoot;
}

async function copyPublishedInputs(sourceRoot: string, packageRoot: string): Promise<void> {
  await mkdir(packageRoot, { recursive: true });
  for (const relative of [
    "bin",
    "docs",
    "examples",
    "schema",
    "scripts",
    "skills",
    "README.md",
    "package.json",
  ]) {
    const source = join(sourceRoot, relative);
    if (!existsSync(source)) continue;
    await cp(source, join(packageRoot, relative), {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
  }
}

async function safeBuildIntoPackage(sourceRoot: string, packageRoot: string): Promise<void> {
  await copyPublishedInputs(sourceRoot, packageRoot);
  const binRoot = join(SOURCE_ROOT, "node_modules", ".bin");
  await command(
    join(binRoot, "vite"),
    ["build", "--outDir", join(packageRoot, "dist", "ui"), "--emptyOutDir", "false"],
    sourceRoot,
  );
  await command(
    join(binRoot, "tsc"),
    ["-p", join(sourceRoot, "tsconfig.build.json"), "--outDir", join(packageRoot, "dist")],
    sourceRoot,
  );
}

function collectDependencyVersions(
  node: Record<string, unknown>,
  versions: Set<string>,
): void {
  const dependencies = node.dependencies;
  if (!dependencies || typeof dependencies !== "object") return;
  for (const [name, raw] of Object.entries(dependencies as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const dependency = raw as Record<string, unknown>;
    if (typeof dependency.version === "string") {
      versions.add(`${name}@${dependency.version}`);
    }
    collectDependencyVersions(dependency, versions);
  }
}

async function dependencyGraphSha256(wrapperRoot: string): Promise<string> {
  const output = await command(
    "pnpm",
    ["list", "--prod", "--json", "--depth", "Infinity"],
    wrapperRoot,
  );
  const parsed = JSON.parse(output) as Array<Record<string, unknown>>;
  const versions = new Set<string>();
  for (const root of parsed) collectDependencyVersions(root, versions);
  return createHash("sha256")
    .update(JSON.stringify([...versions].sort()))
    .digest("hex");
}

async function resolvedPackageVersion(
  wrapperRoot: string,
  packageName: string,
): Promise<string> {
  const output = await command(
    "pnpm",
    ["why", packageName, "--json"],
    wrapperRoot,
  );
  const parsed = JSON.parse(output) as Array<Record<string, unknown>>;
  const match = parsed.find(
    (entry) => entry.name === packageName && typeof entry.version === "string",
  );
  if (!match || typeof match.version !== "string") {
    throw new InconclusiveMeasurementError(`Unable to resolve packaged ${packageName} version`);
  }
  return match.version;
}

async function writeRunner(wrapperRoot: string, packageRoot: string): Promise<string> {
  const runnerPath = join(wrapperRoot, "runner.mjs");
  const serverUrl = pathToFileURL(join(packageRoot, "dist", "server.js")).href;
  await writeFile(
    runnerPath,
    [
      `const { createServer } = await import(${JSON.stringify(serverUrl)});`,
      "const maxSessions = Number(process.argv[2]);",
      "const snapshotIntervalMs = Number(process.argv[3]);",
      "if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new Error('invalid maxSessions');",
      "if (!Number.isInteger(snapshotIntervalMs) || snapshotIntervalMs < 1) throw new Error('invalid snapshot interval');",
      "const running = createServer(undefined, { mcpMaxSessions: maxSessions, runtimeSnapshotIntervalMs: snapshotIntervalMs });",
      "const httpServer = running.app.listen(running.config.port, running.config.host);",
      "await new Promise((resolve, reject) => { httpServer.once('listening', resolve); httpServer.once('error', reject); });",
      "let closing = false;",
      "const shutdown = async () => {",
      "  if (closing) return;",
      "  closing = true;",
      "  await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));",
      "  await running.close();",
      "};",
      "for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { void shutdown().then(() => process.exit(0), () => process.exit(1)); });",
    ].join("\n"),
    "utf8",
  );
  return runnerPath;
}

async function preparePackagedRuntime(
  root: string,
  sourceRoot: string,
): Promise<PackagedRuntime> {
  const packParent = join(root, "pack");
  const packageRoot = join(packParent, "package");
  await mkdir(packParent, { recursive: true });
  await safeBuildIntoPackage(sourceRoot, packageRoot);
  const packageJson = await readJson(join(packageRoot, "package.json"));
  if (packageJson.version !== EXPECTED_PACKAGE_VERSION) {
    throw new InconclusiveMeasurementError("Packaged source version is not v1.0.8");
  }
  const dependencies = packageJson.dependencies as Record<string, string> | undefined;
  if (!dependencies) throw new InconclusiveMeasurementError("Packaged dependencies missing");

  const tarballPath = join(root, "devspace-1.0.8.tgz");
  await command("tar", ["-czf", tarballPath, "-C", packParent, "package"], SOURCE_ROOT);

  const wrapperRoot = join(root, "runtime");
  await mkdir(wrapperRoot, { recursive: true });
  await writeFile(
    join(wrapperRoot, "package.json"),
    `${JSON.stringify({
      private: true,
      packageManager: "pnpm@11.25.0",
      dependencies: { "@waishnav/devspace": "file:../devspace-1.0.8.tgz" },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(wrapperRoot, "pnpm-workspace.yaml"),
    [
      "allowBuilds:",
      "  '@google/genai': false",
      "  '@waishnav/devspace@file:../devspace-1.0.8.tgz': true",
      "  better-sqlite3: true",
      "  esbuild: true",
      "  node-pty: true",
      "  protobufjs: false",
      "",
    ].join("\n"),
    "utf8",
  );
  await command("pnpm", ["install"], wrapperRoot);
  const wrapperLockSha256 = await sha256File(join(wrapperRoot, "pnpm-lock.yaml"));
  const installedPackageRoot = await realpath(
    join(wrapperRoot, "node_modules", "@waishnav", "devspace"),
  );
  const installedPackage = await readJson(join(installedPackageRoot, "package.json"));
  const runnerPath = await writeRunner(wrapperRoot, installedPackageRoot);
  return {
    root: wrapperRoot,
    packageVersion: String(installedPackage.version),
    wrapperLockSha256,
    dependencyGraphSha256: await dependencyGraphSha256(wrapperRoot),
    mcpSdkVersion: await resolvedPackageVersion(wrapperRoot, "@modelcontextprotocol/sdk"),
    directRuntimeDependencies: Object.keys(dependencies).length,
    runnerPath,
  };
}

export async function prepareStockPackagedRuntime(root: string): Promise<PackagedRuntime> {
  return preparePackagedRuntime(root, await stockSourceRoot(root));
}

export async function prepareCandidatePackagedRuntime(root: string): Promise<PackagedRuntime> {
  return preparePackagedRuntime(root, SOURCE_ROOT);
}

export function assertCandidateStateIsolation(candidateRoot: string): void {
  const candidate = resolve(candidateRoot);
  const productionRoots = [
    resolve(homedir(), ".devspace"),
    resolve(homedir(), ".local", "share", "devspace"),
    resolve(DEPLOYED_RUNTIME_ROOT),
  ];
  for (const productionRoot of productionRoots) {
    if (
      candidate === productionRoot ||
      candidate.startsWith(`${productionRoot}/`) ||
      productionRoot.startsWith(`${candidate}/`)
    ) {
      throw new Error("Candidate root overlaps production DevSpace state/runtime");
    }
  }
}

function pickDefinedEnv(
  source: NodeJS.ProcessEnv,
  keys: string[],
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function selectedProxy(source: NodeJS.ProcessEnv, upper: string, lower: string): string | undefined {
  return source[upper] ?? source[lower];
}

function assertApprovedProxy(value: string | undefined, name: string): void {
  if (!value) return;
  const parsed = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new InconclusiveMeasurementError(`${name} is not an approved loopback proxy`);
  }
}

function candidateEnv(candidateRoot: string, ownerToken: string): NodeJS.ProcessEnv {
  const httpProxy = selectedProxy(process.env, "HTTP_PROXY", "http_proxy");
  const httpsProxy = selectedProxy(process.env, "HTTPS_PROXY", "https_proxy");
  assertApprovedProxy(httpProxy, "HTTP proxy");
  assertApprovedProxy(httpsProxy, "HTTPS proxy");
  const inherited = pickDefinedEnv(process.env, [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ]);
  const noProxy = new Set(
    (process.env.NO_PROXY ?? process.env.no_proxy ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  noProxy.add("localhost");
  noProxy.add("127.0.0.1");
  noProxy.add("::1");
  return {
    ...inherited,
    ...(httpProxy ? { HTTP_PROXY: httpProxy } : {}),
    ...(httpsProxy ? { HTTPS_PROXY: httpsProxy } : {}),
    NO_PROXY: [...noProxy].join(","),
    DEVSPACE_CONFIG_DIR: join(candidateRoot, "config"),
    DEVSPACE_OAUTH_OWNER_TOKEN: ownerToken,
  };
}

async function prepareCandidateDirectories(candidateRoot: string): Promise<void> {
  await Promise.all([
    mkdir(join(candidateRoot, "projects", "fixture"), { recursive: true }),
    mkdir(join(candidateRoot, "agent"), { recursive: true }),
    mkdir(join(candidateRoot, "config"), { recursive: true }),
    mkdir(join(candidateRoot, "state"), { recursive: true }),
    mkdir(join(candidateRoot, "worktrees"), { recursive: true }),
  ]);
  const config = {
    configVersion: 1,
    server: {
      host: "127.0.0.1",
      port: 7677,
      publicBaseUrl: CANDIDATE_BASE_URL,
      allowedHosts: ["localhost", "127.0.0.1"],
      trustProxy: false,
    },
    workspaces: {
      allowedRoots: [join(candidateRoot, "projects")],
      worktreeRoot: join(candidateRoot, "worktrees"),
    },
    storage: { stateDir: join(candidateRoot, "state") },
    tools: { mode: "codex" },
    ui: { enabled: false },
    artifacts: { enabled: false, maxFileBytes: 100 * 1024 * 1024 },
    skills: { enabled: false, paths: [], agentDir: join(candidateRoot, "agent") },
    subagents: { enabled: false, providers: [] },
    logging: {
      level: "info",
      format: "json",
      requests: false,
      assets: false,
      toolCalls: false,
      shellCommands: false,
    },
    oauth: {
      accessTokenTtlSeconds: 3_600,
      refreshTokenTtlSeconds: 2_592_000,
      scopes: ["devspace"],
      allowedRedirectHosts: ["chatgpt.com", "localhost", "127.0.0.1"],
    },
  };
  await writeFile(
    join(candidateRoot, "config", "config.jsonc"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

export async function startCandidateProcess(
  candidateRoot: string,
  runtime: PackagedRuntime,
  ownerToken: string,
  maxSessions: number,
): Promise<CandidateProcess> {
  assertCandidateStateIsolation(candidateRoot);
  await prepareCandidateDirectories(candidateRoot);
  return spawn(
    process.execPath,
    [
      runtime.runnerPath,
      String(maxSessions),
      String(MEMORY_RUNTIME_SNAPSHOT_INTERVAL_MS),
    ],
    {
      cwd: candidateRoot,
      env: candidateEnv(candidateRoot, ownerToken),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

export async function stopCandidateProcess(
  processHandle: CandidateProcess,
): Promise<void> {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit, rejectExit) => {
    const timer = setTimeout(
      () => rejectExit(new Error("Candidate did not exit within 40 seconds")),
      40_000,
    );
    processHandle.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
  processHandle.kill("SIGTERM");
  await exited;
}

export async function waitForCandidateHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() <= deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.status !== 200) throw new Error(`Candidate health status ${response.status}`);
      const body = (await response.json()) as Record<string, unknown>;
      if (
        body.ok !== true ||
        body.name !== "devspace" ||
        Object.keys(body).sort().join(",") !== "name,ok"
      ) {
        throw new Error("Candidate health payload expanded or changed");
      }
      return;
    } catch (error) {
      if (error instanceof TypeError) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        continue;
      }
      throw error;
    }
  }
  throw new Error("Candidate health deadline exceeded");
}

export async function bootstrapOAuth(
  baseUrl: string,
  ownerToken: string,
): Promise<string> {
  const redirectUri = "http://127.0.0.1:65534/oauth-callback";
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const resource = `${baseUrl}/mcp`;
  const registrationResponse = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "devspace-v108-reliability",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (registrationResponse.status !== 201) throw new Error("OAuth registration failed");
  const registration = (await registrationResponse.json()) as { client_id?: string };
  if (!registration.client_id) throw new Error("OAuth client ID missing");

  const authorizationFields = {
    response_type: "code",
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "devspace",
    resource,
  };
  const authorization = new URL(`${baseUrl}/authorize`);
  for (const [key, value] of Object.entries(authorizationFields)) {
    authorization.searchParams.set(key, value);
  }
  const authorizationResponse = await fetch(authorization, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...authorizationFields, owner_token: ownerToken }),
  });
  if (authorizationResponse.status !== 302) throw new Error("OAuth authorization failed");
  const location = authorizationResponse.headers.get("location");
  if (!location) throw new Error("OAuth authorization redirect missing");
  const redirect = new URL(location);
  if (redirect.hostname !== "127.0.0.1") throw new Error("OAuth redirect escaped loopback");
  const code = redirect.searchParams.get("code");
  if (!code) throw new Error("OAuth authorization code missing");

  const tokenResponse = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: registration.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource,
    }),
  });
  if (tokenResponse.status !== 200) throw new Error("OAuth token exchange failed");
  const tokens = (await tokenResponse.json()) as { access_token?: string };
  if (!tokens.access_token) throw new Error("OAuth access token missing");
  return tokens.access_token;
}

export async function initializeAndAbandon(
  baseUrl: string,
  accessToken: string,
  id: number,
): Promise<string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const initialize = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "devspace-v108-reliability", version: "1.0.0" },
      },
    }),
  });
  const sessionId = initialize.headers.get("mcp-session-id");
  await initialize.text();
  if (initialize.status !== 200 || !sessionId) {
    throw new Error(`MCP initialize failed with status ${initialize.status}`);
  }
  const initialized = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": sessionId },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }),
  });
  await initialized.text();
  if (initialized.status !== 202) {
    throw new Error(`MCP initialized notification failed with status ${initialized.status}`);
  }
  return sessionId;
}

function readFiniteNonNegative(
  object: Record<string, unknown>,
  key: string,
): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid runtime snapshot field: ${key}`);
  }
  return value;
}

export function validateRuntimeSnapshot(
  entry: Record<string, unknown>,
): RuntimeSnapshotLog {
  if (entry.event !== "mcp_runtime_snapshot") {
    throw new Error("Unexpected runtime snapshot event");
  }
  if (typeof entry.ts !== "string" || !Number.isFinite(Date.parse(entry.ts))) {
    throw new Error("Invalid runtime snapshot timestamp");
  }
  if (!entry.sessions || typeof entry.sessions !== "object") {
    throw new Error("Runtime snapshot sessions missing");
  }
  if (!entry.memory || typeof entry.memory !== "object") {
    throw new Error("Runtime snapshot memory missing");
  }
  const sessions = entry.sessions as Record<string, unknown>;
  const memory = entry.memory as Record<string, unknown>;
  const current = readFiniteNonNegative(sessions, "current");
  const active = readFiniteNonNegative(sessions, "active");
  const pendingReservations = readFiniteNonNegative(sessions, "pendingReservations");
  const max = readFiniteNonNegative(sessions, "max");
  if (![current, active, pendingReservations, max].every(Number.isInteger) || max < 1) {
    throw new Error("Runtime snapshot session counters must be positive/integer as applicable");
  }
  if (active > current || current + pendingReservations > max) {
    throw new Error("Runtime snapshot capacity invariant violated");
  }
  return {
    ts: entry.ts,
    event: "mcp_runtime_snapshot",
    sessions: { current, active, pendingReservations, max },
    memory: {
      heapUsedBytes: readFiniteNonNegative(memory, "heapUsedBytes"),
      heapTotalBytes: readFiniteNonNegative(memory, "heapTotalBytes"),
      rssBytes: readFiniteNonNegative(memory, "rssBytes"),
    },
    uptimeSeconds: readFiniteNonNegative(entry, "uptimeSeconds"),
  };
}

export function attachRuntimeObservers(
  processHandle: CandidateProcess,
): RuntimeObservers {
  const snapshots: RuntimeSnapshotLog[] = [];
  let createdEvents = 0;
  let closedEvents = 0;
  let oomEvidence = 0;
  let unhandledRejectionEvidence = 0;
  let telemetryErrors = 0;
  const stdoutLines = createInterface({ input: processHandle.stdout });
  stdoutLines.on("line", (line) => {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (entry.event === "mcp_runtime_snapshot") {
      try {
        snapshots.push(validateRuntimeSnapshot(entry));
      } catch {
        telemetryErrors += 1;
      }
    }
    if (entry.event === "mcp_session_created") createdEvents += 1;
    if (entry.event === "mcp_session_closed") closedEvents += 1;
  });
  processHandle.stderr.setEncoding("utf8");
  processHandle.stderr.on("data", (chunk: string) => {
    if (/heap out of memory|Reached heap limit/i.test(chunk)) oomEvidence += 1;
    if (/unhandledrejection/i.test(chunk)) unhandledRejectionEvidence += 1;
  });
  return {
    snapshots,
    get createdEvents() { return createdEvents; },
    get closedEvents() { return closedEvents; },
    get oomEvidence() { return oomEvidence; },
    get unhandledRejectionEvidence() { return unhandledRejectionEvidence; },
    get telemetryErrors() { return telemetryErrors; },
  };
}

export async function collectIdleHeapWindow(
  observers: RuntimeObservers,
  trafficStopTimestampMs: number,
): Promise<number[]> {
  const deadlineMs = trafficStopTimestampMs + MEMORY_SAMPLE_COLLECTION_DEADLINE_MS;
  const anchorSnapshot = [...observers.snapshots]
    .reverse()
    .find((snapshot) => Date.parse(snapshot.ts) <= trafficStopTimestampMs);
  if (!anchorSnapshot) {
    throw new InconclusiveMeasurementError("Missing validated pre-stop cadence anchor");
  }
  const anchor: TimedHeapSample = {
    timestampMs: Date.parse(anchorSnapshot.ts),
    heapUsedBytes: anchorSnapshot.memory.heapUsedBytes,
  };
  while (Date.now() <= deadlineMs) {
    if (observers.telemetryErrors > 0) {
      throw new InconclusiveMeasurementError("Malformed runtime telemetry observed");
    }
    const eligible = observers.snapshots
      .map((snapshot) => ({
        timestampMs: Date.parse(snapshot.ts),
        heapUsedBytes: snapshot.memory.heapUsedBytes,
      }))
      .filter((sample) => sample.timestampMs > trafficStopTimestampMs);
    if (eligible.length >= MEMORY_IDLE_SAMPLE_COUNT) {
      try {
        return validateIdleHeapWindow(
          anchor,
          eligible.slice(0, MEMORY_IDLE_SAMPLE_COUNT),
          trafficStopTimestampMs,
        );
      } catch (error) {
        throw new InconclusiveMeasurementError(
          error instanceof Error ? error.message : "Invalid idle heap window",
        );
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new InconclusiveMeasurementError(
    `Fewer than ${MEMORY_IDLE_SAMPLE_COUNT} valid runtime snapshots arrived within ${MEMORY_SAMPLE_COLLECTION_DEADLINE_MS}ms`,
  );
}

async function waitForRuntimeSnapshotAfter(
  observers: RuntimeObservers,
  afterTimestampMs: number,
  timeoutMs = 5_000,
): Promise<RuntimeSnapshotLog> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (observers.telemetryErrors > 0) {
      throw new InconclusiveMeasurementError("Malformed runtime telemetry observed");
    }
    const snapshot = observers.snapshots.find(
      (candidate) => Date.parse(candidate.ts) > afterTimestampMs,
    );
    if (snapshot) return snapshot;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new InconclusiveMeasurementError("Runtime snapshot checkpoint deadline exceeded");
}

async function runInitializeRange(
  baseUrl: string,
  accessToken: string,
  observers: RuntimeObservers,
  seenSessionIds: Set<string>,
  first: number,
  last: number,
): Promise<void> {
  for (let id = first; id <= last; id += 1) {
    const sessionId = await initializeAndAbandon(baseUrl, accessToken, id);
    if (seenSessionIds.has(sessionId)) throw new Error("Duplicate MCP session ID observed during soak");
    seenSessionIds.add(sessionId);
    if (id % 250 === 0) {
      const snapshot = await waitForRuntimeSnapshotAfter(observers, Date.now());
      if (
        snapshot.sessions.max !== 64 ||
        snapshot.sessions.current > 64 ||
        snapshot.sessions.current + snapshot.sessions.pendingReservations > 64
      ) {
        throw new Error("MCP session capacity invariant violated during soak");
      }
    }
  }
}

const defaultStockControlDependencies: StockControlDependencies = {
  createControlRoot: () => mkdtemp(join(tmpdir(), "devspace-r18-control-")),
  createOwnerToken: () => randomBytes(32).toString("base64url"),
  assertProductionBaselineIdentity,
  prepareStockPackagedRuntime,
  assertCandidateStateIsolation,
  startCandidateProcess: (root, runtime, ownerToken, maxSessions) =>
    startCandidateProcess(root, runtime, ownerToken, maxSessions),
  attachRuntimeObservers: (processHandle) =>
    attachRuntimeObservers(processHandle as CandidateProcess),
  waitForCandidateHealth,
  bootstrapOAuth,
  initializeAndAbandon,
  stopCandidateProcess: (processHandle) =>
    stopCandidateProcess(processHandle as CandidateProcess),
};

export function runStockControl(): Promise<StockControlEvidence> {
  return runStockControlWithDependencies(defaultStockControlDependencies);
}

interface CanaryMcpResult {
  status: number;
  messages: Array<Record<string, unknown>>;
}

async function canaryPost(
  baseUrl: string,
  accessToken: string,
  message: Record<string, unknown>,
  sessionId?: string,
): Promise<CanaryMcpResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });
  const text = await response.text();
  if (!text.trim()) return { status: response.status, messages: [] };
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(text) as
      | Record<string, unknown>
      | Array<Record<string, unknown>>;
    return {
      status: response.status,
      messages: Array.isArray(parsed) ? parsed : [parsed],
    };
  }
  if (contentType.includes("text/event-stream")) {
    return {
      status: response.status,
      messages: text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter((data) => data && data !== "[DONE]")
        .map((data) => JSON.parse(data) as Record<string, unknown>),
    };
  }
  throw new Error(`Unexpected MCP content type: ${contentType}`);
}

function canaryResponseForId(
  result: CanaryMcpResult,
  id: number,
): Record<string, unknown> {
  const message = result.messages.find((candidate) => candidate.id === id);
  if (!message) throw new Error(`Missing JSON-RPC response id=${id}`);
  return message;
}

function canaryWorkspaceId(message: Record<string, unknown>): string {
  const result = message.result as
    | { structuredContent?: { workspaceId?: unknown } }
    | undefined;
  const workspaceId = result?.structuredContent?.workspaceId;
  if (typeof workspaceId !== "string") {
    throw new Error("Canary open_workspace did not return workspaceId");
  }
  return workspaceId;
}

let canaryRpcId = 50_000;

async function canaryReadySession(
  baseUrl: string,
  accessToken: string,
  project: string,
): Promise<{ sessionId: string; workspaceId: string }> {
  const sessionId = await initializeAndAbandon(baseUrl, accessToken, canaryRpcId++);
  const id = canaryRpcId++;
  const opened = await canaryPost(
    baseUrl,
    accessToken,
    {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "open_workspace", arguments: { path: project } },
    },
    sessionId,
  );
  if (opened.status !== 200) throw new Error("Canary open_workspace failed");
  const response = canaryResponseForId(opened, id);
  if ("error" in response) throw new Error("Canary open_workspace returned JSON-RPC error");
  return { sessionId, workspaceId: canaryWorkspaceId(response) };
}

async function canaryCapacityRejection(
  baseUrl: string,
  accessToken: string,
): Promise<{ status: number; code: number }> {
  const id = canaryRpcId++;
  const result = await canaryPost(baseUrl, accessToken, {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "devspace-v108-canary", version: "1.0.0" },
    },
  });
  if (result.messages.length !== 1) throw new Error("Capacity rejection response count mismatch");
  const response = result.messages[0]!;
  if (response.id !== null) throw new Error("Capacity rejection id must be null");
  const error = response.error as { code?: unknown } | undefined;
  if (typeof error?.code !== "number") throw new Error("Capacity rejection code missing");
  return { status: result.status, code: error.code };
}

async function waitForSignal(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (existsSync(path)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error(`Timed out waiting for signal: ${path}`);
}

function heldExecArguments(
  workspaceId: string,
  readyPath: string,
  releasePath: string,
): Record<string, unknown> {
  const script = [
    "const fs=require('node:fs');",
    "fs.writeFileSync(process.argv[1],'ready');",
    "const timer=setInterval(()=>{",
    "if(fs.existsSync(process.argv[2])){clearInterval(timer);process.exit(0);}",
    "},10);",
  ].join("");
  return {
    workspaceId,
    cmd: [
      JSON.stringify(process.execPath),
      "-e",
      JSON.stringify(script),
      JSON.stringify(readyPath),
      JSON.stringify(releasePath),
    ].join(" "),
    yieldTimeMs: 30_000,
  };
}

async function releaseSignal(path: string): Promise<void> {
  await writeFile(path, "release").catch(() => {});
}

function expectedProxyHash(value: string | undefined): string {
  return createHash("sha256").update(value ?? "").digest("hex");
}

async function verifyChildProxyInvariant(
  accessToken: string,
  session: { sessionId: string; workspaceId: string },
): Promise<boolean> {
  const expectedHttp = expectedProxyHash(selectedProxy(process.env, "HTTP_PROXY", "http_proxy"));
  const expectedHttps = expectedProxyHash(selectedProxy(process.env, "HTTPS_PROXY", "https_proxy"));
  const childScript = [
    "const c=require('node:crypto');",
    "const h=v=>c.createHash('sha256').update(v||'').digest('hex');",
    "const n=(process.env.NO_PROXY||process.env.no_proxy||'').split(',');",
    `console.log(JSON.stringify({http:h(process.env.HTTP_PROXY||process.env.http_proxy)==='${expectedHttp}',https:h(process.env.HTTPS_PROXY||process.env.https_proxy)==='${expectedHttps}',localhost:n.includes('localhost'),loopback:n.includes('127.0.0.1'),ipv6:n.includes('::1'),allProxy:Boolean(process.env.ALL_PROXY||process.env.all_proxy)}));`,
  ].join("");
  const id = canaryRpcId++;
  const result = await canaryPost(
    CANDIDATE_BASE_URL,
    accessToken,
    {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "exec_command",
        arguments: {
          workspaceId: session.workspaceId,
          cmd: [JSON.stringify(process.execPath), "-e", JSON.stringify(childScript)].join(" "),
          yieldTimeMs: 30_000,
          maxOutputTokens: 2_000,
        },
      },
    },
    session.sessionId,
  );
  if (result.status !== 200) return false;
  const response = canaryResponseForId(result, id);
  const toolResult = response.result as { structuredContent?: { result?: unknown } } | undefined;
  const output = toolResult?.structuredContent?.result;
  if (typeof output !== "string") return false;
  const jsonLine = output.split(/\r?\n/).find((line) => line.startsWith("{"));
  if (!jsonLine) return false;
  const probe = JSON.parse(jsonLine) as Record<string, unknown>;
  return (
    probe.http === true &&
    probe.https === true &&
    probe.localhost === true &&
    probe.loopback === true &&
    probe.ipv6 === true &&
    probe.allProxy === false
  );
}

export async function runActiveProtectionCanary(): Promise<ActiveCanaryEvidence> {
  const canaryRoot = await mkdtemp(join(tmpdir(), "devspace-r18-active-canary-"));
  const ownerToken = randomBytes(32).toString("base64url");
  await assertProductionBaselineIdentity();
  assertCandidateStateIsolation(canaryRoot);
  const runtime = await prepareCandidatePackagedRuntime(canaryRoot);
  const child = await startCandidateProcess(canaryRoot, runtime, ownerToken, 2);
  const observers = attachRuntimeObservers(child);
  const releaseSignals: string[] = [];

  try {
    await waitForCandidateHealth(CANDIDATE_BASE_URL);
    const token = await bootstrapOAuth(CANDIDATE_BASE_URL, ownerToken);
    const project = join(canaryRoot, "projects", "fixture");
    const a = await canaryReadySession(CANDIDATE_BASE_URL, token, project);
    const b = await canaryReadySession(CANDIDATE_BASE_URL, token, project);

    const readyA = join(canaryRoot, "a.ready");
    const releaseA = join(canaryRoot, "a.release");
    releaseSignals.push(releaseA);
    let holdASettled = false;
    const holdAId = canaryRpcId++;
    const holdA = canaryPost(
      CANDIDATE_BASE_URL,
      token,
      {
        jsonrpc: "2.0",
        id: holdAId,
        method: "tools/call",
        params: {
          name: "exec_command",
          arguments: heldExecArguments(a.workspaceId, readyA, releaseA),
        },
      },
      a.sessionId,
    ).finally(() => {
      holdASettled = true;
    });

    let c: { sessionId: string; workspaceId: string } | undefined;
    try {
      await waitForSignal(readyA);
      if (holdASettled) throw new Error("A request settled before eviction assertion");
      c = await canaryReadySession(CANDIDATE_BASE_URL, token, project);
      const bCheckId = canaryRpcId++;
      const bCheck = await canaryPost(
        CANDIDATE_BASE_URL,
        token,
        { jsonrpc: "2.0", id: bCheckId, method: "tools/list", params: {} },
        b.sessionId,
      );
      if (bCheck.status !== 404) throw new Error("Idle session B was not evicted");
      if (holdASettled) throw new Error("Active session A was evicted or released");
    } finally {
      await releaseSignal(releaseA);
    }
    const holdAResult = await holdA;
    if (holdAResult.status !== 200 || "error" in canaryResponseForId(holdAResult, holdAId)) {
      throw new Error("Active session A request failed after release");
    }
    if (!c) throw new Error("Session C was not established");

    const readyA2 = join(canaryRoot, "a2.ready");
    const releaseA2 = join(canaryRoot, "a2.release");
    const readyC = join(canaryRoot, "c.ready");
    const releaseC = join(canaryRoot, "c.release");
    releaseSignals.push(releaseA2, releaseC);
    let holdA2Settled = false;
    let holdCSettled = false;
    const holdA2Id = canaryRpcId++;
    const holdCId = canaryRpcId++;
    const holdA2 = canaryPost(
      CANDIDATE_BASE_URL,
      token,
      {
        jsonrpc: "2.0",
        id: holdA2Id,
        method: "tools/call",
        params: {
          name: "exec_command",
          arguments: heldExecArguments(a.workspaceId, readyA2, releaseA2),
        },
      },
      a.sessionId,
    ).finally(() => {
      holdA2Settled = true;
    });
    const holdC = canaryPost(
      CANDIDATE_BASE_URL,
      token,
      {
        jsonrpc: "2.0",
        id: holdCId,
        method: "tools/call",
        params: {
          name: "exec_command",
          arguments: heldExecArguments(c.workspaceId, readyC, releaseC),
        },
      },
      c.sessionId,
    ).finally(() => {
      holdCSettled = true;
    });

    let rejected: { status: number; code: number } | undefined;
    try {
      await Promise.all([waitForSignal(readyA2), waitForSignal(readyC)]);
      if (holdA2Settled || holdCSettled) {
        throw new Error("Held request settled before all-active assertion");
      }
      rejected = await canaryCapacityRejection(CANDIDATE_BASE_URL, token);
      if (rejected.status !== 503 || rejected.code !== -32001) {
        throw new Error("All-active capacity rejection contract failed");
      }
      if (holdA2Settled || holdCSettled) {
        throw new Error("Active request settled during capacity rejection");
      }
    } finally {
      await Promise.all([releaseSignal(releaseA2), releaseSignal(releaseC)]);
    }
    const [holdA2Result, holdCResult] = await Promise.all([holdA2, holdC]);
    if (
      holdA2Result.status !== 200 ||
      holdCResult.status !== 200 ||
      "error" in canaryResponseForId(holdA2Result, holdA2Id) ||
      "error" in canaryResponseForId(holdCResult, holdCId)
    ) {
      throw new Error("Held active request failed after release");
    }

    for (const sessionId of [a.sessionId, c.sessionId]) {
      const id = canaryRpcId++;
      const result = await canaryPost(
        CANDIDATE_BASE_URL,
        token,
        { jsonrpc: "2.0", id, method: "tools/list", params: {} },
        sessionId,
      );
      if (result.status !== 200 || "error" in canaryResponseForId(result, id)) {
        throw new Error("Active canary session unusable after release");
      }
    }

    const childProxyInvariant = await verifyChildProxyInvariant(token, a);
    if (!childProxyInvariant) throw new Error("Child proxy invariant failed");
    if (
      observers.oomEvidence !== 0 ||
      observers.unhandledRejectionEvidence !== 0 ||
      observers.telemetryErrors !== 0 ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      throw new Error("Active protection canary runtime evidence failed");
    }
    if (!rejected) throw new Error("Capacity rejection evidence missing");

    return {
      pass: true,
      idleSessionEvicted: true,
      activeSessionWronglyEvicted: false,
      allActiveStatus: rejected.status,
      allActiveJsonRpcCode: rejected.code,
      childProxyInvariant,
      packageVersion: runtime.packageVersion,
      wrapperLockSha256: runtime.wrapperLockSha256,
      dependencyGraphSha256: runtime.dependencyGraphSha256,
      mcpSdkVersion: runtime.mcpSdkVersion,
    };
  } finally {
    await Promise.all(releaseSignals.map(releaseSignal));
    await stopCandidateProcess(child);
    await assertProductionBaselineIdentity();
  }
}

export async function runCandidateSoak(): Promise<CandidateSoakEvidence> {
  const candidateRoot = await mkdtemp(join(tmpdir(), "devspace-r18-soak-"));
  const ownerToken = randomBytes(32).toString("base64url");
  await assertProductionBaselineIdentity();
  assertCandidateStateIsolation(candidateRoot);
  const runtime = await prepareCandidatePackagedRuntime(candidateRoot);
  const child = await startCandidateProcess(candidateRoot, runtime, ownerToken, 64);
  const observers = attachRuntimeObservers(child);

  try {
    await waitForCandidateHealth(CANDIDATE_BASE_URL);
    const accessToken = await bootstrapOAuth(CANDIDATE_BASE_URL, ownerToken);
    const seenSessionIds = new Set<string>();
    await runInitializeRange(
      CANDIDATE_BASE_URL,
      accessToken,
      observers,
      seenSessionIds,
      1,
      SOAK_PHASE_A_INITIALIZES,
    );
    const phaseATrafficStopMs = Date.now();
    const phaseAHeapSamples = await collectIdleHeapWindow(observers, phaseATrafficStopMs);
    const hA = retainedHeapFloor(phaseAHeapSamples);

    await runInitializeRange(
      CANDIDATE_BASE_URL,
      accessToken,
      observers,
      seenSessionIds,
      SOAK_PHASE_A_INITIALIZES + 1,
      SOAK_TOTAL_INITIALIZES,
    );
    if (seenSessionIds.size !== SOAK_TOTAL_INITIALIZES) {
      throw new Error("Soak did not produce 10,000 unique MCP session IDs");
    }
    const phaseBTrafficStopMs = Date.now();
    const phaseBHeapSamples = await collectIdleHeapWindow(observers, phaseBTrafficStopMs);
    const hB = retainedHeapFloor(phaseBHeapSamples);
    if (observers.snapshots.length === 0) {
      throw new InconclusiveMeasurementError("No runtime snapshots observed");
    }

    const deltaBA = hB - hA;
    const limit = memoryPlateauLimit(hA);
    const maxObservedCurrent = Math.max(
      ...observers.snapshots.map((snapshot) => snapshot.sessions.current),
    );
    const maxObservedOccupiedCapacity = Math.max(
      ...observers.snapshots.map(
        (snapshot) => snapshot.sessions.current + snapshot.sessions.pendingReservations,
      ),
    );
    const candidateStillRunning = child.exitCode === null && child.signalCode === null;
    const verdict: CandidateSoakEvidence["verdict"] =
      observers.telemetryErrors > 0 || observers.createdEvents !== SOAK_TOTAL_INITIALIZES
        ? "INCONCLUSIVE"
        : candidateStillRunning &&
            observers.oomEvidence === 0 &&
            observers.unhandledRejectionEvidence === 0 &&
            maxObservedCurrent <= 64 &&
            maxObservedOccupiedCapacity <= 64 &&
            deltaBA <= limit
          ? "PASS"
          : "FAIL";

    return {
      verdict,
      candidateRoot,
      packageVersion: runtime.packageVersion,
      wrapperLockSha256: runtime.wrapperLockSha256,
      dependencyGraphSha256: runtime.dependencyGraphSha256,
      mcpSdkVersion: runtime.mcpSdkVersion,
      hA,
      hB,
      deltaBA,
      memoryLimit: limit,
      maxObservedCurrent,
      maxObservedOccupiedCapacity,
      createdEvents: observers.createdEvents,
      telemetryErrors: observers.telemetryErrors,
    };
  } finally {
    await stopCandidateProcess(child);
    await assertProductionBaselineIdentity();
  }
}

async function main(): Promise<void> {
  const sourceSdk = await readJson(
    join(SOURCE_ROOT, "node_modules", "@modelcontextprotocol", "sdk", "package.json"),
  );
  if (sourceSdk.version !== SOURCE_LOCK_MCP_SDK_VERSION) {
    throw new InconclusiveMeasurementError("Source MCP SDK no longer resolves to 1.29.0");
  }
  const result = await runGateOrchestration({
    runStockControl,
    runActiveProtectionCanary,
    runCandidateSoak,
  });
  const { control, canary, soak, verdict } = result;
  console.log(JSON.stringify({
    verdict,
    baseSha: V1_0_8_BASE_SHA,
    sourceLockMcpSdkVersion: SOURCE_LOCK_MCP_SDK_VERSION,
    candidatePackageVersion: soak.packageVersion,
    candidateRuntimeMcpSdkVersion: soak.mcpSdkVersion,
    candidateDependencyGraphSha256: soak.dependencyGraphSha256,
    candidateCanaryWrapperLockSha256: canary.wrapperLockSha256,
    candidateSoakWrapperLockSha256: soak.wrapperLockSha256,
    candidatePackagedGraphConsistent:
      canary.packageVersion === soak.packageVersion &&
      canary.mcpSdkVersion === soak.mcpSdkVersion &&
      canary.dependencyGraphSha256 === soak.dependencyGraphSha256,
    stockControlStatus: control.status,
    stockControlCreatedMinusClosed:
      control.created !== undefined && control.closed !== undefined
        ? control.created - control.closed
        : undefined,
    stockPackageVersion: control.packageVersion,
    stockRuntimeMcpSdkVersion: control.mcpSdkVersion,
    stockDependencyGraphSha256: control.dependencyGraphSha256,
    stockGraphMatchesCandidate:
      control.dependencyGraphSha256 !== undefined &&
      control.dependencyGraphSha256 === soak.dependencyGraphSha256,
    deployedStyleActiveProtectionCanary: canary.pass,
    idleSessionEvicted: canary.idleSessionEvicted,
    activeSessionWronglyEvicted: canary.activeSessionWronglyEvicted,
    allActiveStatus: canary.allActiveStatus,
    allActiveJsonRpcCode: canary.allActiveJsonRpcCode,
    childProxyInvariant: canary.childProxyInvariant,
    soak,
  }));
  if (verdict === "FAIL") process.exitCode = 1;
  if (verdict === "INCONCLUSIVE") process.exitCode = 2;
}

const invokedAsMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsMain) {
  main().catch((error) => {
    const inconclusive = error instanceof InconclusiveMeasurementError;
    console.error(JSON.stringify({
      verdict: inconclusive ? "INCONCLUSIVE" : "FAIL",
      failureClass: inconclusive ? "evidence_insufficient" : "candidate_failure",
    }));
    process.exitCode = inconclusive ? 2 : 1;
  });
}

const CANDIDATE_BASE_URL = "http://127.0.0.1:7677";
const STOCK_INITIALIZES = 256;

export async function runStockControlWithDependencies(
  dependencies: StockControlDependencies,
): Promise<StockControlEvidence> {
  await dependencies.assertProductionBaselineIdentity();
  const root = await dependencies.createControlRoot();
  dependencies.assertCandidateStateIsolation(root);
  const ownerToken = dependencies.createOwnerToken();

  let processHandle: unknown;
  let evidence: StockControlEvidence;
  try {
    const runtime = await dependencies.prepareStockPackagedRuntime(root);
    processHandle = await dependencies.startCandidateProcess(
      root,
      runtime,
      ownerToken,
      Number.MAX_SAFE_INTEGER,
    );
    const observers = dependencies.attachRuntimeObservers(processHandle);
    await dependencies.waitForCandidateHealth(CANDIDATE_BASE_URL);
    const accessToken = await dependencies.bootstrapOAuth(
      CANDIDATE_BASE_URL,
      ownerToken,
    );
    for (let index = 0; index < STOCK_INITIALIZES; index += 1) {
      await dependencies.initializeAndAbandon(
        CANDIDATE_BASE_URL,
        accessToken,
        index + 1,
      );
    }
    const retained = observers.createdEvents - observers.closedEvents;
    evidence = {
      status:
        observers.oomEvidence > 0 || observers.unhandledRejectionEvidence > 0
          ? "FAIL_DIAGNOSTIC"
          : retained >= STOCK_INITIALIZES
            ? "PASS"
            : "INCONCLUSIVE",
      created: observers.createdEvents,
      closed: observers.closedEvents,
      packageVersion: runtime.packageVersion,
      wrapperLockSha256: runtime.wrapperLockSha256,
      dependencyGraphSha256: runtime.dependencyGraphSha256,
      mcpSdkVersion: runtime.mcpSdkVersion,
    };
  } catch {
    evidence = { status: "INCONCLUSIVE" };
  } finally {
    if (processHandle !== undefined) {
      await dependencies.stopCandidateProcess(processHandle).catch(() => {});
    }
  }

  await dependencies.assertProductionBaselineIdentity();
  return evidence;
}

export async function runGateOrchestration(
  dependencies: GateOrchestrationDependencies,
): Promise<GateOrchestrationEvidence> {
  const control = await dependencies.runStockControl();
  const canary = await dependencies.runActiveProtectionCanary();
  const soak = await dependencies.runCandidateSoak();
  const candidateGraphConsistent =
    canary.packageVersion === soak.packageVersion &&
    canary.mcpSdkVersion === soak.mcpSdkVersion &&
    canary.dependencyGraphSha256 === soak.dependencyGraphSha256;
  const verdict =
    canary.pass && candidateGraphConsistent && soak.verdict === "PASS"
      ? "PASS"
      : soak.verdict === "INCONCLUSIVE"
        ? "INCONCLUSIVE"
        : "FAIL";
  return { verdict, control, canary, soak };
}
