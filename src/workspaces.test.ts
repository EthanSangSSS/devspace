import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { platform, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { loadConfig, type ServerConfig } from "./config.js";
import {
  checkoutPinnedWorktree,
  GitWorktreeError,
  reserveManagedWorktreePath,
  verifyManagedWorktreeVolumeSync,
} from "./git-worktrees.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

const execFileAsync = promisify(execFile);

test("a checkout exposes initial and nested instruction context while filtering outside symlinks", async (t) => {
  const context = await fixture(t);
  const opened = await context.registry.openWorkspace(context.root);

  assert.match(opened.workspace.id, /^ws_[a-f0-9]{10}$/);
  assert.equal(opened.workspace.mode, "checkout");
  assert.deepEqual(
    opened.agentsFiles.map((file) => file.content),
    ["global instructions\n", "root instructions\n"],
  );
  assert.deepEqual(
    opened.availableAgentsFiles.map((file) => file.path),
    [join(context.root, "nested", "AGENTS.md")],
  );
  assert.deepEqual(
    opened.workspace.agentProfiles.map((profile) => ({
      name: profile.name,
      description: profile.description,
      provider: profile.provider,
      body: profile.body,
    })),
    [{
      name: "reviewer",
      description: "Read-only project reviewer.",
      provider: "codex",
      body: "Review only.",
    }],
  );

  if (platform() !== "win32") {
    const unsafeAgentDir = join(context.root, ".pi", "unsafe-agent");
    await mkdir(unsafeAgentDir, { recursive: true });
    await writeFile(join(context.outsideRoot, "secret.txt"), "outside secret\n");
    await symlink(join(context.outsideRoot, "secret.txt"), join(unsafeAgentDir, "AGENTS.md"));

    const unsafeConfig = loadConfig(writeTestDevspaceConfig(
      join(context.root, ".devspace-unsafe-home"),
      {
        server: { port: 1 },
        workspaces: {
          allowedRoots: [context.root],
          worktreeRoot: join(context.root, ".devspace", "unsafe-worktrees"),
        },
        skills: { agentDir: unsafeAgentDir },
      },
    ));
    const unsafeWorkspace = await new WorkspaceRegistry(unsafeConfig).openWorkspace(context.root);

    assert.deepEqual(
      unsafeWorkspace.agentsFiles.map((file) => file.content),
      ["root instructions\n"],
    );
  }
});

test("opening a missing checkout creates its workspace root", async (t) => {
  const context = await fixture(t);
  const missingRoot = join(context.root, "missing", "workspace");

  const opened = await context.registry.openWorkspace(missingRoot);
  assert.equal(opened.workspace.root, missingRoot);
  assert.equal((await stat(missingRoot)).isDirectory(), true);
});

test("incomplete SSD policy does not disable unrelated internal checkouts", async (t) => {
  const context = await fixture(t);
  context.config.managedWorktreeVolumeUuid = "11111111-1111-1111-1111-111111111111";
  context.config.managedWorktreeMountPoint = "";

  const opened = await context.registry.openWorkspace(context.root);
  assert.equal(opened.workspace.mode, "checkout");
  assert.equal(opened.workspace.root, context.root);
  assert.equal(context.registry.getWorkspace(opened.workspace.id).root, context.root);
});

test("protected SSD checkout refuses to create a host fallback when its mount is missing", async (t) => {
  const context = await fixture(t);
  const missingMount = join(context.root, "disconnected-external-ssd");
  const checkout = join(missingMount, "Developer", "new-project");
  const config = loadConfig(writeTestDevspaceConfig(
    join(context.root, "checkout-offline-config"),
    { server: { port: 1 }, workspaces: {
      allowedRoots: [context.root], worktreeRoot: join(missingMount, "Worktrees"),
      requireExistingWorktreeRoot: true,
      managedWorktreeMountPoint: missingMount,
      managedWorktreeVolumeUuid: "00000000-0000-0000-0000-000000000000",
    } },
  ));

  await assert.rejects(
    () => new WorkspaceRegistry(config).openWorkspace(checkout),
    /configured mounted encrypted APFS volume|protected checkout volume/i,
  );
  await assert.rejects(stat(missingMount), { code: "ENOENT" });
});

test("protected SSD checkout rejects an existing directory on the wrong physical volume", async (t) => {
  const context = await fixture(t);
  const hostMount = join(context.root, "host-fallback-dir");
  const checkout = join(hostMount, "Developer", "project");
  await mkdir(checkout, { recursive: true });
  const sentinel = join(checkout, "preserve-existing-data.txt");
  await writeFile(sentinel, "untouched\n");
  const config = loadConfig(writeTestDevspaceConfig(
    join(context.root, "checkout-wrong-volume-config"),
    { server: { port: 1 }, workspaces: {
      allowedRoots: [context.root], worktreeRoot: join(hostMount, "Worktrees"),
      requireExistingWorktreeRoot: true,
      managedWorktreeMountPoint: hostMount,
      managedWorktreeVolumeUuid: "00000000-0000-0000-0000-000000000000",
    } },
  ));

  await assert.rejects(
    () => new WorkspaceRegistry(config).openWorkspace(checkout),
    /configured mounted encrypted APFS volume|protected checkout volume/i,
  );
  assert.equal(await readFile(sentinel, "utf8"), "untouched\n");
});

test("a checkout symlink alias cannot bypass a configured protected SSD mount", { skip: platform() === "win32" }, async (t) => {
  const context = await fixture(t);
  const hostMount = join(context.root, "host-dir-impersonating-ssd");
  const alias = join(context.root, "checkout-volume-alias");
  const checkout = join(hostMount, "Developer", "project");
  await mkdir(checkout, { recursive: true });
  await symlink(hostMount, alias, "dir");
  const config = loadConfig(writeTestDevspaceConfig(
    join(context.root, "checkout-aliased-offline-config"),
    { server: { port: 1 }, workspaces: {
      allowedRoots: [context.root], worktreeRoot: join(hostMount, "Worktrees"),
      requireExistingWorktreeRoot: true,
      managedWorktreeMountPoint: hostMount,
      managedWorktreeVolumeUuid: "00000000-0000-0000-0000-000000000000",
    } },
  ));

  await assert.rejects(
    () => new WorkspaceRegistry(config).openWorkspace(join(alias, "Developer", "project")),
    /protected checkout volume/i,
  );
  assert.equal((await stat(checkout)).isDirectory(), true);
});

test("opt-in real encrypted SSD checkout retains its UUID across cache and restart", async (t) => {
  const mount = process.env.DEVSPACE_TEST_SSD_MOUNT_POINT;
  const uuid = process.env.DEVSPACE_TEST_SSD_VOLUME_UUID;
  if (platform() !== "darwin" || !mount || !uuid) {
    t.skip("Requires explicitly configured real encrypted APFS SSD test volume");
    return;
  }

  const context = await fixture(t);
  const scratch = join(mount, "Scratch");
  const config = loadConfig(writeTestDevspaceConfig(
    join(context.root, "checkout-real-ssd-config"),
    { server: { port: 1 }, workspaces: {
      allowedRoots: [scratch], worktreeRoot: join(mount, "Worktrees"),
      requireExistingWorktreeRoot: true,
      managedWorktreeMountPoint: mount,
      managedWorktreeVolumeUuid: uuid,
    }, skills: { agentDir: context.agentDir } },
  ));
  verifyManagedWorktreeVolumeSync(config);
  assert.equal((await stat(scratch)).dev, (await stat(mount)).dev);

  const checkout = await mkdtemp(join(scratch, ".devspace-checkout-volume-test-"));
  t.after(async () => { await rmdir(checkout); });
  const store = new SqliteWorkspaceStore(join(context.root, "checkout-real-ssd-store"));
  try {
    const registry = new WorkspaceRegistry(config, store);
    const opened = await registry.openWorkspace(checkout);
    assert.equal(store.getSession(opened.workspace.id)?.rootVolumeUuid?.toUpperCase(), uuid.toUpperCase());
    assert.equal(registry.getWorkspace(opened.workspace.id).root, checkout);
    assert.equal(new WorkspaceRegistry(config, store).getWorkspace(opened.workspace.id).root, checkout);

    config.managedWorktreeVolumeUuid = "00000000-0000-0000-0000-000000000000";
    assert.throws(() => registry.getWorkspace(opened.workspace.id), /protected checkout volume/i);
    assert.throws(() => new WorkspaceRegistry(config, store).getWorkspace(opened.workspace.id),
      /protected checkout volume/i);
  } finally {
    store.close();
  }
});

test("a protected SSD tool lookup validates diskutil without blocking the event loop", async (t) => {
  const mount = process.env.DEVSPACE_TEST_SSD_MOUNT_POINT;
  const uuid = process.env.DEVSPACE_TEST_SSD_VOLUME_UUID;
  if (platform() !== "darwin" || !mount || !uuid) {
    t.skip("Requires explicitly configured real encrypted APFS SSD test volume");
    return;
  }
  const context = await fixture(t);
  const scratch = join(mount, "Scratch");
  const config = loadConfig(writeTestDevspaceConfig(
    join(context.root, "async-checkout-volume-config"),
    { server: { port: 1 }, workspaces: {
      allowedRoots: [scratch], worktreeRoot: join(mount, "Worktrees"),
      requireExistingWorktreeRoot: true, managedWorktreeMountPoint: mount,
      managedWorktreeVolumeUuid: uuid,
    }, skills: { agentDir: context.agentDir } },
  ));
  verifyManagedWorktreeVolumeSync(config);
  const checkout = await mkdtemp(join(scratch, ".devspace-async-checkout-test-"));
  t.after(async () => { await rmdir(checkout); });
  const registry = new WorkspaceRegistry(config);
  const opened = await registry.openWorkspace(checkout);

  let eventLoopTicked = false;
  setImmediate(() => { eventLoopTicked = true; });
  const reused = await registry.getWorkspaceForTool(opened.workspace.id);
  assert.equal(eventLoopTicked, true, "A diskutil check must not block unrelated MCP sessions");
  assert.equal(reused.id, opened.workspace.id);
  config.managedWorktreeVolumeUuid = "00000000-0000-0000-0000-000000000000";
  await assert.rejects(() => registry.getWorkspaceForTool(opened.workspace.id),
    /protected checkout volume/i);
});

test("opening a protected SSD checkout does not synchronously block the event loop", async (t) => {
  const mount = process.env.DEVSPACE_TEST_SSD_MOUNT_POINT;
  const uuid = process.env.DEVSPACE_TEST_SSD_VOLUME_UUID;
  if (platform() !== "darwin" || !mount || !uuid) {
    t.skip("Requires explicitly configured real encrypted APFS SSD test volume");
    return;
  }
  const context = await fixture(t);
  const scratch = join(mount, "Scratch");
  const config = loadConfig(writeTestDevspaceConfig(
    join(context.root, "async-checkout-open-config"),
    { server: { port: 1 }, workspaces: {
      allowedRoots: [scratch], worktreeRoot: join(mount, "Worktrees"),
      requireExistingWorktreeRoot: true, managedWorktreeMountPoint: mount,
      managedWorktreeVolumeUuid: uuid,
    }, skills: { agentDir: context.agentDir } },
  ));
  const checkout = await mkdtemp(join(scratch, ".devspace-async-open-test-"));
  t.after(async () => { await rmdir(checkout); });
  const registry = new WorkspaceRegistry(config);
  const startedAt = performance.now();
  const pending = registry.openWorkspace(checkout);
  const synchronousDelayMs = performance.now() - startedAt;
  assert.ok(synchronousDelayMs < 75,
    `Opening an SSD checkout blocked the event loop for ${synchronousDelayMs.toFixed(0)} ms`);
  assert.equal((await pending).workspace.root, checkout);
});

test("a verified removable SSD checkout still never auto-creates a missing directory", async (t) => {
  const mount = process.env.DEVSPACE_TEST_SSD_MOUNT_POINT;
  const uuid = process.env.DEVSPACE_TEST_SSD_VOLUME_UUID;
  if (platform() !== "darwin" || !mount || !uuid) {
    t.skip("Requires explicitly configured real encrypted APFS SSD test volume");
    return;
  }
  const context = await fixture(t);
  const scratch = join(mount, "Scratch");
  const config = loadConfig(writeTestDevspaceConfig(
    join(context.root, "checkout-no-auto-mkdir-config"),
    { server: { port: 1 }, workspaces: {
      allowedRoots: [scratch], worktreeRoot: join(mount, "Worktrees"),
      requireExistingWorktreeRoot: true, managedWorktreeMountPoint: mount,
      managedWorktreeVolumeUuid: uuid,
    }, skills: { agentDir: context.agentDir } },
  ));
  verifyManagedWorktreeVolumeSync(config);
  assert.equal((await stat(scratch)).dev, (await stat(mount)).dev);

  const missingCheckout = join(scratch, `.checkout-not-created-${randomBytes(8).toString("hex")}`);
  t.after(async () => {
    try { await rmdir(missingCheckout); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  });
  await assert.rejects(
    () => new WorkspaceRegistry(config).openWorkspace(missingCheckout),
    /protected checkout volume|ENOENT|no such file/i,
  );
  await assert.rejects(stat(missingCheckout), { code: "ENOENT" });
});

test("protected SSD checkout rejects a path symlinked onto an internal disk", async (t) => {
  const mount = process.env.DEVSPACE_TEST_SSD_MOUNT_POINT;
  const uuid = process.env.DEVSPACE_TEST_SSD_VOLUME_UUID;
  if (platform() !== "darwin" || !mount || !uuid) {
    t.skip("Requires explicitly configured real encrypted APFS SSD test volume");
    return;
  }
  const context = await fixture(t);
  const scratch = join(mount, "Scratch");
  const config = loadConfig(writeTestDevspaceConfig(
    join(context.root, "checkout-ssd-symlink-escape-config"),
    { server: { port: 1 }, workspaces: {
      allowedRoots: [scratch, context.root], worktreeRoot: join(mount, "Worktrees"),
      requireExistingWorktreeRoot: true, managedWorktreeMountPoint: mount,
      managedWorktreeVolumeUuid: uuid,
    }, skills: { agentDir: context.agentDir } },
  ));
  verifyManagedWorktreeVolumeSync(config);
  assert.equal((await stat(scratch)).dev, (await stat(mount)).dev);

  const alias = join(scratch, `.checkout-wrong-device-${randomBytes(8).toString("hex")}`);
  await symlink(context.root, alias, "dir");
  t.after(async () => { await unlink(alias); });
  await assert.rejects(
    () => new WorkspaceRegistry(config).openWorkspace(alias),
    /protected checkout volume/i,
  );
  assert.equal((await stat(context.root)).isDirectory(), true);
});

test("cached and restored checkout sessions revalidate an enabled protected SSD volume", async (t) => {
  const context = await fixture(t);
  const fakeMount = join(context.root, "host-mount-for-session");
  const checkout = join(fakeMount, "Developer", "project");
  await mkdir(checkout, { recursive: true });
  const store = new SqliteWorkspaceStore(join(context.root, "checkout-volume-store"));
  try {
    const registry = new WorkspaceRegistry(context.config, store);
    const opened = await registry.openWorkspace(checkout);
    assert.equal(registry.getWorkspace(opened.workspace.id).root, checkout);

    context.config.managedWorktreeMountPoint = fakeMount;
    context.config.managedWorktreeVolumeUuid = "00000000-0000-0000-0000-000000000000";
    context.config.worktreeRoot = join(fakeMount, "Worktrees");
    context.config.requireExistingWorktreeRoot = true;

    assert.throws(() => registry.getWorkspace(opened.workspace.id),
      /configured mounted encrypted APFS volume|protected checkout volume/i);
    assert.throws(() => new WorkspaceRegistry(context.config, store)
      .getWorkspace(opened.workspace.id),
    /configured mounted encrypted APFS volume|protected checkout volume/i);
  } finally {
    store.close();
  }
});

test("a stored volume-bound checkout cannot be restored after its guard is removed", async (t) => {
  const context = await fixture(t);
  const checkout = join(context.root, "historical-ssd-checkout");
  await mkdir(checkout);
  const store = new SqliteWorkspaceStore(join(context.root, "bound-checkout-store"));
  try {
    store.createSession({
      id: "checkout_bound_test", root: checkout, mode: "checkout", managed: false,
      rootVolumeUuid: "11111111-1111-1111-1111-111111111111",
    });
    assert.throws(() => new WorkspaceRegistry(context.config, store)
      .getWorkspace("checkout_bound_test"), /protected checkout volume|unverified checkout volume/i);
  } finally {
    store.close();
  }
});

test("a temporarily missing protected checkout never discards its persisted conversation binding", async (t) => {
  const context = await fixture(t);
  const missingMount = join(context.root, "offline-volume-with-bound-session");
  const checkout = join(missingMount, "Developer", "historical-project");
  const config = loadConfig(writeTestDevspaceConfig(
    join(context.root, "checkout-temporary-disconnect-config"),
    { server: { port: 1 }, workspaces: {
      allowedRoots: [context.root],
      worktreeRoot: join(missingMount, "Worktrees"),
      requireExistingWorktreeRoot: true,
      managedWorktreeMountPoint: missingMount,
      managedWorktreeVolumeUuid: "00000000-0000-0000-0000-000000000000",
    } },
  ));
  const store = new SqliteWorkspaceStore(join(context.root, "checkout-offline-binding-store"));
  const scopeId = "conversation_offline_mount_test";
  const canonicalCheckout = join(await realpath(context.root),
    "offline-volume-with-bound-session", "Developer", "historical-project");
  const targetKey = JSON.stringify(["checkout", canonicalCheckout, null]);
  const previousId = "ws_saved_offline_checkout";
  try {
    store.createSession({ id: previousId, root: checkout, mode: "checkout" });
    store.setConversationBinding({
      conversationScopeId: scopeId, targetKey, workspaceSessionId: previousId,
    });
    assert.equal(store.getConversationBinding(scopeId, targetKey)?.workspaceSessionId, previousId);

    await assert.rejects(
      () => new WorkspaceRegistry(config, store).openWorkspace(checkout, {
        conversationScopeId: scopeId,
      }),
      /protected checkout volume|no such file|unverified/i,
    );
    assert.equal(store.getConversationBinding(scopeId, targetKey)?.workspaceSessionId, previousId);
    assert.equal(store.getSession(previousId)?.root, checkout);
    await assert.rejects(stat(missingMount), { code: "ENOENT" });
  } finally {
    store.close();
  }
});

test("a successfully opened replacement checkout atomically updates a stale conversation binding", async (t) => {
  const context = await fixture(t);
  const store = new SqliteWorkspaceStore(join(context.root, "checkout-replacement-binding-store"));
  const scopeId = "conversation_checkout_replacement_test";
  const targetKey = JSON.stringify(["checkout", await realpath(context.root), null]);
  const previousId = "ws_stale_checkout_binding";
  const missingOldRoot = join(context.root, "missing-old-checkout");
  try {
    store.createSession({ id: previousId, root: missingOldRoot, mode: "checkout" });
    store.setConversationBinding({
      conversationScopeId: scopeId, targetKey, workspaceSessionId: previousId,
    });

    const opened = await new WorkspaceRegistry(context.config, store)
      .openWorkspace(context.root, { conversationScopeId: scopeId });
    assert.equal(opened.workspace.root, context.root);
    assert.notEqual(opened.workspace.id, previousId);
    assert.equal(store.getConversationBinding(scopeId, targetKey)?.workspaceSessionId,
      opened.workspace.id);
    assert.equal(store.getSession(previousId)?.root, missingOldRoot);
    await assert.rejects(stat(missingOldRoot), { code: "ENOENT" });
  } finally {
    store.close();
  }
});

test("worktree opens require Git and create an isolated managed workspace", async (t) => {
  const context = await fixture(t);

  await assert.rejects(
    () => context.registry.openWorkspace({ path: context.root, mode: "worktree" }),
    (error: unknown) =>
      error instanceof GitWorktreeError && error.code === "GIT_REPOSITORY_NOT_FOUND",
  );

  const gitRoot = await createGitProject(context.root);
  await writeFile(join(gitRoot, "dirty.txt"), "not copied\n");

  const opened = await context.registry.openWorkspace({ path: gitRoot, mode: "worktree" });

  assert.equal(opened.workspace.mode, "worktree");
  assert.notEqual(opened.workspace.root, gitRoot);
  assert.equal(opened.workspace.sourceRoot, gitRoot);
  assert.equal(opened.workspace.worktree?.baseRef, "HEAD");
  assert.equal(opened.workspace.worktree?.dirtySource, true);
  assert.equal(opened.workspace.worktree?.managed, true);
  assert.equal((await stat(opened.workspace.root)).isDirectory(), true);
  assert.match(opened.agentsFiles.map((file) => file.content).join("\n"), /global instructions/);
  assert.match(opened.agentsFiles.map((file) => file.content).join("\n"), /git root instructions/);

  const resolvedReadme = context.registry.resolvePath(opened.workspace, "README.md");
  assert.equal(resolvedReadme.startsWith(opened.workspace.canonicalRoot), true);
});

test("managed worktree checkout tolerates more than 1 MiB from a post-checkout hook", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const hook = join(gitRoot, ".git", "hooks", "post-checkout");
  await writeFile(hook, [
    "#!/bin/sh",
    "node -e 'require(\"node:fs\").writeFileSync(\"hook-output.marker\", \"ok\"); process.stdout.write(\"x\".repeat(1250000))'",
    "",
  ].join("\n"));
  await chmod(hook, 0o755);

  const opened = await context.registry.openWorkspace({ path: gitRoot, mode: "worktree" });
  assert.equal(await readFile(join(opened.workspace.root, "hook-output.marker"), "utf8"), "ok");
  // Git normally converts checkout text to CRLF on Windows.
  assert.equal((await readFile(join(opened.workspace.root, "README.md"), "utf8"))
    .replace(/\r\n/g, "\n"), "hello\n");
});

test("managed worktree reservation retries collisions without touching existing files", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const worktreeRoot = context.config.worktreeRoot;
  await mkdir(worktreeRoot, { recursive: true });

  const collidedId = "0".repeat(24);
  const nextId = "1".repeat(24);
  const existing = join(worktreeRoot, `git-project-${collidedId}`);
  await mkdir(existing);
  await writeFile(join(existing, "keep.txt"), "original contents\n");

  const candidates = [collidedId, nextId];
  const reserved = await reserveManagedWorktreePath({
    worktreeRoot,
    repoRoot: gitRoot,
    generateId: () => {
      const id = candidates.shift();
      assert.ok(id, "reservation must not exhaust deterministic candidates");
      return id;
    },
  });

  assert.equal(reserved, join(worktreeRoot, `git-project-${nextId}`));
  assert.equal(await readFile(join(existing, "keep.txt"), "utf8"), "original contents\n");
  assert.deepEqual((await readdir(worktreeRoot)).sort(), [
    `git-project-${collidedId}`,
    `git-project-${nextId}`,
  ]);
  assert.equal(await readFile(join(existing, "keep.txt"), "utf8"), "original contents\n");
});

