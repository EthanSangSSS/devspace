# Agy Runtime Policy & Versioning Design

Date: 2026-09-17
Status: Proposed for implementation
Baseline: `main@79c3ed037b2e1e9614a57231ee5767c73c9f1cf8` (`v1.1.0`)

## 1. Goal

Make Declarative Agy Delegation durable across routine Agy and Gemini updates without requiring a ChatGPT Workspace action republish for every runtime/model change.

The stable public MCP contract should describe *what task to delegate* and *what bounded capability profile to use*. Runtime selection remains a DevSpace server-side policy.

The implementation must preserve the current least-privilege guarantees:

- macOS-only Agy V1 execution contract;
- no persistent project writes;
- no hidden executor fallback;
- no model substitution;
- no resume/continue session reuse;
- telemetry disabled before real runs;
- fixed bounded repository/GUI capabilities;
- exact resolved-model verification after every real run.

## 2. Problem in v1.1.0

The current code has asymmetric upgrade behavior:

1. `agyPath` points at the locally installed Agy executable and `get_agy_runtime` reports its version and SHA-256, but the runtime is not pinned to version `1.1.22` or to a binary digest.
2. A delegated run disables Agy auto-update and probes required CLI flags, so a manually updated compatible Agy binary can already be used without changing the ChatGPT action surface.
3. The Gemini model is hard-coded as `gemini-3.8-flash-high` in runtime code, stream verification, MCP input literals, MCP output literals, tests, and documentation.
4. Because the model is encoded into the public MCP tool schema, changing the approved Gemini model changes the published action definition and therefore requires a Workspace action refresh/re-publish.

The model name is an implementation policy, not information the ChatGPT caller needs to control. Keeping it in the public input contract creates unnecessary coupling.

## 3. Chosen Approach

### 3.1 Stable public action contract

`delegate_to_agy` will no longer expose `requested_model` or `requested_effort` as input parameters.

The caller will continue to provide only task-scoped capability information:

- `profile`
- `task`
- `dry_run`
- repository scope (`workspaceId`, `expected_source_head`, `allowed_read_paths`, optional validation commands)
- GUI target for `gui-inspect`

The tool output may continue to report policy/runtime evidence, but model/effort fields must be typed as ordinary strings rather than exact schema literals. This keeps the action schema stable across future model-policy changes.

This is a one-time public action schema migration. After the refreshed schema is published, later model changes do not require another Workspace action republish as long as the public fields themselves remain unchanged.

### 3.2 Server-side Agy policy

Extend `agyDelegation` in `config.jsonc` with server-owned policy:

```jsonc
{
  "agyDelegation": {
    "enabled": true,
    "agyPath": "~/.local/bin/agy",
    "cuaDriverPath": "~/.local/bin/cua-driver",
    "settingsPath": "~/.gemini/antigravity-cli/settings.json",
    "model": "gemini-3.8-flash-high",
    "effort": "high",
    "compatibleVersions": ">=1.1.22 <1.2.0"
  }
}
```

Defaults preserve the current qualified runtime:

- `model = gemini-3.8-flash-high`
- `effort = high`
- `compatibleVersions = >=1.1.22 <1.2.0`

`model` is configurable because provider model identifiers evolve independently of DevSpace.

`effort` is server-side policy as well. V1 continues to default to `high`; moving it out of the public input contract prevents callers from changing it.

`compatibleVersions` is an owner-controlled SemVer range. It is not a replacement for capability probes; both the range and capability checks must pass.

These three policy strings are owner-authored values and are not normalized by the config loader: leading/trailing whitespace is preserved exactly, while empty or whitespace-only values are rejected. Runtime qualification may later reject a preserved value as semantically invalid, but configuration loading must not silently rewrite it.

### 3.3 Agy version compatibility gate

`inspectAgyRuntime` will classify the configured executable using all of the following:

1. executable exists, is executable, is a regular user-owned file;
2. `agy --version` returns a parseable semantic version;
3. version satisfies `agyDelegation.compatibleVersions`;
4. required CLI flags still exist;
5. real-run preflight requirements remain enforceable.

An out-of-range or unparseable version fails closed with a typed Agy failure rather than silently continuing.

Proposed failure class:

```text
AGY_VERSION_UNQUALIFIED
```

Routine patch update behavior becomes:

```text
1.1.22 -> 1.1.23
  version range passes
  capability probes pass
  canary passes
  => use the updated binary without a DevSpace code release or Workspace republish
```

An update outside the configured range becomes:

```text
1.1.x -> 1.2.x
  version range fails
  => fail closed
  => qualify the new runtime
  => widen compatibleVersions if the CLI contract is still compatible
     OR update the adapter if the CLI contract changed
```

No automatic Agy binary updater is introduced. The existing delegated-run auto-update disables remain in place.

### 3.4 Model policy and telemetry

Every real run will build Agy arguments from server-side config:

```text
--model <agyDelegation.model>
--effort <agyDelegation.effort>
```

The argument verifier will compare against the active server policy, not compile-time constants.

The stream parser must still require exactly one `init` event and exactly one terminal `result` event. The `init.model` telemetry must exactly equal the configured model. Any different resolved model fails closed as `MODEL_MISMATCH`.

This preserves the current no-substitution rule while allowing the approved model to change through local policy rather than through a new public action schema.

Model update behavior becomes:

```text
edit config.jsonc model
  -> restart/reload DevSpace as required
  -> get_agy_runtime
  -> dry-run
  -> real repo-read canary
  -> resolved model must exactly match configured model
```

No automatic "latest Gemini" adoption is allowed. New provider models must be explicitly selected by the owner and qualified before use.

## 4. Migration and Backward Compatibility

This change intentionally modifies the public action schema once.

Deployment order:

1. Ship a DevSpace server version whose internal policy is config-driven and whose MCP schema no longer advertises model/effort input controls.
2. Verify the server safely ignores legacy extra fields from the currently published action payload, or otherwise provide a narrowly scoped migration compatibility path that does not let those fields influence runtime policy.
3. Deploy the new server slot and qualify runtime/dry-run/real repo-read.
4. Refresh/re-publish `DevSpace Candidate` once so the Workspace action definition drops the two input fields and changes model/effort output types from literals to strings.
5. Re-run Candidate Gate 0/1/2 against the refreshed action definition.

After step 4, changing `agyDelegation.model`, `agyDelegation.effort`, or an already-compatible Agy patch version does not require another Workspace republish.

The compatibility requirement is strict:

- legacy fields, if accepted during migration, are ignored as control inputs;
- they must never override server config;
- mismatched legacy values must not cause model substitution;
- the runtime evidence returned by DevSpace remains authoritative.

## 5. Alternatives Considered

### A. Keep exact compile-time model constants

Rejected. It keeps strong safety but couples every provider model rename/update to a DevSpace code change and Workspace schema refresh.

### B. Auto-select the latest model exposed by Agy

Rejected. "Latest" is not a stable security or behavior contract. It would silently change execution semantics and violate the current no-model-substitution principle.

### C. Exact-pin Agy version or executable SHA-256

Rejected as the default compatibility mechanism. It is too brittle for routine patch releases. DevSpace will continue to report the executable SHA-256 for audit evidence, but compatibility is determined by a bounded SemVer range plus capability probes and runtime canaries.

## 6. Files and Components Expected to Change

Implementation is expected to remain localized to the existing Agy/config surface:

- `src/config-schema.ts`
- generated `schema/v1/devspace.schema.json`
- `src/config.ts`
- `src/agy-delegation-types.ts`
- `src/agy-runtime.ts`
- `src/agy-runner.ts`
- `src/agy-delegation.ts`
- `src/server.ts`
- corresponding Agy/config/server tests
- `docs/configuration.md`
- `docs/security.md` if runtime-version policy needs an explicit security note

No new subsystem is introduced.

## 7. Test Contract

Implementation must be test-driven and cover at least:

1. `delegate_to_agy` public input schema no longer contains `requested_model` or `requested_effort`.
2. Runtime output schemas expose model/effort evidence as strings, not fixed model literals.
3. Config defaults reproduce the current model/effort/version range.
4. A configured model is passed exactly once to `--model` and returned `init.model` must match it exactly.
5. A configured effort is passed exactly once to `--effort` and cannot be supplied by the caller.
6. Compatible Agy version + required flags => runtime available.
7. Out-of-range Agy version => typed `AGY_VERSION_UNQUALIFIED` fail-closed result.
8. Malformed/unparseable Agy version => fail closed.
9. Missing required CLI flag continues to fail closed independently of version-range success.
10. Legacy published payload fields, if present during migration, cannot alter the configured model/effort.
11. Existing stream-interruption retry behavior remains unchanged.
12. macOS Agy execution tests remain macOS-only; core DevSpace CI remains cross-platform.
13. Full Node 22 test suite, typecheck, build, doctor, Gitleaks, and exact-head GitHub CI pass before final rollout is considered complete.

## 8. Rollout Qualification

The runtime rollout remains evidence-first:

1. build an isolated install slot from the exact implementation commit;
2. verify package SHA-256 and CLI version;
3. validate config migration with current model and compatible version range;
4. run `get_agy_runtime` and confirm reported Agy version, SHA-256, policy model, policy effort, compatibility range, and required flags;
5. run `repo-read` dry-run;
6. run real `repo-read` canary and verify exact resolved model telemetry;
7. verify source HEAD/status/hash unchanged;
8. atomically switch live slot with rollback;
9. perform the one-time Candidate schema refresh/re-publish;
10. repeat Candidate Gate 0/1/2 after publish;
11. retain at least one known-good rollback slot/config backup until post-publish qualification completes.

## 9. Non-Goals

This change does not:

- add Linux or Windows Agy execution support;
- make ChatGPT choose models or effort;
- auto-upgrade Agy;
- auto-select a provider's newest model;
- add alternate-model fallback;
- relax exact resolved-model verification;
- add arbitrary shell/network/write capabilities;
- change the three existing Agy profiles;
- redesign DevSpace's built-in Subagents system.

## 10. Success Criteria

The design is complete when all of the following are true:

- the public `delegate_to_agy` request schema contains no model/effort selector;
- model and effort are read only from server-side configuration;
- changing the configured Gemini model does not change the public MCP action schema;
- a compatible Agy patch update can be qualified and used without DevSpace code changes or Workspace republish;
- an unqualified Agy version fails closed before delegated execution;
- runtime telemetry still proves the exact resolved model used;
- one final Workspace schema refresh establishes the stable action contract;
- subsequent compatible Agy/model-policy changes require only local qualification, not action re-publication.
