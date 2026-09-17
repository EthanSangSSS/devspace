# macOS Launchd Transactional Rollout Runbook

This runbook covers the repository-local macOS V1 rollout utility for the fixed DevSpace LaunchAgent topology. It is an operator procedure, not a general deployment framework, and it does not authorize a production switch by itself.

## Scope and non-goals

Fixed production topology:

```text
label          = com.ethan.devspace
plist          = ~/Library/LaunchAgents/com.ethan.devspace.plist
domain         = gui/<current uid>
host           = 127.0.0.1
port           = 7676
health         = /healthz
```

The utility is not exposed as an MCP tool and is not registered in the public `devspace` CLI. V1 does not enable/disable the LaunchAgent, manage the public tunnel, claim pre-login recovery, replay interrupted transactions, or treat the advisory lock as a privilege boundary against arbitrary same-user processes.

## Operator commands

Mandatory target-host qualification:

```bash
pnpm exec tsx scripts/devspace-macos-rollout.ts qualify
```

Production rollout syntax, for a separately authorized switch only:

```bash
pnpm exec tsx scripts/devspace-macos-rollout.ts rollout \
  --expected-live-entrypoint <absolute-path> \
  --expected-live-plist-sha256 <64-lowercase-hex> \
  --candidate-entrypoint <absolute-path> \
  --candidate-slot-manifest-sha256 <64-lowercase-hex>
```

There are no caller-selectable `--label`, `--port`, `--plist`, or arbitrary topology overrides.

Run the production command from an independent operator context that is not a descendant of the live DevSpace process. Do not use `launchctl submit` as a one-shot wrapper for this command: macOS documents that `submit` keeps a failed program alive, so a non-zero rollout result can be retried repeatedly. If automation is required, use an explicitly disposable operator definition whose restart policy is off and whose lifecycle is separately verified.

## Mandatory qualification gate

Before the first production-label rollout on a target macOS major version, `qualify` must pass on that machine. Re-qualify after a macOS major-version change.

Qualification uses only a unique disposable label:

```text
com.ethan.devspace.rollout-qualification.<nonce>
```

and a dynamically allocated loopback port other than `7676`.

It must report PASS for:

```text
lockf
durability
launchd
printDisabled
processIdentity
listener
health
stopBarrier
cleanup
```

The qualification fixture deliberately uses a DevSpace-style entrypoint path containing spaces so argv parsing is exercised without whitespace splitting.

The `printDisabled` qualification is read-only and is anchored to the fixed production label `com.ethan.devspace`. It proves that the target host can observe the disabled-state contract used by production rollout preflight; it does not create a persistent enable/disable override for the disposable qualification label.

On the currently qualified macOS 27.0 target, executable identity combines independent observations:

1. `launchctl print` provides loaded argv and the launchd run generation;
2. `ps -o lstart=` contributes process-start identity;
3. `ps -o comm=` provides one executable-path candidate;
4. that path is realpathed and must equal the realpath of launchd `argv[0]`;
5. the same executable realpath must be corroborated by the complete `lsof -d txt` program-text mapping set.

Do not assume that `lsof -d txt` returns exactly one path or that its first path is a stable executable API.

## Preflight evidence

Immediately before any separately authorized production rollout, collect fresh evidence:

```text
implementation HEAD
candidate entrypoint absolute path
candidate slot manifest SHA-256
current canonical plist SHA-256
current canonical entrypoint realpath
current launchd PID + run generation
current strong runtime process identity
current listener owner PID
current /healthz result
current launchd disabled override
old canonical plist backup hash
operator ancestry suitability
latest successful target-host qualification evidence
```

Do not reuse evidence after a relevant file, process generation, or candidate artifact changes.

## Candidate manifest

The manifest covers the entire candidate slot, not a helper-selected subset. Its canonical records are:

```text
D<TAB><mode-octal><TAB><relative-path><LF>
F<TAB><mode-octal><TAB><sha256-hex><TAB><relative-path><LF>
L<TAB><literal-symlink-target><TAB><relative-path><LF>
```

The candidate entrypoint must end in:

```text
node_modules/@waishnav/devspace/dist/cli.js
```

Generate the caller-side digest from the immutable candidate slot root with the repository helper:

```bash
pnpm exec tsx -e '
import { buildCandidateSlotManifest } from "./src/macos-launchd-rollout-manifest.ts";
void (async () => {
  const result = await buildCandidateSlotManifest(process.argv[1]);
  console.log(result.sha256);
})();
' -- <candidate-slot-root>
```

The rollout helper independently rebuilds the manifest and requires the exact digest. A mismatch returns `CANDIDATE_ARTIFACT_MISMATCH` before production is stopped.

## Commit and controlled-reload semantics

The sole logical commit point is the successful same-directory atomic rename of the verified hidden temp file over the canonical plist:

```text
PRE_COMMIT_REVALIDATED
-> COMMITTED
-> POST_COMMIT_VERIFIED
-> ROLLOUT_OK
```

`ROLLOUT_OK` is acknowledgement after qualification, not the commit point. If the helper exits after `COMMITTED` but before `ROLLOUT_OK`, the candidate is still the durable canonical definition and recovery must begin from fresh observations.

A successful rollout also requires two candidate launchd generations from the exact same staged plist bytes:

```text
first candidate start + verification
-> verified candidate stop
-> controlled reload from identical staged bytes
-> second verification
-> PRE_COMMIT_REVALIDATED
-> COMMITTED
```

`ROLLOUT_OK` therefore requires `CONTROLLED_RELOAD=PASS`.

## Post-rollout qualification

After a separately authorized production switch returns `ROLLOUT_OK`, record a fresh read of:

