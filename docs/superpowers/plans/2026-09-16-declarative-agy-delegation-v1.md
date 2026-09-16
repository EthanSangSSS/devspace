# Declarative Agy Delegation V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in DevSpace MCP surface for auditable, fail-closed Agy delegation with `get_agy_runtime` and `delegate_to_agy`, supporting `repo-read`, `repo-validate`, and `gui-inspect` without exposing arbitrary shell, persistent repository writes, unrestricted CuaDriver access, or hidden executor fallback.

**Architecture:** Keep ChatGPT/Web as the controller. DevSpace owns policy, exact runtime identity, snapshot/export, Agy process construction, model/effort verification, validation isolation, GUI observation filtering, typed failures, and execution evidence. Agy runs only behind a feature gate and only against disposable or brokered inputs; `repo-*` uses committed-HEAD snapshots and `gui-inspect` uses a DevSpace-owned semantic CuaDriver broker rather than giving Agy the CuaDriver executable.

**Tech Stack:** TypeScript, Node 24, MCP TypeScript SDK, Zod v4, Git CLI, macOS `sandbox-exec` for validation isolation, Gitleaks, Agy CLI 1.1.22, CuaDriver CLI 0.23.2.

**Spec:** `EthanSangSSS/agent-lab@eccbe369c36434b7426174d0ceab308d885ea7cb:docs/superpowers/specs/2026-09-15-devspace-declarative-agy-delegation-v1-design.md`

## Global Constraints

- Implementation repository is `EthanSangSSS/devspace` from exact base `fe712e2b6c07231d2a76503bf2a674b165850616` (`v1.0.8`), not fork `main`.
- No new npm dependency unless a later blocker proves it necessary.
- Feature is disabled by default and does not enable DevSpace built-in subagents.
- Required Agy model is exactly `gemini-3.8-flash-high`; required effort is exactly `high`.
- Every real Agy run uses `--output-format stream-json`; exact `init.model` is mandatory evidence.
- No `--continue`, `--conversation`, or `--dangerously-skip-permissions` in V1.
- Current host `enableTelemetry=false` may be consumed as preflight evidence, but implementation must never mutate persistent Agy settings.
- `expected_source_head` is required for `repo-read` and `repo-validate`; mismatch fails before export or worker start.
- Persistent repo writes, Git writes, remote writes, auth mutation, external-state actions, arbitrary task network, arbitrary shell, and unrestricted CuaDriver access remain denied.
- `delegate_to_agy` never falls back internally to Codex or another model/provider.
- Agent narrative output is claims only; execution envelope and independent Web verification remain authoritative.
- Platform compatibility is empirical. Tool registration, tool-call acceptance, request arrival, policy preflight, and worker start are separate stages.
- Known baseline caveat before feature changes: `npm run typecheck` passes; tests excluding `src/local-agent-daemon.test.ts` pass; that one baseline test currently fails on this macOS/Node 24 host first with a too-long Unix socket path under the default temp directory and then with an existing EPIPE race under `TMPDIR=/tmp`. Do not mix an unrelated daemon-test repair into this feature.

---

### Task 1: Add the opt-in configuration and core delegation contracts

**Files:**
- Create: `src/agy-delegation-types.ts`
- Modify: `src/config.ts`
- Modify: `src/config.test.ts`

**Interfaces:**
- Produces `AgyDelegationConfig`, `AgyProfile`, `AgyFailureClass`, `AgyPlatformStages`, `AgyRuntimePolicy`, `AgyExecutionEnvelope`, and constants for the required model/effort.
- Adds `ServerConfig.agyDelegation` with `enabled`, `agyPath`, `cuaDriverPath`, and `settingsPath` values controlled only by server configuration, never by MCP tool input.

- [ ] **Step 1: Write failing config/contract tests**

Add assertions equivalent to:

```ts
const disabled = loadConfig(baseEnv);
assert.equal(disabled.agyDelegation.enabled, false);

const enabled = loadConfig({
  ...baseEnv,
  DEVSPACE_AGY_DELEGATION: "1",
  DEVSPACE_AGY_PATH: "/tmp/agy",
  DEVSPACE_CUA_DRIVER_PATH: "/tmp/cua-driver",
  DEVSPACE_AGY_SETTINGS_PATH: "/tmp/settings.json",
});
assert.deepEqual(enabled.agyDelegation, {
  enabled: true,
  agyPath: "/tmp/agy",
  cuaDriverPath: "/tmp/cua-driver",
  settingsPath: "/tmp/settings.json",
});
```

