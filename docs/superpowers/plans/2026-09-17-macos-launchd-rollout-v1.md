# macOS Launchd Transactional Rollout V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a macOS-only, operator-side, one-shot transactional helper that switches the existing `com.ethan.devspace` user LaunchAgent between prebuilt immutable DevSpace slots with whole-state CAS, strong runtime identity, double candidate verification, fixed-file kernel locking, bounded rollback, and reboot-persistence preservation.

**Architecture:** Keep the rollout state machine pure and adapter-driven so ordinary tests never touch the real LaunchAgent. Put deterministic slot-manifest logic, fixed-file `lockf(1)` descriptor locking, and Darwin launchd/process/listener/filesystem adapters in focused modules; expose them only through the repository utility `scripts/devspace-macos-rollout.ts`, not through MCP or the public `devspace` CLI. The canonical plist is replaced only after a twice-verified candidate passes `PRE_COMMIT_REVALIDATED`; same-directory atomic rename is the sole `COMMITTED` transition.

**Tech Stack:** TypeScript 6 / Node.js `>=22.19 <27`, Node built-ins, `node:test` + `node:assert/strict`, macOS `launchctl`, `plutil`, `/usr/bin/lockf`, `ps`, `lsof`, and POSIX-style filesystem primitives exposed by Node.

**Spec:** `docs/superpowers/specs/2026-09-17-macos-launchd-rollout-v1-design.md` at accepted spec commit `23370cee842191da5c6e2107fcc3c8abfc1b9a48`.

## Global Constraints

- Execution starts from the exact commit containing this plan. Before creating the implementation worktree, verify its ancestry contains accepted spec commit `23370cee842191da5c6e2107fcc3c8abfc1b9a48` and baseline `3666314d0e850b1610a79df847cb000f139129eb`. Do not silently rebase if the baseline or reviewed spec changes.
- Use a new isolated implementation worktree/branch, suggested name `feat/macos-launchd-rollout-v1-20260917`; do not implement in the spec worktree.
- Fixed production topology for V1: label `com.ethan.devspace`, domain `gui/<uid>`, canonical plist `~/Library/LaunchAgents/com.ethan.devspace.plist`, listener `127.0.0.1:7676`, health path `/healthz`.
- V1 is macOS-only. Cross-platform CI may run pure/injected tests, but real Darwin adapters must fail closed or skip qualification outside macOS.
- Do not add an MCP tool, server endpoint, public `devspace` CLI command, automatic updater, permanent supervisor, Linux/Windows rollout path, build/install step for candidate slots, tunnel management, or launchd `enable`/`disable` mutation.
- The operator utility remains a repository script. Do not add a `package.json#bin` entry. Do not wire it into `src/cli.ts`.
- Ordinary unit/integration tests must never mutate the real `com.ethan.devspace` LaunchAgent or port `7676`.
- First production-label use requires a target-host disposable-label qualification on the target macOS major version. Current observed target is macOS `27.0`; mock tests are insufficient for that gate.
- The production live switch, real Mac restart, and reboot-recovery canary remain separate explicit user-authorization gates. Implementation completion does not authorize any of them.
- `RunAtLoad=true` and `KeepAlive=true` must remain intact in every committed canonical plist. Persistent disabled override for `com.ethan.devspace` must fail closed; the helper never changes that policy.
- `healthz` proves liveness only. It must never be elevated to full MCP/ChatGPT qualification.
- No credentials, owner tokens, OAuth material, Keychain content, arbitrary environment values, or full secret-bearing command lines may be logged.
- The fixed-file kernel advisory lock is an operational reliability boundary for cooperating rollout helpers, not a privilege/security boundary. A same-user process can ignore advisory locking and directly mutate launchd or the canonical plist; never claim the helper prevents that authority.
- Use TDD for every behavior task: failing test -> verify failure -> minimal implementation -> verify pass -> focused regression -> commit.
- Run `git diff --check` before every task commit that modifies files.

## Result-Code Closure for the Remaining P2

The accepted spec allows implementation planning with one remaining P2: failure-code completeness. Freeze the mapping below before orchestration work so tests and operator output are deterministic.

Concrete observed drift maps to `ROLLBACK_REFUSED_CONCURRENT_DRIFT`:

```text
canonical hash differs from the transaction's expected hash
OR canonical/parent identity is observably different from the recorded valid identity
OR a different same-label runtime generation is observably present
OR an unrelated PID observably owns the rollout listener port
OR the transaction's kernel lock is observably no longer held
OR the diagnostic owner record is validly parsed and its transaction_nonce differs
```

Observation failure maps to `ROLLBACK_REFUSED_UNPROVEN_STATE`:

```text
canonical/runtime/listener/lock/owner-record state cannot be read or parsed reliably enough
to distinguish expected state from concrete drift
```

Confirmed absence is neither drift nor ambiguity:

```text
no active same-label service generation
AND listener port is unowned
```

For pre-`COMMITTED` recovery, an observably changed old canonical hash or file/parent identity is `ROLLBACK_REFUSED_CONCURRENT_DRIFT`; an unreadable/unclassifiable canonical observation is `ROLLBACK_REFUSED_UNPROVEN_STATE`.

This mapping is an implementation/test contract. Do not invent additional terminal codes without returning to written-spec review.

## File Structure

Create focused modules rather than one monolithic rollout file:

