# Agy Runtime Policy & Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Agy model/effort selection behind DevSpace server-side configuration, add a fail-closed Agy SemVer compatibility gate, and establish a stable MCP action schema that does not need republishing for routine compatible Agy/model-policy updates.

**Architecture:** Keep the existing two-tool Agy surface and three bounded profiles. Extend `agyDelegation` config with `model`, `effort`, and `compatibleVersions`; thread that policy through runtime inspection, argument construction, stream verification, and output evidence. Remove model/effort controls from the public `delegate_to_agy` input schema while keeping output evidence as ordinary strings, then perform one final Candidate schema refresh after the exact implementation build is qualified.

**Tech Stack:** TypeScript, Node.js 22, Zod v4, `semver`, MCP SDK, node:test, macOS Seatbelt/CuaDriver/Agy CLI.

**Spec:** `docs/superpowers/specs/2026-09-17-agy-runtime-policy-versioning-design.md`

## Global Constraints

- Agy V1 execution remains supported and qualified only on macOS.
- Default model remains `gemini-3.8-flash-high`.
- Default effort remains `high`.
- Default compatible Agy range is `>=1.1.22 <1.2.0`.
- No automatic Agy update and no automatic provider-model upgrade.
- No model substitution: `init.model` must exactly match configured `agyDelegation.model`.
- No `--continue`, `--conversation`, or `--dangerously-skip-permissions`.
- No persistent project writes, hidden executor fallback, or new shell/network/GUI capability.
- Existing one-time retry for the exact stream-interruption terminal error remains unchanged.
- Public action count remains unchanged; only the `delegate_to_agy` schema is stabilized.

---

### Task 1: Add Server-Side Agy Policy to Versioned Config

**Files:**
- Modify: `src/config-schema.ts`
- Modify: `src/config.ts`
- Modify: `src/config.test.ts`
- Modify: `src/config-schema.test.ts`
- Regenerate: `schema/v1/devspace.schema.json`

**Interfaces:**
- Consumes: existing `agyDelegation` JSONC section.
- Produces: `AgyDelegationConfig.model: string`, `effort: string`, `compatibleVersions: string` with exact defaults from Global Constraints.

- [ ] **Step 1: Write failing config tests**

Add assertions to `src/config.test.ts`:

```ts
assert.deepEqual(defaults.agyDelegation, {
  enabled: false,
  agyPath: resolve(homedir(), ".local", "bin", "agy"),
  cuaDriverPath: resolve(homedir(), ".local", "bin", "cua-driver"),
  settingsPath: resolve(homedir(), ".gemini", "antigravity-cli", "settings.json"),
  model: "gemini-3.8-flash-high",
  effort: "high",
  compatibleVersions: ">=1.1.22 <1.2.0",
});
```

and configure custom values in the existing explicit-config fixture:

```ts
agyDelegation: {
  enabled: true,
  agyPath: "~/bin/agy",
  cuaDriverPath: "~/bin/cua-driver",
  settingsPath: "~/agy-settings.json",
  model: "gemini-next-qualified",
  effort: "high",
  compatibleVersions: ">=1.1.22 <2.0.0",
},
```

Assert those strings survive `loadConfig()` unchanged.

- [ ] **Step 2: Run config tests and verify RED**

Run:

```bash
pnpm exec tsx src/config.test.ts
```

Expected: FAIL because the three fields do not exist yet.

- [ ] **Step 3: Implement config schema and loader**

Extend `agyDelegationConfigSchema`:

```ts
model: z.string().min(1).regex(/\S/).default("gemini-3.8-flash-high"),
effort: z.string().min(1).regex(/\S/).default("high"),
compatibleVersions: z.string().min(1).regex(/\S/).default(">=1.1.22 <1.2.0"),
```

Thread the three stored strings through `loadConfig()` without caller-derived overrides.

- [ ] **Step 4: Regenerate schema and verify GREEN**

Run:

```bash
pnpm schema:config
pnpm exec tsx src/config-schema.test.ts
pnpm exec tsx src/config.test.ts
```