test("managed worktree reservation never creates an absent parent root", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const missingRoot = join(context.root, "not-mounted-worktree-root");

  await assert.rejects(
    () => reserveManagedWorktreePath({ worktreeRoot: missingRoot, repoRoot: gitRoot }),
    { code: "ENOENT" },
  );
  await assert.rejects(stat(missingRoot), { code: "ENOENT" });
});

test("pinned worktree checkout rejects a replaced symlink target before Git writes", {
  skip: platform() === "win32",
}, async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const worktreeRoot = context.config.worktreeRoot;
  await mkdir(worktreeRoot, { recursive: true });
  const reserved = await reserveManagedWorktreePath({ worktreeRoot, repoRoot: gitRoot });
  const identity = await lstat(reserved, { bigint: true });
  const displaced = join(worktreeRoot, "original-reservation");
  await rename(reserved, displaced);
  await symlink(context.outsideRoot, reserved, "dir");
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: gitRoot });

  await assert.rejects(
    () => checkoutPinnedWorktree({
      sourceRoot: gitRoot,
      worktreeRoot,
      worktreePath: reserved,
      baseSha: stdout.trim(),
      expectedDev: identity.dev.toString(),
      expectedIno: identity.ino.toString(),
    }),
    /Reserved managed worktree directory changed before checkout/,
  );
  assert.deepEqual(await readdir(context.outsideRoot), []);
  assert.deepEqual(await readdir(displaced), []);
});

