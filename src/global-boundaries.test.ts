import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { git } from "./git.js";
import { assertAllowedPath } from "./roots.js";
import { readFileTool, writeFileTool } from "./pi-tools.js";
import { applyPatch } from "./apply-patch.js";
import { SqliteOAuthStore } from "./oauth-store.js";
import { gitEnvironment } from "./git-environment.js";

test("file tools reject physical escapes and dangling parent links", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ds-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "unchanged\n");
  await symlink(outside, join(workspace, "escape"));
  await symlink(join(outside, "missing"), join(workspace, "dangling"));
  await symlink(workspace, join(root, "alias"));
  const context = { cwd: workspace, root: workspace };
  const unavailableRoot = join(workspace, "dangling");
  assert.throws(() => assertAllowedPath(workspace, [unavailableRoot]), /Path is outside allowed roots/);
  assert.equal(assertAllowedPath(workspace, [unavailableRoot, workspace]), workspace);
  assert.throws(() => assertAllowedPath(join(workspace, "escape", "sentinel"), [workspace]));
  await assert.rejects(readFileTool({ path: "escape/sentinel" }, context));
  await assert.rejects(writeFileTool({ path: "escape/new", content: "bad" }, context));
  await assert.rejects(writeFileTool({ path: "dangling/new", content: "bad" }, context));
  await assert.rejects(applyPatch(workspace, "*** Begin Patch\n*** Add File: dangling/new\n+bad\n*** End Patch"));
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "unchanged\n");
  assert.equal(assertAllowedPath(join(root, "alias", "new", "nested"), [workspace]), resolve(root, "alias", "new", "nested"));
  const result = await writeFileTool({ path: "safe/new", content: "ok" }, context);
  assert.notEqual(result.isError, true);
  assert.equal(await readFile(join(workspace, "safe", "new"), "utf8"), "ok");
});

test("Git commands ignore inherited repository selectors but preserve explicit isolated indexes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ds-git-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = join(root, "a");
  const b = join(root, "b");
  await mkdir(a);
  await mkdir(b);
  await git(a, ["init", "-q"]);
  await git(b, ["init", "-q"]);
  await writeFile(join(a, "only-a"), "a");
  await writeFile(join(b, "only-b"), "b");
  const keys = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const fixture = Object.fromEntries(keys.map((key) => [key, "foreign"]));
  assert.deepEqual(gitEnvironment(fixture), {});
  assert.deepEqual(gitEnvironment(fixture, { GIT_INDEX_FILE: "controlled" }), { GIT_INDEX_FILE: "controlled" });
  try {
    process.env.GIT_DIR = join(b, ".git");
    process.env.GIT_WORK_TREE = b;
    process.env.GIT_INDEX_FILE = join(b, ".git", "foreign-index");
    const result = await git(a, ["status", "--porcelain"]);
    assert.match(result.stdout, /only-a/);
    assert.doesNotMatch(result.stdout, /only-b/);
    const index = join(root, "isolated-index");
    await git(a, ["add", "only-a"], { env: { GIT_INDEX_FILE: index } });
    assert.match((await git(a, ["ls-files"], { env: { GIT_INDEX_FILE: index } })).stdout, /only-a/);
    assert.equal((await git(a, ["ls-files"])).stdout, "");
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
  assert.equal((await git(b, ["ls-files"])).stdout, "");
});

test("OAuth redirect registration rejects insecure remote schemes, userinfo and fragments", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ds-oauth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SqliteOAuthStore(root);
  try {
    for (const uri of ["http://client.example/callback", "ftp://client.example/callback", "https://user@client.example/callback", "https://client.example/callback#fragment"]) {
      assert.throws(() => store.registerClient({ redirect_uris: [uri] }, ["client.example"]), /redirect_uri/);
    }
    for (const uri of ["https://client.example/callback", "http://127.0.0.1:9876/callback", "http://[::1]:9876/callback"]) {
      assert.ok(store.registerClient({ redirect_uris: [uri] }, ["client.example"]).client_id);
    }
  } finally {
    store.close();
  }
});