Expected: both PASS and committed JSON Schema includes the three fields/defaults.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/config-schema.ts src/config.ts src/config.test.ts src/config-schema.test.ts schema/v1/devspace.schema.json
git commit -m "feat: configure agy runtime policy"
```

---

### Task 2: Add Agy SemVer Qualification and Config-Driven Runtime Evidence

**Files:**
- Modify: `src/agy-delegation-types.ts`
- Modify: `src/agy-runtime.ts`
- Modify: `src/agy-runtime.test.ts`

**Interfaces:**
- Consumes: `AgyDelegationConfig.model`, `.effort`, `.compatibleVersions`.
- Produces: `inspectAgyRuntime(config)` that fails closed outside the configured SemVer range and reports `requiredModel`, `requiredEffort`, `compatibleVersions` as strings.
- Produces: `verifyAgyCommandArguments(args, policy)` and `parseAgyStream(lines, expectedModel)`.

- [ ] **Step 1: Write failing runtime-policy tests**

Update existing tests to call:

```ts
verifyAgyCommandArguments(valid, {
  model: "gemini-qualified-model",
  effort: "high",
});
```

and:

```ts
const result = parseAgyStream(lines, "gemini-qualified-model");
assert.equal(result.resolvedModel, "gemini-qualified-model");
```

Add macOS runtime fixtures that assert:

```ts
assert.equal(result.compatibleVersions, ">=1.1.22 <1.2.0");
```

and reject `--version` outputs `1.2.0` and `not-semver` with `AGY_VERSION_UNQUALIFIED`. Add one invalid configured range such as `not-a-range` and require the same fail-closed class. Add one fixture whose version is compatible but whose help omits `--sandbox`; it must keep `requiredFlagsSupported=false` so the delegation layer can independently reject missing CLI capabilities.

- [ ] **Step 2: Run focused runtime tests and verify RED**

Run:

```bash
pnpm exec tsx --test src/agy-runtime.test.ts
```

Expected: FAIL because runtime functions still use compile-time constants and no version range gate exists.

- [ ] **Step 3: Implement policy types and SemVer gate**

Replace compile-time model/effort literal typing with config-owned strings:

```ts
export interface AgyDelegationConfig {
  enabled: boolean;
  agyPath: string;
  cuaDriverPath: string;
  settingsPath: string;
  model: string;
  effort: string;
  compatibleVersions: string;
}
```

Add failure class:

```ts
| "AGY_VERSION_UNQUALIFIED"
```

Use `semver.valid`, `semver.validRange`, and `semver.satisfies` against trimmed `agy --version` output. Any unparseable version, invalid range, or out-of-range version throws `AgyDelegationError("AGY_VERSION_UNQUALIFIED", ...)` before a real delegated run.

Change runtime helpers to explicit policy arguments:

```ts
verifyAgyCommandArguments(args, { model: config.model, effort: config.effort });
parseAgyStream(lines, config.model);
```

`inspectAgyRuntime()` returns config model/effort/range as evidence and still independently reports `requiredFlagsSupported`.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
pnpm exec tsx --test src/agy-runtime.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/agy-delegation-types.ts src/agy-runtime.ts src/agy-runtime.test.ts
git commit -m "feat: qualify agy runtime versions"
```

---

### Task 3: Drive Headless Agy Execution from Server Policy

**Files:**
- Modify: `src/agy-runner.ts`
- Modify: `src/agy-runner.test.ts`
- Modify: `src/agy-delegation.ts`
- Modify: `src/agy-delegation.test.ts`

**Interfaces:**
- Consumes: `AgyDelegationConfig` from the service.
- Produces: `runAgyHeadless(input)` where input carries `model` and `effort`; the runner uses them exactly once and verifies stream telemetry against the same model.

- [ ] **Step 1: Write failing runner/delegation tests**

Change the primary runner fixture to use a non-default model such as `gemini-qualified-model` and assert:

```ts
assert.deepEqual(option(args, "--model"), ["--model", "gemini-qualified-model"]);
assert.deepEqual(option(args, "--effort"), ["--effort", "high"]);
assert.equal(result.resolvedModel, "gemini-qualified-model");
```

Pass:

```ts
model: "gemini-qualified-model",
effort: "high",
```

to `runAgyHeadless`. Update delegation fixtures so config includes the three new policy fields and verify a returned different model still becomes `MODEL_MISMATCH`.

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm exec tsx --test src/agy-runner.test.ts src/agy-delegation.test.ts
```

Expected: FAIL because the runner still hard-codes model/effort.

- [ ] **Step 3: Implement config-driven runner**

Extend `AgyHeadlessRunInput`:

```ts
model: string;
effort: string;
```

Construct args with:

```ts
"--model", input.model,
"--effort", input.effort,
```

Verify args and streams against the same input policy. Preserve the exact existing stream-interruption retry condition and two-attempt ceiling.

Thread `this.options.config.model` and `.effort` from both repository and GUI delegation paths.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
pnpm exec tsx --test src/agy-runner.test.ts src/agy-delegation.test.ts
```

