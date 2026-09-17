# macOS Launchd Transactional Rollout V1 Design

Date: 2026-09-17
Status: Proposed for implementation
Baseline: `main@3666314d0e850b1610a79df847cb000f139129eb` (`v1.1.0`), fresh-read before this spec branch was created

## 1. Goal

Provide a small, macOS-only, operator-side rollout helper for the current DevSpace launchd deployment topology.

The helper is not a general DevSpace deployment system. It has one responsibility:

> Given an exact expected live state and an already-built candidate slot, switch the current user LaunchAgent from the expected live slot to the candidate, verify that the new process is really the candidate, and recover the exact prior state when a safe rollback is still possible.

The design must also preserve DevSpace service persistence across normal Mac restarts. The durable contract is:

- the canonical user LaunchAgent plist always represents the last committed live definition;
- `RunAtLoad=true` and `KeepAlive=true` remain mandatory;
- after macOS restarts and the user logs in, launchd must be able to start the last committed DevSpace slot without a manual `bootstrap`;
- an uncommitted candidate must never replace the canonical plist merely because it was being tested;
- a helper crash before commit may leave the current login session in a split state, but the canonical on-disk definition remains the known-good restart target.

This does **not** claim pre-login availability. A `~/Library/LaunchAgents` service belongs to the per-user `gui/<uid>` domain and becomes available when that user session is established after reboot. Pre-login service availability would require a system LaunchDaemon and is out of scope.

## 2. Problem

The current DevSpace runtime is managed by:

```text
plist:  ~/Library/LaunchAgents/com.ethan.devspace.plist
label:  com.ethan.devspace
domain: gui/<uid>
port:   127.0.0.1:7676
```

The observed live plist currently has:

```text
RunAtLoad = true
KeepAlive = true
ProgramArguments =
  /opt/homebrew/opt/node@24/bin/node
  /Users/ethan/.local/opt/devspace-1.1.0-main-3666314/node_modules/@waishnav/devspace/dist/cli.js
  serve
```

Those persistence flags are desirable, but they make ad-hoc rollout dangerous:

1. modifying the plist does not update the already-loaded launchd job;
2. `kickstart` restarts the loaded definition and does not substitute for reloading a changed plist;
3. `KeepAlive=true` can immediately resurrect the currently loaded version after a process kill;
4. using DevSpace itself to mutate and restart the live DevSpace LaunchAgent can destroy the MCP transport that is executing the deployment;
5. two concurrent sessions can otherwise race to overwrite the same launchd definition;
6. a PID alone is not sufficient identity because of PID reuse;
7. a healthy listener is not sufficient identity because the wrong process can own the port;
8. an unverified candidate written into the canonical LaunchAgents path can survive a helper crash and become the version started after the next reboot.

V1 must remove these failure modes without adding a permanent supervisor or a general deployment framework.

## 3. Scope

### 3.1 In scope

V1 supports exactly the current macOS per-user launchd topology:

- service label `com.ethan.devspace`;
- launchd domain `gui/<uid>`;
- canonical plist `~/Library/LaunchAgents/com.ethan.devspace.plist`;
- Node-based `ProgramArguments` ending in the DevSpace CLI entrypoint and `serve`;
- loopback listener `127.0.0.1:7676`;
- liveness endpoint `http://127.0.0.1:7676/healthz`;
- immutable/versioned DevSpace install slots under the user's local install prefix;
- a one-shot operator-side helper executed outside the live DevSpace process tree.

The helper may be present in the npm package as a repository utility. The requirement is that it is **not** exposed as:

- an MCP tool;
- a registered `devspace` CLI command;
- an automatically invoked updater.

### 3.2 Out of scope

V1 does not:

