import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { loadConfig, type ServerConfig } from "./config.js";
import { GitWorktreeError } from "./git-worktrees.js";
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
  assert.ok(original.workspace.root.startsWith(`${oldRoot}/`));
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
    assert.ok(created.workspace.root.startsWith(`${newRoot}/`));
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
  assert.ok(created.workspace.root.startsWith(`${targetRoot}/`));
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
  assert.ok(opened.workspace.root.startsWith(`${destination}/`));
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