```text
src/macos-launchd-rollout.ts
  Pure rollout types, result taxonomy, state machine orchestration, CAS/revalidation,
  forward path, pre-commit recovery, post-commit compensating rollback.

src/macos-launchd-rollout-manifest.ts
  Deterministic complete-slot manifest generation and digest verification.

src/macos-launchd-rollout-lock.ts
  Fixed `~/.devspace/rollout/rollout.lock` identity checks and Darwin
  descriptor-mode `/usr/bin/lockf` adapter. No stale-file rename/delete logic.

src/macos-launchd-rollout-darwin.ts
  Concrete macOS filesystem, plist, launchd, process, ancestor, listener,
  health, stop-barrier, durability, and disposable qualification adapters.

src/macos-launchd-rollout.test.ts
src/macos-launchd-rollout-manifest.test.ts
src/macos-launchd-rollout-lock.test.ts
src/macos-launchd-rollout-darwin.test.ts
  Pure/fake tests plus bounded Darwin-only non-production adapter tests.

scripts/devspace-macos-rollout.ts
  Thin operator wrapper with `rollout` and `qualify` modes; no public CLI registration.

docs/macos-launchd-rollout.md
  Operator runbook, evidence format, refusal handling, qualification and reboot gates.
```

Do not modify `src/local-agent-daemon-lifecycle.ts`; its stale-lock algorithm is deliberately not reused.

---

### Task 1: Freeze rollout types and exhaustive result classification

**Files:**
- Create: `src/macos-launchd-rollout.ts`
- Create: `src/macos-launchd-rollout.test.ts`

**Interfaces:**
- Produces:

```ts
export type RolloutResultCode =
  | "ROLLOUT_OK"
  | "PRECONDITION_FAILED"
  | "PERSISTENCE_CONTRACT_INVALID"
  | "CANDIDATE_ARTIFACT_MISMATCH"
  | "LIVE_STATE_CAS_MISMATCH"
  | "SPLIT_STATE_DETECTED"
  | "LOCK_BUSY"
  | "LOCK_AMBIGUOUS"
  | "SELF_HOSTED_ROLLOUT_REFUSED"
  | "SWITCH_FAILED_ROLLBACK_OK"
  | "SWITCH_FAILED_ROLLBACK_FAILED"
  | "ROLLBACK_REFUSED_CONCURRENT_DRIFT"
  | "ROLLBACK_REFUSED_UNPROVEN_STATE";

export interface RolloutRequest {
  expectedLiveEntrypoint: string;
  expectedLivePlistSha256: string;
  candidateEntrypoint: string;
  candidateSlotManifestSha256: string;
}

export interface ProcessIdentity {
  pid: number;
  processStartIdentity: string;
  executableRealpath: string;
  normalizedArgv: string[];
  entrypointRealpath: string;
}

export interface FileIdentity {
  path: string;
  uid: number;
  gid: number;
  mode: number;
  device: number;
  inode: number;
  kind: "file" | "directory";
  symlink: boolean;
}

export type ObservedState<T> =
  | { kind: "known"; value: T }
  | { kind: "unproven"; reason: string };

export type RollbackRefusal =
  | "ROLLBACK_REFUSED_CONCURRENT_DRIFT"
  | "ROLLBACK_REFUSED_UNPROVEN_STATE";

export interface RollbackClassificationInput {
  canonical: ObservedState<"expected" | "drift">;
  runtime: ObservedState<"expected" | "absent" | "drift">;
  listener: ObservedState<"expected" | "unowned" | "drift">;
  lock: ObservedState<"owned" | "drift">;
  ownerRecord: ObservedState<"ours" | "drift">;
}

export function classifyRollbackRefusal(
  input: RollbackClassificationInput,
): RollbackRefusal | undefined;
```

- Later tasks consume these names exactly. Do not rename them casually.

- [ ] **Step 1: Write failing taxonomy tests**

Add table-driven cases covering the P2 closure:

```ts
const known = <T>(value: T): ObservedState<T> => ({ kind: "known", value });
const unproven = <T>(reason: string): ObservedState<T> => ({ kind: "unproven", reason });

function rollbackState(
  overrides: Partial<RollbackClassificationInput> = {},
): RollbackClassificationInput {
  return {
    canonical: known("expected"),
    runtime: known("expected"),
    listener: known("expected"),
    lock: known("owned"),
    ownerRecord: known("ours"),
    ...overrides,
  };
}

const cases = [
  {
    name: "canonical hash drift is concrete drift",
    input: rollbackState({ canonical: known("drift") }),
    expected: "ROLLBACK_REFUSED_CONCURRENT_DRIFT",
  },
  {
    name: "valid owner nonce mismatch is concrete drift",
    input: rollbackState({ ownerRecord: known("drift") }),
    expected: "ROLLBACK_REFUSED_CONCURRENT_DRIFT",
  },
  {
    name: "unreadable owner record is unproven",
    input: rollbackState({ ownerRecord: unproven("read failed") }),
    expected: "ROLLBACK_REFUSED_UNPROVEN_STATE",
  },
  {
    name: "positive concrete drift outranks another unproven observation",
    input: rollbackState({
      canonical: known("drift"),
      ownerRecord: unproven("read failed"),
    }),
    expected: "ROLLBACK_REFUSED_CONCURRENT_DRIFT",
  },
  {
    name: "confirmed candidate absence is not a refusal",
    input: rollbackState({ runtime: known("absent"), listener: known("unowned") }),
    expected: undefined,
  },
] as const;
```

- [ ] **Step 2: Run focused test and verify RED**

Run:

```bash
pnpm exec tsx --test --test-concurrency=1 src/macos-launchd-rollout.test.ts
```

Expected: FAIL because `classifyRollbackRefusal` and rollout types do not exist.

- [ ] **Step 3: Implement the minimal exhaustive classifier**

Concrete drift takes precedence when it is positively observed. If no concrete drift is known but any required observation is unproven, return the unproven-state code:

```ts
export function classifyRollbackRefusal(input: RollbackClassificationInput): RollbackRefusal | undefined {
  if (
    (input.canonical.kind === "known" && input.canonical.value === "drift")
    || (input.runtime.kind === "known" && input.runtime.value === "drift")
    || (input.listener.kind === "known" && input.listener.value === "drift")
    || (input.lock.kind === "known" && input.lock.value === "drift")
    || (input.ownerRecord.kind === "known" && input.ownerRecord.value === "drift")
  ) {
    return "ROLLBACK_REFUSED_CONCURRENT_DRIFT";
  }
  if (
    input.canonical.kind === "unproven"
    || input.runtime.kind === "unproven"
    || input.listener.kind === "unproven"
    || input.lock.kind === "unproven"
    || input.ownerRecord.kind === "unproven"
  ) {
    return "ROLLBACK_REFUSED_UNPROVEN_STATE";
  }
  return undefined;
}
```

