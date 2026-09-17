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

The canonical plist is **not** replaced before the candidate has been started, stopped cleanly, started again from the same staged definition, and re-verified.

The helper creates a transaction-local candidate plist outside `~/Library/LaunchAgents`, validates the candidate twice through the same launchd lifecycle, performs one final runtime/plist compare-and-swap, and only then publishes the already-qualified candidate bytes into the canonical LaunchAgents path.

This ordering is intentional:

```text
canonical disk plist = old known-good
        ↓
stop old loaded job + verify stopped
        ↓
bootstrap candidate from transaction staging plist
        ↓
verify candidate identity + listener ownership + liveness
        ↓
stop staging-loaded candidate + verify stopped
        ↓
bootstrap the exact same staging candidate plist again
        ↓
re-verify candidate identity + listener ownership + liveness
        ↓
PRE_COMMIT_REVALIDATED
        ↓
same-directory atomic canonical replace
        ↓
COMMITTED
        ↓
post-commit durability finalization + qualification
        ↓
ROLLOUT_OK
```

`COMMITTED` has exactly one meaning in V1: the atomic replacement of the canonical plist has occurred. `ROLLOUT_OK` is a later acknowledgement that durability finalization and post-commit qualification also passed; it is not the transaction commit point.

Consequences:

- before `COMMITTED`, a helper crash cannot make an unverified candidate the canonical reboot target;
- if the helper dies before the canonical replace, the current login session may be split, but the next user-session launch still has the old canonical known-good definition;
- after `COMMITTED`, the canonical plist is byte-identical to the candidate definition that already passed initial runtime verification and a second controlled reload;
- if post-commit qualification fails, recovery is a compensating rollback of an already-committed candidate, not an "uncommitted transaction rollback".

This is stronger than replacing the canonical plist first and then attempting rollback.

## 5. Persistent Service Contract

The canonical plist is the durable declaration of the last committed live DevSpace service.

Before every rollout, the helper must validate all of the following:

```text
canonical plist path == ~/Library/LaunchAgents/com.ethan.devspace.plist
canonical plist parent == ~/Library/LaunchAgents
canonical plist is a non-symlink regular file
canonical plist owner uid == current effective uid
canonical plist is not group- or world-writable
canonical plist gid/mode are captured as part of the expected live file identity
canonical plist parent is a non-symlink directory owned by current effective uid
canonical plist parent is not group- or world-writable
Label == com.ethan.devspace
RunAtLoad == true
KeepAlive == true
launchd disabled override for com.ethan.devspace != true
ProgramArguments contains exactly one DevSpace CLI entrypoint
ProgramArguments terminates in the expected `serve` invocation
StandardOutPath and StandardErrorPath are present and preserved
```

The candidate plist must be derived from the exact observed canonical plist and may change only the approved DevSpace entrypoint path for V1. All other keys remain semantically identical.

The candidate publish temp and any compensating rollback temp must preserve the prechecked canonical plist's uid, gid, and permission mode exactly. V1 does not hard-code the current machine's numeric uid/gid or `0644` mode into portable logic; it records the qualified live file identity and requires the replacement to match it. A helper run must fail closed before service interruption if ownership or mode cannot be observed or safely reproduced.

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

The caller also supplies a deterministic manifest digest for the immutable candidate slot. V1 defines one canonical manifest format so caller and helper compute the same artifact identity.

The manifest covers the entire candidate slot tree, not a helper-selected subset of "runtime-relevant" files. Entries are emitted in canonical lexical relative-path order using POSIX `/` separators. V1 accepts only directories, regular files, and symlinks. Unsupported filesystem entry types fail closed.

Each canonical manifest line is one of:

```text
D<TAB><mode-octal><TAB><relative-path><LF>
F<TAB><mode-octal><TAB><sha256-hex><TAB><relative-path><LF>
L<TAB><symlink-target><TAB><relative-path><LF>
```

V1 rejects manifest paths or symlink targets containing NUL, CR, LF, or TAB so the line encoding is unambiguous. Regular-file digests are SHA-256 of exact file bytes. Mode records include the permission/executable bits used by the prepared slot. Symlink targets are recorded exactly as stored and must resolve within the candidate slot; absolute links or links escaping the slot fail closed.

`candidate_slot_manifest_sha256` is SHA-256 of the exact UTF-8 manifest bytes, including the final LF. The slot root itself is not emitted as a record.

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