- build or install a candidate package;
- create versioned slots;
- manage npm publishing;
- manage ngrok, Tailscale, Cloudflare Tunnel, or another public tunnel;
- preserve in-memory MCP transport, workspace, or process-session state across a DevSpace restart;
- provide zero-downtime deployment;
- provide pre-login macOS availability;
- add a permanent deployment daemon or supervisor;
- add Linux or Windows deployment support;
- expose rollout through MCP;
- add cryptographic authorization that prevents a same-user shell from running the helper;
- make generic shell execution a security boundary;
- migrate MCP to a stateless protocol;
- modify DevSpace application configuration, OAuth state, credentials, or Keychain state.

## 4. Chosen Architecture

### 4.1 Operator-side one-shot helper

The helper runs as an ordinary short-lived local process, independent of the live DevSpace process lifecycle.

It may live in the repository as:

```text
src/macos-launchd-rollout.ts
src/macos-launchd-rollout.test.ts
scripts/devspace-macos-rollout.ts
docs/macos-launchd-rollout.md
```

The core state machine and validation logic live in `src/`. The script is a thin argument/presentation wrapper.

No `package.json#bin` entry is added for it, and `src/cli.ts` does not register it as a DevSpace command.

### 4.2 Deferred persistent commit

The canonical plist is **not** replaced before the candidate has been started and verified.

The helper creates a transaction-local candidate plist outside `~/Library/LaunchAgents`, starts the candidate from that staging plist, validates the resulting process, listener, and liveness, and only then atomically publishes that exact candidate definition into the canonical LaunchAgents path.

This ordering is intentional:

```text
canonical disk plist = old known-good
        ↓
stop old loaded job
        ↓
bootstrap candidate from transaction staging plist
        ↓
verify candidate identity + listener ownership + liveness
        ↓
bootout staging-loaded candidate
        ↓
bootstrap the exact same staging candidate plist again
        ↓
re-verify candidate identity + listener ownership + liveness
        ↓
atomic publish those already-reloaded candidate bytes to canonical path
        ↓
COMMITTED
```

Consequences:

- before commit, a helper crash cannot make an unverified candidate the reboot target;
- if the helper dies before canonical publish, the current login session may be split, but the next user-session launch still has the old canonical known-good definition;
- after commit, the canonical plist is byte-identical to the candidate definition that already passed initial runtime verification and a second controlled reload.

This is stronger than replacing the canonical plist first and then attempting rollback.

## 5. Persistent Service Contract

The canonical plist is the durable declaration of the last committed live DevSpace service.

Before every rollout, the helper must validate all of the following:

```text
canonical plist path == ~/Library/LaunchAgents/com.ethan.devspace.plist
Label == com.ethan.devspace
RunAtLoad == true
KeepAlive == true
launchd disabled override for com.ethan.devspace != true
ProgramArguments contains exactly one DevSpace CLI entrypoint
ProgramArguments terminates in the expected `serve` invocation
StandardOutPath and StandardErrorPath are present and preserved
```

The candidate plist must be derived from the exact observed canonical plist and may change only the approved DevSpace entrypoint path for V1. All other keys remain semantically identical.

In particular, rollout must not silently change:

- Node executable path;
- environment variables;
- label;
- log paths;
- `RunAtLoad`;
- `KeepAlive`;
- other launchd policy keys.

If a future rollout needs to change those fields, it is a different change and must not be smuggled through this helper.

### 5.1 Restart recovery claim

Static persistence qualification is satisfied only if the committed canonical plist still has `RunAtLoad=true` and `KeepAlive=true` and points at the committed entrypoint.

It also requires that `com.ethan.devspace` is not persistently disabled in the user launchd domain. The macOS adapter may inspect this through the platform's disabled-service reporting surface, but any parser is version-qualified and fails closed on unknown output. V1 never calls `launchctl disable` or `launchctl enable`; changing persistent enable/disable policy is outside the rollout transaction.

The final user-facing claim must distinguish:

```text
PERSISTENCE_STATIC_CONTRACT = PASS | FAIL
CONTROLLED_RELOAD           = PASS | FAIL | NOT_RUN
REBOOT_RECOVERY             = PASS | UNVERIFIED | FAIL
```

