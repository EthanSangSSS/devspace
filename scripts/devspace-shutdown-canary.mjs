// Disposable real-CLI canary. Never reads production configuration or binds 7676.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { createServer, createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defaultDevspaceConfig } from "../dist/config-schema.js";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entrypoint = await realpath(process.argv[2] ?? join(packageRoot, "dist/cli.js"));
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function allocatePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
  assert.notEqual(address.port, 7676);
  return address.port;
}

async function run(mode) {
  const root = await mkdtemp(join(tmpdir(), "ds-shutdown-canary-"));
  const port = await allocatePort();
  const configDir = join(root, "config");
  await mkdir(configDir);
  const config = defaultDevspaceConfig();
  config.server = { ...config.server, host: "127.0.0.1", port, publicBaseUrl: `http://127.0.0.1:${port}` };
  config.workspaces = { allowedRoots: [root], worktreeRoot: join(root, "worktrees") };
  config.storage.stateDir = join(root, "state");
  config.skills = { enabled: false, paths: [], agentDir: join(root, "agent") };
  config.subagents = { enabled: false, providers: [] };
  config.agyDelegation.enabled = false;
  config.logging.level = "error";
  await writeFile(join(configDir, "config.jsonc"), JSON.stringify(config), { mode: 0o600 });
  const child = spawn(process.execPath, [entrypoint, "serve"], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      DEVSPACE_CONFIG_DIR: configDir,
      DEVSPACE_OAUTH_OWNER_TOKEN: "disposable-canary-not-a-real-owner-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-16000); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-16000); });
  const exited = once(child, "exit");
  let socket;
  let release;
  let deadline;
  try {
    const readyDeadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < readyDeadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`canary startup failed: ${stderr}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
        const health = await response.json();
        ready = response.ok && health.ok === true && health.name === "devspace";
        if (ready) break;
      } catch {}
      await delay(50);
    }
    assert.equal(ready, true, "disposable CLI never became ready");
    if (process.platform === "darwin") {
      const owner = await execFileAsync("/usr/sbin/lsof", ["-t", "-a", "-p", String(child.pid), `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN"], { timeout: 2000 });
      assert.equal(owner.stdout.trim(), String(child.pid));
    }
    socket = createConnection(port, "127.0.0.1");
    socket.on("error", () => {});
    await once(socket, "connect");
    socket.write("POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n");
    await delay(100);
    const started = Date.now();
    assert.equal(child.kill("SIGTERM"), true);
    if (mode === "finite-12s") release = setTimeout(() => socket.destroy(), 12000);
    const [code, signal] = await Promise.race([
      exited,
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("real CLI exceeded the 45s canary bound")), 45000); }),
    ]);
    const elapsedMs = Date.now() - started;
    assert.equal(signal, null);
    assert.equal(code, mode === "finite-12s" ? 0 : 1);
    if (mode === "finite-12s") {
      assert.ok(elapsedMs >= 11000 && elapsedMs < 20000);
    } else {
      assert.ok(elapsedMs >= 38000 && elapsedMs < 42000);
      assert.match(stderr, /HTTP\/application shutdown deadline exceeded/);
    }
    console.log(JSON.stringify({ mode, result: "PASS", entrypoint, pid: child.pid, port, exitCode: code, elapsedMs }));
  } finally {
    clearTimeout(release);
    clearTimeout(deadline);
    socket?.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    // Only this invocation's freshly allocated disposable fixture is removed.
    await rm(root, { recursive: true, force: true });
  }
}

for (const mode of ["finite-12s", "held-until-deadline"]) await run(mode);