Do not convert observation errors into concrete drift.

- [ ] **Step 4: Run focused test and verify GREEN**

Run the same focused command. Expected: PASS.

- [ ] **Step 5: Typecheck the new public types**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git diff --check
git add src/macos-launchd-rollout.ts src/macos-launchd-rollout.test.ts
git commit -m "feat: define macOS rollout contracts"
```

---

### Task 2: Implement deterministic full-slot candidate manifests

**Files:**
- Create: `src/macos-launchd-rollout-manifest.ts`
- Create: `src/macos-launchd-rollout-manifest.test.ts`

**Interfaces:**
- Produces:

```ts
export interface CandidateSlotManifest {
  bytes: Buffer;
  sha256: string;
}

export function resolveCandidateSlotRoot(candidateEntrypoint: string): string;
export async function buildCandidateSlotManifest(slotRoot: string): Promise<CandidateSlotManifest>;
export async function verifyCandidateSlotManifest(
  slotRoot: string,
  expectedSha256: string,
): Promise<CandidateSlotManifest>;
```

- Manifest line format is exactly the spec contract:

```text
D<TAB><mode-octal><TAB><relative-path><LF>
F<TAB><mode-octal><TAB><sha256-hex><TAB><relative-path><LF>
L<TAB><symlink-target><TAB><relative-path><LF>
```

- [ ] **Step 1: Write failing manifest tests**

Use `mkdtemp()` with nested files, executable bits, directories, and internal symlinks. Cover:

```ts
assert.equal(first.sha256, second.sha256, "directory enumeration order must not affect digest");
assert.match(text, /^D\t755\tbin\n/m);
assert.match(text, /^F\t755\t[0-9a-f]{64}\tbin\/devspace\n/m);
assert.match(text, /^L\t\.\.\/lib\/entry\.js\tbin\/entry-link\n/m);
await assert.rejects(() => buildCandidateSlotManifest(slotWithEscapingSymlink), /escapes candidate slot/);
await assert.rejects(() => buildCandidateSlotManifest(slotWithTabInName), /unsupported manifest path/);
```

Also cover FIFO/socket/device rejection where the test platform permits creating one; otherwise inject a fake directory-entry adapter for that case.

Add `resolveCandidateSlotRoot()` tests for the fixed V1 package layout. Accepted entrypoints must end in the exact path suffix:

```text
node_modules/@waishnav/devspace/dist/cli.js
```

For `/Users/ethan/.local/opt/devspace-1.1.0-candidate/node_modules/@waishnav/devspace/dist/cli.js`, the slot root is `/Users/ethan/.local/opt/devspace-1.1.0-candidate`. A path not matching that suffix fails closed rather than guessing a parent directory.

- [ ] **Step 2: Verify RED**

```bash
pnpm exec tsx --test --test-concurrency=1 src/macos-launchd-rollout-manifest.test.ts
```

Expected: FAIL because manifest functions do not exist.

- [ ] **Step 3: Implement lexical traversal and encoding**

Implementation rules:

```ts
const entries = await readdir(directory, { withFileTypes: true });
entries.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "variant" }));
```

Do not use locale-sensitive ordering for the final implementation; replace the illustrative `localeCompare` above with direct Unicode code-unit lexical comparison:

```ts
entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
```

Use `lstat()` so symlinks are never followed during type classification. Resolve symlink targets only to check that their normalized destination remains inside `slotRoot`; record the literal target string in the manifest.

- [ ] **Step 4: Verify GREEN and deterministic repeatability**

Run focused test twice. Expected: PASS both times with identical expected digest fixture.

- [ ] **Step 5: Commit**

```bash
git diff --check
git add src/macos-launchd-rollout-manifest.ts src/macos-launchd-rollout-manifest.test.ts
git commit -m "feat: verify rollout candidate manifests"
```

---

### Task 3: Implement the fixed-file Darwin kernel lock adapter

**Files:**
- Create: `src/macos-launchd-rollout-lock.ts`
- Create: `src/macos-launchd-rollout-lock.test.ts`

**Interfaces:**
- Produces:

```ts
export interface RolloutLockOwnerRecord {
  schema_version: 1;
  pid: number;
  process_start_identity: string;
  transaction_nonce: string;
  transaction_id: string;
  created_at: string;
  released_at?: string;
}

export interface RolloutLockLease {
  readonly fd: number;
  readonly owner: RolloutLockOwnerRecord;
  assertOwned(): Promise<ObservedState<"owned" | "drift">>;
  release(): Promise<void>;
}

