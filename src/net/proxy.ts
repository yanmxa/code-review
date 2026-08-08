import { spawnSync } from "node:child_process";

/**
 * Make outbound HTTP honour the shell's proxy settings.
 *
 * `curl` reads `HTTPS_PROXY`; Node's global `fetch` does not, unless the process
 * was started with `NODE_USE_ENV_PROXY=1`. On a machine where the proxy is the
 * only route out, that mismatch surfaces as a bare "Connection error." from the
 * model provider — a failure that looks like a bad API key and costs an
 * afternoon to diagnose.
 *
 * The flag is only read at startup, so the fix is to start again with it set.
 * One re-exec at launch is cheap and removes a whole class of support question.
 */
export function ensureProxySupport(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_USE_ENV_PROXY) return false;
  if (!hasProxyConfigured(env)) return false;
  if (majorNodeVersion() < 24) return false; // The flag does not exist before Node 24.

  const result = spawnSync(
    process.execPath,
    // execArgv carries loaders such as `--import tsx`; dropping it would
    // re-exec into a runtime that cannot read the entry point.
    [...process.execArgv, ...process.argv.slice(1)],
    { stdio: "inherit", env: { ...env, NODE_USE_ENV_PROXY: "1" } },
  );
  process.exit(result.status ?? 0);
}

export function hasProxyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.HTTPS_PROXY ||
      env.https_proxy ||
      env.HTTP_PROXY ||
      env.http_proxy ||
      env.ALL_PROXY ||
      env.all_proxy,
  );
}

export function majorNodeVersion(version: string = process.versions.node): number {
  return Number(version.split(".")[0] ?? 0);
}

/** Human-readable note for the diagnostics in `--help` and error paths. */
export function proxyStatus(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!hasProxyConfigured(env)) return undefined;
  const url = env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || env.HTTP_PROXY;
  return env.NODE_USE_ENV_PROXY
    ? `proxy active (${url})`
    : `proxy configured (${url}) but not applied — Node ${process.versions.node} cannot use it`;
}