`CONTROLLED_RELOAD=PASS` requires the candidate to have been booted out after its first successful verification, bootstrapped again from the exact same staged plist bytes, and to have passed the strong process-identity, listener-owner, and liveness gates again. Only after this second verification may those exact staged bytes be atomically published to the canonical path. A successful V1 rollout cannot report `ROLLOUT_OK` unless this controlled reload passes.

`REBOOT_RECOVERY=PASS` requires one explicitly authorized real Mac restart followed by evidence that, after the user login session is established:

1. no manual DevSpace `bootstrap` was used;
2. launchd loaded `com.ethan.devspace` in `gui/<uid>`;
3. the new PID matches the committed entrypoint identity;
4. the listener on `127.0.0.1:7676` is owned by that PID;
5. `/healthz` succeeds.

Until that real restart has been observed, the implementation may claim the static/controlled launchd contract but not that reboot recovery was empirically proven.

Tunnel recovery is a separate dependency. This helper does not manage the tunnel and must not claim that public ChatGPT connectivity automatically recovers merely because the local DevSpace process does.

## 6. Required Inputs and Fixed Topology

The helper accepts a deliberately small set of consequential inputs:

```text
expected_live_entrypoint
expected_live_plist_sha256
candidate_entrypoint
candidate_slot_manifest_sha256
```

The following are fixed V1 topology, not caller-selectable general deployment knobs:

```text
label          = com.ethan.devspace
plist path     = ~/Library/LaunchAgents/com.ethan.devspace.plist
launchd domain = gui/<uid>
host           = 127.0.0.1
port           = 7676
health path    = /healthz
```

The helper fails closed if the observed topology differs.

### 6.1 Candidate artifact identity

`candidate_entrypoint` must resolve to a regular file inside the candidate slot.

The caller also supplies a deterministic manifest digest for the immutable candidate slot. The implementation must define one canonical manifest format and verify it before stopping the old service.

The manifest must cover every runtime-relevant file in the prepared slot, not merely the entrypoint JavaScript file. At minimum its identity includes relative path, entry type, and content digest for regular files; symlink identity must be explicit and must not resolve outside the approved candidate slot.

The helper verifies the supplied digest. It does not build the manifest from source code, install dependencies, or decide that a different candidate is equivalent.

## 7. Whole-Plist CAS

The helper uses raw-byte SHA-256 of the canonical plist as a compare-and-swap boundary.

The initial precondition is:

```text
sha256(canonical plist bytes) == expected_live_plist_sha256
AND
observed canonical entrypoint == expected_live_entrypoint
AND
observed loaded runtime identity == expected_live_entrypoint
```

The full plist hash is required because entrypoint-only comparison would miss concurrent changes to environment, port-related settings, logs, persistence flags, or other launchd fields.

Immediately before stopping the old job, the helper fresh-reads:

```text
canonical plist hash
loaded PID/process generation
loaded process identity
```

If any differs from the prechecked values, the helper returns:

```text
LIVE_STATE_CAS_MISMATCH
```

and performs no switch.

## 8. Strong Runtime Process Identity

The phrase "running process matches the slot" has one explicit meaning.

The runtime observation must include:

```text
pid
process_start_identity
executable_realpath
normalized_argv
entrypoint_realpath
```

Requirements:

- PID alone is never sufficient identity;
- the start identity must distinguish a later process that reused the same PID;
- the actual executable realpath is recorded even though it may be the Node binary rather than the DevSpace entrypoint;
- argv is inspected from a macOS-qualified process-introspection adapter and normalized deterministically;
- the exact DevSpace entrypoint realpath is extracted from argv and must match the expected slot;
- a parse failure is an identity failure, not permission to continue.

Implementation may use a Darwin-specific process adapter, but the adapter and parser must be explicitly qualified on supported macOS versions. Human-readable `launchctl print` output is not treated as a stable machine API.

