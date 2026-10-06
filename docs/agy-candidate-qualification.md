# Agy candidate qualification contract

This document defines the first, non-promoting stage of a future Agy runtime
update workflow. It does not make DevSpace an Agy updater and it does not
authorize an Agy version for production merely because upstream publishes it.

## Scope

The initial contract is deliberately narrow:

```text
reviewed release source
  -> parse candidate metadata
  -> bind exact metadata/package/executable identity
  -> record qualification evidence
  -> stop
```

It does not download or execute a candidate by itself. Acquisition, sandboxed
candidate execution, provider canaries, promotion, rollback and scheduling are
separate work.

The current `agyDelegation.compatibleVersions` value remains an owner adoption
gate. A future exact-artifact qualification receipt is additional evidence; it
does not override that configured range.

## Reviewed source identity

The first adapter covers only the Google Antigravity macOS arm64 platform
manifest:

```text
https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/
  manifests/darwin_arm64.json
```

At the time this adapter was reviewed, the official installer consumed the
manifest fields `version`, `url` and `sha512`, and the observed artifact URL was
under:

```text
https://storage.googleapis.com/antigravity-public/antigravity-cli/
```

The adapter treats those facts as a reviewed source contract, not as a promise
that the endpoint is a public stable API or that it represents a universal
"latest stable" channel. The parser therefore returns a **discovered
candidate**, not a globally-latest assertion.

The adapter fails closed if a future manifest introduces explicit `schema`,
`schemaVersion` or `channel` fields before those semantics have been reviewed.
Other fields are ignored when they do not participate in the consumed identity
contract.

## Candidate identity

Discovery binds:

- adapter id and revision;
- platform and architecture;
- exact manifest URL;
- SHA-256 of the exact manifest bytes;
- canonical SemVer version;
- reviewed HTTPS artifact URL;
- upstream SHA-512 package digest.

Later acquisition must add the SHA-256 of the extracted native executable.
Qualification must execute that exact immutable executable, not a mutable
launcher such as `~/.local/bin/agy`.

The upstream package digest proves consistency with the reviewed manifest. It
does not by itself prove an independently signed release. A macOS qualification
stage is expected to verify the extracted executable's platform signature and
reviewed signer identity before executing it.

## Qualification receipt

The receipt is evidence about one exact artifact under one DevSpace
qualification revision and policy fingerprint. It is not a production adoption
decision.

The receipt records:

- candidate source and artifact identity;
- DevSpace source commit;
- qualification revision;
- server-policy fingerprint;
- attempted profiles and successfully qualified profiles;
- per-gate status and evidence scope;
- discovery and qualification timestamps.

Evidence scopes are intentionally explicit:

```text
NONE
CONFIGURED
OBSERVED
BEHAVIORALLY_VERIFIED
```

Configuration intent must not be reported as runtime proof. In particular,
`auto-update-isolation`, `runtime-policy`, `stream-protocol` and profile canary
gates can pass only with `BEHAVIORALLY_VERIFIED` evidence.

A profile may appear in `qualifiedProfiles` only when its matching profile gate
passed with behavioral evidence. A `repo-read` canary therefore does not qualify
`repo-validate` or `gui-inspect`.

For a receipt-level `PASS`, the current schema requires all reviewed core gates
to be present and passing:

```text
artifact-integrity
executable-identity
platform-signature
static-cli-contract
auto-update-isolation
runtime-policy
stream-protocol
```

Every attempted profile also requires a recorded profile gate. Provider auth,
entitlement, quota or network failures that cannot be attributed to the binary
must remain `INCONCLUSIVE` rather than being promoted into a compatibility
failure.

## Policy fingerprint

The policy fingerprint currently binds the qualification revision plus the
server-owned values that materially affect Agy execution:

- model;
- effort;
- compatible version range;
- GUI foreground policy;
- attempted profiles.

Changing those values invalidates the old policy fingerprint. It does not
change the already-recorded package or executable digest, so a later workflow
may reuse immutable artifact identity while rerunning policy-dependent canaries.

## Explicit non-goals for this stage

This contract does not add:

- an MCP updater tool;
- a server timer or background updater daemon;
- candidate downloading or extraction;
- candidate execution;
- model selection or entitlement changes;
- changes to `agyDelegation.compatibleVersions`;
- changes to `agyDelegation.agyPath`;
- automatic or manual promotion;
- rollback logic;
- production changes.

Those capabilities require separate review because downloading and executing an
untrusted candidate, and later changing the active executor identity, introduce
different authority, supply-chain and concurrency boundaries.