Test constants/types through a small runtime assertion in a new `agy-delegation-types.test.ts` only if TypeScript typecheck cannot cover the contract.

- [ ] **Step 2: Run the config test and observe RED**

Run:

```bash
npx tsx src/config.test.ts
```

Expected: FAIL because `agyDelegation` does not exist on `ServerConfig`.

- [ ] **Step 3: Implement the minimal configuration and types**

Use server-side defaults:

```ts
export const AGY_REQUIRED_MODEL = "gemini-3.8-flash-high" as const;
export const AGY_REQUIRED_EFFORT = "high" as const;
export type AgyProfile = "repo-read" | "repo-validate" | "gui-inspect";

export interface AgyDelegationConfig {
  enabled: boolean;
  agyPath: string;
  cuaDriverPath: string;
  settingsPath: string;
}
```

Defaults resolve from `homedir()` to:

```text
~/.local/bin/agy
~/.local/bin/cua-driver
~/.gemini/antigravity-cli/settings.json
```

Keep typed failure strings centralized in `agy-delegation-types.ts`, including at minimum:

```text
POLICY_DENIED
AGY_UNAVAILABLE
AGY_START_FAILED
MODEL_MISMATCH
MODEL_UNVERIFIED
EFFORT_MISMATCH
SOURCE_HEAD_MISMATCH
RUNTIME_STATE_POLICY_UNENFORCEABLE
TELEMETRY_POLICY_UNENFORCEABLE
TIMEOUT
EXECUTOR_FAILURE
SCOPE_VIOLATION
VALIDATION_FAILED
NETWORK_POLICY_DENIED
GUI_ACTION_UNCLASSIFIED
GUI_CAPABILITY_DENIED
GUI_SENSITIVE_VIEW_DENIED
EVIDENCE_INCOMPLETE
```

- [ ] **Step 4: Re-run tests and typecheck**

Run:

```bash
npx tsx src/config.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit locally**

```bash
git add src/agy-delegation-types.ts src/config.ts src/config.test.ts
git commit -m "feat: add agy delegation configuration"
```

---

### Task 2: Implement Agy runtime introspection and fail-closed runtime policy preflight

**Files:**
- Create: `src/agy-runtime.ts`
- Create: `src/agy-runtime.test.ts`

**Interfaces:**
- Produces `inspectAgyRuntime(config): Promise<AgyRuntimeInspection>`.
- Produces `preflightAgyRealRun(config, inspection): Promise<AgyRuntimePolicy>`.
- Produces `parseAgyStream(lines): AgyStreamResult` for exact `init.model`/terminal-result verification.

- [ ] **Step 1: Write failing runtime tests with fake executables/settings**

Cover these cases:

```ts
assert.equal(result.requiredFlagsSupported, true);
assert.equal(result.telemetryEnabled, false);
assert.equal(result.taskLocalSessionEnforcement, "available");
assert.equal(result.workerStarted, false);
```

And failures:

```ts
await assert.rejects(() => preflightAgyRealRun(configWithTelemetryTrue, inspection),
  /TELEMETRY_POLICY_UNENFORCEABLE/);
```

Stream parsing tests must include:

```ts
const parsed = parseAgyStream([
  JSON.stringify({ event: "init", init: { model: "gemini-3.8-flash-high" } }),
  JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "ok" } }),
]);
assert.equal(parsed.resolvedModel, "gemini-3.8-flash-high");
```

and missing/mismatched model events.

- [ ] **Step 2: Run the new test and observe RED**

```bash
npx tsx src/agy-runtime.test.ts
```

Expected: FAIL because runtime helpers do not exist.

- [ ] **Step 3: Implement executable identity and help/version probing**

Requirements:

```text
regular executable file
owned by current uid
SHA-256 captured
`--version` captured
`--help` must expose --model, --effort, --output-format, --mode, --sandbox, --print
```

Do not call `agy models` during Gate 0.

- [ ] **Step 4: Implement narrow settings preflight**

Parse `settings.json` internally but return only non-secret policy state. Required rule:

```ts
if (settings.enableTelemetry !== false) {
  throw new AgyDelegationError("TELEMETRY_POLICY_UNENFORCEABLE", ...);
}
```

Do not mutate the file and do not return unrelated settings fields.

V1 session policy is enforced by command construction: no `--continue`, no `--conversation`, one headless print run per execution.

- [ ] **Step 5: Implement stream-json model/effort verification**

Require:

```text
init.model === gemini-3.8-flash-high
constructed argv contains exactly one `--effort high`
terminal result.status === SUCCESS
```

Map absent/malformed model to `MODEL_UNVERIFIED`, mismatch to `MODEL_MISMATCH`, and contradictory reported effort to `EFFORT_MISMATCH` if the CLI later provides one.

- [ ] **Step 6: Re-run runtime tests and typecheck**

```bash
npx tsx src/agy-runtime.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit locally**