## 9. Single-Writer Lock

Rollout state lives under:

```text
~/.devspace/rollout/
```

The lock owner record contains at least:

```text
schema_version
pid
process_start_identity
transaction_nonce
transaction_id
created_at
```

Lock publication follows the existing DevSpace daemon principles but strengthens ownership beyond PID-only identity:

1. write a complete owner record to a temporary file;
2. atomically publish ownership;
3. if the owner PID is alive and the start identity matches, return `LOCK_BUSY`;
4. if the PID no longer identifies that process generation, atomically rename the stale lock out of the ownership path and retry;
5. if the record is malformed, process identity is unavailable, or ownership is otherwise ambiguous, return `LOCK_AMBIGUOUS` and do not delete it automatically;
6. release removes the lock only if both process identity and `transaction_nonce` still belong to the releasing helper.

A later transaction must never be able to delete an earlier live transaction's lock merely because a PID was reused.

## 10. Self-Hosted Rollout Refusal

Before any mutation, the helper resolves the current live DevSpace PID and its own ancestor process chain.

If the live DevSpace PID is an ancestor of the helper process, return:

```text
SELF_HOSTED_ROLLOUT_REFUSED
```

This is a lifecycle-independence guard, not a security boundary.

It prevents the exact unsafe pattern:

```text
live DevSpace MCP request
  -> exec_command
  -> rollout helper child process
  -> helper restarts ancestor DevSpace
  -> transport executing the rollout disappears
```

It does **not** prove that MCP, another local agent, or another same-user shell can never start the helper. Generic shell authority remains generic shell authority.

## 11. Launchd Adapter Contract

V1 targets exactly:

```text
domain: gui/<uid>
label:  com.ethan.devspace
```

The adapter uses current `bootstrap` / `bootout` service-management semantics.

The implementation must not use `kickstart` as a substitute for reloading a modified plist.

The implementation must not mutate launchd's persistent enable/disable override state.

Candidate start uses the transaction staging plist. The canonical plist remains unchanged until candidate verification succeeds.

When a PID is required, prefer a documented PID-producing interface such as a qualified `launchctl kickstart -p gui/<uid>/<label>` flow if its semantics are verified not to violate the candidate start contract. If the implementation must parse `launchctl print`, that parser is an explicit macOS-version-qualified adapter and fails closed on unknown output. No design claim relies on `launchctl print` text being a stable API.

## 12. Transaction Files

Each transaction has a bounded directory such as:

```text
~/.devspace/rollout/transactions/<transaction_id>/
```

It contains only transaction evidence required for the current switch:

```text
old.plist
old.plist.sha256
candidate.plist
candidate.plist.sha256
candidate-slot.manifest.sha256
```

The old plist backup is copied before the old job is stopped and is immediately hash-verified against `expected_live_plist_sha256`.

The transaction directory is evidence, not an automatic crash-recovery journal. V1 does not automatically replay an interrupted transaction.

Cleanup removes only exact known files/directories owned by the completed transaction. It must not use recursive wildcard deletion over shared rollout state.

## 13. State Machine

The normal state machine is:

```text
LOCKED
  -> PRECHECKED
  -> BACKED_UP
  -> CANDIDATE_STAGED
  -> OLD_STOPPED
  -> CANDIDATE_STARTED
  -> CANDIDATE_VERIFIED
  -> CONTROLLED_RELOAD_VERIFIED
  -> CANONICAL_PUBLISHED
  -> COMMITTED
```

### 13.1 `LOCKED`

- strong single-writer lock acquired;
- self-hosted ancestry check passes.

### 13.2 `PRECHECKED`

- whole-plist CAS matches caller expectation;
- old process identity matches expected entrypoint;
- persistence contract is valid;
- candidate slot manifest matches caller digest;
- candidate entrypoint identity is valid;
- no split state is present.

### 13.3 `BACKED_UP`

