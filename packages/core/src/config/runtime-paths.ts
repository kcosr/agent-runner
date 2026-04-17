import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const TASK_RUNNER_CONFIG_DIR_ENV = "TASK_RUNNER_CONFIG_DIR";
export const TASK_RUNNER_STATE_DIR_ENV = "TASK_RUNNER_STATE_DIR";
export const UNKNOWN_REPO_KEY = "unknown";

type DefinitionKind = "agent" | "assignment";

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function gitProbeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const nextEnv = { ...env };
  for (const key of Object.keys(nextEnv)) {
    // Git hooks export repo-bound GIT_* variables that can make an arbitrary
    // target cwd resolve as the hook's repository instead of the probed path.
    if (key.startsWith("GIT_")) {
      delete nextEnv[key];
    }
  }
  return nextEnv;
}

function resolvedHome(env: NodeJS.ProcessEnv): string {
  return nonEmpty(env.HOME) ?? homedir();
}

export function isPathArg(arg: string): boolean {
  return arg.includes("/") || arg.startsWith("./");
}

export function resolveTaskRunnerConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = nonEmpty(env[TASK_RUNNER_CONFIG_DIR_ENV]);
  if (explicit) return explicit;

  const xdgConfigHome = nonEmpty(env.XDG_CONFIG_HOME);
  if (xdgConfigHome) return join(xdgConfigHome, "task-runner");

  return join(resolvedHome(env), ".config", "task-runner");
}

export function resolveTaskRunnerStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = nonEmpty(env[TASK_RUNNER_STATE_DIR_ENV]);
  if (explicit) return explicit;

  const xdgStateHome = nonEmpty(env.XDG_STATE_HOME);
  if (xdgStateHome) return join(xdgStateHome, "task-runner");

  return join(resolvedHome(env), ".local", "state", "task-runner");
}

export function definitionLayout(kind: DefinitionKind): { dirName: string; fileName: string } {
  return kind === "agent"
    ? { dirName: "agents", fileName: "agent.md" }
    : { dirName: "assignments", fileName: "assignment.md" };
}

export function resolveDefinitionRoot(
  kind: DefinitionKind,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const { dirName } = definitionLayout(kind);
  return join(resolveTaskRunnerConfigDir(env), dirName);
}

export function slugifyRepoKey(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const slug = normalized.replaceAll("/", "-").replace(/^-+/, "").toLowerCase();
  return slug.length > 0 ? slug : UNKNOWN_REPO_KEY;
}

export function deriveRepoKey(cwd: string = process.cwd()): string {
  try {
    const gitCommonDir = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd,
        env: gitProbeEnv(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();

    if (!isAbsolute(gitCommonDir)) {
      return UNKNOWN_REPO_KEY;
    }

    // Keep workspace paths short and human-readable by using the repo root
    // basename instead of a slugified absolute path. Same-named repo
    // collisions are an accepted product tradeoff for simpler paths.
    return slugifyRepoKey(basename(dirname(gitCommonDir)));
  } catch {
    return UNKNOWN_REPO_KEY;
  }
}

export function resolveRunsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveTaskRunnerStateDir(env), "runs");
}

export function resolveRunsBucketDir(bucket: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveRunsRoot(env), bucket);
}

export function resolveRepoRunsDir(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveRunsBucketDir(deriveRepoKey(cwd), env);
}

export function resolveRunWorkspaceDirForRepo(
  repo: string,
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(resolveRunsBucketDir(repo, env), runId);
}

export function resolveUnknownRunsDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveRunsBucketDir(UNKNOWN_REPO_KEY, env);
}

export function resolveRunWorkspaceDir(
  cwd: string,
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveRunWorkspaceDirForRepo(deriveRepoKey(cwd), runId, env);
}

export function resolveInputPath(arg: string, cwd: string): string {
  return isAbsolute(arg) ? arg : resolve(cwd, arg);
}