```bash
git add src/agy-runtime.ts src/agy-runtime.test.ts
git commit -m "feat: add agy runtime preflight"
```

---

### Task 3: Add repository TOCTOU checks, committed-HEAD export, sensitive-path rejection, and Gitleaks preflight

**Files:**
- Create: `src/agy-repository.ts`
- Create: `src/agy-repository.test.ts`

**Interfaces:**
- Produces `prepareAgyRepositorySnapshot(input): Promise<AgyRepositorySnapshot>`.
- Produces `fingerprintRepository(root): Promise<string>`.
- Produces `verifySourceUnchanged(snapshot): Promise<void>`.

- [ ] **Step 1: Write failing repository-policy tests**

Create a temporary Git repo and assert:

```ts
const snapshot = await prepareAgyRepositorySnapshot({
  repositoryRoot: repo,
  expectedSourceHead: head,
  allowedReadPaths: ["README.md", "src"],
  gitleaksPath: "/opt/homebrew/bin/gitleaks",
});
assert.equal(snapshot.sourceHead, head);
assert.equal(await exists(join(snapshot.root, ".git")), false);
```

Also cover:

```text
HEAD mismatch -> SOURCE_HEAD_MISMATCH
absolute path -> SCOPE_VIOLATION
`..` traversal -> SCOPE_VIOLATION
.git request -> SCOPE_VIOLATION
missing committed path -> SCOPE_VIOLATION
Gitleaks finding -> POLICY_DENIED
```

- [ ] **Step 2: Run repository tests and observe RED**

```bash
npx tsx src/agy-repository.test.ts
```

- [ ] **Step 3: Implement exact HEAD and source fingerprint checks**

Read source identity with Git argv, never shell text:

```text
git rev-parse HEAD
git status --porcelain=v1 -z
```

Fingerprint the exact HEAD plus status bytes. Compare actual HEAD with `expected_source_head` before any export.

- [ ] **Step 4: Implement committed-HEAD scoped export**

Use `git archive` with literal validated paths into a private temp directory, then `/usr/bin/tar` to extract. The exported snapshot must not contain `.git` or unrelated paths.

- [ ] **Step 5: Run Gitleaks against the exported snapshot before any provider call**

Use argv form equivalent to:

```text
gitleaks detect --no-git --source <snapshot> --exit-code 1
```

Do not send provider data when this fails.

- [ ] **Step 6: Verify cleanup and source-unchanged checks**

Ensure disposal removes only the task temp root and never recursively deletes the source repository.

- [ ] **Step 7: Re-run tests and typecheck**

```bash
npx tsx src/agy-repository.test.ts
npm run typecheck
```

- [ ] **Step 8: Commit locally**

```bash
git add src/agy-repository.ts src/agy-repository.test.ts
git commit -m "feat: add bounded agy repository snapshots"
```

---

### Task 4: Implement bounded validation execution for `repo-validate`

**Files:**
- Create: `src/agy-validation.ts`
- Create: `src/agy-validation.test.ts`

**Interfaces:**
- Produces `validateValidationCommand(argv, snapshotRoot): ValidatedCommand`.
- Produces `runValidationCommands(commands, context): Promise<ValidationReceipt[]>`.

- [ ] **Step 1: Write RED tests for command policy**

Required denied examples:

```ts
for (const argv of [
  ["bash", "-c", "npm test"],
  ["sh", "-c", "npm test"],
  ["git", "push"],
  ["gh", "pr", "create"],
  ["curl", "https://example.com"],
  ["python", "-c", "print(1)"],
]) {
  assert.throws(() => validateValidationCommand(argv, root));
}
```

Allow explicit project validators such as `npm test`, `npm run build`, `npm run lint`, `flutter test`, or exact executables resolved inside approved runtime prefixes only when represented as argv.

- [ ] **Step 2: Run test and observe RED**

```bash
npx tsx src/agy-validation.test.ts
```

- [ ] **Step 3: Implement macOS sandbox profile generation**

For V1 macOS validation:

```text
deny network*
allow process-fork
allow process-exec only for resolved command/runtime chain
read snapshot/system runtime
write snapshot-local build outputs, validation HOME, TMPDIR, and evidence only
```

