import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { resolveTaskRunnerStateDir } from "../../config/runtime-paths.js";
import { defineHook } from "../../hooks.js";
import type { HookResult, PrepareHookContext } from "./types.js";

type GitCloneCollisionMode = "fail" | "reuse" | "replace";

interface GitCloneConfig {
  repoUrl: string;
  ref?: string;
  path?: string;
  remoteName: string;
  depth?: number;
  collision: GitCloneCollisionMode;
}

interface CheckoutTarget {
  path: string;
}

const CONFIG_KEYS = new Set(["repo_url", "ref", "path", "remote_name", "depth", "collision"]);

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

function rejectLeadingDash(value: string, key: string): void {
  if (value.startsWith("-")) {
    throw new Error(`git-clone config validation failed: \`${key}\` must not begin with '-'`);
  }
}

function validateRepoUrl(value: string): void {
  rejectLeadingDash(value, "repo_url");
  try {
    const parsed = new URL(value);
    if (
      parsed.password ||
      ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.username)
    ) {
      throw new Error(
        "git-clone config validation failed: `repo_url` must not include embedded credentials",
      );
    }
  } catch (error) {
    if (error instanceof TypeError) {
      return;
    }
    throw error;
  }
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
  if (trimmed.length === 0) {
    return undefined;
  }
  rejectLeadingDash(trimmed, "ref");
  return trimmed;
}

function optionalCollision(record: Record<string, unknown>): GitCloneCollisionMode | undefined {
  if (!("collision" in record)) {
    return undefined;
  }
  const value = record.collision;
  if (value !== "fail" && value !== "reuse" && value !== "replace") {
    throw new Error(
      "git-clone config validation failed: `collision` must be one of: fail, reuse, replace",
    );
  }
  return value;
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

  const repoUrl = requiredString(record, "repo_url");
  validateRepoUrl(repoUrl);
  const path = optionalNonEmptyString(record, "path");
  const remoteName = optionalNonEmptyString(record, "remote_name") ?? "origin";
  rejectLeadingDash(remoteName, "remote_name");
  return {
    repoUrl,
    ref: optionalRef(record),
    path,
    remoteName,
    depth: depth as number | undefined,
    collision: optionalCollision(record) ?? (path ? "fail" : "reuse"),
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

function resolveCheckoutTarget(
  config: GitCloneConfig,
  ctx: PrepareHookContext,
  repoSlug: string,
): CheckoutTarget {
  if (config.path) {
    return {
      path: isAbsolute(config.path) ? config.path : resolve(ctx.run.cwd, config.path),
    };
  }
  return {
    path: join(resolveTaskRunnerStateDir(), "checkouts", `${repoSlug}-${ctx.run.runId}`),
  };
}

function checkoutPathState(path: string): "missing" | "empty" | "occupied" {
  if (!existsSync(path)) {
    return "missing";
  }
  const stat = statSync(path);
  if (!stat.isDirectory()) {
    throw new Error(
      `git-clone path collision: checkout path ${path} exists and is not a directory`,
    );
  }
  return readdirSync(path).length === 0 ? "empty" : "occupied";
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
  args.push("--", config.repoUrl, checkoutPath);
  return args;
}

function fetchArgs(config: GitCloneConfig, ref: string): string[] {
  const args = ["fetch"];
  if (config.depth !== undefined) {
    args.push("--depth", String(config.depth));
  }
  args.push("--", config.remoteName, ref);
  return args;
}

function tagFetchArgs(config: GitCloneConfig, ref: string): string[] {
  const args = ["fetch"];
  if (config.depth !== undefined) {
    args.push("--depth", String(config.depth));
  }
  args.push("--", config.remoteName, "tag", ref);
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

  git(["checkout", "--detach", "--", ref], checkoutPath, "checkout");
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
  try {
    git(cloneArgs(config, checkoutPath), dirname(checkoutPath), "clone");
    if (config.ref) {
      checkoutRef(config, checkoutPath, config.ref);
    }
    return git(["rev-parse", "HEAD"], checkoutPath, "rev-parse");
  } catch (error) {
    rmSync(checkoutPath, { recursive: true, force: true });
    throw error;
  }
}

function existingRemoteUrl(config: GitCloneConfig, checkoutPath: string): string | undefined {
  const remote = tryGit(["remote", "get-url", config.remoteName], checkoutPath);
  return remote.ok ? remote.stdout : undefined;
}

function reuseRepository(config: GitCloneConfig, checkoutPath: string): string {
  const insideWorkTree = tryGit(["rev-parse", "--is-inside-work-tree"], checkoutPath);
  const remoteUrl = existingRemoteUrl(config, checkoutPath);
  if (!insideWorkTree.ok || remoteUrl !== config.repoUrl) {
    throw new Error(
      `git-clone path collision: checkout path ${checkoutPath} already exists and is not a reusable clone of ${config.repoUrl}`,
    );
  }
  if (config.ref) {
    checkoutRef(config, checkoutPath, config.ref);
  }
  return git(["rev-parse", "HEAD"], checkoutPath, "rev-parse");
}

function prepareCheckoutPath(config: GitCloneConfig, target: CheckoutTarget): "clone" | "reuse" {
  const state = checkoutPathState(target.path);
  if (state === "missing" || state === "empty") {
    return "clone";
  }
  if (config.collision === "replace") {
    rmSync(target.path, { recursive: true, force: true });
    return "clone";
  }
  if (config.collision === "reuse") {
    return "reuse";
  }
  throw new Error(
    `git-clone path collision: checkout path ${target.path} already exists and is non-empty`,
  );
}

export default defineHook({
  name: "git-clone",
  prepare(ctx: PrepareHookContext): HookResult {
    const config = gitCloneConfig(ctx.config);
    const repoSlug = deriveRepoSlug(config.repoUrl);
    const target = resolveCheckoutTarget(config, ctx, repoSlug);
    const checkoutPath = target.path;
    const commitSha =
      prepareCheckoutPath(config, target) === "reuse"
        ? reuseRepository(config, checkoutPath)
        : cloneRepository(config, checkoutPath);
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