Expected: PASS including retry/no-retry regression tests.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/agy-runner.ts src/agy-runner.test.ts src/agy-delegation.ts src/agy-delegation.test.ts
git commit -m "feat: apply server agy execution policy"
```

---

### Task 4: Stabilize the Public MCP Action Schema

**Files:**
- Modify: `src/server.ts`
- Modify: `src/server.test.ts`

**Interfaces:**
- Produces: `delegate_to_agy` input schema with no `requested_model` and no `requested_effort`.
- Produces: runtime/delegation output model/effort evidence as `z.string()`.
- Migration behavior: legacy extra input fields cannot influence runtime policy; the currently published old schema may continue sending them during rollout, but server policy remains authoritative.

- [ ] **Step 1: Write failing MCP schema tests**

Replace fixed-policy assertions with:

```ts
assert.equal("requested_model" in (input.properties ?? {}), false);
assert.equal("requested_effort" in (input.properties ?? {}), false);
```

Inspect output schema properties and assert model/effort fields have string schemas rather than `const` values.

Change the dry-run call to omit model/effort. Add one migration test that calls the tool with legacy extra fields containing deliberately wrong values and verifies the service receives the same request shape as a call without those fields and policy evidence still comes from the fake service config.

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm exec tsx --test src/server.test.ts
```

Expected: FAIL because the two input literals still exist.

- [ ] **Step 3: Implement stable MCP schema**

Remove the two fields from `delegate_to_agy.inputSchema`. Change runtime/delegation output schemas from model/effort literals to `z.string()`.

Keep response field names (`requested_model`, `resolved_model`, `requested_effort`) as audit evidence for compatibility, but source them only from the service envelope/runtime inspection.

Do not read or branch on legacy input model/effort fields. MCP/Zod handling must either ignore old extras or accept them only as non-authoritative migration extras; they must never reach `AgyDelegationRequest` or override config.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
pnpm exec tsx --test src/server.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat: stabilize agy mcp policy schema"
```

---

### Task 5: Documentation, Exact-Head Qualification, and Rollout Preparation

**Files:**
- Modify: `docs/configuration.md`
- Modify: `docs/security.md`
- Modify as needed for test fixtures only: Agy/config/server tests touched above

**Interfaces:**
- Documents the stable public contract and local-only future update workflow.
- Produces no new runtime capability.

- [ ] **Step 1: Update docs to match implemented policy**

Document the config block:

```jsonc
"agyDelegation": {
  "enabled": true,
  "agyPath": "~/.local/bin/agy",
  "cuaDriverPath": "~/.local/bin/cua-driver",
  "settingsPath": "~/.gemini/antigravity-cli/settings.json",
  "model": "gemini-3.8-flash-high",
  "effort": "high",
  "compatibleVersions": ">=1.1.22 <1.2.0"
}
```

State explicitly that compatible Agy patch updates and later owner-qualified model-policy changes do not require a Workspace action republish after the one-time stable-schema refresh.

- [ ] **Step 2: Run focused Agy/config/server tests**

Run on Node 22:

```bash
pnpm exec tsx --test src/agy-runtime.test.ts src/agy-runner.test.ts src/agy-delegation.test.ts src/server.test.ts
pnpm exec tsx src/config-schema.test.ts
pnpm exec tsx src/config.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run full verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
node dist/cli.js doctor
git diff --check
```

Expected: all PASS. Existing known daemon flake, if it reappears, must be compared against baseline rather than silently ignored.

- [ ] **Step 4: Commit docs/qualification state**

```bash
git add docs/configuration.md docs/security.md
git commit -m "docs: explain agy runtime policy upgrades"
```

- [ ] **Step 5: Package and qualify exact implementation locally before any live switch**

Build an isolated install slot from the exact HEAD. Verify package SHA-256, CLI version, config parsing, `get_agy_runtime`, dry-run, and a real `repo-read` canary. Confirm source HEAD/status/content hashes are unchanged.

- [ ] **Step 6: Live rollout and one-time Candidate schema refresh**

Only after exact-head qualification: atomically switch live with rollback, refresh/re-publish the Candidate action schema once, then repeat Gate 0/1/2. Retain the previous known-good slot/config backup through post-publish qualification.

- [ ] **Step 7: Remote verification**

After authorized push, require exact-head GitHub Ubuntu/macOS/Windows Smoke and Gitleaks to complete successfully before final completion is claimed.