export async function acquireDarwinRolloutLock(input: {
  lockPath: string;
  owner: RolloutLockOwnerRecord;
}): Promise<RolloutLockLease>;
```

**Darwin mechanism to implement and qualify:**

macOS `lockf(1)` explicitly supports descriptor mode:

```text
lockf [-s] [-t seconds] fd
```

The adapter must open the fixed file first, validate it, keep that Node-owned FD open, and call descriptor mode with an inherited child descriptor. The qualification target is equivalent to:

```text
/usr/bin/lockf -s -t 0 3
```

where child fd `3` maps to the already-open parent lock FD. No command is supplied; `lockf` exits after applying the BSD-style lock to the inherited open file description. The parent retains the FD until transaction release.

- [ ] **Step 1: Write failing lock tests with an injected `LockfRunner`**

Cover safe identity, lock busy, no stale rename, diagnostic ownership, and release:

```ts
interface LockfRunner {
  tryExclusive(fd: number): Promise<"acquired" | "busy">;
}
```

Tests must assert:

```text
live kernel owner -> LOCK_BUSY equivalent error, owner bytes unchanged
old diagnostic bytes + unlocked file -> acquisition succeeds and record is replaced
symlink/non-regular/wrong-owner/group-or-world-writable lock -> LOCK_AMBIGUOUS equivalent error
release never unlinks or renames rollout.lock
nonce mismatch during diagnostic cleanup does not overwrite another record
```

- [ ] **Step 2: Verify RED**

```bash
pnpm exec tsx --test --test-concurrency=1 src/macos-launchd-rollout-lock.test.ts
```

- [ ] **Step 3: Implement safe fixed-file open and descriptor lock**

Use a fixed path. Never truncate before the lock is acquired. Open read/write, create only if absent, then `lstat`/`fstat` and verify the same inode/device before proceeding.

Spawn `/usr/bin/lockf` with explicit stdio mapping so the lock FD is inherited only as the descriptor argument used by `lockf`; all later child processes use ordinary `stdio` and must not receive this FD.

Treat the `lockf` timeout exit (`EX_TEMPFAIL`) as busy; any other nonzero exit is ambiguity/error, not busy.

- [ ] **Step 4: Add a Darwin-only real descriptor-semantics test**

This test uses a temporary lock file only. Sequence:

```text
parent opens fd
descriptor-mode lockf acquires
second independent process/path lock attempt fails immediately
parent still holds fd after lockf process exits
parent closes fd
second attempt now succeeds
```

Skip this test outside `darwin`.

- [ ] **Step 5: Verify GREEN on focused lock tests**

```bash
pnpm exec tsx --test --test-concurrency=1 src/macos-launchd-rollout-lock.test.ts
```

Expected on macOS: all fake tests plus real temporary-file descriptor test PASS.

- [ ] **Step 6: Commit**

```bash
git diff --check
git add src/macos-launchd-rollout-lock.ts src/macos-launchd-rollout-lock.test.ts
git commit -m "feat: add fixed-file macOS rollout lock"
```

---

### Task 4: Implement qualified Darwin filesystem, process, launchd, listener, and health adapters

**Files:**
- Create: `src/macos-launchd-rollout-darwin.ts`
- Create: `src/macos-launchd-rollout-darwin.test.ts`
- Modify: `src/macos-launchd-rollout.ts`

**Interfaces:**
- Extend core with adapter contracts:

```ts
export interface LaunchdObservation {
  loaded: boolean;
  pid?: number;
  runCount?: number;
  normalizedArgv?: string[];
}

export interface ListenerObservation {
  state: "unowned" | "owned";
  ownerPid?: number;
}

export interface CanonicalPlistSnapshot {
  bytes: Buffer;
  sha256: string;
  identity: FileIdentity;
  parentIdentity: FileIdentity;
  entrypointRealpath: string;
  runAtLoad: boolean;
  keepAlive: boolean;
}

export interface PreparedCanonicalTemp {
  path: string;
  sha256: string;
  identity: FileIdentity;
}