test("Git cannot follow a symlink swapped after the pinned child has entered its cwd", {
  skip: platform() === "win32",
}, async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const shimDir = join(context.root, "swap-before-git");
  await mkdir(shimDir);
  const shim = join(shimDir, "git");
  await writeFile(shim, [
    "#!/bin/sh",
    "if [ \"$1\" = \"worktree\" ] && [ \"$2\" = \"add\" ]; then",
    "  original=$(/bin/pwd -P)",
    "  /bin/mv \"$original\" \"$original-relocated\"",
    "  /bin/ln -s \"$DEVSPACE_TEST_SWAPPED_TARGET\" \"$original\"",
    "fi",
    "exec /usr/bin/git \"$@\"",
    "",
  ].join("\n"));
  await chmod(shim, 0o700);

  const originalPath = process.env.PATH;
  const originalTarget = process.env.DEVSPACE_TEST_SWAPPED_TARGET;
  process.env.PATH = `${shimDir}:${originalPath ?? ""}`;
  process.env.DEVSPACE_TEST_SWAPPED_TARGET = context.outsideRoot;
  try {
    await assert.rejects(
      () => context.registry.openWorkspace({ path: gitRoot, mode: "worktree" }),
      (error: unknown) => error instanceof GitWorktreeError &&
        error.code === "GIT_WORKTREE_CREATE_FAILED" &&
        /Reserved managed worktree directory changed during checkout/.test(error.message),
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalTarget === undefined) delete process.env.DEVSPACE_TEST_SWAPPED_TARGET;
    else process.env.DEVSPACE_TEST_SWAPPED_TARGET = originalTarget;
  }
  assert.deepEqual(await readdir(context.outsideRoot), []);
  const paths = await readdir(context.config.worktreeRoot);
  const relocated = paths.find((name) => name.endsWith("-relocated"));
  assert.ok(relocated, "the original directory should contain the checkout under a different name");
  assert.equal(await readFile(join(context.config.worktreeRoot, relocated, "README.md"), "utf8"), "hello\n");
});

