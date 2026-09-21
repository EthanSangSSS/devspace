# DevSpace global boundary and lifecycle review

Review base: `7bccd5c36f2cf1442bca868e5c6c9518ff3903e8`, the merge of PR #11.
Scope: host-facing file/workspace tools, Git/worktrees, process sessions, MCP
HTTP/session lifecycle, local-agent adapters/daemon, OAuth, observability, and
macOS rollout/recovery. This is an evidence-bounded engineering review, not a
claim that arbitrary same-user programs or every kernel failure are sandboxed.

## Findings and disposition

| Finding | Classification | Disposition and evidence |
| --- | --- | --- |
| F1: forward exceptions and committed-state recovery | PR11_BLOCKER | PR #11 retains the lease through recovery, records committed truth immediately after rename, and returns explicitly unproven outcomes for unexpected recovery exceptions. Fault-injection tests include post-rename sync failure. |
| F2: newest candidate generation | PR11_BLOCKER | Readiness advances the remembered candidate before stability awaits; returned-unproven and thrown paths do not regress 203 to 202 or 202 to 201. Existing adversarial rollout tests passed in the full-suite checkpoints. |
| F3: physical file/workspace containment | PRODUCTION_BLOCKER | Resolve existing ancestors physically, reject dangling symlink ancestors, pass resolved paths to Pi file operations, and recheck configured roots when accessing a cached workspace. `global-boundaries.test.ts` and the cached-root replacement test reproduce the former escapes. |
| F4: real shutdown contract | PRODUCTION_BLOCKER | Track owned raw/upgraded sockets. HTTP/application shutdown has a 39-second deadline; transport closure has a separate bounded failure path and owned process shutdown fences admissions, then applies TERM/KILL escalation. Timeout is an explicit failure, not a claim of graceful completion. |
| F5: active candidate ownership | PR11_BLOCKER | PR #11 binds both forward qualification and recovery to expected argv and the verified Node executable, not only the entrypoint string. Foreign active candidates are refused. |
| F6: rollout boundedness | PRODUCTION_BLOCKER / GLOBAL_FOLLOWUP | PR #11 bounds subprocess/probe/stability work, propagates cancellation and preserves absolute stop deadlines. Filesystem sync/rename and kernel stalls remain non-cancellable; this is explicitly not a universal 40-second transaction guarantee. |
| F7: forward failure observability | PR11_BLOCKER | Phase, original code and reason survive successful rollback. Production health remains minimal; session and memory diagnostics belong in structured logs. |
| F8: inherited Git repository selectors | PRODUCTION_BLOCKER | Strip inherited repository-selection/config-injection variables at Git, shell and provider process boundaries. Deliberate internal private-index overrides remain supported. A two-repository regression verifies that repo A cannot be silently redirected into repo B. |
| Daemon Unix socket path length | PRODUCTION_BLOCKER | Validate UTF-8 byte length before filesystem mutation. macOS fixtures use short private prefixes without changing TMPDIR or weakening assertions. |
| OAuth callback URL policy | PRODUCTION_BLOCKER | Reject insecure remote schemes, userinfo, fragments and empty callback lists; recheck persisted clients against the current allowlist. Loopback HTTP remains supported. No production credential or token migration is performed. |
| Filesystem observation error identity | REGRESSION_FIXED | Preserve ELOOP/EACCES rather than treating them as stale/denied bindings; the existing binding-preservation regression remains authoritative. |

## Independent validation

The pre-final checkpoint ran the default environment full suite: 235 tests,
235 passed, zero failed/skipped. Typecheck, build, operator tests (3), and the
soak-metrics unit test passed. A further cached-root adversarial regression was
then reproduced and fixed; the final exact commit must pass the complete suite
and GitHub checks again before landing.

Final local checkpoint at source commit
`7b4759f64f7d4006f675ba883e85dd780eb365fd` (tree
`715bd9f165b060285ab4b79471141953812972db`): **236/236 tests passed**, zero
failures and zero skips, with typecheck, build, diff check, canary syntax,
operator tests (3), soak-metrics tests and disposable Darwin qualification all
passing. Qualification used label suffix `fe39b00a40c059ed` and port `60649`;
cleanup passed. The working diff and new-file hashes were compared with the
validation receipt immediately before commit. This documentation-only update
does not change that tested runtime tree; its own exact remote HEAD still
requires CI and Secret Scan before merge.

`scripts/devspace-shutdown-canary.mjs` runs the actual built CLI in a private
fixture, with synthetic test authentication and an allocated non-7676 loopback
port. It never loads production configuration or starts a delegated agent.
Observed first checkpoint: finite incomplete request released after 12 seconds
exited normally in 12,046 ms; a continuously held incomplete request exited
with the explicit shutdown-deadline error in 39,048 ms. Both child PIDs exited.
The same canary must be run on the eventual immutable production candidate.

Prior default-environment failures are retained as evidence rather than
discarded: an overlong daemon-test path, a daemon oversized-request close race,
and the ELOOP error-classification regression. Fixes were checked against the
original assertions, not by suppressing errors or shortening the global temp
root. The Vite large-chunk warning is non-blocking and remains a performance
follow-up.

## Architecture boundaries and residuals

MCP admissions use capacity reservations and in-flight leases; active sessions
are not selected for idle eviction. Expired/restarted sessions still require
client reinitialization (404) and shutdown may reject new requests (503). No
claim is made that server code can prevent all host/client transport failures.
The 48-bit process-session handles are opaque, workspace-scoped and reject
stale handles; existing collision and restart-isolation tests remain required.

Local-agent model/effort, source-HEAD and allowed-path policies were inspected
and exercised through the test doubles. No real Agy/Codex/other model delegation
was performed. The current ChatGPT surface need not expose Agy for the primary
controller to complete this work. No additional app actions are enabled here.

File path checks prevent the reproduced static/dangling symlink escapes. They
are not an OS sandbox against a malicious same-user process continuously
swapping parent directories or deliberately escaping a shell's process group.
Shell execution retains the local user's authority. Native artifact writes
use descriptor-anchored operations only on supported platforms; this review
does not enable them on unsupported macOS paths. Stronger hostile-concurrency
isolation is a separate design task, not an implicit release claim.

The daemon's runtime reuse and shutdown differ from the production MCP
service. Stopping MCP does not authorize stopping unrelated agents or other
applications. OAuth persistence and structured logging were reviewed without
reading production credential values. Candidate build/deploy must retain the
existing durable config, database location and OAuth state.

## Landing gates

The merge gate requires the exact reviewed commit, clean worktree, full local
validation, matching remote diff/HEAD, successful CI and Secret Scan, and no
unresolved review blockers. Production additionally requires an immutable
candidate from the audited merge, frozen dependency identity, native SQLite
preflight, disposable qualification, strong live ownership/CAS evidence and an
independent one-shot operator with restart disabled. Read back the transaction
outcome and local/public connector behavior after deployment.

Whole-machine reboot/logout is not authorized. `REBOOT_RECOVERY=UNVERIFIED`
remains required even after a successful service rollout. A local health
response alone is not proof of end-to-end ChatGPT continuity.
