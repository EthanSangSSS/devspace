import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

const DEPLOYED_RUNTIME_ROOT = "/Users/ethan/.local/opt/devspace-1.0.7";
const DEPLOYED_PACKAGE_RELATIVE = join(
  "node_modules",
  "@waishnav",
  "devspace",
);
const EXPECTED_DEPLOYED_WRAPPER_LOCK_SHA256 =
  "3422a3141d78f628d0309ddb42f71ec784d0928792cd9d44c3029374dd033428";
const EXPECTED_DEPLOYED_PACKAGE_VERSION = "1.0.7";
const EXPECTED_DEPLOYED_MCP_SDK_VERSION = "1.30.0";
const EXPECTED_DIRECT_DEPENDENCY_COUNT = 19;
const SOURCE_LOCK_MCP_SDK_VERSION = "1.29.0";
const CANDIDATE_BASE_URL = "http://127.0.0.1:7677";
type CandidateProcess = ChildProcessByStdio<null, Readable, Readable>;

export const MEMORY_IDLE_SAMPLE_COUNT = 60;
export const MEMORY_RUNTIME_SNAPSHOT_INTERVAL_MS = 1_000;
export const MEMORY_SAMPLE_INTERVAL_TOLERANCE_MS = 250;
export const MEMORY_SAMPLE_COLLECTION_DEADLINE_MS = 76_000;

export class InconclusiveMeasurementError extends Error {}

export interface TimedHeapSample {
  timestampMs: number;
  heapUsedBytes: number;
}

export interface RuntimeClone {
  root: string;
  packageRoot: string;
  cliPath: string;
  wrapperLockSha256: string;
  mcpSdkVersion: string;
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
  wrapperLockSha256?: string;
  mcpSdkVersion?: string;
}

export interface ActiveCanaryEvidence {
  pass: true;
  idleSessionEvicted: true;
  activeSessionWronglyEvicted: false;
  allActiveStatus: 503;
  allActiveJsonRpcCode: -32001;
  wrapperLockSha256: string;
  mcpSdkVersion: string;
}