### 7.1 Consequential stop ownership invariant

Every consequential `bootout` must fresh-read and prove that the service being stopped still belongs to the transaction's currently expected state.

This applies to:

- the initial old-service stop;
- stopping the first candidate generation before controlled reload;
- any candidate cleanup after a failed pre-commit switch;
- any post-commit compensating rollback.

The proof includes the expected label, strong runtime process identity, and the runtime/plist relationship appropriate to that phase. A same-label process with an unexpected generation or entrypoint is not safe to stop merely because the canonical plist hash still matches.

If ownership cannot be proven, the helper fails closed and does not `bootout` the unknown runtime. During pre-switch CAS this is `LIVE_STATE_CAS_MISMATCH`; during compensating rollback it is `ROLLBACK_REFUSED_CONCURRENT_DRIFT`.

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

`bootout` command success is not equivalent to a verified stopped state. Every stop transition uses a bounded observable barrier after the stop request. The barrier must prove all of the following before another service generation may be bootstrapped:

```text
the transaction's expected process generation is no longer alive
the expected service target is no longer active as that generation
127.0.0.1:7676 is no longer owned by the stopped PID
no incompatible same-label runtime has appeared
```

Before starting the next DevSpace generation, the rollout additionally requires that `127.0.0.1:7676` is not owned by an unrelated process. An unexpected owner is concurrent drift, not a reason to kill that process.

The adapter may use bounded polling around ordinary `bootout`. A potentially unbounded `bootout --wait` is not the sole stop-completion mechanism.

When a PID is required, prefer a documented PID-producing interface such as a qualified `launchctl kickstart -p gui/<uid>/<label>` flow if its semantics are verified not to violate the candidate start contract. If the implementation must parse `launchctl print`, that parser is an explicit macOS-version-qualified adapter and fails closed on unknown output. No design claim relies on `launchctl print` text being a stable API.

Successful deferred publish does not require the currently loaded job's original bootstrap plist path to equal the canonical plist path. A staging-loaded job is reconciled with canonical state by service label, canonical definition/hash, strong runtime process identity, expected entrypoint, and listener ownership. The transaction staging path may be deleted after successful completion; its continued existence is not part of steady-state identity.

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

### 12.1 Canonical publish and durability contract

The helper never renames `candidate.plist` directly from `~/.devspace/rollout/transactions/...` onto the canonical LaunchAgents path.

For canonical publish it creates a hidden temporary file inside the canonical parent directory, for example:

```text
~/Library/LaunchAgents/.com.ethan.devspace.rollout-<transaction_nonce>.tmp
```

The temporary filename intentionally does not end in `.plist`.

The publish protocol is:

```text
copy exact verified candidate.plist bytes to same-directory temp
  -> verify temp is a non-symlink regular file with required ownership/mode
  -> verify temp SHA-256 == staged candidate plist SHA-256
  -> flush temp file through the qualified Darwin filesystem adapter
  -> PRE_COMMIT_REVALIDATED
  -> atomic same-directory rename temp -> canonical plist
  -> COMMITTED
  -> verify canonical hash/file identity
  -> flush/synchronize canonical parent directory using the qualified Darwin durability primitive
  -> POST_COMMIT_VERIFIED
```

The successful same-directory atomic rename is the **single logical transaction commit point**. The helper must not describe any earlier state as committed. After the rename succeeds, the candidate is the committed canonical definition even if the helper crashes before returning `ROLLOUT_OK`.

Before the old service is stopped, the Darwin filesystem adapter must prove that the required same-directory temp creation, regular-file flush, atomic replacement, and parent-directory synchronization operations are available for the canonical LaunchAgents filesystem. A missing or unsupported durability primitive is a precondition failure, not something discovered for the first time after the candidate has been committed.

The file flush before rename and parent-directory synchronization after rename are crash-oriented durability precautions. The implementation must treat an OS-level flush/sync error as a real failure. V1 does **not** claim a strict formal guarantee that arbitrary sudden power loss at every storage-controller/cache boundary preserves the newest bytes. If a stronger Darwin primitive such as `F_FULLFSYNC` is implemented and qualified, it may strengthen the evidence, but V1 correctness claims do not assume it unless that primitive is actually present and tested.