export interface MacosRolloutAdapters {
  acquireLock(input: {
    transactionId: string;
    transactionNonce: string;
  }): Promise<RolloutLockLease>;
  readCanonical(): Promise<ObservedState<CanonicalPlistSnapshot>>;
  validateCandidateEntrypoint(path: string): Promise<void>;
  createCandidatePlist(oldBytes: Buffer, candidateEntrypoint: string): Promise<Buffer>;
  writeOldBackup(input: {
    transactionDir: string;
    bytes: Buffer;
    sha256: string;
    uid: number;
    gid: number;
    mode: number;
  }): Promise<void>;
  writeCandidateEvidence(input: {
    transactionDir: string;
    plistBytes: Buffer;
    plistSha256: string;
    manifestSha256: string;
  }): Promise<void>;
  prepareCanonicalTemp(input: {
    transactionNonce: string;
    bytes: Buffer;
    expectedSha256: string;
    uid: number;
    gid: number;
    mode: number;
  }): Promise<PreparedCanonicalTemp>;
  atomicReplaceCanonical(tempPath: string): Promise<void>;
  syncCanonicalParent(): Promise<void>;
  observeLaunchd(): Promise<ObservedState<LaunchdObservation>>;
  observeProcess(pid: number): Promise<ObservedState<ProcessIdentity>>;
  observeListener(): Promise<ObservedState<ListenerObservation>>;
  checkHealth(): Promise<ObservedState<"healthy" | "unhealthy">>;
  bootoutExpected(expected: ProcessIdentity): Promise<void>;
  bootstrap(plistPath: string): Promise<void>;
  observeDisabledOverride(): Promise<ObservedState<"enabled" | "disabled">>;
  observeAncestors(pid: number): Promise<ObservedState<number[]>>;
  waitStopped(expected: ProcessIdentity): Promise<ObservedState<"stopped">>;
  waitStable(expected: ProcessIdentity): Promise<ObservedState<"stable">>;
  readFileSha256(path: string): Promise<ObservedState<string>>;
  observeFileIdentity(path: string): Promise<ObservedState<FileIdentity>>;
  preflightDurability(): Promise<void>;
}
```

`waitStable()` is the injected bounded observation-window gate used after each candidate start; `readFileSha256()` re-verifies exact file bytes; `observeFileIdentity()` performs the fresh uid/gid/mode/device/inode/type/symlink observation required immediately before compensating restore. These are adapter methods rather than direct `fs`/timer calls in the state machine so ordinary tests remain deterministic.

- [ ] **Step 1: Write failing parser/adapter unit tests**

Use injected command output rather than production launchd. Cover:

```text
plutil semantic parsing and only-entrypoint rewrite
print-disabled parser: enabled / disabled / malformed
launchctl service observation parser with exact PID
process parser -> pid + start identity + executable + normalized argv + entrypoint
lsof listener parser -> exact owner PID / unowned / malformed
ancestor parsing
stop barrier rejects unrelated port owner or incompatible same-label runtime
canonical symlink / uid / mode / parent checks
same-directory hidden temp uses non-.plist suffix and preserves uid/gid/mode
file fsync failure and parent-directory fsync failure propagate distinctly
```

- [ ] **Step 2: Verify RED**

```bash
pnpm exec tsx --test --test-concurrency=1 src/macos-launchd-rollout-darwin.test.ts
```

- [ ] **Step 3: Implement command execution without a shell**

Use `execFile`/`spawn` argument arrays. Do not interpolate paths into shell strings.

Required command surfaces:

```text
/bin/launchctl bootstrap gui/<uid> <plist-path>
/bin/launchctl bootout gui/<uid>/com.ethan.devspace
/bin/launchctl print gui/<uid>/com.ethan.devspace
/bin/launchctl print-disabled gui/<uid>
/usr/bin/plutil -extract Label raw -o - <plist-path>
/usr/bin/plutil -extract RunAtLoad raw -o - <plist-path>
/usr/bin/plutil -extract KeepAlive raw -o - <plist-path>
/usr/bin/plutil -extract ProgramArguments json -o - <plist-path>
/usr/bin/plutil -replace ProgramArguments.1 -string <candidate-entrypoint> <staged-plist-path>
/usr/bin/plutil -lint <staged-plist-path>
/bin/ps -p <pid> -o lstart=
/usr/sbin/lsof -a -p <pid> -d txt -Fn
/usr/sbin/lsof -nP -a -iTCP@127.0.0.1:<port> -sTCP:LISTEN -Fp
```

If actual binary paths differ on the target host, qualification fails closed; do not PATH-search a different tool silently.

The qualified `launchctl print` parser must extract `pid`, `runs`, and the loaded job `arguments` array. Build `ProcessIdentity.processStartIdentity` from the observed PID generation evidence (`runs` plus the exact `ps lstart` text), use the loaded launchd arguments as `normalizedArgv`, and use `lsof -d txt` to resolve the executable realpath. Extract and realpath the DevSpace entrypoint from that normalized argument array. The disposable qualification must prove that the parser preserves an argument containing a space; do not fall back to splitting a `ps command` string on whitespace.

- [ ] **Step 4: Implement canonical file/durability primitives**

Use `lstat` before `realpath`; reject symlink canonical and unsafe parent. Prepare hidden temp inside `~/Library/LaunchAgents`, preserve recorded uid/gid/mode, hash exact bytes, `fsync` file, atomic `rename`, then `fsync` parent directory.

`preflightDurability()` must use a disposable hidden non-`.plist` file in the canonical parent to prove create/write/fsync/rename/parent-sync support before any live service stop.

- [ ] **Step 5: Implement bounded stop barrier**

Use polling with explicit deadline. A successful `bootout` return is not enough. Stop is verified only when:

```text
expected process generation is gone
same-label expected generation is not active
port is no longer owned by stopped PID
no unrelated PID owns the port
no incompatible same-label runtime appears
```

- [ ] **Step 6: Verify focused adapter tests**

Run focused test. Expected: PASS without touching production label.

- [ ] **Step 7: Commit**

```bash
git diff --check
git add src/macos-launchd-rollout.ts src/macos-launchd-rollout-darwin.ts src/macos-launchd-rollout-darwin.test.ts
git commit -m "feat: add Darwin rollout adapters"
```

---

### Task 5: Implement forward rollout state machine through `COMMITTED`

**Files:**
- Modify: `src/macos-launchd-rollout.ts`
- Modify: `src/macos-launchd-rollout.test.ts`

**Interfaces:**
- Produces:

```ts
export interface RolloutOutcome {
  code: RolloutResultCode;
  transactionId: string;
  transactionNonce: string;
  committed: boolean;
  controlledReload: "PASS" | "FAIL" | "NOT_RUN";
  persistenceStaticContract: "PASS" | "FAIL";
  rebootRecovery: "UNVERIFIED";
  evidence: Record<string, string | number | boolean | undefined>;
}

export type ForwardRolloutFailurePhase =
  | "precheck"
  | "old_stop"
  | "candidate_first_start"
  | "candidate_first_verify"
  | "candidate_controlled_stop"
  | "candidate_reload"
  | "pre_commit_revalidation"
  | "post_commit_verification";

export interface ForwardRolloutFailure {
  ok: false;
  phase: ForwardRolloutFailurePhase;
  code:
    | "PRECONDITION_FAILED"
    | "PERSISTENCE_CONTRACT_INVALID"
    | "CANDIDATE_ARTIFACT_MISMATCH"
    | "LIVE_STATE_CAS_MISMATCH"
    | "SPLIT_STATE_DETECTED"
    | "SELF_HOSTED_ROLLOUT_REFUSED";
  committed: boolean;
  context: ForwardTransactionContext;
  initial?: InitialRolloutState;
  candidateProcess?: ProcessIdentity;
  candidateCanonicalSha256?: string;
  reason: string;
}

export interface ForwardRolloutSuccess {
  ok: true;
  committed: true;
  context: ForwardTransactionContext;
  candidateProcess: ProcessIdentity;
  candidateCanonicalSha256: string;
}

export type ForwardRolloutResult = ForwardRolloutSuccess | ForwardRolloutFailure;

export interface ForwardTransactionContext {
  transactionId: string;
  transactionNonce: string;
  transactionDir: string;
  candidatePlistPath: string;
  lease: RolloutLockLease;
  initial?: InitialRolloutState;
  candidatePlistBytes?: Buffer;
  candidatePlistSha256?: string;
}

export async function runMacosLaunchdForwardPath(
  request: RolloutRequest,
  adapters: MacosRolloutAdapters,
): Promise<ForwardRolloutResult>;

interface InitialRolloutState {
  canonical: CanonicalPlistSnapshot;
  launchd: LaunchdObservation;
  process: ProcessIdentity;
}