test("managed worktree reservation fails closed when all candidates collide", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const id = "0".repeat(24);
  const occupied = join(context.config.worktreeRoot, `git-project-${id}`);
  await mkdir(occupied, { recursive: true });
  await writeFile(join(occupied, "keep.txt"), "user content\n");
  let attempts = 0;
  await assert.rejects(
    () => reserveManagedWorktreePath({
      worktreeRoot: context.config.worktreeRoot,
      repoRoot: gitRoot,
      generateId: () => {
        attempts++;
        return id;
      },
    }),
    (error: unknown) => error instanceof GitWorktreeError && error.code === "GIT_WORKTREE_CREATE_FAILED",
  );
  assert.equal(attempts, 10);
  assert.equal(await readFile(join(occupied, "keep.txt"), "utf8"), "user content\n");
});

test("managed worktree reservation fails closed for symlink collision", { skip: platform() === "win32" }, async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const id = "0".repeat(24);
  const foreign = join(context.root, "foreign-directory");
  await mkdir(foreign);
  await writeFile(join(foreign, "keep.txt"), "foreign data\n");
  await mkdir(context.config.worktreeRoot, { recursive: true });
  const link = join(context.config.worktreeRoot, `git-project-${id}`);
  await symlink(foreign, link, "dir");

  await assert.rejects(
    () => reserveManagedWorktreePath({
      worktreeRoot: context.config.worktreeRoot,
      repoRoot: gitRoot,
      generateId: () => id,
    }),
    /outside allowed roots/,
  );
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal(await readFile(join(foreign, "keep.txt"), "utf8"), "foreign data\n");
});

test("failed Git worktree creation retains its reservation without deleting anything", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  await writeFile(join(gitRoot, ".git", "worktrees"), "prevent git metadata creation\n");

  await assert.rejects(
    () => context.registry.openWorkspace({ path: gitRoot, mode: "worktree" }),
    (error: unknown) => error instanceof GitWorktreeError && error.code === "GIT_WORKTREE_CREATE_FAILED",
  );
  const paths = await readdir(context.config.worktreeRoot);
  assert.equal(paths.length, 1, "failed Git must not delete or reuse the reserved path");
  assert.match(paths[0]!, /^git-project-[a-f0-9]{24}$/);
  assert.equal((await stat(join(context.config.worktreeRoot, paths[0]!))).isDirectory(), true);
});

test("checkout-stage failure never promises Git left its worktree target in place", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  await writeFile(join(gitRoot, ".gitattributes"), "README.md filter=checkout-fail\n");
  await git(gitRoot, ["add", ".gitattributes"]);
  await git(gitRoot, ["commit", "-m", "Require failing checkout filter"]);
  await git(gitRoot, ["config", "filter.checkout-fail.clean", "cat"]);
  await git(gitRoot, ["config", "filter.checkout-fail.smudge", "false"]);
  await git(gitRoot, ["config", "filter.checkout-fail.required", "true"]);

  await assert.rejects(
    () => context.registry.openWorkspace({ path: gitRoot, mode: "worktree" }),
    (error: unknown) =>
      error instanceof GitWorktreeError
      && error.code === "GIT_WORKTREE_CREATE_FAILED"
      && /smudge filter '?checkout-fail'? failed/.test(error.message)
      && /DevSpace did not delete the target/.test(error.message)
      && /Git may have removed it/.test(error.message),
  );
  assert.equal(await readFile(join(gitRoot, "README.md"), "utf8"), "hello\n");
  const remaining = await readdir(context.config.worktreeRoot);
  assert.ok(remaining.length <= 1, "Git may retain or clean up its own failed checkout");
  for (const entry of remaining) {
    assert.match(entry, /^git-project-[a-f0-9]{24}$/);
  }
});

test("persisted checkout and worktree sessions restore after recreating the registry", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const stateDir = join(context.root, ".state");
  const firstStore = new SqliteWorkspaceStore(stateDir);
  const firstRegistry = new WorkspaceRegistry(context.config, firstStore);

  const checkout = await firstRegistry.openWorkspace(context.root);
  const worktree = await firstRegistry.openWorkspace({ path: gitRoot, mode: "worktree" });
  firstStore.close();

  const secondStore = new SqliteWorkspaceStore(stateDir);
  try {
    const restoredRegistry = new WorkspaceRegistry(context.config, secondStore);
    const restoredCheckout = restoredRegistry.getWorkspace(checkout.workspace.id);
    const restoredWorktree = restoredRegistry.getWorkspace(worktree.workspace.id);

    assert.equal(restoredCheckout.root, context.root);
    assert.equal(restoredCheckout.mode, "checkout");
    assert.equal(restoredWorktree.root, worktree.workspace.root);
    assert.equal(restoredWorktree.mode, "worktree");
    assert.equal(restoredWorktree.sourceRoot, gitRoot);
    assert.equal(restoredWorktree.worktree?.managed, true);
  } finally {
    secondStore.close();
  }
});