```text
canonical plist SHA-256 + entrypoint
launchd PID + process generation
strong runtime identity
listener owner PID
/healthz
CONTROLLED_RELOAD=PASS
canonical SHA-256 == twice-verified staged candidate SHA-256
```

Local DevSpace qualification and public connector/tunnel qualification are separate. Keep `REBOOT_RECOVERY=UNVERIFIED` until the separately authorized restart canary described below is actually observed.

`/healthz` is a bounded liveness gate. The production Darwin adapter applies a 2-second request deadline by default; timeout, connection failure, malformed response, or a non-matching health payload is treated as unhealthy. This does not qualify the end-to-end ChatGPT/MCP path.

Runtime startup readiness is also bounded. After each candidate bootstrap and after an old-runtime recovery bootstrap, the production Darwin adapter waits up to 15 seconds, polling every 100 ms for the expected same-label process identity, listener ownership, and healthy `/healthz`. Transient `launchd` PID availability, listener absence, or unhealthy startup responses are retried inside that window. A same-label process with a different entrypoint or an unrelated owner of port `7676` fails closed immediately rather than being treated as startup delay. The normal stability observation still runs after readiness succeeds.

## Result codes

| Result code | Operator meaning |
| --- | --- |
| `ROLLOUT_OK` | Candidate committed and post-commit qualification passed. Reboot recovery is still separate. |
| `PRECONDITION_FAILED` | A required observation/platform operation could not be established safely. Do not bypass it. |
| `PERSISTENCE_CONTRACT_INVALID` | Canonical persistence flags or disabled-state contract is invalid. V1 does not auto-enable the service. |
| `CANDIDATE_ARTIFACT_MISMATCH` | Candidate entrypoint, manifest, staged plist, or byte identity does not match caller-bound evidence. |
| `LIVE_STATE_CAS_MISMATCH` | Old canonical/runtime state changed relative to the caller-bound live state or exact stop ownership cannot be proven. |
| `SPLIT_STATE_DETECTED` | Disk, launchd, runtime, or listener state cannot be reconciled into one valid starting state. |
| `LOCK_BUSY` | Another cooperating rollout owns the fixed kernel advisory lock. Never delete/rename the lock to bypass it. |
| `LOCK_AMBIGUOUS` | Lock file/kernel-lock identity is unsafe or unprovable. There is no stale-lock rename/delete fallback. |
| `SELF_HOSTED_ROLLOUT_REFUSED` | Live DevSpace is in the helper ancestry. Use an independent operator context. |
| `SWITCH_FAILED_ROLLBACK_OK` | Switch failed, but old state was safely restored or remained healthy and verified. |
| `SWITCH_FAILED_ROLLBACK_FAILED` | Recovery was eligible but old-state restore/verification failed. Inspect current state before further action. |
| `ROLLBACK_REFUSED_CONCURRENT_DRIFT` | Concrete incompatible state was observed. Do not stop or overwrite the unknown state. |
| `ROLLBACK_REFUSED_UNPROVEN_STATE` | Required state cannot be reliably classified. Unknown is not silently promoted to drift or absence. |

## Recovery rules

Every recovery starts by fresh-reading:

```text
canonical plist hash + file identity
launchd label/PID/generation
strong runtime identity
listener owner PID
transaction kernel-lock state, when applicable
```

Do not use blanket backup copies, blind `bootout`, blind process kills, or blind `launchctl enable` as shortcuts.

### Canonical committed but service not running

1. Read the current canonical hash and entrypoint.
2. Read same-label launchd state and listener ownership.
3. Determine whether canonical is the transaction candidate, the old hash, or unknown third-party state.
4. If state is ambiguous, preserve evidence and stop; do not automatically select a winner.
5. Bootstrap only after proving that no incompatible same-label runtime or unrelated listener owner exists.

Do not infer that the old plist should be restored merely because a previous helper never printed `ROLLOUT_OK`.

### `ROLLBACK_REFUSED_CONCURRENT_DRIFT`

Treat current runtime/disk state as externally changed. Re-read from scratch. Do not boot out the current service or restore the transaction backup unless a new recovery procedure is explicitly bound to the newly observed state.

### `ROLLBACK_REFUSED_UNPROVEN_STATE`

Resolve the failed observation first. Examples include unreadable file identity, unavailable process generation evidence, or ambiguous listener data. Do not relabel unknown state as drift or absence merely to continue.

### `LOCK_BUSY` and `LOCK_AMBIGUOUS`

For `LOCK_BUSY`, allow the current cooperating holder to finish or investigate that process. The fixed lock file is persistent and must not be removed as a stale-lock workaround.

For `LOCK_AMBIGUOUS`, inspect file type, ownership, mode, inode/device identity, and kernel-lock evidence. V1 deliberately has no stale-lock rename/delete recovery path.

## Restart/login recovery canary

The production service is a per-user LaunchAgent, so the claim is recovery after the user's login session is established, not pre-login availability.

A real restart canary requires separate explicit authorization. After restart and login, verify without manually bootstrapping DevSpace first:

1. `com.ethan.devspace` is loaded in `gui/<uid>`;
2. PID/process generation matches the committed entrypoint identity;
3. `127.0.0.1:7676` is owned by that PID;
4. `/healthz` succeeds;
5. no manual `bootstrap` was required.

Only then may evidence report `REBOOT_RECOVERY=PASS`. Otherwise report `REBOOT_RECOVERY=UNVERIFIED`.

## Tunnel/public endpoint recovery

The public connector/tunnel is outside this transaction. Verify it separately after local service recovery. Local launchd/listener/health evidence does not prove ChatGPT/MCP end-to-end recovery.