export interface CandidateSoakEvidence {
  verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  candidateRoot: string;
  wrapperLockSha256: string;
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

export interface StockControlDependencies {
  createControlRoot(): Promise<string>;
  createOwnerToken(): string;
  assertLiveRuntimeIdentity(): Promise<void>;
  prepareRuntimeClone(root: string): Promise<RuntimeClone>;
  assertCandidateStateIsolation(root: string): void;
  startCandidateProcess(
    root: string,
    runtime: RuntimeClone,
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
  if (!anchor) {
    throw new Error("Idle heap cadence anchor is required");
  }
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

export async function assertLiveRuntimeIdentity(): Promise<void> {
  const liveRoot = await realpath(DEPLOYED_RUNTIME_ROOT);
  const lockSha = await sha256File(join(liveRoot, "package-lock.json"));
  if (lockSha !== EXPECTED_DEPLOYED_WRAPPER_LOCK_SHA256) {
    throw new InconclusiveMeasurementError("Live DevSpace wrapper lock drifted");
  }

  const packageJson = await readJson(
    join(liveRoot, DEPLOYED_PACKAGE_RELATIVE, "package.json"),
  );
  if (packageJson.version !== EXPECTED_DEPLOYED_PACKAGE_VERSION) {
    throw new InconclusiveMeasurementError("Live DevSpace package version drifted");
  }
  const dependencies = packageJson.dependencies as Record<string, string> | undefined;
  if (!dependencies || Object.keys(dependencies).length !== EXPECTED_DIRECT_DEPENDENCY_COUNT) {
    throw new InconclusiveMeasurementError("Live DevSpace direct dependency set drifted");
  }

  const sdkJson = await readJson(
    join(
      liveRoot,
      "node_modules",
      "@modelcontextprotocol",
      "sdk",
      "package.json",
    ),
  );
  if (sdkJson.version !== EXPECTED_DEPLOYED_MCP_SDK_VERSION) {
    throw new InconclusiveMeasurementError("Live MCP SDK version drifted");
  }
}

export async function prepareRuntimeClone(
  candidateRoot: string,
  distOverlay?: string,
): Promise<RuntimeClone> {
  const liveRoot = await realpath(DEPLOYED_RUNTIME_ROOT);
  const runtimeRoot = join(candidateRoot, "runtime");
  await cp(liveRoot, runtimeRoot, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true,
  });

  const wrapperLockSha256 = await sha256File(join(runtimeRoot, "package-lock.json"));
  if (wrapperLockSha256 !== EXPECTED_DEPLOYED_WRAPPER_LOCK_SHA256) {
    throw new InconclusiveMeasurementError("Deployed wrapper lock identity mismatch");
  }

  const packageRoot = join(runtimeRoot, DEPLOYED_PACKAGE_RELATIVE);
  const packageJson = await readJson(join(packageRoot, "package.json"));
  if (packageJson.version !== EXPECTED_DEPLOYED_PACKAGE_VERSION) {
    throw new InconclusiveMeasurementError("Deployed DevSpace package version mismatch");
  }
  const dependencies = packageJson.dependencies as Record<string, string> | undefined;
  if (!dependencies || Object.keys(dependencies).length !== EXPECTED_DIRECT_DEPENDENCY_COUNT) {
    throw new InconclusiveMeasurementError("Deployed DevSpace direct dependency set mismatch");
  }

  const runtimeReal = await realpath(runtimeRoot);
  const runtimePrefix = `${runtimeReal}/`;
  for (const dependencyName of Object.keys(dependencies)) {
    const dependencyRoot = await realpath(
      join(runtimeRoot, "node_modules", dependencyName),
    );
    if (!dependencyRoot.startsWith(runtimePrefix)) {
      throw new InconclusiveMeasurementError(
        `Runtime clone dependency escaped clone root: ${dependencyName}`,
      );
    }
  }

  const sdkJson = await readJson(
    join(
      runtimeRoot,
      "node_modules",
      "@modelcontextprotocol",
      "sdk",
      "package.json",
    ),
  );
  if (sdkJson.version !== EXPECTED_DEPLOYED_MCP_SDK_VERSION) {
    throw new InconclusiveMeasurementError("Deployed MCP SDK version mismatch");
  }

  if (distOverlay !== undefined) {
    const sourceDist = await realpath(distOverlay);
    const targetDist = join(packageRoot, "dist");
    const stockDistBackup = join(packageRoot, "dist.stock-evidence");
    if (existsSync(stockDistBackup)) {
      throw new InconclusiveMeasurementError(
        "Candidate stock dist evidence path already exists",
      );
    }
    await rename(targetDist, stockDistBackup);
    await cp(sourceDist, targetDist, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
  }

  return {
    root: runtimeRoot,
    packageRoot,
    cliPath: join(packageRoot, "dist", "cli.js"),
    wrapperLockSha256,
    mcpSdkVersion: String(sdkJson.version),
  };
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

export function candidateEnv(
  candidateRoot: string,
  ownerToken: string,
  maxSessions: number,
): NodeJS.ProcessEnv {
  const inheritedEnv = pickDefinedEnv(process.env, [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ]);
  return {
    ...inheritedEnv,
    HOST: "127.0.0.1",
    PORT: "7677",
    DEVSPACE_CONFIG_DIR: join(candidateRoot, "config"),
    DEVSPACE_STATE_DIR: join(candidateRoot, "state"),
    DEVSPACE_WORKTREE_ROOT: join(candidateRoot, "worktrees"),
    DEVSPACE_AGENT_DIR: join(candidateRoot, "agent"),
    DEVSPACE_ALLOWED_ROOTS: join(candidateRoot, "projects"),
    DEVSPACE_ALLOWED_HOSTS: "localhost,127.0.0.1",
    DEVSPACE_PUBLIC_BASE_URL: CANDIDATE_BASE_URL,
    DEVSPACE_OAUTH_OWNER_TOKEN: ownerToken,
    DEVSPACE_SUBAGENTS: "0",
    DEVSPACE_SKILLS: "0",
    DEVSPACE_WIDGETS: "off",
    DEVSPACE_TOOL_MODE: "codex",
    DEVSPACE_MCP_MAX_SESSIONS: String(maxSessions),
    DEVSPACE_RUNTIME_SNAPSHOT_INTERVAL_MS: "1000",
    DEVSPACE_LOG_LEVEL: "info",
    DEVSPACE_LOG_FORMAT: "json",
    DEVSPACE_TRUST_PROXY: "0",
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

export async function startCandidateProcess(
  candidateRoot: string,
  runtime: RuntimeClone,
  ownerToken: string,
  maxSessions: number,
): Promise<CandidateProcess> {
  assertCandidateStateIsolation(candidateRoot);
  await prepareCandidateDirectories(candidateRoot);
  return spawn(process.execPath, [runtime.cliPath, "serve"], {
    cwd: candidateRoot,
    env: candidateEnv(candidateRoot, ownerToken, maxSessions),
    stdio: ["ignore", "pipe", "pipe"],
  });
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
  const deadline = Date.now() + 10_000;
  while (Date.now() <= deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.status !== 200) {
        throw new Error(`Candidate health status ${response.status}`);
      }
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
      client_name: "devspace-reliability-soak",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (registrationResponse.status !== 201) {
    throw new Error("OAuth registration failed");
  }
  const registration = (await registrationResponse.json()) as {
    client_id?: string;
  };
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
  if (authorizationResponse.status !== 302) {
    throw new Error("OAuth authorization failed");
  }
  const location = authorizationResponse.headers.get("location");
  if (!location) throw new Error("OAuth authorization redirect missing");
  const redirect = new URL(location);
  if (redirect.hostname !== "127.0.0.1") {
    throw new Error("OAuth redirect escaped loopback");
  }
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
  const commonHeaders: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const initialize = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "devspace-reliability-soak", version: "1.0.0" },
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
    headers: { ...commonHeaders, "mcp-session-id": sessionId },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }),
  });
  await initialized.text();
  if (initialized.status !== 202) {
    throw new Error(
      `MCP initialized notification failed with status ${initialized.status}`,
    );
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
    get createdEvents() {
      return createdEvents;
    },
    get closedEvents() {
      return closedEvents;
    },
    get oomEvidence() {
      return oomEvidence;
    },
    get unhandledRejectionEvidence() {
      return unhandledRejectionEvidence;
    },
    get telemetryErrors() {
      return telemetryErrors;
    },
  };
}

export async function collectIdleHeapWindow(
  observers: RuntimeObservers,
  trafficStopTimestampMs: number,
): Promise<number[]> {
  const deadlineMs =
    trafficStopTimestampMs + MEMORY_SAMPLE_COLLECTION_DEADLINE_MS;
  const anchorSnapshot = [...observers.snapshots]
    .reverse()
    .find((snapshot) => Date.parse(snapshot.ts) <= trafficStopTimestampMs);
  if (!anchorSnapshot) {
    throw new InconclusiveMeasurementError(
      "Missing validated pre-stop cadence anchor",
    );
  }
  const anchor: TimedHeapSample = {
    timestampMs: Date.parse(anchorSnapshot.ts),
    heapUsedBytes: anchorSnapshot.memory.heapUsedBytes,
  };

  while (Date.now() <= deadlineMs) {
    if (observers.telemetryErrors > 0) {
      throw new InconclusiveMeasurementError(
        "Malformed runtime telemetry observed",
      );
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
      throw new InconclusiveMeasurementError(
        "Malformed runtime telemetry observed",
      );
    }
    const snapshot = observers.snapshots.find(
      (candidate) => Date.parse(candidate.ts) > afterTimestampMs,
    );
    if (snapshot) return snapshot;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new InconclusiveMeasurementError(
    "Runtime snapshot checkpoint deadline exceeded",
  );
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
    if (seenSessionIds.has(sessionId)) {
      throw new Error("Duplicate MCP session ID observed during soak");
    }
    seenSessionIds.add(sessionId);
    if (id % 250 === 0) {
      const checkpointTimestampMs = Date.now();
      const snapshot = await waitForRuntimeSnapshotAfter(
        observers,
        checkpointTimestampMs,
      );
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
  createControlRoot: () =>
    mkdtemp(join(tmpdir(), "devspace-r1-control-")),
  createOwnerToken: () => randomBytes(32).toString("base64url"),
  assertLiveRuntimeIdentity,
  prepareRuntimeClone: (root) => prepareRuntimeClone(root),
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

let canaryRpcId = 50_000;

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

async function canaryReadySession(
  baseUrl: string,
  accessToken: string,
  project: string,
): Promise<{ sessionId: string; workspaceId: string }> {
  const sessionId = await initializeAndAbandon(
    baseUrl,
    accessToken,
    canaryRpcId++,
  );
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
  return {
    sessionId,
    workspaceId: canaryWorkspaceId(response),
  };
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
      clientInfo: { name: "devspace-reliability-canary", version: "1.0.0" },
    },
  });
  if (result.messages.length !== 1) {
    throw new Error("Capacity rejection response count mismatch");
  }
  const response = result.messages[0]!;
  if (response.id !== null) {
    throw new Error("Capacity rejection must preserve current id:null contract");
  }
  const error = response.error as { code?: unknown } | undefined;
  if (typeof error?.code !== "number") {
    throw new Error("Capacity rejection JSON-RPC error code missing");
  }
  return { status: result.status, code: error.code };
}

async function releaseSignal(path: string): Promise<void> {
  await writeFile(path, "release").catch(() => {});
}

export async function runActiveProtectionCanary(): Promise<ActiveCanaryEvidence> {
  const canaryRoot = await mkdtemp(
    join(tmpdir(), "devspace-r1-active-canary-"),
  );
  const canaryToken = randomBytes(32).toString("base64url");
  await assertLiveRuntimeIdentity();
  assertCandidateStateIsolation(canaryRoot);
  const canaryRuntime = await prepareRuntimeClone(canaryRoot, resolve("dist"));
  const canary = await startCandidateProcess(
    canaryRoot,
    canaryRuntime,
    canaryToken,
    2,
  );
  const observers = attachRuntimeObservers(canary);
  const releaseSignals: string[] = [];

  try {
    await waitForCandidateHealth(CANDIDATE_BASE_URL);
    const token = await bootstrapOAuth(CANDIDATE_BASE_URL, canaryToken);
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

    try {
      await Promise.all([waitForSignal(readyA2), waitForSignal(readyC)]);
      if (holdA2Settled || holdCSettled) {
        throw new Error("Held request settled before all-active assertion");
      }
      const rejected = await canaryCapacityRejection(
        CANDIDATE_BASE_URL,
        token,
      );
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

    if (
      observers.oomEvidence !== 0 ||
      observers.unhandledRejectionEvidence !== 0 ||
      observers.telemetryErrors !== 0 ||
      canary.exitCode !== null ||
      canary.signalCode !== null
    ) {
      throw new Error("Active protection canary runtime evidence failed");
    }

    return {
      pass: true,
      idleSessionEvicted: true,
      activeSessionWronglyEvicted: false,
      allActiveStatus: 503,
      allActiveJsonRpcCode: -32001,
      wrapperLockSha256: canaryRuntime.wrapperLockSha256,
      mcpSdkVersion: canaryRuntime.mcpSdkVersion,
    };
  } finally {
    await Promise.all(releaseSignals.map(releaseSignal));
    await stopCandidateProcess(canary);
    await assertLiveRuntimeIdentity();
  }
}

export async function runCandidateSoak(): Promise<CandidateSoakEvidence> {
  const candidateRoot = await mkdtemp(join(tmpdir(), "devspace-r1-soak-"));
  const ownerToken = randomBytes(32).toString("base64url");
  await assertLiveRuntimeIdentity();
  assertCandidateStateIsolation(candidateRoot);
  const runtime = await prepareRuntimeClone(candidateRoot, resolve("dist"));
  const child = await startCandidateProcess(
    candidateRoot,
    runtime,
    ownerToken,
    64,
  );
  const observers = attachRuntimeObservers(child);

  try {
    await waitForCandidateHealth(CANDIDATE_BASE_URL);
    const accessToken = await bootstrapOAuth(CANDIDATE_BASE_URL, ownerToken);
    if (runtime.wrapperLockSha256 !== EXPECTED_DEPLOYED_WRAPPER_LOCK_SHA256) {
      throw new InconclusiveMeasurementError(
        "Soak runtime dependency graph does not match production",
      );
    }
    if (runtime.mcpSdkVersion !== EXPECTED_DEPLOYED_MCP_SDK_VERSION) {
      throw new InconclusiveMeasurementError(
        "Soak MCP SDK does not match production runtime",
      );
    }

    const seenSessionIds = new Set<string>();
    await runInitializeRange(
      CANDIDATE_BASE_URL,
      accessToken,
      observers,
      seenSessionIds,
      1,
      5_000,
    );

    const phaseATrafficStopMs = Date.now();
    const phaseAHeapSamples = await collectIdleHeapWindow(
      observers,
      phaseATrafficStopMs,
    );
    const hA = retainedHeapFloor(phaseAHeapSamples);

    await runInitializeRange(
      CANDIDATE_BASE_URL,
      accessToken,
      observers,
      seenSessionIds,
      5_001,
      10_000,
    );
    if (seenSessionIds.size !== 10_000) {
      throw new Error("Soak did not produce 10,000 unique MCP session IDs");
    }

    const phaseBTrafficStopMs = Date.now();
    const phaseBHeapSamples = await collectIdleHeapWindow(
      observers,
      phaseBTrafficStopMs,
    );
    const hB = retainedHeapFloor(phaseBHeapSamples);

    if (observers.snapshots.length === 0) {
      throw new InconclusiveMeasurementError("No runtime snapshots observed");
    }
    const deltaBA = hB - hA;
    const limit = memoryPlateauLimit(hA);
    const memoryPass = deltaBA <= limit;
    const maxObservedCurrent = Math.max(
      ...observers.snapshots.map((snapshot) => snapshot.sessions.current),
    );
    const maxObservedOccupiedCapacity = Math.max(
      ...observers.snapshots.map(
        (snapshot) =>
          snapshot.sessions.current + snapshot.sessions.pendingReservations,
      ),
    );
    const candidateStillRunning =
      child.exitCode === null && child.signalCode === null;

    const verdict: CandidateSoakEvidence["verdict"] =
      observers.telemetryErrors > 0 || observers.createdEvents !== 10_000
        ? "INCONCLUSIVE"
        : candidateStillRunning &&
            observers.oomEvidence === 0 &&
            observers.unhandledRejectionEvidence === 0 &&
            maxObservedCurrent <= 64 &&
            maxObservedOccupiedCapacity <= 64 &&
            memoryPass
          ? "PASS"
          : "FAIL";

    return {
      verdict,
      candidateRoot,
      wrapperLockSha256: runtime.wrapperLockSha256,
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
    await assertLiveRuntimeIdentity();
  }
}

export async function runStockControlWithDependencies(
  deps: StockControlDependencies,
): Promise<StockControlEvidence> {
  const controlRoot = await deps.createControlRoot();
  const controlToken = deps.createOwnerToken();

  // These are blocking GATE_R4 checks. They deliberately sit outside the
  // stock-only diagnostic catch.
  await deps.assertLiveRuntimeIdentity();
  const controlRuntime = await deps.prepareRuntimeClone(controlRoot);
  deps.assertCandidateStateIsolation(controlRoot);

  let control: unknown;
  let evidence: StockControlEvidence;
  let stopFailed = false;
  try {
    control = await deps.startCandidateProcess(
      controlRoot,
      controlRuntime,
      controlToken,
      64,
    );
    const observers = deps.attachRuntimeObservers(control);
    const baseUrl = "http://127.0.0.1:7677";
    await deps.waitForCandidateHealth(baseUrl);
    const accessToken = await deps.bootstrapOAuth(baseUrl, controlToken);
    for (let id = 1; id <= 256; id += 1) {
      await deps.initializeAndAbandon(baseUrl, accessToken, id);
    }

    const controlPass =
      observers.createdEvents === 256 &&
      observers.createdEvents - observers.closedEvents > 64 &&
      observers.oomEvidence === 0 &&
      observers.unhandledRejectionEvidence === 0;
    evidence = {
      status: controlPass ? "PASS" : "FAIL_DIAGNOSTIC",
      created: observers.createdEvents,
      closed: observers.closedEvents,
      wrapperLockSha256: controlRuntime.wrapperLockSha256,
      mcpSdkVersion: controlRuntime.mcpSdkVersion,
    };
  } catch {
    evidence = { status: "INCONCLUSIVE" };
  } finally {
    if (control !== undefined) {
      try {
        await deps.stopCandidateProcess(control);
      } catch {
        stopFailed = true;
      }
    }
  }

  // Post-run live identity is blocking too. Drift rejects the whole operation
  // instead of being downgraded to stock INCONCLUSIVE.
  await deps.assertLiveRuntimeIdentity();
  if (stopFailed) {
    throw new Error("Stock control process did not stop cleanly");
  }
  return evidence;
}

export async function runGateOrchestration(
  deps: GateOrchestrationDependencies,
): Promise<GateOrchestrationEvidence> {
  const control = await deps.runStockControl();
  const canary = await deps.runActiveProtectionCanary();
  const soak = await deps.runCandidateSoak();
  const verdict =
    canary.pass && soak.verdict === "PASS"
      ? "PASS"
      : soak.verdict === "INCONCLUSIVE"
        ? "INCONCLUSIVE"
        : "FAIL";
  return { verdict, control, canary, soak };
}

async function main(): Promise<void> {
  const result = await runGateOrchestration({
    runStockControl,
    runActiveProtectionCanary,
    runCandidateSoak,
  });
  const { control, canary, soak, verdict } = result;
  console.log(
    JSON.stringify({
      verdict,
      sourceLockMcpSdkVersion: SOURCE_LOCK_MCP_SDK_VERSION,
      candidateRuntimeMcpSdkVersion: soak.mcpSdkVersion,
      candidateWrapperLockSha256: soak.wrapperLockSha256,
      candidateDependencyGraphMatchesProduction:
        soak.wrapperLockSha256 === EXPECTED_DEPLOYED_WRAPPER_LOCK_SHA256 &&
        soak.mcpSdkVersion === EXPECTED_DEPLOYED_MCP_SDK_VERSION,
      stockControlStatus: control.status,
      stockControlCreatedMinusClosed:
        control.created !== undefined && control.closed !== undefined
          ? control.created - control.closed
          : undefined,
      deployedGraphActiveProtectionCanary: canary.pass,
      idleSessionEvicted: canary.idleSessionEvicted,
      activeSessionWronglyEvicted: canary.activeSessionWronglyEvicted,
      allActiveStatus: canary.allActiveStatus,
      allActiveJsonRpcCode: canary.allActiveJsonRpcCode,
      soak,
    }),
  );
  if (verdict === "FAIL") process.exitCode = 1;
  if (verdict === "INCONCLUSIVE") process.exitCode = 2;
}

const invokedAsMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsMain) {
  main().catch((error) => {
    const inconclusive = error instanceof InconclusiveMeasurementError;
    console.error(
      JSON.stringify({
        verdict: inconclusive ? "INCONCLUSIVE" : "FAIL",
        failureClass: inconclusive
          ? "evidence_insufficient"
          : "candidate_failure",
      }),
    );
    process.exitCode = inconclusive ? 2 : 1;
  });
}