If authoritative `sandbox-exec` is unavailable, return `NETWORK_POLICY_DENIED`; do not silently run unsandboxed.

- [ ] **Step 4: Implement validation receipts**

Each receipt records argv, resolved executable, exit code, duration, bounded stdout/stderr artifact names, and sandboxed=true. Non-zero command exit maps to `VALIDATION_FAILED` while retaining evidence.

- [ ] **Step 5: Re-run tests/typecheck**

```bash
npx tsx src/agy-validation.test.ts
npm run typecheck
```

- [ ] **Step 6: Commit locally**

```bash
git add src/agy-validation.ts src/agy-validation.test.ts
git commit -m "feat: sandbox agy validation commands"
```

---

### Task 5: Implement the Agy process runner and `repo-read` / `repo-validate` service

**Files:**
- Create: `src/agy-runner.ts`
- Create: `src/agy-runner.test.ts`
- Create: `src/agy-delegation.ts`
- Create: `src/agy-delegation.test.ts`

**Interfaces:**
- Produces `runAgyHeadless(input): Promise<AgyRunResult>`.
- Produces `AgyDelegationService.inspectRuntime()` and `AgyDelegationService.delegate(request)`.
- Consumes Tasks 1-4 runtime, repository, and validation contracts.

- [ ] **Step 1: Write RED tests around argv and no-fallback behavior**

The fake process runner must observe argv exactly containing:

```text
--print <prompt>
--model gemini-3.8-flash-high
--effort high
--output-format stream-json
--mode plan
--sandbox
--disable-slash-commands
```

and never containing:

```text
--continue
--conversation
--dangerously-skip-permissions
```

Assert any start/model/evidence failure returns the typed Agy failure without invoking a second executor.

- [ ] **Step 2: Add a task-local Agy hook policy in the disposable snapshot**

Generate `.agents/hooks.json` plus a task-local hook executable that denies every tool except bounded read/search operations for `repo-read` and `repo-validate`. It must hard-deny write tools, terminal commands, browser/web tools, MCP tools, credential access, and non-workspace reads. The hook must live inside disposable task state and must not modify global Antigravity settings.

- [ ] **Step 3: Run runner/delegation tests and observe RED**

```bash
npx tsx src/agy-runner.test.ts
npx tsx src/agy-delegation.test.ts
```

- [ ] **Step 4: Implement `repo-read` execution**

Sequence:

```text
runtime preflight
expected HEAD check
snapshot export
Gitleaks
task-local read-only hook policy
Agy headless start
stream-json model/result verification
source fingerprint re-check
snapshot cleanup
typed envelope return
```

- [ ] **Step 5: Implement `repo-validate` execution**

Run declared validation commands in the disposable snapshot under Task 4 isolation, capture receipts/output, append only bounded validation evidence to the Agy prompt, then run Agy in the same read-only agent policy to analyze the evidence. Agy itself does not gain arbitrary shell authority.

- [ ] **Step 6: Re-run tests/typecheck**

```bash
npx tsx src/agy-runner.test.ts
npx tsx src/agy-delegation.test.ts
npm run typecheck
```

- [ ] **Step 7: Commit locally**

```bash
git add src/agy-runner.ts src/agy-runner.test.ts src/agy-delegation.ts src/agy-delegation.test.ts
git commit -m "feat: add fail-closed agy repository delegation"
```

---

### Task 6: Implement the `gui-inspect` CuaDriver data/action broker

**Files:**
- Create: `src/agy-gui.ts`
- Create: `src/agy-gui.test.ts`
- Modify: `src/agy-delegation.ts`
- Modify: `src/agy-delegation.test.ts`

**Interfaces:**
- Produces `CuaDriverClient` with only the exact broker calls V1 needs.
- Produces `sanitizeGuiSnapshot(snapshot, policy): SanitizedGuiSnapshot`.
- Produces `classifyGuiIntent(intent, freshSnapshot): BrokeredGuiAction`.
- Adds `gui-inspect` handling to `AgyDelegationService.delegate`.

- [ ] **Step 1: Write RED tests for target ownership and disclosure filtering**

Tests must reject:

```text
PID mismatch
application identity mismatch
window owner PID mismatch
cross-window observation
secure/password fields
credential/auth surfaces
unknown sensitive view
```

Sensitive data must be redacted before any Agy prompt is assembled. Do not test only the final response; assert the fake Agy runner never receives the secret value.

