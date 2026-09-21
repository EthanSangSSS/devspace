import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { assertAllowedPath } from "./roots.js";
import { gitEnvironment } from "./git-environment.js";

export interface CliWorkspaceContext {
  workspaceId?: string;
  workspaceRoot: string;
}

/** Resolve the project context used by local agent commands. */
export function resolveCliWorkspaceContext(
  allowedRoots: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): CliWorkspaceContext {
  const workspaceId = env.DEVSPACE_WORKSPACE_ID?.trim() || undefined;
  const injectedRoot = workspaceId ? env.DEVSPACE_WORKSPACE_ROOT?.trim() : undefined;
  const candidate = canonicalizePath(
    injectedRoot ? resolve(injectedRoot) : findGitRoot(cwd, env) ?? resolve(cwd),
  );

  if (!workspaceId) return { workspaceId, workspaceRoot: candidate };

  return {
    workspaceId,
    workspaceRoot: assertAllowedPath(candidate, allowedRoots.map(canonicalizePath)),
  };
}

function canonicalizePath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function findGitRoot(cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: resolve(cwd),
    env: gitEnvironment(env),
    timeout: 5_000,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return undefined;
  const root = result.stdout.trim();
  return root ? resolve(root) : undefined;
}
