import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { resolveTaskRunnerStateDir } from "../../config/runtime-paths.js";
import { defineHook } from "../../hooks.js";
import type { HookResult, PrepareHookContext } from "./types.js";

interface GitCloneConfig {
  repoUrl: string;
  ref?: string;
  path?: string;
  remoteName: string;
  depth?: number;
}

const CONFIG_KEYS = new Set(["repo_url", "ref", "path", "remote_name", "depth"]);

function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => {
      return !key.startsWith("GIT_");
    }),
  );
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`git-clone config validation failed: \`${key}\` must be a non-empty string`);
  }
  return value.trim();
}

function optionalNonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
  if (!(key in record)) {
    return undefined;
  }
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`git-clone config validation failed: \`${key}\` must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(
      `git-clone config validation failed: \`${key}\` must be non-empty when present`,
    );
  }
  return trimmed;
}

function optionalRef(record: Record<string, unknown>): string | undefined {
  if (!("ref" in record)) {
    return undefined;
  }
  const value = record.ref;
  if (typeof value !== "string") {
    throw new Error("git-clone config validation failed: `ref` must be a string");
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function gitCloneConfig(config: unknown): GitCloneConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("git-clone config validation failed: hook requires an object config");
  }
  const record = config as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !CONFIG_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `git-clone config validation failed: unknown field(s): ${unknownKeys.join(", ")}`,
    );
  }

  const depth = record.depth;
  if (
    depth !== undefined &&
    (typeof depth !== "number" || !Number.isInteger(depth) || depth <= 0)
  ) {
    throw new Error("git-clone config validation failed: `depth` must be a positive integer");
  }

  return {
    repoUrl: requiredString(record, "repo_url"),
    ref: optionalRef(record),
    path: optionalNonEmptyString(record, "path"),
    remoteName: optionalNonEmptyString(record, "remote_name") ?? "origin",
    depth: depth as number | undefined,
  };
}

function lastPathSegment(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  const scpLike = trimmed.match(/^[^/\s@]+@[^:\s]+:(.+)$/);
  if (scpLike?.[1]) {
    return scpLike[1].split("/").filter(Boolean).at(-1) ?? "";
  }

  try {
    const parsed = new URL(trimmed);
    const segment = parsed.pathname.split("/").filter(Boolean).at(-1) ?? "";
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  } catch {
    return (
      trimmed
        .split(/[/:\\]+/)
        .filter(Boolean)
        .at(-1) ?? ""
    );
  }
}

export function deriveRepoSlug(repoUrl: string): string {
  const tail = lastPathSegment(repoUrl).replace(/\.git$/i, "");
  const slug = tail
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "");
  if (!/[A-Za-z0-9_]/.test(slug)) {
    throw new Error("git-clone invalid slug: could not derive a filesystem-safe repo slug");
  }
  return slug;
}

function resolveCheckoutPath(config: GitCloneConfig, ctx: PrepareHookContext, repoSlug: string) {
  if (config.path) {
    return isAbsolute(config.path) ? config.path : resolve(ctx.run.cwd, config.path);
  }
  return join(resolveTaskRunnerStateDir(), "checkouts", `${repoSlug}-${ctx.run.runId}`);
}

function assertCheckoutPathAvailable(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  const stat = statSync(path);
  if (!stat.isDirectory()) {
    throw new Error(
      `git-clone path collision: checkout path ${path} exists and is not a directory`,
    );
  }
  if (readdirSync(path).length > 0) {
    throw new Error(
      `git-clone path collision: checkout path ${path} already exists and is non-empty`,
    );
  }
}

function redactGitOutput(value: string): string {
  return value.replace(/((?:https?|ssh):\/\/)([^@\s/]+)@/gi, "$1<redacted>@");
}

