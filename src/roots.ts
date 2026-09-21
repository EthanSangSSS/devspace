import { homedir } from "node:os";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }

  return path;
}

export function isPathInsideRoot(path: string, root: string): boolean {
  const resolvedPath = resolve(expandHomePath(path));
  const resolvedRoot = resolve(expandHomePath(root));
  const relationship = relative(resolvedRoot, resolvedPath);

  return (
    relationship === "" ||
    (!isAbsolute(relationship) &&
      !relationship.startsWith(`..${sep}`) &&
      relationship !== ".." &&
      !relationship.includes(`..${sep}`))
  );
}

export function assertAllowedPath(path: string, allowedRoots: string[]): string {
  const resolvedPath = resolve(expandHomePath(path));
  // Preserve observation failures such as ELOOP/EACCES. Relabeling them as
  // access denial could make workspace recovery replace a valid binding.
  const physicalPath = resolvePhysicalPath(resolvedPath);
  if (allowedRoots.some((root) => {
    let physicalRoot: string;
    try {
      physicalRoot = resolvePhysicalPath(root);
    } catch (error) {
      // An unavailable configured volume/root grants no access. Do not let it
      // hide another valid root, and do not swallow target-path failures or
      // observation errors such as ELOOP/EACCES.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    return isPathInsideRoot(physicalPath, physicalRoot);
  })) {
    // Preserve the caller's spelling (including an authorized root alias).
    return resolvedPath;
  }

  throw new AccessDeniedError(`Path is outside allowed roots: ${path}`);
}

/** Resolve existing ancestors without treating a dangling link as a missing directory. */
export function resolvePhysicalPath(path: string): string {
  const absolute = resolve(expandHomePath(path));
  let ancestor = absolute;
  for (;;) {
    try {
      lstatSync(ancestor);
    } catch (error) {
      const parent = dirname(ancestor);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === ancestor) throw error;
      ancestor = parent;
      continue;
    }
    // Deliberately outside the ENOENT handler: a present symlink with a missing
    // target must fail closed, not be skipped in favor of its lexical parent.
    return resolve(realpathSync(ancestor), relative(ancestor, absolute));
  }
}

export function resolveAllowedPath(inputPath: string, cwd: string, allowedRoots: string[]): string {
  const absolutePath = resolve(cwd, inputPath);
  return assertAllowedPath(absolutePath, allowedRoots);
}