test("a restarted registry rejects a replaced managed worktree at the original path without touching it", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const stateDir = join(context.root, "state-restart-same-path");
  const originalStore = new SqliteWorkspaceStore(stateDir);
  const initial = await new WorkspaceRegistry(context.config, originalStore)
    .openWorkspace({ path: gitRoot, mode: "worktree" });
  const storedId = initial.workspace.id;
  const oldPath = initial.workspace.root;
  const displacedPath = join(context.root, "original-worktree-preserved");
  originalStore.close();

  await rename(oldPath, displacedPath);
  await mkdir(oldPath);
  // An impersonator can copy the legitimate Git pointer without having the
  // inode originally persisted for the workspace session.
  await copyFile(join(displacedPath, ".git"), join(oldPath, ".git"));
  await writeFile(join(oldPath, "other-users-data.txt"), "keep untouched\n");

  const restoredStore = new SqliteWorkspaceStore(stateDir);
  try {
    const restarted = new WorkspaceRegistry(context.config, restoredStore);
    assert.throws(
      () => restarted.getWorkspace(storedId),
      /workspace root (changed|replaced)|unverified.*worktree/i,
    );
    assert.equal(await readFile(join(oldPath, "other-users-data.txt"), "utf8"), "keep untouched\n");
    assert.deepEqual(await readdir(oldPath), [".git", "other-users-data.txt"]);
    assert.equal((await stat(displacedPath)).isDirectory(), true);
  } finally {
    restoredStore.close();
  }
});

test("a restarted registry refuses a missing managed worktree without recreating its directory", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const stateDir = join(context.root, "state-restart-missing-path");
  const store = new SqliteWorkspaceStore(stateDir);
  const opened = await new WorkspaceRegistry(context.config, store)
    .openWorkspace({ path: gitRoot, mode: "worktree" });
  store.close();

  const displaced = join(context.root, "missing-test-original-preserved");
  await rename(opened.workspace.root, displaced);
  const nextStore = new SqliteWorkspaceStore(stateDir);
  try {
    assert.throws(() => new WorkspaceRegistry(context.config, nextStore)
      .getWorkspace(opened.workspace.id), /no longer accessible|outside allowed roots/i);
    await assert.rejects(stat(opened.workspace.root), { code: "ENOENT" });
    assert.equal((await stat(displaced)).isDirectory(), true);
  } finally {
    nextStore.close();
  }
});

test("a restarted registry refuses an SSD-managed session on a wrong or unmounted volume", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const stateDir = join(context.root, "state-restart-wrong-volume");
  const store = new SqliteWorkspaceStore(stateDir);
  const initial = await new WorkspaceRegistry(context.config, store)
    .openWorkspace({ path: gitRoot, mode: "worktree" });
  store.close();

  // This is a normal host directory deliberately impersonating a mounted
  // external volume. A restart must not treat it as the real encrypted SSD.
  const fakeMount = join(context.root, "fake-external-volume");
  await mkdir(fakeMount);
  const mountedConfig = loadConfig(writeTestDevspaceConfig(
    join(context.root, "config-restart-mount-identity"),
    { server: { port: 1 }, workspaces: {
      allowedRoots: [context.root],
      worktreeRoot: context.config.worktreeRoot,
      requireExistingWorktreeRoot: true,
      managedWorktreeMountPoint: fakeMount,
      managedWorktreeVolumeUuid: "00000000-0000-0000-0000-000000000000",
    } },
  ));
  const secondStore = new SqliteWorkspaceStore(stateDir);
  try {
    const restarted = new WorkspaceRegistry(mountedConfig, secondStore);
    assert.throws(() => restarted.getWorkspace(initial.workspace.id),
      /mounted encrypted APFS volume|unverified.*worktree/i);
    assert.equal((await stat(initial.workspace.root)).isDirectory(), true);
  } finally {
    secondStore.close();
  }
});

test("a restarted registry refuses a historical managed session whose Git worktree backlink is absent", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const stateDir = join(context.root, "state-restart-legacy-impostor");
  const store = new SqliteWorkspaceStore(stateDir);
  const initial = await new WorkspaceRegistry(context.config, store)
    .openWorkspace({ path: gitRoot, mode: "worktree" });
  // Historical rows predate persisted directory identity. Keep their columns
  // empty so this tests the Git backlink fallback, not the new inode check.
  const historicalId = "ws_old_session_without_physical_identity";
  store.createSession({
    id: historicalId,
    root: initial.workspace.root,
    mode: "worktree",
    sourceRoot: gitRoot,
    baseRef: "HEAD",
    baseSha: initial.workspace.worktree?.baseSha,
    managed: true,
  });
  store.close();

  const oldPath = initial.workspace.root;
  const displacedPath = join(context.root, "legacy-git-worktree-preserved");
  await rename(oldPath, displacedPath);
  await mkdir(oldPath);
  await writeFile(join(oldPath, "unrelated.txt"), "do not remove\n");

  const store2 = new SqliteWorkspaceStore(stateDir);
  try {
    const restarted = new WorkspaceRegistry(context.config, store2);
    assert.throws(() => restarted.getWorkspace(historicalId),
      /workspace root (changed|replaced)|unverified.*worktree/i);
    assert.equal(await readFile(join(oldPath, "unrelated.txt"), "utf8"), "do not remove\n");
  } finally {
    store2.close();
  }
});

test("an existing pre-identity SQLite session migrates without guessing its physical inode", async (t) => {
  const context = await fixture(t);
  const stateDir = join(context.root, "pre-identity-schema-state");
  await mkdir(stateDir);
  const dbPath = join(stateDir, "devspace.sqlite");
  const oldDb = new Database(dbPath);
  oldDb.exec(`
    create table devspace_schema_migrations (
      version integer primary key, name text not null, applied_at text not null
    );
    insert into devspace_schema_migrations values
      (1, 'workspace-state', '2026-01-01'),
      (2, 'oauth-state', '2026-01-01'),
      (3, 'local-agent-sessions', '2026-01-01'),
      (4, 'workspace-conversation-bindings', '2026-01-01'),
      (5, 'local-agent-structured-errors', '2026-01-01'),
      (6, 'local-agent-effort-rename', '2026-01-01');
    create table workspace_sessions (
      id text primary key, root text not null, status text not null,
      mode text not null, source_root text, base_ref text, base_sha text,
      managed text not null, created_at text not null, last_used_at text not null
    );
    insert into workspace_sessions values (
      'ws_legacy_schema', '/legacy/example', 'active', 'worktree',
      '/source/example', 'HEAD', '0000000000000000000000000000000000000000',
      'true', '2026-01-01', '2026-01-01'
    );
  `);
  oldDb.close();

  const upgraded = new SqliteWorkspaceStore(stateDir);
  try {
    const historic = upgraded.getSession("ws_legacy_schema");
    assert.equal(historic?.root, "/legacy/example");
    assert.equal(historic?.rootInode, undefined);
    assert.equal(historic?.rootVolumeUuid, undefined);
    const added = upgraded.createSession({
      id: "ws_new_schema",
      root: context.root,
      mode: "checkout",
      rootInode: "123456789012345678",
    });
    assert.equal(added.rootInode, "123456789012345678");
    assert.equal(upgraded.getSession("ws_new_schema")?.rootInode, "123456789012345678");
  } finally {
    upgraded.close();
  }
});

test("a restarted legacy session restores when its Git source is itself a linked worktree", async (t) => {
  const context = await fixture(t);
  const main = await createGitProject(context.root);
  const stateDir = join(context.root, "legacy-linked-source-state");
  const store = new SqliteWorkspaceStore(stateDir);
  const original = new WorkspaceRegistry(context.config, store);
  const firstLinked = await original.openWorkspace({ path: main, mode: "worktree" });
  const secondLinked = await original.openWorkspace({
    path: firstLinked.workspace.root, mode: "worktree",
  });
  assert.equal(secondLinked.workspace.sourceRoot, firstLinked.workspace.root);
  store.close();

  const reopened = new SqliteWorkspaceStore(stateDir);
  try {
    const restarted = new WorkspaceRegistry(context.config, reopened);
    const recovered = restarted.getWorkspace(secondLinked.workspace.id);
    assert.equal(recovered.id, secondLinked.workspace.id);
    assert.equal(recovered.root, secondLinked.workspace.root);
    assert.equal(recovered.sourceRoot, firstLinked.workspace.root);
  } finally {
    reopened.close();
  }
});