If the helper dies after the atomic rename but before parent-directory synchronization or `ROLLOUT_OK`, the next invocation must reason from the observed canonical hash/runtime identity. It must not reinterpret the candidate as "uncommitted" merely because the previous process never emitted an acknowledgement.

## 13. State Machine

The normal state machine is:

```text
LOCKED
  -> PRECHECKED
  -> BACKED_UP
  -> CANDIDATE_STAGED
  -> OLD_STOP_REQUESTED
  -> OLD_STOPPED_VERIFIED
  -> CANDIDATE_STARTED
  -> CANDIDATE_VERIFIED
  -> CANDIDATE_STOP_REQUESTED
  -> CANDIDATE_STOPPED_VERIFIED
  -> CONTROLLED_RELOAD_STARTED
  -> CONTROLLED_RELOAD_VERIFIED
  -> PRE_COMMIT_REVALIDATED
  -> COMMITTED
  -> POST_COMMIT_VERIFIED
  -> ROLLOUT_OK
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

### 13.5 `OLD_STOP_REQUESTED`

- final pre-stop CAS has been repeated successfully;
- the consequential-stop ownership invariant still identifies the exact expected old process generation;
- `bootout` has been requested for `gui/<uid>/com.ethan.devspace`.

### 13.6 `OLD_STOPPED_VERIFIED`

- the expected old process generation is no longer alive;
- the expected old service generation is no longer active;
- `127.0.0.1:7676` is no longer owned by the stopped PID;
- the port is not owned by an unrelated process;
- the bounded stop barrier completed before candidate bootstrap.

### 13.7 `CANDIDATE_STARTED`

- candidate staging plist is bootstrapped into `gui/<uid>`;
- candidate PID/process generation is resolved.

### 13.8 `CANDIDATE_VERIFIED`

- strong process identity matches `candidate_entrypoint`;
- the listener on `127.0.0.1:7676` is owned by the candidate PID;
- `/healthz` returns the expected liveness response;
- a bounded observation window does not show a rapid restart/crash loop.

`/healthz` is only a liveness gate. It is not proof that the full ChatGPT/MCP path or all DevSpace features are qualified.

### 13.9 `CANDIDATE_STOP_REQUESTED`

- a fresh ownership read proves the loaded service is the exact verified candidate process generation or a same-slot KeepAlive replacement that independently passes strong identity;
- `bootout` is requested only after that ownership proof.

### 13.10 `CANDIDATE_STOPPED_VERIFIED`

- the candidate process generation being stopped is no longer alive;
- the candidate service generation is no longer active;
- `127.0.0.1:7676` is no longer owned by the stopped PID;
- the port is not owned by an unrelated process;
- the bounded stop barrier completed before controlled reload bootstrap.

### 13.11 `CONTROLLED_RELOAD_STARTED`

- the exact same transaction staging plist bytes are bootstrapped again into `gui/<uid>`;
- a new launchd PID/process generation is resolved.

### 13.12 `CONTROLLED_RELOAD_VERIFIED`

- strong process identity matches the candidate entrypoint;
- listener owner PID matches the reloaded candidate PID;
- `/healthz` passes;
- the bounded stability observation passes again;
- the staged plist bytes and staged plist hash remain unchanged from the first candidate start.

### 13.13 `PRE_COMMIT_REVALIDATED`

- canonical disk hash still equals `expected_live_plist_sha256`;
- canonical file identity still satisfies the non-symlink regular-file/ownership/mode contract;
- staged candidate plist hash still equals the previously verified candidate plist hash;
- the loaded runtime is still the controlled-reload candidate process generation, or a same-slot KeepAlive replacement that independently passes strong identity;
- listener owner PID equals that verified candidate PID;
- `/healthz` still passes;
- no incompatible service/runtime generation has appeared;
- the same-directory canonical temporary file has exact candidate bytes and has passed its pre-rename flush/hash checks.

Any failure here returns a pre-commit failure and does not replace the canonical plist.

### 13.14 `COMMITTED`

- the verified same-directory temporary file is atomically renamed over the canonical plist;
- that successful rename is the single logical commit point;
- from this point forward, the candidate is the committed canonical definition even if the helper exits before acknowledgement.

### 13.15 `POST_COMMIT_VERIFIED`

- canonical plist hash equals the staged candidate plist hash;
- canonical file identity still satisfies the recorded uid/gid/mode and non-symlink regular-file contract;
- parent-directory durability synchronization completed through the qualified Darwin filesystem adapter;
- the loaded runtime is still the candidate slot under the reconciliation rule in §11;
- listener owner PID and `/healthz` still pass;
- persistence contract remains valid;
- `CONTROLLED_RELOAD=PASS`.

Failure after `COMMITTED` is a post-commit qualification failure and may trigger only the runtime-aware compensating rollback in §14.2.

### 13.16 `ROLLOUT_OK`

- post-commit verification passed;
- the helper returns `ROLLOUT_OK` as acknowledgement of the already-committed candidate.

## 14. Rollback

### 14.1 Failure before `COMMITTED`

Before `COMMITTED`, the canonical plist still contains the exact old known-good definition.

If failure occurs after `OLD_STOP_REQUESTED`, recovery first applies the consequential-stop ownership invariant to any runtime it intends to stop.

```text
fresh-read loaded runtime
  -> if candidate cleanup is needed, prove it is this transaction's candidate generation or a same-slot verified replacement
  -> request candidate stop
  -> verify candidate stopped with the bounded stop barrier
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

