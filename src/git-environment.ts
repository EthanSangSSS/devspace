const REPOSITORY_SELECTORS = new Set([
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE", "GIT_IMPLICIT_WORK_TREE", "GIT_PREFIX",
  "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS",
]);

/** Host repository selection never overrides a workspace's cwd. Explicit
 * internal overrides (for example a private review index) remain supported. */
export function gitEnvironment(
  inherited: NodeJS.ProcessEnv = process.env,
  explicit: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(inherited).filter(([key]) =>
      !REPOSITORY_SELECTORS.has(key) && !/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key))),
    ...explicit,
  };
}