function resolveTransactionDir(transactionId: string): string;
async function assertNotSelfHosted(input: {
  adapters: MacosRolloutAdapters;
  livePid: number;
  helperPid: number;
}): Promise<void>;
async function readAndValidateInitialState(input: {
  request: RolloutRequest;
  adapters: MacosRolloutAdapters;
}): Promise<InitialRolloutState>;
async function revalidateBeforeOldStop(input: {
  initial: InitialRolloutState;
  request: RolloutRequest;
  adapters: MacosRolloutAdapters;
}): Promise<void>;
```

- [ ] **Step 1: Write failing forward-path state-machine tests**

Fake adapter must record every side effect. Cover exact ordering:

```text
LOCKED
PRECHECKED
BACKED_UP
CANDIDATE_STAGED
OLD_STOP_REQUESTED
OLD_STOPPED_VERIFIED
CANDIDATE_STARTED
CANDIDATE_VERIFIED
CANDIDATE_STOP_REQUESTED
CANDIDATE_STOPPED_VERIFIED
CONTROLLED_RELOAD_STARTED
CONTROLLED_RELOAD_VERIFIED
PRE_COMMIT_REVALIDATED
COMMITTED
POST_COMMIT_VERIFIED
ROLLOUT_OK
```

Add negative tests for whole-plist mismatch, runtime generation drift, disabled override, ancestry refusal, manifest mismatch, wrong listener owner, health failure, controlled reload failure, and pre-commit runtime drift. Assert canonical replace never occurs in those pre-commit failures.

- [ ] **Step 2: Verify RED**

```bash
pnpm exec tsx --test --test-concurrency=1 src/macos-launchd-rollout.test.ts
```

- [ ] **Step 3: Implement precheck and old-service stop**

Order must be explicit:

```ts
const lease = await adapters.acquireLock({ transactionId, transactionNonce });
const initial = await readAndValidateInitialState({ request, adapters });
await assertNotSelfHosted({ adapters, livePid: initial.process.pid, helperPid: process.pid });
await adapters.preflightDurability();
const candidateSlotRoot = resolveCandidateSlotRoot(request.candidateEntrypoint);
await verifyCandidateSlotManifest(candidateSlotRoot, request.candidateSlotManifestSha256);
const transactionDir = resolveTransactionDir(transactionId);
await adapters.writeOldBackup({
  transactionDir,
  bytes: initial.canonical.bytes,
  sha256: initial.canonical.sha256,
  uid: initial.canonical.identity.uid,
  gid: initial.canonical.identity.gid,
  mode: initial.canonical.identity.mode,
});
await revalidateBeforeOldStop({ initial, request, adapters });
await adapters.bootoutExpected(initial.process);
const stopped = await adapters.waitStopped(initial.process);
if (stopped.kind === "unproven") {
  return {
    ok: false,
    phase: "old_stop",
    code: "LIVE_STATE_CAS_MISMATCH",
    committed: false,
    initial,
    reason: stopped.reason,
  };
}
```

No candidate bootstrap may run before `OLD_STOPPED_VERIFIED`.

Task 5 deliberately returns a typed `ForwardRolloutFailure` instead of attempting rollback. Task 6 is the only task that turns a forward failure into pre-commit recovery or post-commit compensating rollback and then produces the public `RolloutOutcome`. This keeps forward ordering independently testable without temporary raw exceptions or duplicate recovery logic.

The forward result retains the exact kernel `RolloutLockLease`; Task 5 must **not** release it. Task 6 owns the terminal `finally` release after recovery/compensating rollback/public outcome classification. This is required so the single-writer guarantee spans the entire forward + recovery transaction rather than ending at the Task 5 function boundary.

- [ ] **Step 4: Implement double candidate boot + verification**

First candidate and controlled reload both require strong process identity, exact listener owner, liveness, bounded stability, and unchanged staged plist hash.

- [ ] **Step 5: Implement `PRE_COMMIT_REVALIDATED` and sole commit point**

Immediately before rename, fresh-read and require:

```text
old canonical hash still expected
canonical file/parent identity still valid
staged candidate hash unchanged
loaded runtime is expected candidate generation or verified same-slot replacement
listener owner == candidate PID
health passes
no incompatible runtime exists
same-directory temp bytes/hash/file identity valid and file flush succeeded
```

Only then call `atomicReplaceCanonical()`. Set `committed=true` only after that call succeeds.

- [ ] **Step 6: Implement post-commit qualification**

Verify canonical candidate hash/file identity, parent-directory sync, runtime reconciliation, listener, health, persistence contract, and `CONTROLLED_RELOAD=PASS` before returning `ROLLOUT_OK`.

- [ ] **Step 7: Verify focused tests GREEN**

Run core + manifest tests. Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git diff --check
git add src/macos-launchd-rollout.ts src/macos-launchd-rollout.test.ts
git commit -m "feat: implement transactional rollout forward path"
```

---

### Task 6: Implement pre-commit recovery and post-commit compensating rollback

**Files:**
- Modify: `src/macos-launchd-rollout.ts`
- Modify: `src/macos-launchd-rollout.test.ts`

**Interfaces:**
- Consumes the Task 1 deterministic result taxonomy.
- Consumes `runMacosLaunchdForwardPath()` from Task 5.
- Produces the public orchestration entrypoint:

```ts
export async function runMacosLaunchdRollout(
  request: RolloutRequest,
  adapters: MacosRolloutAdapters,
): Promise<RolloutOutcome>;
```

- No new terminal result codes.

- [ ] **Step 1: Write failing pre-`COMMITTED` recovery tests**

Cover accepted spec A-E classification:

```text
A old runtime already healthy -> verify/reuse, no bootout
B transaction candidate -> prove ownership, stop, barrier, bootstrap old
C confirmed candidate absence -> no bootout, bootstrap old
D concrete incompatible runtime/listener/canonical/file identity -> ROLLBACK_REFUSED_CONCURRENT_DRIFT
E unreadable/unclassifiable runtime/listener/canonical observation -> ROLLBACK_REFUSED_UNPROVEN_STATE
```

Explicitly add the P2 mapping cases:

```text
pre-commit old canonical hash changed -> CONCURRENT_DRIFT
pre-commit old canonical validly observed with changed uid/mode/parent identity -> CONCURRENT_DRIFT
pre-commit old canonical cannot be read/stat'ed reliably -> UNPROVEN_STATE
```

- [ ] **Step 2: Write failing post-`COMMITTED` rollback tests**

Cover:

```text
exact candidate generation -> eligible
verified same-slot KeepAlive replacement -> eligible
confirmed candidate absence -> eligible, no bootout
unexpected same-label generation -> CONCURRENT_DRIFT
unrelated listener owner -> CONCURRENT_DRIFT
kernel lock demonstrably lost -> CONCURRENT_DRIFT
valid owner record with different nonce -> CONCURRENT_DRIFT
owner record unreadable/unparseable -> UNPROVEN_STATE
ambiguous process/listener observation -> UNPROVEN_STATE
```

- [ ] **Step 3: Add the final-rename race regression**

Fake adapter changes canonical/runtime/lock state after initial eligibility and after stop/temp preparation but before restore rename. Assert `ROLLBACK_PRE_RESTORE_REVALIDATED` refuses the rename and returns the correct concrete-vs-unproven code.

- [ ] **Step 4: Verify RED**

Run focused core tests and confirm new rollback cases fail.

- [ ] **Step 5: Implement pre-commit recovery exactly once**

Keep classification separate from mutation. Never `bootout` until expected ownership is proven. Re-read old canonical hash/file identity before accepting A or bootstrapping B/C.

- [ ] **Step 6: Implement post-commit eligibility + final revalidation**

Sequence:

```text
initial persistent/runtime/lock classification
-> optional candidate bootout only for verified A/B
-> bounded stop barrier
-> prepare exact old backup same-directory temp + flush/hash/attrs
-> ROLLBACK_PRE_RESTORE_REVALIDATED
-> atomic restore rename
-> parent sync
-> bootstrap old
-> verify old identity/listener/health
```

No code path may restore the old canonical after `ROLLBACK_PRE_RESTORE_REVALIDATED` fails.

- [ ] **Step 7: Verify GREEN**

Run core tests. Expected: all forward + rollback cases PASS.

- [ ] **Step 8: Commit**

```bash
git diff --check
git add src/macos-launchd-rollout.ts src/macos-launchd-rollout.test.ts
git commit -m "feat: add rollout compensating rollback"
```

---

### Task 7: Add the operator script and mandatory disposable target-host qualification

**Files:**
- Create: `scripts/devspace-macos-rollout.ts`
- Modify: `src/macos-launchd-rollout-darwin.ts`
- Modify: `src/macos-launchd-rollout-darwin.test.ts`

**Interfaces:**
- Script modes:

```text
pnpm exec tsx scripts/devspace-macos-rollout.ts qualify
pnpm exec tsx scripts/devspace-macos-rollout.ts rollout \
  --expected-live-entrypoint <absolute-path> \
  --expected-live-plist-sha256 <64-hex> \
  --candidate-entrypoint <absolute-path> \
  --candidate-slot-manifest-sha256 <64-hex>
```

- [ ] **Step 1: Write failing argument/presentation tests through exported pure helpers**

Keep parsing/presentation functions importable without executing the script:

```ts
export function parseRolloutScriptArgs(argv: string[]): ScriptCommand;
export function formatRolloutOutcome(outcome: RolloutOutcome): string;
```

Reject relative entrypoints, malformed SHA-256, unknown flags, production-label qualification overrides, and any attempt to select an arbitrary label/port in `rollout` mode.

- [ ] **Step 2: Implement thin wrapper**

The script only:

```text
parse args
construct fixed V1 topology
construct Darwin adapters
call qualify or runMacosLaunchdRollout
print bounded JSON/text evidence
set exit code
```

It must not contain an independent copy of the state machine.

- [ ] **Step 3: Implement disposable qualification**

Qualification must use a unique label such as:

```text
com.ethan.devspace.rollout-qualification.<nonce>
```

and a free loopback port that is not `7676`. Build a temporary Node health server script whose argv intentionally includes a path containing a space so the process-argv parser is exercised.

Qualification evidence must cover:

```text
macOS exact version
/usr/bin/lockf descriptor semantics and lock contention
launchctl bootstrap + bootout for disposable label
qualified launchctl observation parser
print-disabled parser
strong process identity + start generation + argv/entrypoint extraction
listener owner PID through lsof
health request
bounded stop barrier
hidden non-.plist temp create/write/fsync/rename/parent-sync in ~/Library/LaunchAgents
cleanup of disposable label, listener and temp artifacts
```

It must never read or mutate `com.ethan.devspace` beyond any explicitly read-only topology validation that the implementation later requires; simplest V1 qualification should avoid the production label entirely.

- [ ] **Step 4: Add non-live qualification tests**

Unit-test qualification orchestration with fakes on all platforms. On macOS, add an opt-in local command or test path that executes only disposable qualification; do not run it automatically in generic CI if CI hosts cannot guarantee launchd user-domain availability.

- [ ] **Step 5: Typecheck the script explicitly**

Because repository `tsconfig.json` includes only `src/**`, run:

```bash
pnpm exec tsc --ignoreConfig --noEmit \
  --target ES2022 \
  --module NodeNext \
  --moduleResolution NodeNext \
  --strict \
  --esModuleInterop \
  --skipLibCheck \
  --types node \
  scripts/devspace-macos-rollout.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git diff --check
git add scripts/devspace-macos-rollout.ts src/macos-launchd-rollout-darwin.ts src/macos-launchd-rollout-darwin.test.ts
git commit -m "feat: add macOS rollout operator utility"
```

---

### Task 8: Write the runbook and operator evidence contract

**Files:**
- Create: `docs/macos-launchd-rollout.md`
- Modify: `src/macos-launchd-rollout.test.ts` only if documentation exposes a missing result/output contract.