function safeErrorContext(error: unknown): string {
  const err = error as NodeJS.ErrnoException & {
    stderr?: string | Buffer;
    stdout?: string | Buffer;
  };
  const stderr =
    typeof err.stderr === "string"
      ? err.stderr
      : Buffer.isBuffer(err.stderr)
        ? err.stderr.toString("utf8")
        : "";
  const stdout =
    typeof err.stdout === "string"
      ? err.stdout
      : Buffer.isBuffer(err.stdout)
        ? err.stdout.toString("utf8")
        : "";
  const detail = (stderr.trim() || stdout.trim() || err.message || String(error)).trim();
  return redactGitOutput(detail);
}

function git(args: string[], cwd: string, operation: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(`git-clone ${operation} failed: ${safeErrorContext(error)}`);
  }
}

function cloneArgs(config: GitCloneConfig, checkoutPath: string): string[] {
  const args = ["clone", "--origin", config.remoteName];
  if (config.depth !== undefined) {
    args.push("--depth", String(config.depth));
  }
  args.push(config.repoUrl, checkoutPath);
  return args;
}

function fetchArgs(config: GitCloneConfig, ref: string): string[] {
  const args = ["fetch"];
  if (config.depth !== undefined) {
    args.push("--depth", String(config.depth));
  }
  args.push(config.remoteName, ref);
  return args;
}

function tagFetchArgs(config: GitCloneConfig, ref: string): string[] {
  const args = ["fetch"];
  if (config.depth !== undefined) {
    args.push("--depth", String(config.depth));
  }
  args.push(config.remoteName, "tag", ref);
  return args;
}

function tryGit(args: string[], cwd: string): { ok: true; stdout: string } | { ok: false } {
  try {
    return {
      ok: true,
      stdout: execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: gitEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    };
  } catch {
    return { ok: false };
  }
}

function checkoutRef(config: GitCloneConfig, checkoutPath: string, ref: string): void {
  const fetch = tryGit(fetchArgs(config, ref), checkoutPath);
  if (fetch.ok) {
    git(["checkout", "--detach", "FETCH_HEAD"], checkoutPath, "checkout");
    return;
  }

  const tagFetch = tryGit(tagFetchArgs(config, ref), checkoutPath);
  if (tagFetch.ok) {
    git(["checkout", "--detach", "FETCH_HEAD"], checkoutPath, "checkout");
    return;
  }

  git(["checkout", "--detach", ref], checkoutPath, "checkout");
}

function resolvedDefaultRef(checkoutPath: string): string | undefined {
  const symbolic = tryGit(["symbolic-ref", "--quiet", "--short", "HEAD"], checkoutPath);
  if (symbolic.ok && symbolic.stdout.length > 0) {
    return symbolic.stdout;
  }
  return undefined;
}

function cloneRepository(config: GitCloneConfig, checkoutPath: string): string {
  mkdirSync(dirname(checkoutPath), { recursive: true });
  git(cloneArgs(config, checkoutPath), dirname(checkoutPath), "clone");
  if (config.ref) {
    checkoutRef(config, checkoutPath, config.ref);
  }
  return git(["rev-parse", "HEAD"], checkoutPath, "rev-parse");
}

export default defineHook({
  name: "git-clone",
  prepare(ctx: PrepareHookContext): HookResult {
    const config = gitCloneConfig(ctx.config);
    const repoSlug = deriveRepoSlug(config.repoUrl);
    const checkoutPath = resolveCheckoutPath(config, ctx, repoSlug);
    assertCheckoutPathAvailable(checkoutPath);
    const commitSha = cloneRepository(config, checkoutPath);
    const resolvedRef = config.ref ?? resolvedDefaultRef(checkoutPath);
    const vars: Record<string, unknown> = {
      repo_slug: repoSlug,
      checkout_path: checkoutPath,
      commit_sha: commitSha,
    };
    if (resolvedRef) {
      vars.resolved_ref = resolvedRef;
    }
    return {
      action: "continue",
      mutate: {
        run: {
          cwd: checkoutPath,
        },
        vars,
      },
    };
  },
});