test("a restarted registry accepts the same managed worktree on the verified real encrypted SSD", {
  skip: !(process.env.DEVSSD_ACCEPT_MOUNT && process.env.DEVSSD_ACCEPT_UUID),
}, async (t) => {
  const mount = process.env.DEVSSD_ACCEPT_MOUNT!;
  const uuid = process.env.DEVSSD_ACCEPT_UUID!;
  assert.equal(platform(), "darwin");
  assert.equal(mount, "/Volumes/DevSSD");
  assert.match(uuid, /^[0-9a-fA-F-]{8}(-[0-9a-fA-F-]{4}){3}-[0-9a-fA-F-]{12}$/);
  assert.notEqual((await stat(mount)).dev, (await stat(dirname(mount))).dev);
  const scratch = join(mount, "Scratch");
  assert.equal((await lstat(scratch)).isSymbolicLink(), false);
  const { stdout } = await execFileAsync("/usr/sbin/diskutil", ["info", "-plist", mount]);
  assert.match(stdout, new RegExp(`<key>VolumeUUID</key>\\s*<string>${uuid}</string>`, "i"));
  const targetRoot = await mkdtemp(join(scratch, ".devssd-worktree-restart-test-"));
  t.after(async () => {
    // Cleanup only our uniquely named temporary directory on the verified
    // external device. A disconnected disk must never trigger host cleanup.
    const currentMount = await stat(mount).catch(() => undefined);
    const currentRoot = await lstat(targetRoot).catch(() => undefined);
    if (currentMount && currentRoot?.isDirectory() && !currentRoot.isSymbolicLink()
        && currentMount.dev === currentRoot.dev
        && targetRoot.startsWith(`${scratch}/.devssd-worktree-restart-test-`)) {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const stateDir = join(context.root, "ssd-valid-restored-session");
  const config = loadConfig(writeTestDevspaceConfig(
    join(context.root, "ssd-valid-recovery-config"),
    { server: { port: 1 }, workspaces: {
      allowedRoots: [context.root],
      worktreeRoot: targetRoot,
      requireExistingWorktreeRoot: true,
      managedWorktreeSourceRoots: [gitRoot],
      managedWorktreeMountPoint: mount,
      managedWorktreeVolumeUuid: uuid,
    } },
  ));
  const firstStore = new SqliteWorkspaceStore(stateDir);
  const firstRegistry = new WorkspaceRegistry(config, firstStore);
  const created = await firstRegistry
    .openWorkspace({ path: gitRoot, mode: "worktree" });
  assert.equal(firstRegistry.getWorkspace(created.workspace.id).id, created.workspace.id);
  config.managedWorktreeVolumeUuid = "00000000-0000-0000-0000-000000000000";
  assert.throws(
    () => firstRegistry.getWorkspace(created.workspace.id),
    /configured mounted encrypted APFS volume/,
  );
  config.managedWorktreeVolumeUuid = uuid;
  assert.equal(firstRegistry.getWorkspace(created.workspace.id).id, created.workspace.id);
  const persisted = firstStore.getSession(created.workspace.id);
  assert.equal(persisted?.rootVolumeUuid?.toUpperCase(), uuid.toUpperCase());
  assert.match(persisted?.rootInode ?? "", /^\d+$/);
  firstStore.close();

  const nextStore = new SqliteWorkspaceStore(stateDir);
  try {
    const restarted = new WorkspaceRegistry(config, nextStore);
    const recovered = restarted.getWorkspace(created.workspace.id);
    assert.equal(recovered.root, created.workspace.root);
    assert.equal(recovered.sourceRoot, gitRoot);
    assert.equal(recovered.rootInode, created.workspace.rootInode);
  } finally {
    nextStore.close();
  }

  const mismatch = loadConfig(writeTestDevspaceConfig(
    join(context.root, "ssd-wrong-uuid-recovery-config"),
    { server: { port: 1 }, workspaces: {
      allowedRoots: [context.root],
      worktreeRoot: targetRoot,
      requireExistingWorktreeRoot: true,
      managedWorktreeSourceRoots: [gitRoot],
      managedWorktreeMountPoint: mount,
      managedWorktreeVolumeUuid: "00000000-0000-0000-0000-000000000000",
    } },
  ));
  const wrongStore = new SqliteWorkspaceStore(stateDir);
  try {
    assert.throws(() => new WorkspaceRegistry(mismatch, wrongStore)
      .getWorkspace(created.workspace.id), /Unverified managed worktree volume identity/);
  } finally {
    wrongStore.close();
  }

  const relocated = join(targetRoot, "original-worktree-unchanged");
  await rename(created.workspace.root, relocated);
  await mkdir(created.workspace.root);
  await copyFile(join(relocated, ".git"), join(created.workspace.root, ".git"));
  await writeFile(join(created.workspace.root, "foreign-data.txt"), "preserve me\n");
  const replacedStore = new SqliteWorkspaceStore(stateDir);
  try {
    assert.throws(() => new WorkspaceRegistry(config, replacedStore)
      .getWorkspace(created.workspace.id), /Workspace root changed after it was opened/);
    assert.equal(await readFile(join(created.workspace.root, "foreign-data.txt"), "utf8"),
      "preserve me\n");
  } finally {
    replacedStore.close();
  }
});

test("a new managed worktree root retains old stored sessions through explicitly listed legacy roots", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const oldRoot = join(context.root, "managed-old");
  const newRoot = join(context.root, "managed-new");
  const stateDir = join(context.root, "state-dual-roots");
  const oldConfig = loadConfig(writeTestDevspaceConfig(
    join(context.root, "config-old-root"),
    { server: { port: 1 }, workspaces: { allowedRoots: [context.root], worktreeRoot: oldRoot } },
  ));

  const firstStore = new SqliteWorkspaceStore(stateDir);
  const original = await new WorkspaceRegistry(oldConfig, firstStore)
    .openWorkspace({ path: gitRoot, mode: "worktree" });
  assert.ok(original.workspace.root.startsWith(`${oldRoot}${sep}`));
  firstStore.close();

  const newConfig = loadConfig(writeTestDevspaceConfig(
    join(context.root, "config-new-root"),
    {
      server: { port: 1 },
      workspaces: {
        allowedRoots: [context.root],
        worktreeRoot: newRoot,
        legacyWorktreeRoots: [oldRoot],
      },
    },
  ));
  const secondStore = new SqliteWorkspaceStore(stateDir);
  try {
    const registry = new WorkspaceRegistry(newConfig, secondStore);
    const persisted = registry.getWorkspace(original.workspace.id);
    assert.equal(persisted.root, original.workspace.root);
    assert.equal(persisted.mode, "worktree");

    const created = await registry.openWorkspace({ path: gitRoot, mode: "worktree" });
    assert.ok(created.workspace.root.startsWith(`${newRoot}${sep}`));
    assert.equal(created.workspace.sourceRoot, gitRoot);
    assert.equal(registry.getWorkspace(original.workspace.id).root, original.workspace.root);
  } finally {
    secondStore.close();
  }
});

test("switching managed roots without a legacy allowlist rejects old stored worktrees", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const storeDir = join(context.root, "state-reject-legacy");
  const store = new SqliteWorkspaceStore(storeDir);
  const original = await new WorkspaceRegistry(context.config, store)
    .openWorkspace({ path: gitRoot, mode: "worktree" });
  store.close();

  const config = loadConfig(writeTestDevspaceConfig(
    join(context.root, "config-reject-legacy"),
    { server: { port: 1 }, workspaces: {
      allowedRoots: [context.root],
      worktreeRoot: join(context.root, "replacement-root"),
    } },
  ));
  const persistedStore = new SqliteWorkspaceStore(storeDir);
  try {
    const registry = new WorkspaceRegistry(config, persistedStore);
    assert.throws(() => registry.getWorkspace(original.workspace.id), /outside allowed roots/);
  } finally {
    persistedStore.close();
  }
});

test("an external managed root configured as existing-only is never created when missing", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const targetRoot = join(context.root, "unmounted-drive", "worktrees");
  const config = loadConfig(writeTestDevspaceConfig(
    join(context.root, "config-require-existing"),
    { server: { port: 1 }, workspaces: {
      allowedRoots: [context.root],
      worktreeRoot: targetRoot,
      requireExistingWorktreeRoot: true,
    } },
  ));
  const registry = new WorkspaceRegistry(config);

  await assert.rejects(
    () => registry.openWorkspace({ path: gitRoot, mode: "worktree" }),
    (error: unknown) => error instanceof GitWorktreeError &&
      error.code === "GIT_WORKTREE_CREATE_FAILED",
  );
  await assert.rejects(stat(targetRoot), { code: "ENOENT" });

  await mkdir(targetRoot, { recursive: true });
  const created = await registry.openWorkspace({ path: gitRoot, mode: "worktree" });
  assert.ok(created.workspace.root.startsWith(`${targetRoot}${sep}`));
});