**Interfaces:**
- The runbook must use the exact result-code names from Task 1 and exact script syntax from Task 7.

- [ ] **Step 1: Write runbook sections**

Required sections:

```text
Scope and non-goals
Preflight evidence collection
Candidate manifest creation/verification
Mandatory `qualify` gate
How to perform a rollout after explicit authorization
Meaning of ROLLOUT_OK vs COMMITTED
Post-rollout qualification after ROLLOUT_OK
LOCK_BUSY / LOCK_AMBIGUOUS
LIVE_STATE_CAS_MISMATCH
SPLIT_STATE_DETECTED
ROLLBACK_REFUSED_CONCURRENT_DRIFT
ROLLBACK_REFUSED_UNPROVEN_STATE
SWITCH_FAILED_ROLLBACK_OK / FAILED
Canonical committed but service not running
Mac reboot/login did not auto-start DevSpace
Local service recovery vs tunnel/public endpoint recovery
Real reboot canary and REBOOT_RECOVERY=PASS criteria
```

- [ ] **Step 2: Document the post-rollout qualification contract**

After a separately authorized production switch returns `ROLLOUT_OK`, the runbook must require a fresh read of:

```text
canonical plist hash + entrypoint
launchd PID/process generation
strong runtime identity
listener owner PID
/healthz
CONTROLLED_RELOAD=PASS
canonical hash == twice-verified staged candidate hash
```

Tunnel/public connector routing is verified separately and cannot downgrade local rollout evidence. Keep `REBOOT_RECOVERY=UNVERIFIED` until a different, explicitly authorized real Mac restart/login canary proves auto-recovery without a manual `bootstrap`.

- [ ] **Step 3: Make manual recovery CAS-aware**

Every restore instruction must begin by re-reading the current canonical hash/runtime identity. Do not include blanket `cp backup plist`, blind `bootout`, blind `launchctl enable`, or blind process kill instructions.

- [ ] **Step 4: Verify docs against result-code union**

Use a small grep/script check or test fixture that extracts the code literals from the runbook and ensures every documented code exists in `RolloutResultCode`.

- [ ] **Step 5: Commit**

```bash
git diff --check
git add docs/macos-launchd-rollout.md src/macos-launchd-rollout.test.ts
git commit -m "docs: add macOS rollout recovery runbook"
```

---

### Task 9: Full implementation verification and pre-live gate package

**Files:**
- Modify only files required to fix verification failures discovered here. Do not perform a live rollout in this task.

- [ ] **Step 1: Run all focused rollout tests**

```bash
pnpm exec tsx --test --test-concurrency=1 \
  src/macos-launchd-rollout.test.ts \
  src/macos-launchd-rollout-manifest.test.ts \
  src/macos-launchd-rollout-lock.test.ts \
  src/macos-launchd-rollout-darwin.test.ts
```

Expected: PASS with no production-label mutation.

- [ ] **Step 2: Run repository verification**

```bash
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Expected: all PASS.

- [ ] **Step 3: Re-run script-only typecheck**

Run the Task 7 direct `tsc` command. Expected: PASS.

- [ ] **Step 4: Verify product-surface non-exposure**

Check:

```bash
git diff -- package.json src/cli.ts src/server.ts
```

Expected: no rollout registration in `bin`, public CLI, MCP schema, or server tool surface. If one of these files changed for an unrelated necessary reason, review it manually and prove no rollout exposure was added.

- [ ] **Step 5: Run mandatory disposable qualification on the target Mac**

This is allowed because it uses a disposable label/port/path and does not switch production live state:

```bash
pnpm exec tsx scripts/devspace-macos-rollout.ts qualify
```

Record exact:

```text
implementation HEAD
macOS version
qualification label
qualification port
lockf adapter PASS/FAIL
launchd adapter PASS/FAIL
process identity adapter PASS/FAIL
listener adapter PASS/FAIL
filesystem durability adapter PASS/FAIL
cleanup PASS/FAIL
```

If qualification fails, implementation is not live-rollout-ready. Fix the adapter with TDD/qualification evidence; do not weaken the spec.

- [ ] **Step 6: Prepare but do not execute production live preflight**

Read-only evidence may be collected for later authorization:

```text
candidate slot manifest hash
current canonical plist hash
current live strong process identity
current listener owner PID
current /healthz
current disabled override
exact old plist backup hash
external operator ancestry suitability
```

Do not call production `bootout`, `bootstrap`, rename canonical plist, or restart macOS.

- [ ] **Step 7: Final change review**

Use the repository review tool/change card and inspect the exact diff. Confirm implementation matches the accepted spec and this plan, especially:

```text
fixed-file kernel lock
no stale rename/delete
P2 result-code mapping
whole-plist CAS
every consequential bootout ownership proof
stop barriers
double candidate verification
PRE_COMMIT_REVALIDATED
single COMMITTED rename
ROLLBACK_PRE_RESTORE_REVALIDATED
mandatory qualification
no production live mutation in tests
```

- [ ] **Step 8: Commit verification-only fixes, if any**

If verification required code/doc fixes, commit them with a specific message after rerunning the failed checks. If no files changed, do not create an empty commit.

## Implementation Completion Gate

Implementation work may be called complete only when:

```text
FOCUSED_TESTS                    = PASS
FULL_TEST_SUITE                  = PASS
TYPECHECK                        = PASS
BUILD                            = PASS
SCRIPT_TYPECHECK                 = PASS
DIFF_CHECK                       = PASS
DISPOSABLE_MACOS_QUALIFICATION   = PASS
PUBLIC_CLI_EXPOSURE              = NONE
MCP_EXPOSURE                     = NONE
PRODUCTION_LIVE_MUTATION         = NONE
LIVE_ROLLOUT_AUTHORIZED          = NO   # until a later explicit user decision
REBOOT_RECOVERY                  = UNVERIFIED
```

The next phase after this gate is an independent implementation review. A successful implementation review may make the helper eligible for a separately authorized production rollout; it must not perform that rollout automatically.