- exact canonical plist copied into the transaction directory;
- backup hash equals expected live plist hash.

### 13.4 `CANDIDATE_STAGED`

- candidate plist derived from the exact old canonical definition;
- only the approved entrypoint field changes;
- staged plist passes `plutil` validation;
- candidate staging hash recorded;
- `RunAtLoad=true` and `KeepAlive=true` still hold.

### 13.5 `OLD_STOPPED`

- final pre-stop CAS has been repeated successfully;
- old launchd job is booted out from `gui/<uid>`.

### 13.6 `CANDIDATE_STARTED`

- candidate staging plist is bootstrapped into `gui/<uid>`;
- candidate PID/process generation is resolved.

### 13.7 `CANDIDATE_VERIFIED`

- strong process identity matches `candidate_entrypoint`;
- the listener on `127.0.0.1:7676` is owned by the candidate PID;
- `/healthz` returns the expected liveness response;
- a bounded observation window does not show a rapid restart/crash loop.

`/healthz` is only a liveness gate. It is not proof that the full ChatGPT/MCP path or all DevSpace features are qualified.

### 13.8 `CONTROLLED_RELOAD_VERIFIED`

- the first verified candidate generation is booted out;
- the exact same transaction staging plist is bootstrapped again into `gui/<uid>`;
- a new launchd PID/process generation is resolved;
- strong process identity matches the candidate entrypoint;
- listener owner PID matches the reloaded candidate PID;
- `/healthz` passes;
- the bounded stability observation passes again;
- the staged plist bytes and staged plist hash remain unchanged from the first candidate start.

### 13.9 `CANONICAL_PUBLISHED`

- before publish, canonical disk hash is still the exact old hash;
- the staged candidate plist is atomically renamed/published into the canonical LaunchAgents path;
- the newly published canonical hash equals the staged candidate hash;
- the loaded runtime is still the already-verified candidate process generation or a same-slot KeepAlive replacement that independently passes the full identity/listener/liveness gate.

Successful atomic canonical publish is the durable commit point. `COMMITTED` is the acknowledged terminal state after the post-publish identity/hash checks below. If the helper process disappears after canonical publish but before it can return `ROLLOUT_OK`, V1 does not silently roll back that already-published state on the next invocation; the next operator must reconcile the observed canonical/runtime identity through the normal CAS rules.

### 13.10 `COMMITTED`

- canonical plist and loaded runtime both identify the candidate slot;
- persistence contract remains valid;
- `CONTROLLED_RELOAD=PASS`;
- transaction reports `ROLLOUT_OK`.

## 14. Rollback

### 14.1 Failure before canonical publish

Before `CANONICAL_PUBLISHED`, the canonical plist still contains the exact old known-good definition.

If failure occurs after `OLD_STOPPED`:

```text
stop candidate if it is loaded/running
  -> verify canonical plist still equals expected old hash
  -> bootstrap the unchanged canonical old plist
  -> resolve old PID/process generation
  -> verify old process identity
  -> verify listener owner PID
  -> verify /healthz
```

Success returns:

```text
SWITCH_FAILED_ROLLBACK_OK
```

The helper does not rewrite the canonical plist in this path because it never changed it.

### 14.2 Failure after canonical publish

Automatic rollback after canonical publish is allowed only when:

```text
sha256(current canonical plist) == this transaction's candidate canonical hash
```

If the hash differs, another actor changed the live definition. Return:

```text
ROLLBACK_REFUSED_CONCURRENT_DRIFT
```

and do not overwrite the new state with the old backup.

If rollback CAS succeeds:

```text
bootout candidate if loaded
  -> atomically restore exact hash-verified old backup
  -> bootstrap old definition
  -> resolve old PID/process generation
  -> verify old process identity
  -> verify listener belongs to old PID
  -> verify /healthz
```

Return either:

```text
SWITCH_FAILED_ROLLBACK_OK
SWITCH_FAILED_ROLLBACK_FAILED
```