test("an existing-only managed root rejects a redirected symlink", { skip: platform() === "win32" }, async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const actualRoot = join(context.root, "other-location");
  const redirectedRoot = join(context.root, "redirected-worktree-root");
  await mkdir(actualRoot);
  await symlink(actualRoot, redirectedRoot, "dir");
  const config = loadConfig(writeTestDevspaceConfig(
    join(context.root, "config-symlink-root"),
    { server: { port: 1 }, workspaces: {
      allowedRoots: [context.root],
      worktreeRoot: redirectedRoot,
      requireExistingWorktreeRoot: true,
    } },
  ));
  const registry = new WorkspaceRegistry(config);
  await assert.rejects(
    () => registry.openWorkspace({ path: gitRoot, mode: "worktree" }),
    (error: unknown) => error instanceof GitWorktreeError &&
      error.code === "GIT_WORKTREE_CREATE_FAILED",
  );
  assert.deepEqual(await stat(actualRoot).then((s) => s.isDirectory()), true);
});

test("failed managed worktree creation never recursively deletes an unexpected pre-existing file", { skip: platform() === "win32" }, async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const targetRoot = join(context.root, "preserve-failed-git-worktree");
  const shimDir = join(context.root, "fake-git-tools");
  await mkdir(targetRoot);
  await mkdir(shimDir);
  const shim = join(shimDir, "git");
  await writeFile(shim, [
    "#!/bin/sh",
    "if [ \"$1\" = \"worktree\" ] && [ \"$2\" = \"add\" ]; then",
    "  /bin/mkdir -p \"$4\"",
    "  printf 'UNOWNED_FILE' > \"$4/preserve-me.txt\"",
    "  exit 1",
    "fi",
    "exec /usr/bin/git \"$@\"",
    "",
  ].join("\n"));
  await chmod(shim, 0o700);
  const config = loadConfig(writeTestDevspaceConfig(
    join(context.root, "config-preserve-git-error"),
    { server: { port: 1 }, workspaces: {
      allowedRoots: [context.root], worktreeRoot: targetRoot,
      requireExistingWorktreeRoot: true,
    } },
  ));
  const originalPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${originalPath ?? ""}`;
  try {
    await assert.rejects(
      () => new WorkspaceRegistry(config).openWorkspace({ path: gitRoot, mode: "worktree" }),
      (error: unknown) => error instanceof GitWorktreeError &&
        error.code === "GIT_WORKTREE_CREATE_FAILED",
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
  const children = await readdir(targetRoot);
  assert.equal(children.length, 1);
  assert.equal(await readFile(join(targetRoot, children[0], "preserve-me.txt"), "utf8"), "UNOWNED_FILE");
});

test("configured managed SSD volume identity must fail closed on an ordinary directory", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const fakeMount = join(context.root, "unmounted-external-volume");
  const targetRoot = join(fakeMount, "Worktrees");
  await mkdir(targetRoot, { recursive: true });
  const config = loadConfig(writeTestDevspaceConfig(
    join(context.root, "config-identity-mismatch"),
    { server: { port: 1 }, workspaces: {
      allowedRoots: [context.root], worktreeRoot: targetRoot,
      requireExistingWorktreeRoot: true,
      managedWorktreeMountPoint: fakeMount,
      managedWorktreeVolumeUuid: "00000000-0000-0000-0000-000000000000",
    } },
  ));
  await assert.rejects(
    () => new WorkspaceRegistry(config).openWorkspace({ path: gitRoot, mode: "worktree" }),
    (error: unknown) => error instanceof GitWorktreeError &&
      error.code === "GIT_WORKTREE_CREATE_FAILED",
  );
  assert.deepEqual(await readdir(targetRoot), []);
});

test("SSD identity guard never creates a host fallback when existing-root protection is omitted", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const fakeUnmountedVolume = join(context.root, "not-mounted-ssd");
  const targetRoot = join(fakeUnmountedVolume, "Worktrees");
  const config = loadConfig(writeTestDevspaceConfig(
    join(context.root, "config-missing-external-volume"),
    { server: { port: 1 }, workspaces: {
      allowedRoots: [context.root],
      worktreeRoot: targetRoot,
      requireExistingWorktreeRoot: false,
      managedWorktreeMountPoint: fakeUnmountedVolume,
      managedWorktreeVolumeUuid: "00000000-0000-0000-0000-000000000000",
    } },
  ));

  await assert.rejects(
    () => new WorkspaceRegistry(config).openWorkspace({ path: gitRoot, mode: "worktree" }),
    (error: unknown) => error instanceof GitWorktreeError &&
      error.code === "GIT_WORKTREE_CREATE_FAILED",
  );
  await assert.rejects(stat(fakeUnmountedVolume), { code: "ENOENT" });
  await assert.rejects(stat(targetRoot), { code: "ENOENT" });
});

test("new managed worktrees may be created only from explicitly listed Git repositories", async (t) => {
  const context = await fixture(t);
  const approvedParent = join(context.root, "approved-source-repos");
  const excludedParent = join(context.root, "excluded-source-repos");
  await mkdir(approvedParent);
  await mkdir(excludedParent);
  const approvedGit = await createGitProject(approvedParent);
  const excludedGit = await createGitProject(excludedParent);
  const destination = join(context.root, "new-worktree-root");
  await mkdir(destination);
  const config = loadConfig(writeTestDevspaceConfig(
    join(context.root, "config-allowed-sources"),
    { server: { port: 1 }, workspaces: {
      allowedRoots: [context.root],
      worktreeRoot: destination,
      managedWorktreeSourceRoots: [approvedGit],
      requireExistingWorktreeRoot: true,
    } },
  ));
  const registry = new WorkspaceRegistry(config);

  await assert.rejects(
    () => registry.openWorkspace({ path: excludedGit, mode: "worktree" }),
    (error: unknown) => error instanceof GitWorktreeError &&
      error.code === "GIT_WORKTREE_CREATE_FAILED",
  );
  assert.deepEqual(await (await import("node:fs/promises")).readdir(destination), []);

  const opened = await registry.openWorkspace({ path: approvedGit, mode: "worktree" });
  assert.ok(opened.workspace.root.startsWith(`${destination}${sep}`));
  assert.equal(opened.workspace.sourceRoot, approvedGit);
});

test("a broad parent directory never permits unlisted source Git repositories", async (t) => {
  const context = await fixture(t);
  const parent = join(context.root, "shared-developer-parent");
  await mkdir(parent);
  const excludedProject = await createGitProject(parent);
  const destination = join(context.root, "isolated-managed-target");
  await mkdir(destination);
  const config = loadConfig(writeTestDevspaceConfig(
    join(context.root, "config-not-a-prefix-allowlist"),
    { server: { port: 1 }, workspaces: {
      allowedRoots: [context.root],
      worktreeRoot: destination,
      managedWorktreeSourceRoots: [parent],
      requireExistingWorktreeRoot: true,
    } },
  ));
  const registry = new WorkspaceRegistry(config);

  await assert.rejects(
    () => registry.openWorkspace({ path: excludedProject, mode: "worktree" }),
    (error: unknown) => error instanceof GitWorktreeError &&
      error.code === "GIT_WORKTREE_CREATE_FAILED",
  );
  assert.deepEqual(await (await import("node:fs/promises")).readdir(destination), []);
});

test("workspace paths outside the allowed roots are rejected", async (t) => {
  const context = await fixture(t);

  await assert.rejects(
    () => context.registry.openWorkspace(context.outsideRoot),
    /outside allowed roots/,
  );
});

test("cached workspace access rejects a root replaced with an outside symlink", { skip: platform() === "win32" }, async (t) => {
  const context = await fixture(t);
  const project = join(context.root, "cached-project");
  await mkdir(project);
  const opened = await context.registry.openWorkspace(project);
  await rename(project, join(context.root, "original-project"));
  await symlink(context.outsideRoot, project, "dir");
  assert.throws(() => context.registry.getWorkspace(opened.workspace.id), /outside allowed roots/);
});

test("cached workspace access rejects a root symlink retargeted within the allowed root", { skip: platform() === "win32" }, async (t) => {
  const context = await fixture(t);
  const firstTarget = join(context.root, "first-target");
  const secondTarget = join(context.root, "second-target");
  const workspaceLink = join(context.root, "workspace-link");
  await mkdir(firstTarget);
  await mkdir(secondTarget);
  await symlink(firstTarget, workspaceLink, "dir");

  const opened = await context.registry.openWorkspace(workspaceLink);
  await rm(workspaceLink);
  await symlink(secondTarget, workspaceLink, "dir");

  assert.throws(
    () => context.registry.getWorkspace(opened.workspace.id),
    /root changed after it was opened/,
  );
});

test("cached managed workspace rejects a different directory recreated at the same path", async (t) => {
  const context = await fixture(t);
  const source = await createGitProject(context.root);
  const opened = await context.registry.openWorkspace({ path: source, mode: "worktree" });
  const originalRoot = opened.workspace.root;
  const relocatedRoot = join(context.root, "displaced-original-worktree");

  // A disconnected volume can leave the same logical mount path backed by a
  // different physical directory. The path string alone is not an identity.
  await rename(originalRoot, relocatedRoot);
  await mkdir(originalRoot);
  await writeFile(join(originalRoot, "unexpected-file.txt"), "other data\n");

  assert.throws(
    () => context.registry.getWorkspace(opened.workspace.id),
    /workspace root (changed|replaced) after it was opened/i,
  );
});

test("cached managed workspace fails closed when its configured SSD volume identity is no longer valid", async (t) => {
  const context = await fixture(t);
  const source = await createGitProject(context.root);
  const opened = await context.registry.openWorkspace({ path: source, mode: "worktree" });
  const marker = join(opened.workspace.root, "README.md");
  const before = await readFile(marker, "utf8");

  // Model a mount/volume policy mismatch without unmounting any real SSD.
  // The same cached workspace ID must not bypass the opt-in volume guard.
  context.config.requireExistingWorktreeRoot = true;
  context.config.managedWorktreeMountPoint = join(context.root, "not-a-mounted-volume");
  context.config.managedWorktreeVolumeUuid = "00000000-0000-0000-0000-000000000000";
  assert.throws(
    () => context.registry.getWorkspace(opened.workspace.id),
    /configured mounted encrypted APFS volume/,
  );
  assert.equal(await readFile(marker, "utf8"), before);

  context.config.managedWorktreeMountPoint = "";
  context.config.managedWorktreeVolumeUuid = "";
  context.config.requireExistingWorktreeRoot = false;
  assert.equal(context.registry.getWorkspace(opened.workspace.id).id, opened.workspace.id);
});

test("cached managed workspace rejects a changed Git admin backlink even when its directory is unchanged", async (t) => {
  const context = await fixture(t);
  const source = await createGitProject(context.root);
  const opened = await context.registry.openWorkspace({ path: source, mode: "worktree" });
  const pointer = join(opened.workspace.root, ".git");
  const adminPath = resolve(opened.workspace.root,
    (await readFile(pointer, "utf8")).trim().slice("gitdir: ".length));
  const backlink = join(adminPath, "gitdir");
  const original = await readFile(backlink, "utf8");
  const unexpected = `${join(source, ".git", "config")}\n`;
  // Windows may protect the generated .git pointer from direct modification.
  // Mutate the synthetic admin backlink instead; the worktree inode stays put.
  await chmod(backlink, 0o666);
  await writeFile(backlink, unexpected);

  assert.throws(
    () => context.registry.getWorkspace(opened.workspace.id),
    /Unverified managed Git worktree/,
  );
  assert.equal(await readFile(backlink, "utf8"), unexpected);
  await writeFile(backlink, original);
  assert.equal(context.registry.getWorkspace(opened.workspace.id).id, opened.workspace.id);
});

test("a symlinked allowed root preserves checkout and worktree path behavior", { skip: platform() === "win32" }, async (t) => {
  const context = await fixture(t);
  const aliasRoot = join(context.root, "alias-root");
  await symlink(context.root, aliasRoot, "dir");
  await createGitProject(context.root);

  const aliasConfig = loadConfig(writeTestDevspaceConfig(
    join(context.root, ".devspace-alias-home"),
    {
      server: { port: 1 },
      workspaces: {
        allowedRoots: [aliasRoot],
        worktreeRoot: join(aliasRoot, ".devspace", "alias-worktrees"),
      },
      skills: { agentDir: context.agentDir },
    },
  ));
  const aliasRegistry = new WorkspaceRegistry(aliasConfig);

  const worktree = await aliasRegistry.openWorkspace({
    path: join(aliasRoot, "git-project"),
    mode: "worktree",
  });
  const checkout = await aliasRegistry.openWorkspace(aliasRoot);

  assert.equal(worktree.workspace.sourceRoot, join(aliasRoot, "git-project"));
  assert.deepEqual(
    checkout.agentsFiles.map((file) => file.content),
    ["global instructions\n", "root instructions\n"],
  );
});

interface WorkspaceFixture {
  root: string;
  outsideRoot: string;
  agentDir: string;
  config: ServerConfig;
  registry: WorkspaceRegistry;
}

async function fixture(t: TestContext): Promise<WorkspaceFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-workspace-test-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "devspace-workspace-outside-test-"));
  const agentDir = join(root, ".pi", "agent");

  if (platform() === "win32") {
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  } else {
    await mkdir(join(agentDir, "skills"), { recursive: true });
    await writeFile(join(agentDir, "skills", "AGENTS.md"), "global instructions\n");
    await symlink("skills/AGENTS.md", join(agentDir, "AGENTS.md"));
  }

  await writeFile(join(root, "AGENTS.md"), "root instructions\n");
  await mkdir(join(root, ".devspace", "agents"), { recursive: true });
  await writeFile(
    join(root, ".devspace", "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Read-only project reviewer.",
      "provider: codex",
      "---",
      "",
      "Review only.",
      "",
    ].join("\n"),
  );
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "AGENTS.md"), "nested instructions\n");
  await writeFile(join(root, "nested", "file.txt"), "hello\n");

  const config = loadConfig(writeTestDevspaceConfig(join(root, ".devspace-home"), {
    server: { port: 1 },
    workspaces: {
      allowedRoots: [root],
      worktreeRoot: join(root, ".devspace", "worktrees"),
    },
    skills: { agentDir },
    subagents: { enabled: true, providers: [] },
  }));

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });

  return {
    root,
    outsideRoot,
    agentDir,
    config,
    registry: new WorkspaceRegistry(config),
  };
}

async function createGitProject(parent: string): Promise<string> {
  const gitRoot = join(parent, "git-project");
  await mkdir(gitRoot);
  await writeFile(join(gitRoot, "AGENTS.md"), "git root instructions\n");
  await writeFile(join(gitRoot, "README.md"), "hello\n");
  await git(gitRoot, ["init"]);
  await git(gitRoot, ["config", "user.email", "devspace@example.com"]);
  await git(gitRoot, ["config", "user.name", "DevSpace Test"]);
  await git(gitRoot, ["add", "."]);
  await git(gitRoot, ["commit", "-m", "Initial commit"]);
  return gitRoot;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