If runtime ownership cannot be proven, return `ROLLBACK_REFUSED_CONCURRENT_DRIFT` and do not stop the unknown runtime.

### 14.2 Failure after `COMMITTED`: compensating rollback

Automatic compensating rollback after `COMMITTED` is allowed only when **both** persistent and runtime CAS still belong to this transaction:

```text
sha256(current canonical plist) == this transaction's candidate canonical hash
AND
loaded runtime is either:
  A. the exact transaction candidate process generation
  OR
  B. a same-candidate-slot KeepAlive replacement that independently passes strong identity
AND
listener owner PID == the verified candidate PID
AND
no incompatible same-label runtime generation has appeared
```

If any part differs, another actor changed persistent or runtime state. Return:

```text
ROLLBACK_REFUSED_CONCURRENT_DRIFT
```

and do not `bootout` the unknown runtime or overwrite the new canonical state with the old backup.

If rollback CAS succeeds:

```text
request candidate bootout
  -> verify candidate stopped with the bounded stop barrier
  -> prepare same-directory canonical temp from exact hash-verified old backup
  -> flush/hash-verify temp
  -> atomic same-directory rename old temp -> canonical
  -> synchronize canonical parent directory through the qualified Darwin adapter
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

- before `COMMITTED`, the old canonical plist remains the durable restart target;
- after `COMMITTED`, the candidate had already passed both runtime verification passes and pre-commit revalidation;
- if the helper disappears mid-transaction, the next helper invocation must detect any mismatch between canonical plist and loaded runtime and fail closed as `SPLIT_STATE_DETECTED`;
- V1 does not silently decide which side of a split state should win;
- the runbook provides explicit recovery procedures.

Examples:

```text
helper dies after OLD_STOPPED_VERIFIED
  disk canonical = old
  runtime = stopped
  next login/reboot -> old canonical can start automatically

helper dies after CANDIDATE_STARTED but before commit
  disk canonical = old
  runtime = candidate
  next helper -> SPLIT_STATE_DETECTED
  next login/reboot -> old canonical remains restart target

helper dies after COMMITTED but before POST_COMMIT_VERIFIED / ROLLOUT_OK
  disk canonical = verified candidate
  runtime = candidate that already passed the controlled reload, or a later KeepAlive generation
  next helper -> reconcile canonical definition and runtime identity; do not call it uncommitted
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

The following successful deferred-publish steady state is explicitly **not** a split state:

```text
loaded job was originally bootstrapped from a transaction staging plist
AND
loaded service label == com.ethan.devspace
AND
canonical plist semantically equals the staged definition that was committed
AND
canonical entrypoint == loaded runtime entrypoint
AND
strong runtime identity is valid
AND
listener owner PID == resolved runtime PID
```