- [ ] **Step 2: Write RED tests for semantic action classification**

Permit only role-supported intents such as:

```text
open_transient_menu
close_transient_menu
select_existing_tab
toggle_disclosure
scroll_within_approved_target
```

Reject stale indices, raw pixel coordinates, generic clicks, text entry, submit/save/send/delete/install/purchase/upload/download/settings/auth actions, and ambiguous roles with `GUI_ACTION_UNCLASSIFIED` or `GUI_CAPABILITY_DENIED`.

- [ ] **Step 3: Implement the minimal CuaDriver CLI adapter**

Use absolute configured path and JSON argv. Required calls are limited to:

```text
list_windows
get_window_state(include_screenshot=false)
click by fresh element_index/window_id for positively classified semantic roles
press_key Escape only to close a currently observed transient menu
scroll only for the approved target window
```

Do not expose the executable or generic tool name to Agy.

- [ ] **Step 4: Implement the Agy/broker loop**

Agy receives only sanitized AX observation text and a JSON response schema. It returns either a final answer or one semantic intent. DevSpace re-snapshots before every intent, reclassifies it, executes the brokered action, snapshots again, and repeats up to a small fixed action ceiling (4). No screenshot is sent to Agy in V1; local screenshot capture is therefore unnecessary for the initial activation path.

- [ ] **Step 5: Re-run GUI/delegation tests and typecheck**

```bash
npx tsx src/agy-gui.test.ts
npx tsx src/agy-delegation.test.ts
npm run typecheck
```

- [ ] **Step 6: Commit locally**

```bash
git add src/agy-gui.ts src/agy-gui.test.ts src/agy-delegation.ts src/agy-delegation.test.ts
git commit -m "feat: add bounded agy gui inspection broker"
```

---

### Task 7: Register the MCP tools with honest schemas, annotations, and stage telemetry

**Files:**
- Modify: `src/server.ts`
- Modify: `src/server.test.ts`
- Modify: `package.json`

**Interfaces:**
- Adds `get_agy_runtime` and `delegate_to_agy` only when `config.agyDelegation.enabled === true`.
- Consumes one `AgyDelegationService` instance owned by the MCP server.

- [ ] **Step 1: Write RED server tests**

Verify disabled default:

```ts
const names = (await client.listTools()).tools.map((tool) => tool.name);
assert.equal(names.includes("get_agy_runtime"), false);
assert.equal(names.includes("delegate_to_agy"), false);
```

With feature enabled, assert both appear and schemas restrict:

```text
profile enum = repo-read | repo-validate | gui-inspect
requested_model literal = gemini-3.8-flash-high
requested_effort literal = high
expected_source_head required by runtime validation for repo-* profiles
```

Dry-run test must prove fake runner start count remains zero.

- [ ] **Step 2: Run server tests and observe RED**

```bash
npx tsx src/server.test.ts
```

- [ ] **Step 3: Register `get_agy_runtime`**

Use annotations:

```ts
{
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
```

Description must state that it inspects Agy without starting an agent.

- [ ] **Step 4: Register `delegate_to_agy`**

Use conservative annotations:

```ts
{
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
}
```

Description must explicitly say it starts one bounded local Agy task and may contact the model provider. Do not euphemize or hide Agy.

Every result includes stage booleans independently:

```text
tool_surface_registered
tool_call_accepted
request_reached_devspace
policy_preflight_passed
worker_started
```

- [ ] **Step 5: Add all new focused tests to the npm test chain**

Insert the new `tsx src/agy-*.test.ts` files before the broader server tests so CI exercises the feature without a separate hidden command.

- [ ] **Step 6: Re-run focused tests and typecheck**

```bash
npx tsx src/server.test.ts
npm run typecheck
```

- [ ] **Step 7: Commit locally**

```bash
git add src/server.ts src/server.test.ts package.json
git commit -m "feat: expose declarative agy delegation tools"
```

---

### Task 8: Document the feature gate and security/runtime contract

**Files:**
- Modify: `docs/configuration.md`
- Modify: `docs/security.md`

**Interfaces:**
- Documents server-only feature-gate/configuration values and the exact fail-closed boundaries users/operators need to understand.

- [ ] **Step 1: Add configuration documentation**

Document:

```text
DEVSPACE_AGY_DELEGATION=1
DEVSPACE_AGY_PATH
DEVSPACE_CUA_DRIVER_PATH
DEVSPACE_AGY_SETTINGS_PATH
```

State that the feature is disabled by default, fixed to the required model/effort in V1, and does not enable DevSpace built-in subagents.

