# Configuration Reference

DevSpace stores durable settings in `~/.devspace/config.jsonc`. The file accepts
comments and trailing commas and is validated before the server starts. Editor
completion is provided by the versioned [JSON Schema](../schema/v1/devspace.schema.json),
also hosted at the URL in the file's `$schema` property.

Authentication stays separate because it contains a secret:

```text
~/.devspace/config.jsonc
~/.devspace/auth.json
```

Run `devspace init` to create both files. `devspace config set publicBaseUrl
<url|null>` updates the JSONC document without discarding its comments.

## Complete example

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/Waishnav/devspace/main/schema/v1/devspace.schema.json",
  "configVersion": 1,

  "server": {
    "host": "127.0.0.1",
    "port": 7676,
    // Use the public origin only; do not append /mcp.
    "publicBaseUrl": "https://devspace.example.com",
    "allowedHosts": [],
    "trustProxy": false,
    "mcpMaxSessions": 64,
    "mcpSessionIdleTimeoutMs": 30000,
    "mcpSessionCleanupIntervalMs": 5000,
  },
  "workspaces": {
    "allowedRoots": ["~/personal", "~/work"],
    "worktreeRoot": "~/.devspace/worktrees",
    "legacyWorktreeRoots": [],
    "requireExistingWorktreeRoot": false,
    "managedWorktreeSourceRoots": [],
    "managedWorktreeMountPoint": "",
    "managedWorktreeVolumeUuid": "",
  },
  "storage": {
    "stateDir": "~/.local/share/devspace",
  },
  "tools": {
    "mode": "codex",
  },
  "ui": {
    "enabled": true,
  },
  "artifacts": {
    "enabled": false,
    "maxFileBytes": 104857600,
  },
  "skills": {
    "enabled": true,
    "paths": [],
    "agentDir": "~/.codex",
  },
  "subagents": {
    "enabled": false,
    "providers": [],
  },
  "logging": {
    "level": "info",
    "format": "json",
    "requests": true,
    "assets": false,
    "toolCalls": true,
    "shellCommands": false,
  },
  "oauth": {
    "accessTokenTtlSeconds": 3600,
    "refreshTokenTtlSeconds": 2592000,
    "scopes": ["devspace"],
    "allowedRedirectHosts": ["chatgpt.com", "localhost", "127.0.0.1"],
  },
}
```

Omitted sections and keys use the defaults shown above. An empty
`workspaces.allowedRoots` uses the current working directory. Unknown keys are
rejected so spelling mistakes cannot silently alter behavior.

### Moving managed worktrees without breaking older sessions

`workspaces.worktreeRoot` is the destination for **new** managed worktrees.
Changing it does not relocate old worktrees or rewrite persisted workspace
session records. Add the previous root to `legacyWorktreeRoots` when changing
the preferred destination, so already-stored managed sessions remain readable:

```jsonc
{
  "workspaces": {
    "allowedRoots": ["~/projects", "/Volumes/DevSSD/Developer"],
    "worktreeRoot": "/Volumes/DevSSD/Worktrees",
    "legacyWorktreeRoots": ["~/.devspace/worktrees"],
    "requireExistingWorktreeRoot": true,
    "managedWorktreeMountPoint": "/Volumes/DevSSD",
    "managedWorktreeVolumeUuid": "00000000-0000-0000-0000-000000000000",
    "managedWorktreeSourceRoots": [
      "/Volumes/DevSSD/Developer/devspace-mcp-session-reliability-v1-1",
      "/Volumes/DevSSD/Developer/app-legal-docs"
    ]
  }
}
```

Legacy roots authorize persisted managed workspace access; they are **not**
destinations for new managed worktrees. With `requireExistingWorktreeRoot=true`,
an unavailable directory or a symlink at the configured new root causes new
worktree creation to fail rather than creating a fallback directory.

On macOS, replace the example all-zero UUID above with the **actual UUID** of
the intended encrypted APFS volume as reported by `diskutil info -plist`.
When `managedWorktreeMountPoint` and `managedWorktreeVolumeUuid` are both set,
new worktree creation checks the exact volume UUID, mount point, APFS type,
encryption (`FileVault` flag), writable status, and that the configured
worktree directory resides on the mounted volume rather than the host disk.
If either field is missing, the other does not grant permission: new worktree
creation fails closed. Both fields default to empty to preserve current
configurations, which means volume identity checking is **opt-in**. This
guard requires macOS; non-macOS systems reject the opt-in settings.
`requireExistingWorktreeRoot` must also be enabled. The check occurs before
`git worktree add`, but it cannot eliminate all filesystem hot-unplug races;
maintain backups and verify a stable physical connection.

**Restart and persisted-session safety:** DevSpace also checks the configured
mount UUID before restoring a saved managed workspace located under the **new**
`worktreeRoot`. Sessions created with this opt-in guard remember their expected
volume UUID and original directory inode in the state database. After a server
restart, an unexpectedly replaced directory or an incorrect/missing encrypted
APFS volume causes session restoration to **fail closed**, without creating,
remapping or deleting any worktree files. A matching UUID can safely be
accepted even if macOS assigned a different `st_dev` after remounting; directory
inode and Git worktree links must still match.

Database migration v7 adds nullable `workspace_sessions.root_inode` and
`workspace_sessions.root_volume_uuid`. It never guesses physical identity for
pre-existing session rows. Historical managed worktrees are instead checked
against their source repository's Git admin directory **and its reverse
`gitdir` backlink**, including sources that are themselves linked worktrees.
Missing directories, inconsistent Git links or a new-root session without its
original expected volume identity are not recreated or silently rebound.
Old checkout sessions are retained for compatibility.

This is a conservative filesystem/Git identity check, **not cryptographic
attestation**: a legacy session with no recorded inode cannot distinguish a
perfectly forged working-tree copy with equivalent Git metadata. Nor can it
eliminate filesystem races between verification and subsequent file access.
Back up the existing state database, confirm the volume UUID, test legacy
session restoration on an isolated instance, and preserve rollback capability
**before** installing the new binary: startup migrates the database schema.

Do not delete or move old worktrees until their active sessions and
uncommitted changes are independently accounted for. The global configuration
change also affects sources outside the external volume; validate the backup
allowlist before creating worktrees from those repositories.

`managedWorktreeSourceRoots` restricts **new managed worktree creation** to
the listed **exact Git repository roots** (without changing general checkout
access or historical workspace recovery). The empty default retains v1.1
behavior. For an SSD-only development cutover, list each approved repository
under the verified SSD Developer directory **individually**, and keep that
list synchronized with the local backup allowlist. Listing the parent
`/Volumes/DevSSD/Developer` does *not* grant access to its children. This
prevents snapshot-only or unprotected Git sources from gaining automatic
worktree access through an overly broad parent. A new project needs separate
source and backup authorization before using managed worktree mode.

If Git fails to create a new managed worktree, DevSpace leaves any remaining
target directory in place rather than recursively removing files whose
ownership cannot be established. Inspect the resulting path before explicit
cleanup; this intentionally favors preserving user data over automatic cleanup.

`server.mcpSessionIdleTimeoutMs` applies only after a session has no in-flight
requests. The cleanup timer never expires an active tool call or active MCP
request. Keep `mcpSessionCleanupIntervalMs` substantially smaller than the idle
timeout so abandoned sessions are reclaimed before `mcpMaxSessions` is reached.

## Tool modes and UI

`tools.mode` accepts two values:

| Value | Tool surface |
| --- | --- |
| `codex` | Default. `open_workspace`, `read`, `apply_patch`, `exec_command`, `write_stdin`, `list_process_sessions`, and `show_changes`. |
| `claude` | `open_workspace`, `read`, `write`, `edit`, `bash`, and `show_changes`. |

The dedicated MCP tools `grep`, `glob`, and `ls` are not exposed. Each mode uses
its shell tool with programs such as `rg`, `find`, and `ls` when it needs those
operations.

DevSpace attaches Apps UI metadata only to `open_workspace` and `show_changes`.
This avoids rendering an iframe for every read, edit, search, or command call.
Setting `ui.enabled` to `false` removes the metadata but does not remove the
`show_changes` tool.

## Skills and subagents

DevSpace discovers standard Agent Skills from `~/.agents/skills`, project
`.agents/skills`, and `~/.devspace/skills`. It also checks
`skills.agentDir/skills` and each path in `skills.paths`. Relative custom paths
are resolved from the active workspace.

Subagent providers are explicit. Omitted providers are disabled:

```jsonc
{
  "configVersion": 1,
  "subagents": {
    "enabled": true,
    "providers": [
      {
        "id": "codex",
        "enabled": true,
        "model": "gpt-5.4",
        "effort": "high",
      },
      {
        "id": "claude",
        "enabled": true,
        "model": "sonnet",
      },
    ],
  },
}
```

Profiles are loaded from `~/.devspace/agents/*.md` and project
`.devspace/agents/*.md`. `devspace agents targets` prints the configured targets
available in the current workspace.

Provider executable discovery remains process-scoped. The supported overrides
are `CODEX_COMMAND`, `CODEX_HOME`, `CLAUDE_COMMAND`, `CURSOR_COMMAND`,
`COPILOT_COMMAND`, `GROK_COMMAND`, and `GROK_AGENT_PROFILE`. DevSpace does not
persist provider credentials.

## Native artifact download

Set `artifacts.enabled` to `true` when a host needs to save a native attached or
generated file into an open workspace. `artifacts.maxFileBytes` limits one
streamed file. The secure publication path is currently available only on
Linux; the tool is not registered on macOS, Windows, or BSD.

## Declarative Agy Delegation

Declarative Agy delegation is an experimental, server-side capability and is
disabled by default. It is separate from DevSpace's built-in Subagents system:
enabling it does not enable Subagents, provider profiles, or
`devspace agents` commands.

V1 is supported and qualified only on macOS. DevSpace's core server remains
cross-platform, but Linux and Windows are not supported Agy execution targets
for this version. In particular, `repo-validate` fails closed outside macOS
because its authoritative validation isolation uses Seatbelt.

Configure it in `config.jsonc`:

```jsonc
{
  "configVersion": 1,
  "agyDelegation": {
    "enabled": true,
    "agyPath": "~/.local/bin/agy",
    "cuaDriverPath": "~/.local/bin/cua-driver",
    "settingsPath": "~/.gemini/antigravity-cli/settings.json",
    "model": "gemini-3.8-flash-high",
    "effort": "high",
    "compatibleVersions": ">=1.1.22 <1.2.0",
    "guiForegroundPolicy": "deny"
  }
}
```

The section defaults to disabled. The three path fields default to the values
shown above and are normalized using the same home-path rules as other stored
DevSpace paths. `model`, `effort`, and `compatibleVersions` are server-owned
policy strings. They are not trimmed or selected by the MCP caller; empty or
whitespace-only values are rejected. `guiForegroundPolicy` is also server-owned
and defaults to `deny`; it is never exposed as an Agy or MCP action selector.

The default policy remains:

```text
model              = gemini-3.8-flash-high
effort             = high
compatibleVersions = >=1.1.22 <1.2.0
guiForegroundPolicy = deny
```

`delegate_to_agy` does not expose model or effort selectors. Real runs use the
configured values for `--model` and `--effort`, use `--output-format
stream-json`, and fail closed unless `init.model` exactly matches the configured
model. Runtime inspection also requires the configured Agy version to satisfy
`compatibleVersions`; malformed or out-of-range versions are rejected even if
the executable otherwise starts.

`compatibleVersions` is a qualification boundary, not an updater. DevSpace
continues to disable Agy auto-update during delegated runs and also checks that
the required CLI flags still exist. A routine compatible patch upgrade can be
used after local runtime/canary qualification without a DevSpace code change.
An out-of-range release requires explicit qualification before widening the
configured range or changing the adapter.

After the one-time Workspace action schema refresh that removes the legacy
model/effort input literals, changing `model`, `effort`, or an already-qualified
Agy patch version does not require another action republish as long as the MCP
field contract itself remains unchanged. During that migration, legacy extra
`requested_model` / `requested_effort` payload fields are ignored as control
inputs and cannot override server policy.

Real runs require telemetry to already be disabled in the configured Agy
settings. DevSpace does not change the user's persistent Agy settings to make a
delegation pass. The worker uses a task-local HOME and does not use
`--continue`, `--conversation`, or automatic permission bypass flags.

Repository profiles also require `gitleaks` to be installed as an executable on
the DevSpace service PATH. DevSpace resolves that executable to an absolute
path before using it for the bounded snapshot preflight.

The V1 profiles are:

- `repo-read` — committed-HEAD read/search analysis only.
- `repo-validate` — the same bounded snapshot plus declared validation commands
  executed by DevSpace under a network-denied sandbox before Agy analysis.
- `gui-inspect` — exact-window AX inspection through the CuaDriver broker; no
  generic CuaDriver executable, raw pixel action surface, screenshot feed, or
  text-entry capability is exposed to Agy.

`gui-inspect` always sends brokered actions with CuaDriver
`delivery_mode="background"`. Before each GUI mutation DevSpace records the
current frontmost app and exact top-level window from CuaDriver's WindowServer
`z_index` data, then checks the same state again after the action.

With the default `guiForegroundPolicy="deny"`, DevSpace refuses to mutate a
target that belongs to the user's current frontmost app. If a background action
nevertheless changes the frontmost app or window, the delegation fails closed
and stops further GUI actions; DevSpace deliberately does not steal focus back.

`guiForegroundPolicy="allow-restore"` is an explicit local opt-in for workflows
where a brief restore is acceptable. Actions still start in background mode,
but if the foreground changes DevSpace asks CuaDriver to restore the exact
previous PID/window and verifies that restoration. This mode can conflict with
a human who changes windows concurrently, so keep `deny` for normal interactive
use.

`get_agy_runtime` reports the active policy as `gui_foreground_policy` so the
effective server-side setting can be verified without starting a worker.

`delegate_to_agy` has no internal Codex or alternate-model fallback. Any later
fallback is a separate host/controller decision.

## Environment boundary

Only two user-facing DevSpace environment variables remain:

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_CONFIG_DIR` | Bootstrap location for `config.jsonc`, `auth.json`, skills, and profiles. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Optional secret override for the owner token stored in `auth.json`. |

Durable environment settings were removed in v1.1. Move existing deployment
values to these JSONC keys:

| Removed setting | JSONC key |
| --- | --- |
| `HOST`, `PORT` | `server.host`, `server.port` |
| `DEVSPACE_PUBLIC_BASE_URL` | `server.publicBaseUrl` |
| `DEVSPACE_ALLOWED_HOSTS` | `server.allowedHosts` |
| `DEVSPACE_TRUST_PROXY` | `server.trustProxy` |
| `DEVSPACE_ALLOWED_ROOTS` | `workspaces.allowedRoots` |
| `DEVSPACE_WORKTREE_ROOT` | `workspaces.worktreeRoot` |
| `DEVSPACE_STATE_DIR` | `storage.stateDir` |
| `DEVSPACE_TOOL_MODE`, `DEVSPACE_MINIMAL_TOOLS` | `tools.mode` |
| `DEVSPACE_WIDGETS` | `ui.enabled` |
| `DEVSPACE_ARTIFACTS` | `artifacts.enabled` |
| `DEVSPACE_ARTIFACT_MAX_FILE_BYTES` | `artifacts.maxFileBytes` |
| `DEVSPACE_SKILLS` | `skills.enabled` |
| `DEVSPACE_SKILL_PATHS` | `skills.paths` |
| `DEVSPACE_AGENT_DIR` | `skills.agentDir` |
| `DEVSPACE_SUBAGENTS` | `subagents.enabled` |
| `DEVSPACE_LOG_LEVEL` | `logging.level` |
| `DEVSPACE_LOG_FORMAT` | `logging.format` |
| `DEVSPACE_LOG_REQUESTS` | `logging.requests` |
| `DEVSPACE_LOG_ASSETS` | `logging.assets` |
| `DEVSPACE_LOG_TOOL_CALLS` | `logging.toolCalls` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `logging.shellCommands` |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `oauth.accessTokenTtlSeconds` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `oauth.refreshTokenTtlSeconds` |
| `DEVSPACE_OAUTH_SCOPES` | `oauth.scopes` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `oauth.allowedRedirectHosts` |

These environment values are not read or auto-imported in v1.1. Environment is
process state, so there is no reliable file DevSpace can migrate on the user's
behalf.

## v1.0 file migration

The first v1.1 load performs one migration when `config.jsonc` is missing and
`config.json` exists:

1. Validate the old JSON document.
2. Translate its known fields into the versioned JSONC structure.
3. Write and validate a temporary `config.jsonc`.
4. Atomically publish it.
5. Rename the old file to `config.json.v1.0.bak`.

If `config.jsonc` exists, DevSpace never reads `config.json`. Invalid JSONC also
never falls back to the old file. Unsupported legacy keys stop migration with an
actionable error instead of being silently discarded.

The persisted fields map as follows:

| v1.0 JSON field | v1.1 JSONC key |
| --- | --- |
| `host`, `port` | `server.host`, `server.port` |
| `publicBaseUrl`, `allowedHosts` | `server.publicBaseUrl`, `server.allowedHosts` |
| `allowedRoots`, `worktreeRoot` | `workspaces.allowedRoots`, `workspaces.worktreeRoot` |
| `stateDir` | `storage.stateDir` |
| `artifactsEnabled`, `artifactMaxFileBytes` | `artifacts.enabled`, `artifacts.maxFileBytes` |
| `agentDir` | `skills.agentDir` |
| `subagents` | `subagents` |
| `tools.mode`, `ui.enabled` | unchanged nested keys |

`auth.json` is unchanged.