`SWITCH_FAILED_ROLLBACK_OK` means the rollout failed and the old service was restored. It must never be presented as rollout success.

## 15. Crash and Power-Loss Semantics

V1 is intentionally not a journaled crash-recovery transaction manager.

The guarantee is narrower:

- before canonical publish, the old canonical plist remains the durable restart target;
- after canonical publish, the candidate had already passed runtime verification;
- if the helper disappears mid-transaction, the next helper invocation must detect any mismatch between canonical plist and loaded runtime and fail closed as `SPLIT_STATE_DETECTED`;
- V1 does not silently decide which side of a split state should win;
- the runbook provides explicit recovery procedures.

Examples:

```text
helper dies after OLD_STOPPED
  disk canonical = old
  runtime = stopped
  next login/reboot -> old canonical can start automatically

helper dies after CANDIDATE_STARTED but before commit
  disk canonical = old
  runtime = candidate
  next helper -> SPLIT_STATE_DETECTED
  next login/reboot -> old canonical remains restart target

helper dies after CANONICAL_PUBLISHED
  disk canonical = verified candidate
  runtime = candidate that already passed the controlled reload, or a later KeepAlive generation
  next login/reboot -> candidate is restart target
```

The design therefore improves reboot conservatism without claiming full online crash recovery.

## 16. Split-State Detection

At helper start, these states are considered inconsistent and block mutation:

```text
canonical entrypoint != loaded runtime entrypoint
loaded PID cannot be tied to one process generation
listener owner PID != loaded candidate/old PID
launchd job loaded from an identity that cannot be reconciled with canonical state
```

Return:

```text
SPLIT_STATE_DETECTED
```

The helper reports observed non-secret identity evidence and exits. It does not auto-repair ambiguous state.

A canonical plist hash that is internally coherent but no longer equals the caller-supplied expected hash is not a split-state classification. It returns `LIVE_STATE_CAS_MISMATCH` under the whole-plist CAS contract.

## 17. Result Codes

The operator-visible terminal result is one of:

```text
ROLLOUT_OK
PRECONDITION_FAILED
PERSISTENCE_CONTRACT_INVALID
CANDIDATE_ARTIFACT_MISMATCH
LIVE_STATE_CAS_MISMATCH
SPLIT_STATE_DETECTED
LOCK_BUSY
LOCK_AMBIGUOUS
SELF_HOSTED_ROLLOUT_REFUSED
SWITCH_FAILED_ROLLBACK_OK
SWITCH_FAILED_ROLLBACK_FAILED
ROLLBACK_REFUSED_CONCURRENT_DRIFT
```

Results include bounded evidence such as hashes, PIDs, process generation identities, entrypoint realpaths, listener ownership, and health status. They do not include credentials, OAuth state, Keychain content, tokens, or arbitrary environment values.

## 18. Concurrency Properties

The combination of the strong lock and whole-state CAS is the concurrency boundary.

Example:

```text
transaction A acquires lock
transaction B -> LOCK_BUSY

A commits candidate
A releases lock

B later acquires lock
B expected_live_plist_sha256 still names old state
fresh CAS sees candidate state
-> LIVE_STATE_CAS_MISMATCH
```

The helper never treats lock acquisition alone as proof that the caller's expected live state is still current.

## 19. Listener and Health Verification

Port-open checks are insufficient.

The candidate/rollback verification must prove:

```text
listener address == 127.0.0.1:7676
listener owner PID == resolved launchd service PID
resolved PID process identity == expected slot
health endpoint succeeds
```

If `KeepAlive` creates a replacement PID during the verification window, the helper must re-resolve and re-run strong identity checks for that new process generation. Repeated unexpected PID churn is a candidate failure, not a successful healthy deployment.

## 20. Test Contract

Implementation must be test-driven.

Ordinary unit/integration tests must not modify the real `com.ethan.devspace` LaunchAgent.