The original bootstrap plist pathname is not part of durable service identity. The staging file may already have been removed. Reconciliation depends on the committed canonical definition and live runtime identity, not on the historical source path used for `bootstrap`.

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
5. manifest generation is deterministic for an entire slot tree regardless of directory-enumeration order;
6. manifest records directory/file mode, regular-file SHA-256, and exact symlink target using the canonical line encoding;
7. absolute/escaping symlinks, unsupported entry types, and ambiguous path characters fail artifact qualification;
8. canonical plist symlink, wrong owner, group/world-writable mode, or unexpected parent directory fails before service interruption;
9. replacement temp preserves the prechecked canonical uid/gid/mode exactly;
10. lock refuses a live matching owner;
11. stale lock with dead/reused process generation is atomically moved and retried;
12. malformed/ambiguous lock is not auto-deleted;
13. lock release refuses to remove a different nonce;
14. ancestry containing live DevSpace PID -> `SELF_HOSTED_ROLLOUT_REFUSED`;
15. candidate plist changes only the approved entrypoint field;
16. candidate plist preserves `RunAtLoad=true` and `KeepAlive=true`;
17. a persistently disabled launchd override fails the persistence contract and the helper never mutates that override;
18. every consequential bootout refuses an unexpected same-label process generation instead of stopping it;
19. `bootout` command success alone does not advance state until the expected process is gone and the stop barrier passes;
20. lingering old/candidate ownership of port 7676 blocks the next bootstrap;
21. unrelated ownership of port 7676 is concurrent drift and is never killed by the helper;
22. candidate runtime may not commit until listener owner PID equals candidate PID;
23. `/healthz` success with wrong listener/process identity still fails;
24. candidate is booted out, verified stopped, and successfully bootstrapped a second time from the exact same staged plist before commit;
25. controlled reload failure occurs while canonical disk bytes are still the old known-good definition and cannot report success;
26. runtime drift after controlled reload but before commit fails `PRE_COMMIT_REVALIDATED` without replacing canonical bytes;
27. canonical temp is created inside the canonical parent with a non-`.plist` hidden name, exact candidate bytes, and matching hash;
28. required pre-rename file flush failure leaves old canonical bytes intact and prevents commit;
29. atomic canonical rename failure leaves old canonical bytes intact;
30. successful atomic rename is the single `COMMITTED` transition; a later acknowledgement is not a second commit point;
31. parent-directory synchronization failure occurs after `COMMITTED` and is classified as post-commit qualification failure, eligible only for compensating rollback;
32. post-commit compensating rollback requires both the transaction candidate canonical hash and the transaction-owned candidate runtime generation/same-slot verified replacement;
33. same candidate canonical hash with an unexpected same-label runtime -> `ROLLBACK_REFUSED_CONCURRENT_DRIFT` and does not bootout that runtime;
34. compensating rollback uses same-directory atomic replacement of the exact hash-verified old backup and verifies the old runtime after bootstrap;
35. a staging-loaded candidate whose staging file/path is gone still reconciles as a valid steady state when canonical definition, strong runtime identity, entrypoint, and listener ownership match;
36. true canonical/runtime disagreement -> `SPLIT_STATE_DETECTED`;
37. successful rollout leaves canonical bytes equal to the twice-verified staged definition, preserves persistence flags/file identity, and records `CONTROLLED_RELOAD=PASS`;
38. result classification distinguishes `ROLLOUT_OK`, pre-commit failure with successful old-runtime recovery, post-commit failure with successful compensating rollback, and rollback refusal/failure.

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
- the same-directory atomic canonical replace is the single `COMMITTED` transition and becomes the last-committed restart definition, with the explicitly bounded crash-oriented durability precautions in §12.1;
- a rollout cannot publish the canonical plist until the candidate has been bootstrapped and re-verified a second time from the exact staged bytes that will be published;
- every consequential stop has an observable stopped barrier before another generation is bootstrapped;
- `PRE_COMMIT_REVALIDATED` fresh-checks canonical bytes, candidate bytes, runtime generation, listener ownership, and liveness immediately before commit;
- post-`COMMITTED` compensating rollback is CAS-protected against both persistent and runtime concurrent drift;
- a successful staging-loaded runtime remains reconcilable after transaction staging cleanup without requiring the historical bootstrap plist path to exist;
- interrupted transactions are detected as split state rather than silently repaired;
- `RunAtLoad=true` and `KeepAlive=true` remain mandatory in every committed definition;
- the service label is verified not to have a persistent disabled override, and rollout never mutates enable/disable policy;
- ordinary tests never touch the real production LaunchAgent;
- live rollout remains separately authorization-gated;
- reboot recovery is not claimed as empirically PASS until a real authorized Mac restart/login qualification succeeds.