- [ ] **Step 2: Add security documentation**

Document the four state categories, trusted cached-auth boundary, telemetry=false preflight, task-local/no-resume rule, committed-HEAD snapshot, expected-source-head TOCTOU gate, validation network denial, and GUI data/action broker.

- [ ] **Step 3: Run doc-sensitive build/typecheck**

```bash
npm run typecheck
npm run build
git diff --check
```

- [ ] **Step 4: Commit locally**

```bash
git add docs/configuration.md docs/security.md
git commit -m "docs: document declarative agy delegation"
```

---

### Task 9: Local candidate verification, package smoke, and compatibility gates

**Files:**
- No new production source files unless verification exposes a feature-local defect.

**Interfaces:**
- Produces evidence for local correctness and then the actual platform Gate 0/1/2 result.

- [ ] **Step 1: Run all focused feature tests**

```bash
npx tsx src/agy-runtime.test.ts
npx tsx src/agy-repository.test.ts
npx tsx src/agy-validation.test.ts
npx tsx src/agy-runner.test.ts
npx tsx src/agy-gui.test.ts
npx tsx src/agy-delegation.test.ts
npx tsx src/server.test.ts
```

- [ ] **Step 2: Run typecheck and build**

```bash
npm run typecheck
npm run build
```

- [ ] **Step 3: Run the baseline suite excluding the pre-existing daemon-test defect**

```bash
for f in src/*.test.ts src/ui/*.test.ts; do
  case "$f" in src/local-agent-daemon.test.ts) continue;; esac
  npx tsx "$f" || exit 1
done
```

Expected: PASS. Separately rerun `src/local-agent-daemon.test.ts` and record its baseline result without changing it unless the feature altered that path.

- [ ] **Step 4: Inspect final diff and exact Git identity**

```bash
git diff --check
git status --short
git log --oneline --decorate -10
git merge-base HEAD fe712e2b6c07231d2a76503bf2a674b165850616
```

The merge base must remain the exact v1.0.8 commit.

- [ ] **Step 5: Build a stable local candidate package without modifying the live service**

Use `npm pack` from the verified worktree and install it into a new versioned local prefix. Do not overwrite `/Users/ethan/.local/opt/devspace-1.0.8`.

- [ ] **Step 6: Before live rollout, create a hash-bound backup of the current launchd plist and record the current live package path/PID/health**

The rollout script must have a rollback path that restores the prior `ProgramArguments` and reloads launchd if candidate health fails.

- [ ] **Step 7: Activate the candidate behind `DEVSPACE_AGY_DELEGATION=1` and verify local health before platform calls**

Required local evidence:

```text
DevSpace process running from candidate prefix
127.0.0.1:7676 LISTEN
/healthz = 200 / ok
ngrok target unchanged
OAuth/auth files unchanged
```

- [ ] **Step 8: Gate 0 — call `get_agy_runtime` through ChatGPT's real DevSpace connector**

Record separately:

```text
TOOL_SURFACE_REGISTERED
TOOL_CALL_ACCEPTED
REQUEST_REACHED_DEVSPACE
POLICY_PREFLIGHT_PASSED
WORKER_STARTED=false
```

- [ ] **Step 9: Gate 1 — call `delegate_to_agy(... dry_run=true ...)` against a disposable Git fixture**

Require exact `expected_source_head`, no provider request, and `WORKER_STARTED=false`.

- [ ] **Step 10: Gate 2 — run the minimal real `repo-read` canary only if Gates 0 and 1 pass**

Fixture task:

```text
Read the one allowed non-sensitive file and return its first line.
```

Required evidence:

```text
WORKER_STARTED=true
RESOLVED_MODEL=gemini-3.8-flash-high
EFFORT_SELECTION_VERIFIED=true
RUNTIME_TELEMETRY=false
RUNTIME_SESSION_STATE=task-local-no-resume
EXIT_STATUS=0
CHANGED_PERSISTENT_PATHS=0
EXTERNAL_ACTIONS=0
SOURCE_FINGERPRINT_UNCHANGED=true
```

If the ChatGPT platform blocks any gate, stop there and record the last reached stage. Do not rename, wrap, obfuscate, or reroute Agy to force acceptance.

- [ ] **Step 11: Final verification and no implicit remote write**

Do not push, create a PR, mark ready, merge, publish npm, or change GitHub state without a separate explicit authorization. Report the local branch/HEAD, exact verification evidence, platform gate result, and any remaining blocker.