The core module uses injected adapters for:

- filesystem reads/writes/atomic publish;
- hashing;
- process observation;
- ancestor inspection;
- launchd operations;
- listener ownership;
- HTTP liveness;
- clock/nonce generation.

Required tests include at least:

1. exact old plist hash + matching old process identity passes precheck;
2. entrypoint match but whole-plist hash mismatch fails CAS;
3. runtime process generation changes after precheck and before stop -> `LIVE_STATE_CAS_MISMATCH`;
4. candidate slot digest mismatch fails before old service stop;
5. lock refuses a live matching owner;
6. stale lock with dead/reused process generation is atomically moved and retried;
7. malformed/ambiguous lock is not auto-deleted;
8. lock release refuses to remove a different nonce;
9. ancestry containing live DevSpace PID -> `SELF_HOSTED_ROLLOUT_REFUSED`;
10. candidate plist changes only the approved entrypoint field;
11. candidate plist preserves `RunAtLoad=true` and `KeepAlive=true`;
12. a persistently disabled launchd override fails the persistence contract and the helper never mutates that override;
13. candidate runtime may not commit until listener owner PID equals candidate PID;
14. `/healthz` success with wrong listener/process identity still fails;
15. candidate failure before canonical publish restarts old service from unchanged canonical plist;
16. rollback after canonical publish requires the transaction's exact candidate plist hash;
17. concurrent drift after publish -> `ROLLBACK_REFUSED_CONCURRENT_DRIFT`;
18. split canonical/runtime identity -> `SPLIT_STATE_DETECTED`;
19. atomic canonical publish failure leaves old canonical bytes intact;
20. candidate is booted out and successfully bootstrapped a second time from the exact same staged plist before canonical publish;
21. controlled reload failure occurs while canonical disk bytes are still the old known-good definition and cannot report success;
22. successful commit atomically publishes the exact already-reloaded staged bytes, preserves persistence flags, and records `CONTROLLED_RELOAD=PASS`;
23. result classification distinguishes rollout success from failed rollout with successful rollback.

Optional local qualification may use a disposable launchd label, never the production label, to validate the macOS launchd adapter on the target OS.

## 21. Implementation Boundaries

Expected implementation files:

```text
src/macos-launchd-rollout.ts
src/macos-launchd-rollout.test.ts
scripts/devspace-macos-rollout.ts
docs/macos-launchd-rollout.md
```

The helper may reuse small generic ideas from the existing local-agent daemon lock implementation, but it must not copy the daemon's PID-only ownership contract. Rollout ownership includes process generation and transaction nonce.

No refactor of the daemon lock is required for this change.

No new MCP schema, MCP handler, server endpoint, application config field, or public CLI command is introduced.

## 22. Qualification Before Any Live Switch

Implementation completion and live authorization are separate gates.

Before the helper can be used against `com.ethan.devspace`:

1. implementation branch exact HEAD is recorded;
2. focused rollout tests pass;
3. full relevant suite, typecheck, and build pass;
4. exact diff is reviewed;
5. candidate package/slot is built separately from an exact reviewed commit;
6. candidate slot manifest hash is recorded;
7. current canonical live plist hash is recorded;
8. current live process identity is recorded;
9. current live listener owner and `/healthz` are recorded;
10. a hash-bound old plist backup exists;
11. if used, the launchd adapter has passed a disposable-label qualification on the target macOS version;
12. an external operator context is chosen whose ancestor chain does not include live DevSpace;
13. the user explicitly authorizes the actual live switch.

No implementation or CI result grants live rollout authority by itself.

## 23. Post-Rollout Qualification

After an explicitly authorized live switch reports `ROLLOUT_OK`:

