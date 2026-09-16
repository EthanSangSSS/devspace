# Security Model

DevSpace exposes local coding capabilities over MCP. Treat it as remote access
to your development machine.

The security model is simple:

- you choose a narrow filesystem allowlist
- the MCP endpoint requires OAuth approval with your Owner password
- Host headers are allowlisted from the configured public URL
- every coding action happens through explicit MCP tool calls

## Filesystem Allowlist

DevSpace only opens workspaces under configured roots.

Good examples:

```text
~/work
~/personal/open-source
```

Avoid broad roots:

```text
~
/
C:\
```

The narrower the root, the easier it is to reason about what the MCP client can
reach.

## Owner Password

`devspace init` generates an Owner password and stores it in:

```text
~/.devspace/auth.json
```

When an MCP client connects, DevSpace shows an approval page. Enter the Owner
password only when you intentionally want that client to access this server.

For env-driven deployments, set a long random value:

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)"
```

## Public URL And Host Allowlist

DevSpace needs `DEVSPACE_PUBLIC_BASE_URL` so MCP clients can discover OAuth
metadata and connect to the correct resource.

The value should be the origin only:

```text
https://your-tunnel-host.example.com
```

Do not include `/mcp` in `DEVSPACE_PUBLIC_BASE_URL`.

By default, DevSpace derives allowed Host headers from the local host and public
URL. Use `DEVSPACE_ALLOWED_HOSTS=*` only for intentional local debugging.

## Tunnels

DevSpace does not manage tunnels. Your tunnel or reverse proxy should point to:

```text
http://127.0.0.1:7676
```

Prefer adding Cloudflare Access, Tailscale identity controls, or equivalent
protection in front of public tunnels. DevSpace OAuth still protects the MCP
endpoint, but the tunnel URL should not be treated as a secret.

## Shell Access

The shell tool is powerful by design. It is meant for tests, builds, git, and
package scripts.

Filesystem path containment applies to DevSpace file tools. Shell commands run
as local commands and can do what your user account can do. This is why the MCP
client must be trusted and the Owner password must stay private.

## Worktrees

Managed worktrees reduce accidental edits to your active checkout, but they are
not a security boundary. They are a workflow boundary for isolated coding
sessions.

## Native File Download

Native file download is an opt-in, one-shot transfer into an already-open
workspace. `download_artifact` accepts the MCP host's native file value, the
`workspaceId` returned by `open_workspace`, and an unused relative destination
path. It returns only the workspace-relative path and does not create a
persistent artifact service or reusable artifact ID.

DevSpace accepts only the documented native-file object and trusted OpenAI
download hosts and redirects. Arbitrary URL strings, local source paths,
credentials, malformed references, and unknown object fields are rejected.

Absolute paths, traversal, symlinked parents, and existing destinations also
fail closed. Downloads stream under the configured per-file limit and are
published without overwrite as owner-only files. DevSpace does not extract or
execute transferred content.

## Logs

By default, DevSpace logs requests and tool calls. Shell command previews are
disabled unless `DEVSPACE_LOG_SHELL_COMMANDS=1`.

Do not enable shell command logging if commands may contain secrets.

Artifact tool logs contain bounded workspace ID, validated hostname,
workspace-relative output path, byte count, hash, duration, and status metadata.
`download_artifact` does not log the opaque file value. Raw content, connector
references, native file IDs, bearer credentials, presigned URLs, host paths,
temporary paths, and base64 chunks are never included in tool logs or tool
results.

## Declarative Agy Delegation

The optional declarative Agy surface narrows agent execution into two explicit
MCP tools instead of exposing Agy through arbitrary shell text. This is a
least-privilege and auditability boundary; it is not a promise that every MCP
host or platform will accept agent delegation.

### Four state categories

V1 distinguishes four kinds of state:

1. **Persistent project state** — source files, Git metadata, and durable
   project configuration. Delegated mutation is denied.
2. **External state** — GitHub, messages, cloud resources, purchases, account
   settings, uploads, and other remote/user-visible effects. Delegated mutation
   is denied.
3. **Persistent runtime/control-plane state** — cached authentication, Agy
   settings, resumable conversation/session metadata, telemetry/crash state,
   DevSpace receipts/logs, caches, and update metadata. V1 permits cached-auth
   consumption only inside the trusted Agy CLI boundary; delegated model/tool
   surfaces do not receive credentials.
4. **Ephemeral execution state** — disposable snapshots, temporary HOME/cache,
   validation artifacts, and bounded evidence. These writes are allowed only
   where the selected profile needs them.

`auth.read_secret=false` means secret bytes are not exposed to the delegated
model, prompt, GUI broker, task tools, or public MCP result. It does not mean
the trusted Agy authentication subsystem never consumes its own cached
credential while contacting the configured model provider.

### Runtime policy

Before a real run, DevSpace verifies the configured Agy settings report
`enableTelemetry=false`. It does not persistently edit Agy settings to satisfy
that requirement. Real runs use a task-local HOME, disable update routines, and
do not use `--continue`, `--conversation`, or
`--dangerously-skip-permissions`.

On macOS, Agy's cached authentication is backed by the user's login Keychain.
The task-local HOME therefore projects only the verified user-owned
`login.keychain-db` path into its own `Library/Keychains` directory so the
trusted Agy CLI can resolve its cached credential. DevSpace does not read or
copy credential bytes into task state, prompts, tool arguments, artifacts, or
MCP results. The projection is accepted only when the host keychain is a
non-symlink regular file owned by the current user and is not group- or
world-writable; an unexpected task-local projection fails closed.

The model contract is fail-closed: the command contains the exact fixed model
and effort, the worker emits stream JSON, and `init.model` must equal
`gemini-3.8-flash-high`. Missing model telemetry is not treated as success.
There is no internal executor/model fallback inside `delegate_to_agy`.

### Repository profiles

`repo-read` and `repo-validate` require the caller to supply the exact reviewed
`expected_source_head`. DevSpace compares it with the live Git HEAD before
exporting or starting a worker. The worker receives a disposable archive of
only the declared committed-HEAD paths, without `.git`, symlinks, or known
sensitive paths. Gitleaks scans that bounded snapshot before cloud delegation.

Source fingerprints are captured before and after execution. `repo-read` does
not run validation commands. `repo-validate` accepts only structured argv from
a small validator allowlist; DevSpace, not Agy, runs those commands in the
disposable snapshot. On macOS the validator uses Seatbelt to deny network and
limit writable locations to ephemeral validation state. Persistent source
remains read-only.

The repository worker also receives a task-local PreToolUse policy that denies
unknown tools, writes, commands, browser/MCP tools, and reads outside the
delegated snapshot.

### GUI observation and actions

`gui-inspect` binds every observation/action to an exact PID, application
identity, and window ID. The broker asks CuaDriver for AX state with screenshots
disabled. Static document/conversation text and editable field values are not
forwarded to Agy; secure/password roles, credential/auth surfaces, and unknown
sensitive views fail closed before model exposure.

Agy never receives a raw CuaDriver executable, raw pixel coordinates, or a
generic click/type interface. It may request only a small semantic intent set.
DevSpace re-snapshots the exact window, reclassifies the fresh AX role, performs
the bounded broker action, and snapshots again. Ambiguous or unsupported
actions fail closed. Scrolling is treated as target-specific transient
navigation, not as intrinsically side-effect-free observation.

The safe claim is therefore that V1 intentionally exposes no
persistent/external mutation capability through the broker. It does not claim
that every third-party GUI operation is intrinsically side-effect-free.