1. re-read canonical plist hash and entrypoint;
2. re-resolve launchd PID/process generation;
3. confirm listener owner PID;
4. confirm `/healthz`;
5. confirm `CONTROLLED_RELOAD=PASS` and that the canonical plist hash is exactly the hash of the staged bytes that passed the controlled reload;
6. verify public connector routing separately if the tunnel is available;
7. retain the prior known-good slot and hash-bound plist backup through qualification;
8. keep `REBOOT_RECOVERY=UNVERIFIED` until a separately authorized real restart test is performed.

For the real restart test:

```text
restart macOS
  -> establish normal user login session
  -> do not manually bootstrap DevSpace
  -> resolve launchd service
  -> verify committed entrypoint identity
  -> verify listener owner PID
  -> verify /healthz
```

Only then may `REBOOT_RECOVERY=PASS` be reported.

## 24. Runbook Recovery Requirements

The implementation PR must include a runbook for at least:

- `LOCK_AMBIGUOUS` inspection without deleting unknown ownership;
- `SPLIT_STATE_DETECTED` where canonical is old but runtime is candidate;
- candidate start failure with unchanged old canonical plist;
- `ROLLBACK_REFUSED_CONCURRENT_DRIFT`;
- canonical candidate committed but service not running;
- Mac reboot/login where LaunchAgent did not auto-start;
- distinguishing local DevSpace recovery from tunnel/public-endpoint recovery.

Manual recovery must remain CAS-aware. The runbook must never instruct an operator to blindly overwrite a plist whose current hash no longer matches the state being recovered.

## 25. Security and Authority Model

This helper is an operational reliability boundary, not a privilege boundary.

It runs with the user's normal local authority. A same-user process that can edit the canonical plist or invoke `launchctl` can bypass the helper.

Therefore the correct claims are:

- the helper reduces accidental and concurrent rollout corruption;
- it prevents self-restart when it detects the live DevSpace process in its ancestry;
- it verifies exact expected state before consequential mutation;
- it does not make same-user arbitrary shell execution safe or impossible.

## 26. Alternatives Considered

### A. Add `devspace rollout`

Rejected for V1. It would make the current-machine launchd topology part of the DevSpace product CLI surface and makes self-hosted execution easier to trigger accidentally.

### B. Expose rollout as an MCP tool

Rejected. It recreates the same control-plane coupling that caused the observed self-restart failure.

### C. Permanent supervisor

Rejected. A second always-on daemon is excessive for the current requirement.

### D. Replace canonical plist before candidate verification

Rejected. It makes an unverified candidate the persistent reboot target during the riskiest part of the transaction and requires more aggressive rollback after helper crashes.

### E. Move to a system LaunchDaemon

Rejected for V1. It would require root/admin installation and changes the current user-scoped security and lifecycle model. The requirement is recovery after normal user login, not pre-login service availability.

## 27. Success Criteria

The implementation is complete when all of the following are true:

- rollout can only proceed from an exact whole-plist and strong process-identity match;
- candidate artifact identity is verified before old service interruption;
- only one rollout transaction owns the lock at a time;
- lock ownership survives PID reuse ambiguity through process-generation identity and nonce;
- self-hosted descendant execution fails before mutation;
- the old canonical plist remains unchanged until candidate runtime verification succeeds;
- candidate listener ownership is tied to the verified candidate PID;
- health is treated as liveness, not complete functional qualification;
- canonical publish is atomic and becomes the durable last-committed restart definition;
- a rollout cannot publish the canonical plist until the candidate has been bootstrapped and re-verified a second time from the exact staged bytes that will be published;
- rollback after canonical publish is CAS-protected against concurrent drift;
- interrupted transactions are detected as split state rather than silently repaired;
- `RunAtLoad=true` and `KeepAlive=true` remain mandatory in every committed definition;
- the service label is verified not to have a persistent disabled override, and rollout never mutates enable/disable policy;
- ordinary tests never touch the real production LaunchAgent;
- live rollout remains separately authorization-gated;
- reboot recovery is not claimed as empirically PASS until a real authorized Mac restart/login qualification succeeds.

