import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadEnvironmentConfig } from "../../config/loader.js";
import { resolveTaskRunnerStateDir } from "../../config/runtime-paths.js";
import { runProcess } from "../../util/spawn.js";
import { writeTextFileAtomic } from "../../util/write-file-atomic.js";
import type { BackendName } from "../backends/types.js";
import type { EnvironmentReference, LoadedEnvironmentDefinition } from "../config/environments.js";
import { interpolate } from "../config/interpolate.js";
import type { ResolvedLauncherConfig } from "../config/launchers.js";
import type {
  RunEnvironmentLifecycleStep,
  RunEnvironmentSessionMount,
  RunEnvironmentSessionMountPreset,
  RunEnvironmentWorkspace,
  RunExecutionEnvironment,
  RunExistingContainerEnvironment,
  RunManagedContainerEnvironment,
  RunManifest,
} from "./manifest.js";

const INTERPOLATION_TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
const LATE_LIFECYCLE_TOKENS = new Set(["container_name", "container_id", "container_pid"]);

export class ExecutionEnvironmentError extends Error {
  environment: RunExecutionEnvironment | null;

  constructor(message: string, environment: RunExecutionEnvironment | null = null) {
    super(message);
    this.name = "ExecutionEnvironmentError";
    this.environment = environment;
  }
}

const ENGINE_DEFAULT_TIMEOUT_MS = 30_000;
const ENGINE_START_TIMEOUT_MS = 60_000;
const WORKSPACE_LIFECYCLE_STEP_TIMEOUT_MS = 30 * 60_000;
const WORKSPACE_LIFECYCLE_LOCK_WAIT_MS = 100;
const WORKSPACE_LIFECYCLE_LOCK_STALE_BUFFER_MS = 60_000;
const WORKSPACE_LIFECYCLE_MARKER = ".task-runner-workspace-lifecycle.json";
const WORKSPACE_LIFECYCLE_LOCK = ".task-runner-workspace-lifecycle.lock";
const WORKSPACE_LIFECYCLE_LOCK_METADATA = "metadata.json";
const WORKSPACE_STATE_DIR = "workspace-state";
const CONTAINER_STATE_DIR = "container-state";
const AFTER_START_LIFECYCLE_MARKER = ".task-runner-after-start-lifecycle.json";
const AFTER_START_LIFECYCLE_LOCK = ".task-runner-after-start-lifecycle.lock";

interface ResolveEnvironmentOptions {
  reference: EnvironmentReference | undefined;
  overrideEnvironment?: string;
  selectedEnvironment?: LoadedEnvironmentDefinition | null;
  cwd: string;
  injectedVars: Record<string, unknown>;
  runId: string;
  runGroupId: string;
  backend: BackendName;
}

function loadReferencedEnvironment(
  reference: EnvironmentReference,
  cwd: string,
): LoadedEnvironmentDefinition {
  return reference.kind === "path"
    ? loadEnvironmentConfig(reference.path, cwd)
    : loadEnvironmentConfig(reference.name, cwd);
}

export function resolveFreshExecutionEnvironmentDefinition(options: {
  reference: EnvironmentReference | undefined;
  overrideEnvironment?: string;
  cwd: string;
}): LoadedEnvironmentDefinition | null {
  if (options.overrideEnvironment !== undefined) {
    return loadEnvironmentConfig(options.overrideEnvironment, options.cwd);
  }
  return options.reference === undefined
    ? null
    : loadReferencedEnvironment(options.reference, options.cwd);
}

function interpolateString(value: string, vars: Record<string, unknown>): string {
  const interpolated = interpolate(value, vars);
  const unresolved = unresolvedTokens(interpolated);
  if (unresolved.length > 0) {
    const first = unresolved[0] as { token: string; name: string };
    throw new ExecutionEnvironmentError(
      `execution environment interpolation could not resolve token ${first.token}`,
    );
  }
  return interpolated;
}

function unresolvedTokens(value: string): { token: string; name: string }[] {
  return [...value.matchAll(INTERPOLATION_TOKEN_PATTERN)].map((match) => ({
    token: match[0],
    name: match[1] ?? "",
  }));
}

function interpolateLifecycleString(value: string, vars: Record<string, unknown>): string {
  const interpolated = interpolate(value, vars);
  const unresolved = unresolvedTokens(interpolated).find(
    (token) => !LATE_LIFECYCLE_TOKENS.has(token.name),
  );
  if (unresolved) {
    throw new ExecutionEnvironmentError(
      `execution environment lifecycle interpolation could not resolve token ${unresolved.token}`,
    );
  }
  return interpolated;
}

function interpolateLateLifecycleString(value: string, vars: Record<string, string>): string {
  return interpolateString(value, vars);
}

function interpolateStringRecord(
  record: Record<string, string>,
  vars: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, interpolateString(value, vars)]),
  );
}

function interpolateLifecycleStringRecord(
  record: Record<string, string>,
  vars: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, interpolateLifecycleString(value, vars)]),
  );
}

function assertAbsolutePath(path: string, field: string): void {
  if (!isAbsolute(path)) {
    throw new ExecutionEnvironmentError(`${field} must resolve to an absolute path`);
  }
}

function generatedContainerName(
  lifetime: "run" | "group",
  runId: string,
  runGroupId: string,
): string {
  return `task-runner-${lifetime === "group" ? runGroupId : runId}`;
}

function resolveMounts(
  mounts: { hostPath: string; containerPath: string; mode: "ro" | "rw" }[],
  vars: Record<string, unknown>,
): { hostPath: string; containerPath: string; mode: "ro" | "rw" }[] {
  return mounts.map((mount, index) => {
    const hostPath = interpolateString(mount.hostPath, vars);
    const containerPath = interpolateString(mount.containerPath, vars);
    assertAbsolutePath(hostPath, `mounts[${index}].hostPath`);
    assertAbsolutePath(containerPath, `mounts[${index}].containerPath`);
    return {
      hostPath,
      containerPath,
      mode: mount.mode,
    };
  });
}

function homeRoot(): string {
  return process.env.HOME?.trim() || homedir();
}

function opencodeDataDir(): string {
  const explicit =
    process.env.TASK_RUNNER_OPENCODE_DATA_DIR?.trim() || process.env.OPENCODE_DATA_DIR?.trim();
  if (explicit) {
    return resolve(explicit);
  }
  const xdgData = process.env.XDG_DATA_HOME?.trim() || join(homeRoot(), ".local", "share");
  return resolve(xdgData, "opencode");
}

function sessionMountHostPath(preset: RunEnvironmentSessionMountPreset): string {
  switch (preset) {
    case "claude":
      return join(homeRoot(), ".claude", "projects");
    case "codex":
      return join(homeRoot(), ".codex", "sessions");
    case "cursor":
      return join(homeRoot(), ".cursor", "chats");
    case "opencode":
      return opencodeDataDir();
    case "pi":
      return process.env.PI_HOME?.trim() || join(homeRoot(), ".pi");
  }
}

function isSessionMountPreset(value: string): value is RunEnvironmentSessionMountPreset {
  return (
    value === "claude" ||
    value === "codex" ||
    value === "cursor" ||
    value === "opencode" ||
    value === "pi"
  );
}

function resolveSessionMounts(
  sessionMounts: "backend" | RunEnvironmentSessionMountPreset[],
  backend: BackendName,
): RunEnvironmentSessionMount[] {
  const presets =
    sessionMounts === "backend"
      ? isSessionMountPreset(backend)
        ? [backend]
        : null
      : sessionMounts;
  if (presets === null) {
    throw new ExecutionEnvironmentError(
      `execution environment sessionMounts: backend has no built-in preset for backend "${backend}"`,
    );
  }
  const uniquePresets = [...new Set(presets)];
  return uniquePresets.map((preset) => {
    const hostPath = resolve(sessionMountHostPath(preset));
    return {
      preset,
      hostPath,
      containerPath: hostPath,
      mode: "rw",
    };
  });
}

function pathWithin(hostPath: string, candidate: string): string | null {
  const root = resolve(hostPath);
  const target = resolve(candidate);
  const suffix = relative(root, target);
  if (suffix === "") {
    return "";
  }
  return suffix.startsWith("..") || isAbsolute(suffix) ? null : suffix.split(sep).join("/");
}

function rewriteWorkspacePath(workspace: RunEnvironmentWorkspace | null, path: string): string {
  if (workspace === null) {
    return path;
  }
  const suffix = pathWithin(workspace.hostPath, path);
  if (suffix === null) {
    return path;
  }
  return suffix.length === 0 ? workspace.containerPath : `${workspace.containerPath}/${suffix}`;
}

function resolveWorkspace(
  workspace:
    | {
        scope: "run" | "group";
        hostRoot?: string;
        hostPath?: string;
        containerPath: string;
        mode: "ro" | "rw";
        create: boolean;
      }
    | undefined,
  vars: Record<string, unknown>,
  runId: string,
  runGroupId: string,
): RunEnvironmentWorkspace | null {
  if (workspace === undefined) {
    return null;
  }
  const containerPath = interpolateString(workspace.containerPath, vars);
  assertAbsolutePath(containerPath, "workspace.containerPath");
  const hostRoot =
    workspace.hostPath === undefined
      ? workspace.hostRoot !== undefined
        ? interpolateString(workspace.hostRoot, vars)
        : interpolateString("{{state_dir}}/workspaces", vars)
      : null;
  const hostPath =
    workspace.hostPath !== undefined
      ? interpolateString(workspace.hostPath, vars)
      : join(hostRoot as string, workspace.scope === "group" ? runGroupId : runId);
  if (hostRoot !== null) {
    assertAbsolutePath(hostRoot, "workspace.hostRoot");
  }
  assertAbsolutePath(hostPath, "workspace.hostPath");
  return {
    scope: workspace.scope,
    hostRoot: hostRoot === null ? null : resolve(hostRoot),
    hostPath: resolve(hostPath),
    containerPath,
    mode: workspace.mode,
    create: workspace.create,
    createdAt: null,
  };
}

type AuthoredLifecycleStep =
  | {
      kind: "command";
      target: "host" | "container";
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
      timeoutMs?: number;
      user?: string;
      detach: boolean;
    }
  | {
      kind: "git-clone";
      target: "host" | "container";
      source: string;
      baseRef: string;
      branch: string;
      timeoutMs?: number;
    };

function resolveLifecycle(
  lifecycle:
    | {
        afterStart: AuthoredLifecycleStep[];
        onWorkspaceCreate: AuthoredLifecycleStep[];
      }
    | undefined,
  vars: Record<string, unknown>,
): RunManagedContainerEnvironment["lifecycle"] {
  if (lifecycle === undefined) {
    return null;
  }
  const afterStartSteps = resolveLifecycleSteps(lifecycle.afterStart, vars);
  const onWorkspaceCreateSteps = resolveLifecycleSteps(lifecycle.onWorkspaceCreate, vars);
  if (afterStartSteps.length === 0 && onWorkspaceCreateSteps.length === 0) {
    return null;
  }
  return {
    afterStart:
      afterStartSteps.length === 0
        ? null
        : {
            steps: afterStartSteps,
            completedContainerId: null,
            completedAt: null,
            lastError: null,
          },
    onWorkspaceCreate:
      onWorkspaceCreateSteps.length === 0
        ? null
        : {
            steps: onWorkspaceCreateSteps,
            completedAt: null,
            lastError: null,
          },
  };
}

function resolveLifecycleSteps(
  steps: AuthoredLifecycleStep[],
  vars: Record<string, unknown>,
): RunEnvironmentLifecycleStep[] {
  return steps.map((step) => {
    if (step.kind === "command") {
      const cwd = step.cwd === undefined ? null : interpolateLifecycleString(step.cwd, vars);
      if (cwd !== null) {
        assertAbsolutePath(cwd, "lifecycle command cwd");
      }
      return {
        kind: "command",
        target: step.target,
        command: interpolateLifecycleString(step.command, vars),
        args: step.args.map((arg) => interpolateLifecycleString(arg, vars)),
        env: interpolateLifecycleStringRecord(step.env, vars),
        cwd,
        timeoutMs: step.timeoutMs ?? null,
        user: step.user ?? null,
        detach: step.detach,
      };
    }
    const branch = interpolateLifecycleString(step.branch, vars);
    const baseRef = interpolateLifecycleString(step.baseRef, vars);
    assertGitBranchName(branch);
    assertGitBaseRefName(baseRef);
    return {
      kind: "git-clone",
      target: step.target,
      source: interpolateLifecycleString(step.source, vars),
      baseRef,
      branch,
      timeoutMs: step.timeoutMs ?? null,
    };
  });
}

function assertGitBranchName(branch: string): void {
  const trimmed = branch.trim();
  if (trimmed.length === 0 || trimmed.startsWith("-")) {
    throw new ExecutionEnvironmentError(
      "lifecycle git-clone branch must be non-empty and must not start with '-'",
    );
  }
}

function assertGitBaseRefName(baseRef: string): void {
  const trimmed = baseRef.trim();
  if (trimmed.length === 0 || trimmed.startsWith("-")) {
    throw new ExecutionEnvironmentError(
      "lifecycle git-clone baseRef must be non-empty and must not start with '-'",
    );
  }
}

function resolveLateLifecycleStep(
  step: RunEnvironmentLifecycleStep,
  vars: Record<string, string>,
): RunEnvironmentLifecycleStep {
  if (step.kind === "command") {
    return {
      kind: "command",
      target: step.target,
      command: interpolateLateLifecycleString(step.command, vars),
      args: step.args.map((arg) => interpolateLateLifecycleString(arg, vars)),
      env: Object.fromEntries(
        Object.entries(step.env).map(([key, value]) => [
          key,
          interpolateLateLifecycleString(value, vars),
        ]),
      ),
      cwd: step.cwd === null ? null : interpolateLateLifecycleString(step.cwd, vars),
      timeoutMs: step.timeoutMs,
      user: step.user,
      detach: step.detach,
    };
  }
  const branch = interpolateLateLifecycleString(step.branch, vars);
  const baseRef = interpolateLateLifecycleString(step.baseRef, vars);
  assertGitBranchName(branch);
  assertGitBaseRefName(baseRef);
  return {
    kind: "git-clone",
    target: step.target,
    source: interpolateLateLifecycleString(step.source, vars),
    baseRef,
    branch,
    timeoutMs: step.timeoutMs,
  };
}

function resolvePhaseSteps(
  steps: RunEnvironmentLifecycleStep[],
  vars: Record<string, string>,
  defaults: { hostCwd: string; containerCwd: string },
): RunEnvironmentLifecycleStep[] {
  return steps.map((step) => {
    const resolved = resolveLateLifecycleStep(step, vars);
    if (resolved.kind !== "command") {
      return resolved;
    }
    const cwd =
      resolved.cwd ?? (resolved.target === "container" ? defaults.containerCwd : defaults.hostCwd);
    assertAbsolutePath(cwd, "lifecycle command cwd");
    return {
      ...resolved,
      cwd,
    };
  });
}

function lifecycleMetadataVars(
  environment: RunManagedContainerEnvironment,
  inspect: InspectSummary,
): Record<string, string> {
  return {
    container_name: environment.containerName,
    container_id: inspect.id,
    container_pid: inspect.pid,
  };
}

function phaseErrorMessage(error: unknown): string {
  const message = (error as Error).message;
  return message.length > 800 ? `${message.slice(0, 800)}...` : message;
}

function resolveEnvironmentConfig(
  loaded: LoadedEnvironmentDefinition,
  vars: Record<string, unknown>,
  runId: string,
  runGroupId: string,
  backend: BackendName,
): RunExecutionEnvironment {
  const config = loaded.config;
  const resolvedWorkspace =
    config.mode === "managed" ? resolveWorkspace(config.workspace, vars, runId, runGroupId) : null;
  const environmentVars =
    resolvedWorkspace === null
      ? vars
      : {
          ...vars,
          workspace_host_path: resolvedWorkspace.hostPath,
          workspace_container_path: resolvedWorkspace.containerPath,
        };
  const cwd = rewriteWorkspacePath(
    resolvedWorkspace,
    interpolateString(config.cwd, environmentVars),
  );
  assertAbsolutePath(cwd, "executionEnvironment.cwd");
  const env = interpolateStringRecord(config.env, environmentVars);
  const common = {
    kind: "container" as const,
    name: loaded.name,
    sourcePath: loaded.sourcePath,
    engine: config.engine,
    cwd,
    env,
    extraExecArgs: [...config.extraExecArgs],
    lastValidatedAt: null,
    lastError: null,
  };

  if (config.mode === "existing") {
    return {
      ...common,
      mode: "existing",
      container: interpolateString(config.container, vars),
      containerIdAtValidation: null,
      expectedMounts: resolveMounts(config.expectedMounts, vars),
    };
  }

  return {
    ...common,
    mode: "managed",
    image: interpolateString(config.image, environmentVars),
    lifetime: config.lifetime,
    containerName: config.containerName
      ? interpolateString(config.containerName, environmentVars)
      : generatedContainerName(config.lifetime, runId, runGroupId),
    containerId: null,
    workspace: resolvedWorkspace,
    lifecycle: resolveLifecycle(config.lifecycle, environmentVars),
    sessionMounts: resolveSessionMounts(config.sessionMounts, backend),
    mounts: resolveMounts(config.mounts, environmentVars),
    network: config.network,
    security: {
      ...config.security,
      capDrop: [...config.security.capDrop],
      capAdd: [...config.security.capAdd],
    },
    extraRunArgs: [...config.extraRunArgs],
    cleanup: {
      policy: config.cleanup.policy,
      cleanedAt: null,
      lastError: null,
    },
  };
}

export function resolveFreshExecutionEnvironment(
  options: ResolveEnvironmentOptions,
): RunExecutionEnvironment | null {
  const selected =
    options.selectedEnvironment !== undefined
      ? options.selectedEnvironment
      : resolveFreshExecutionEnvironmentDefinition({
          reference: options.reference,
          overrideEnvironment: options.overrideEnvironment,
          cwd: options.cwd,
        });
  if (selected === null) {
    return null;
  }
  return resolveEnvironmentConfig(
    selected,
    options.injectedVars,
    options.runId,
    options.runGroupId,
    options.backend,
  );
}

interface InspectSummary {
  id: string;
  pid: string;
  running: boolean;
  mounts: { source: string; destination: string; rw: boolean }[];
}

async function runEngine(
  environment: RunExecutionEnvironment,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  let result: Awaited<ReturnType<typeof runProcess>>;
  try {
    result = await runProcess({
      command: environment.engine,
      args,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      timeoutMs: options.timeoutMs ?? ENGINE_DEFAULT_TIMEOUT_MS,
      abortSignal: options.signal,
    });
  } catch (error) {
    throw new ExecutionEnvironmentError(
      `${environment.engine} ${args[0]} failed: ${(error as Error).message}`,
    );
  }
  if (result.exitCode !== 0 || result.timedOut || result.aborted) {
    const detail = processFailureDetail(result);
    throw new ExecutionEnvironmentError(`${environment.engine} ${args[0]} failed: ${detail}`);
  }
  return {
    stdout: result.stdoutText,
    stderr: result.stderrText,
  };
}

function boundedExcerpt(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed;
}

function processFailureDetail(result: Awaited<ReturnType<typeof runProcess>>): string {
  return (
    boundedExcerpt(result.stderrText) ||
    boundedExcerpt(result.stdoutText) ||
    (result.timedOut
      ? "timed out"
      : result.aborted
        ? "aborted"
        : `exited with code ${result.exitCode ?? "null"}`)
  );
}

async function inspectContainer(
  environment: RunExecutionEnvironment,
  container: string,
  options: { signal?: AbortSignal } = {},
): Promise<InspectSummary> {
  const result = await runEngine(environment, ["inspect", container], {
    signal: options.signal,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new ExecutionEnvironmentError(
      `${environment.engine} inspect returned invalid JSON: ${(error as Error).message}`,
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ExecutionEnvironmentError(`container ${container} was not found`);
  }
  const record = parsed[0] as Record<string, unknown>;
  const state = record.State as Record<string, unknown> | undefined;
  const mounts = Array.isArray(record.Mounts) ? record.Mounts : [];
  const running = state?.Running === true;
  const pid = running
    ? typeof state?.Pid === "number" && Number.isFinite(state.Pid) && state.Pid > 0
      ? String(state.Pid)
      : typeof state?.Pid === "string" && state.Pid !== "0"
        ? state.Pid
        : ""
    : "";
  return {
    id: typeof record.Id === "string" ? record.Id : container,
    pid,
    running,
    mounts: mounts.flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const mount = entry as Record<string, unknown>;
      return typeof mount.Source === "string" && typeof mount.Destination === "string"
        ? [
            {
              source: mount.Source,
              destination: mount.Destination,
              rw: mount.RW !== false,
            },
          ]
        : [];
    }),
  };
}

function assertStartedContainerRunning(
  environment: RunManagedContainerEnvironment,
  inspect: InspectSummary,
): void {
  if (!inspect.running) {
    throw new ExecutionEnvironmentError(`container ${environment.containerName} failed to start`);
  }
}

async function cleanupStartedManagedContainer(
  environment: RunManagedContainerEnvironment,
): Promise<string | null> {
  if (environment.containerId === null) {
    return null;
  }
  try {
    await runEngine(environment, ["rm", "-f", environment.containerId]);
    return null;
  } catch (error) {
    return `container cleanup failed: ${phaseErrorMessage(error)}`;
  }
}

async function validateCwd(
  environment: RunExecutionEnvironment,
  container: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  await runEngine(environment, ["exec", container, "test", "-d", environment.cwd], {
    signal: options.signal,
  });
}

async function runContainerCommand(
  environment: RunExecutionEnvironment,
  container: string,
  cwd: string,
  env: Record<string, string>,
  command: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    user?: string | null;
    detach?: boolean;
  } = {},
): Promise<void> {
  await runEngine(
    environment,
    [
      "exec",
      options.detach === true ? "-d" : "-i",
      ...environment.extraExecArgs,
      ...(options.user === null || options.user === undefined ? [] : ["--user", options.user]),
      "-w",
      cwd,
      ...Object.entries({ ...environment.env, ...env }).flatMap(([key, value]) => [
        "-e",
        `${key}=${value}`,
      ]),
      container,
      command,
      ...args,
    ],
    {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    },
  );
}

async function runHostCommand(
  cwd: string,
  env: Record<string, string>,
  command: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  let result: Awaited<ReturnType<typeof runProcess>>;
  try {
    result = await runProcess({
      command,
      args,
      cwd,
      env: { ...(process.env as Record<string, string>), ...env },
      timeoutMs: options.timeoutMs ?? WORKSPACE_LIFECYCLE_STEP_TIMEOUT_MS,
      abortSignal: options.signal,
    });
  } catch (error) {
    throw new ExecutionEnvironmentError(`${command} failed: ${(error as Error).message}`);
  }
  if (result.exitCode !== 0 || result.timedOut || result.aborted) {
    throw new ExecutionEnvironmentError(`${command} failed: ${processFailureDetail(result)}`);
  }
}

function explicitWorkspaceStateKey(hostPath: string): string {
  return createHash("sha256").update(resolve(hostPath)).digest("hex");
}

function workspaceLifecycleStateDir(workspace: RunEnvironmentWorkspace): string {
  const key =
    workspace.hostRoot === null
      ? explicitWorkspaceStateKey(workspace.hostPath)
      : pathWithin(workspace.hostRoot, workspace.hostPath);
  return join(
    resolveTaskRunnerStateDir(),
    WORKSPACE_STATE_DIR,
    key && key.length > 0 ? key : explicitWorkspaceStateKey(workspace.hostPath),
  );
}

function afterStartLifecycleStateDir(
  environment: RunManagedContainerEnvironment,
  inspect: InspectSummary,
): string {
  const key = createHash("sha256")
    .update(`${environment.engine}\0${environment.containerName}\0${inspect.id}`)
    .digest("hex");
  return join(resolveTaskRunnerStateDir(), CONTAINER_STATE_DIR, key);
}

function readWorkspaceLifecycleMarker(stateDir: string): string | null {
  const markerPath = join(stateDir, WORKSPACE_LIFECYCLE_MARKER);
  let raw: string;
  try {
    raw = readFileSync(markerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ExecutionEnvironmentError(
      `workspace lifecycle marker ${markerPath} is invalid JSON: ${(error as Error).message}`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>).completedAt !== "string"
  ) {
    throw new ExecutionEnvironmentError(
      `workspace lifecycle marker ${markerPath} is missing completedAt`,
    );
  }
  return (parsed as { completedAt: string }).completedAt;
}

function readAfterStartLifecycleMarker(stateDir: string, containerId: string): string | null {
  const markerPath = join(stateDir, AFTER_START_LIFECYCLE_MARKER);
  let raw: string;
  try {
    raw = readFileSync(markerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ExecutionEnvironmentError(
      `afterStart lifecycle marker ${markerPath} is invalid JSON: ${(error as Error).message}`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).containerId !== containerId ||
    typeof (parsed as Record<string, unknown>).completedAt !== "string"
  ) {
    throw new ExecutionEnvironmentError(
      `afterStart lifecycle marker ${markerPath} is missing completed state`,
    );
  }
  return (parsed as { completedAt: string }).completedAt;
}

function writeWorkspaceLifecycleMarker(stateDir: string, completedAt: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeTextFileAtomic(
    join(stateDir, WORKSPACE_LIFECYCLE_MARKER),
    `${JSON.stringify({ completedAt }, null, 2)}\n`,
  );
}

function writeAfterStartLifecycleMarker(
  stateDir: string,
  containerId: string,
  completedAt: string,
): void {
  mkdirSync(stateDir, { recursive: true });
  writeTextFileAtomic(
    join(stateDir, AFTER_START_LIFECYCLE_MARKER),
    `${JSON.stringify({ containerId, completedAt }, null, 2)}\n`,
  );
}

async function acquireLifecycleLock(
  stateDir: string,
  lockName: string,
  staleAfterMs: number,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  mkdirSync(stateDir, { recursive: true });
  const lockPath = join(stateDir, lockName);
  while (true) {
    try {
      mkdirSync(lockPath);
      try {
        writeWorkspaceLifecycleLockMetadata(lockPath);
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      return lockPath;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw error;
      }
      if (isStaleWorkspaceLifecycleLock(lockPath, staleAfterMs)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      await sleep(WORKSPACE_LIFECYCLE_LOCK_WAIT_MS, undefined, { signal: options.signal });
    }
  }
}

async function acquireWorkspaceLifecycleLock(
  stateDir: string,
  staleAfterMs: number,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  return acquireLifecycleLock(stateDir, WORKSPACE_LIFECYCLE_LOCK, staleAfterMs, options);
}

interface WorkspaceLifecycleLockMetadata {
  pid: number;
  acquiredAt: string;
}

function writeWorkspaceLifecycleLockMetadata(lockPath: string): void {
  const metadata: WorkspaceLifecycleLockMetadata = {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  writeTextFileAtomic(
    join(lockPath, WORKSPACE_LIFECYCLE_LOCK_METADATA),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
}

function readWorkspaceLifecycleLockMetadata(
  lockPath: string,
): WorkspaceLifecycleLockMetadata | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(lockPath, WORKSPACE_LIFECYCLE_LOCK_METADATA), "utf8"),
    );
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Number.isInteger((parsed as Record<string, unknown>).pid) &&
      typeof (parsed as Record<string, unknown>).acquiredAt === "string"
    ) {
      return parsed as WorkspaceLifecycleLockMetadata;
    }
  } catch {
    return null;
  }
  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function workspaceLifecycleLockAgeMs(lockPath: string): number {
  try {
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return 0;
  }
}

function isStaleWorkspaceLifecycleLock(lockPath: string, staleAfterMs: number): boolean {
  const metadata = readWorkspaceLifecycleLockMetadata(lockPath);
  if (metadata !== null) {
    return (
      !isProcessAlive(metadata.pid) || Date.now() - Date.parse(metadata.acquiredAt) > staleAfterMs
    );
  }
  return workspaceLifecycleLockAgeMs(lockPath) > staleAfterMs;
}

function lifecycleStepTimeoutMs(step: RunEnvironmentLifecycleStep): number {
  return step.timeoutMs ?? WORKSPACE_LIFECYCLE_STEP_TIMEOUT_MS;
}

function lifecycleLockStaleAfterMs(steps: RunEnvironmentLifecycleStep[]): number {
  const timeoutBudget = steps.reduce((total, step) => total + lifecycleStepTimeoutMs(step), 0);
  return (
    Math.max(WORKSPACE_LIFECYCLE_STEP_TIMEOUT_MS, timeoutBudget) +
    WORKSPACE_LIFECYCLE_LOCK_STALE_BUFFER_MS
  );
}

async function runLifecycleStep(
  environment: RunManagedContainerEnvironment,
  container: string,
  step: RunEnvironmentLifecycleStep,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (step.kind === "command") {
    if (step.cwd === null) {
      throw new ExecutionEnvironmentError("lifecycle command cwd was not resolved");
    }
    if (step.target === "host") {
      await runHostCommand(step.cwd, step.env, step.command, step.args, {
        signal: options.signal,
        timeoutMs: step.timeoutMs ?? WORKSPACE_LIFECYCLE_STEP_TIMEOUT_MS,
      });
      return;
    }
    await runContainerCommand(environment, container, step.cwd, step.env, step.command, step.args, {
      signal: options.signal,
      timeoutMs: step.timeoutMs ?? WORKSPACE_LIFECYCLE_STEP_TIMEOUT_MS,
      user: step.user,
      detach: step.detach,
    });
    return;
  }
  const workspace = environment.workspace;
  if (workspace === null) {
    throw new ExecutionEnvironmentError("lifecycle git-clone requires workspace");
  }
  const cwd = step.target === "container" ? workspace.containerPath : workspace.hostPath;
  const runGit =
    step.target === "container"
      ? (args: string[]) =>
          runContainerCommand(environment, container, cwd, {}, "git", args, {
            signal: options.signal,
            timeoutMs: step.timeoutMs ?? WORKSPACE_LIFECYCLE_STEP_TIMEOUT_MS,
          })
      : (args: string[]) =>
          runHostCommand(cwd, {}, "git", args, {
            signal: options.signal,
            timeoutMs: step.timeoutMs ?? WORKSPACE_LIFECYCLE_STEP_TIMEOUT_MS,
          });
  await runGit(["-c", "protocol.ext.allow=never", "clone", "--", step.source, "."]);
  await runGit(["checkout", "-B", step.branch, step.baseRef]);
}

function updateAfterStartLifecycle(
  environment: RunManagedContainerEnvironment,
  updates: Partial<
    NonNullable<NonNullable<RunManagedContainerEnvironment["lifecycle"]>["afterStart"]>
  >,
): RunManagedContainerEnvironment {
  if (environment.lifecycle === null || environment.lifecycle.afterStart === null) {
    return environment;
  }
  return {
    ...environment,
    lifecycle: {
      ...environment.lifecycle,
      afterStart: {
        ...environment.lifecycle.afterStart,
        ...updates,
      },
    },
  };
}

function updateOnWorkspaceCreateLifecycle(
  environment: RunManagedContainerEnvironment,
  updates: Partial<
    NonNullable<NonNullable<RunManagedContainerEnvironment["lifecycle"]>["onWorkspaceCreate"]>
  >,
): RunManagedContainerEnvironment {
  if (environment.lifecycle === null || environment.lifecycle.onWorkspaceCreate === null) {
    return environment;
  }
  return {
    ...environment,
    lifecycle: {
      ...environment.lifecycle,
      onWorkspaceCreate: {
        ...environment.lifecycle.onWorkspaceCreate,
        ...updates,
      },
    },
  };
}

async function runAfterStartLifecycle(
  environment: RunManagedContainerEnvironment,
  inspect: InspectSummary,
  options: { signal?: AbortSignal } = {},
): Promise<RunManagedContainerEnvironment> {
  const phase = environment.lifecycle?.afterStart ?? null;
  if (phase === null || phase.completedContainerId === inspect.id) {
    return environment;
  }
  const lifecycleStateDir = afterStartLifecycleStateDir(environment, inspect);
  const completedAt = readAfterStartLifecycleMarker(lifecycleStateDir, inspect.id);
  if (completedAt !== null) {
    return updateAfterStartLifecycle(environment, {
      completedContainerId: inspect.id,
      completedAt,
      lastError: null,
    });
  }
  const lockPath = await acquireLifecycleLock(
    lifecycleStateDir,
    AFTER_START_LIFECYCLE_LOCK,
    lifecycleLockStaleAfterMs(phase.steps),
    options,
  );
  const container = containerTarget(environment);
  try {
    const lockedCompletedAt = readAfterStartLifecycleMarker(lifecycleStateDir, inspect.id);
    if (lockedCompletedAt !== null) {
      return updateAfterStartLifecycle(environment, {
        completedContainerId: inspect.id,
        completedAt: lockedCompletedAt,
        lastError: null,
      });
    }
    const steps = resolvePhaseSteps(phase.steps, lifecycleMetadataVars(environment, inspect), {
      hostCwd: process.cwd(),
      containerCwd: environment.cwd,
    });
    for (const [index, step] of steps.entries()) {
      try {
        await runLifecycleStep(environment, container, step, options);
      } catch (error) {
        const label = step.kind === "command" ? `${step.kind}: ${step.command}` : step.kind;
        throw new ExecutionEnvironmentError(
          `afterStart lifecycle step ${index} (${label}) failed: ${(error as Error).message}`,
        );
      }
    }
    const lifecycleCompletedAt = new Date().toISOString();
    writeAfterStartLifecycleMarker(lifecycleStateDir, inspect.id, lifecycleCompletedAt);
    return updateAfterStartLifecycle(environment, {
      completedContainerId: inspect.id,
      completedAt: lifecycleCompletedAt,
      lastError: null,
    });
  } catch (error) {
    const message = `afterStart lifecycle failed: ${phaseErrorMessage(error)}`;
    throw new ExecutionEnvironmentError(
      message,
      updateAfterStartLifecycle(environment, {
        lastError: message,
      }),
    );
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

async function runWorkspaceLifecycle(
  environment: RunManagedContainerEnvironment,
  inspect: InspectSummary,
  options: { signal?: AbortSignal } = {},
): Promise<RunManagedContainerEnvironment> {
  const workspace = environment.workspace;
  const phase = environment.lifecycle?.onWorkspaceCreate ?? null;
  if (workspace === null || phase === null) {
    return environment;
  }
  const lifecycleStateDir = workspaceLifecycleStateDir(workspace);
  const completedAt = readWorkspaceLifecycleMarker(lifecycleStateDir);
  if (completedAt !== null) {
    return updateOnWorkspaceCreateLifecycle(environment, {
      completedAt,
      lastError: null,
    });
  }

  const lockPath = await acquireWorkspaceLifecycleLock(
    lifecycleStateDir,
    lifecycleLockStaleAfterMs(phase.steps),
    options,
  );
  try {
    const lockedCompletedAt = readWorkspaceLifecycleMarker(lifecycleStateDir);
    if (lockedCompletedAt !== null) {
      return updateOnWorkspaceCreateLifecycle(environment, {
        completedAt: lockedCompletedAt,
        lastError: null,
      });
    }

    const container = containerTarget(environment);
    const steps = resolvePhaseSteps(phase.steps, lifecycleMetadataVars(environment, inspect), {
      hostCwd: workspace.hostPath,
      containerCwd: workspace.containerPath,
    });
    try {
      for (const [index, step] of steps.entries()) {
        try {
          await runLifecycleStep(environment, container, step, options);
        } catch (error) {
          const label = step.kind === "command" ? `${step.kind}: ${step.command}` : step.kind;
          throw new ExecutionEnvironmentError(
            `workspace lifecycle step ${index} (${label}) failed: ${(error as Error).message}`,
          );
        }
      }
      const lifecycleCompletedAt = new Date().toISOString();
      writeWorkspaceLifecycleMarker(lifecycleStateDir, lifecycleCompletedAt);
      return updateOnWorkspaceCreateLifecycle(environment, {
        completedAt: lifecycleCompletedAt,
        lastError: null,
      });
    } catch (error) {
      const message = `workspace lifecycle failed: ${phaseErrorMessage(error)}`;
      throw new ExecutionEnvironmentError(
        message,
        updateOnWorkspaceCreateLifecycle(environment, {
          lastError: message,
        }),
      );
    }
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function validateExpectedMounts(
  environment: RunExistingContainerEnvironment,
  inspect: InspectSummary,
): void {
  for (const expected of environment.expectedMounts) {
    const actual = inspect.mounts.find(
      (mount) => mount.source === expected.hostPath && mount.destination === expected.containerPath,
    );
    if (!actual) {
      throw new ExecutionEnvironmentError(
        `container ${environment.container} is missing expected mount ${expected.hostPath}:${expected.containerPath}`,
      );
    }
    if (expected.mode === "rw" && !actual.rw) {
      throw new ExecutionEnvironmentError(
        `container ${environment.container} mount ${expected.containerPath} is not writable`,
      );
    }
  }
}

async function startManagedContainer(
  environment: RunManagedContainerEnvironment,
  options: { signal?: AbortSignal } = {},
): Promise<RunManagedContainerEnvironment> {
  const args = [
    "run",
    "-d",
    "--name",
    environment.containerName,
    "--label",
    "task-runner=true",
    "--label",
    `task-runner-environment=${environment.name ?? "inline"}`,
    "--workdir",
    environment.workspace !== null && environment.lifecycle?.onWorkspaceCreate !== null
      ? environment.workspace.containerPath
      : environment.cwd,
  ];

  if (environment.network !== "default") {
    args.push("--network", environment.network);
  }
  if (environment.security.userns) {
    args.push("--userns", environment.security.userns);
  }
  if (environment.security.selinuxLabel === "disable") {
    args.push("--security-opt", "label=disable");
  } else if (environment.security.selinuxLabel === "shared") {
    args.push("--security-opt", "label=shared");
  } else if (environment.security.selinuxLabel === "private") {
    args.push("--security-opt", "label=private");
  }
  if (environment.security.readOnlyRootFilesystem) {
    args.push("--read-only");
  }
  for (const cap of environment.security.capDrop) {
    args.push("--cap-drop", cap);
  }
  for (const cap of environment.security.capAdd) {
    args.push("--cap-add", cap);
  }
  for (const mount of [
    ...(environment.workspace === null ? [] : [environment.workspace]),
    ...environment.sessionMounts,
    ...environment.mounts,
  ]) {
    args.push("-v", `${mount.hostPath}:${mount.containerPath}:${mount.mode}`);
  }
  for (const [key, value] of Object.entries(environment.env)) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(...environment.extraRunArgs);
  args.push(
    environment.image,
    "/bin/sh",
    "-lc",
    'trap "exit 0" TERM INT; while true; do sleep 3600; done',
  );
  const started = await runEngine(environment, args, {
    signal: options.signal,
    timeoutMs: ENGINE_START_TIMEOUT_MS,
  });
  const containerId = started.stdout.trim() || environment.containerName;
  return {
    ...environment,
    containerId,
    cleanup: {
      ...environment.cleanup,
      cleanedAt: null,
      lastError: null,
    },
    lastError: null,
  };
}

export async function prepareExecutionEnvironment(
  environment: RunExecutionEnvironment | null,
  options: { signal?: AbortSignal } = {},
): Promise<RunExecutionEnvironment | null> {
  if (environment === null) {
    return null;
  }
  if (environment.mode === "existing") {
    const inspected = await inspectContainer(environment, environment.container, {
      signal: options.signal,
    });
    if (!inspected.running) {
      throw new ExecutionEnvironmentError(`container ${environment.container} is not running`);
    }
    validateExpectedMounts(environment, inspected);
    await validateCwd(environment, environment.container, { signal: options.signal });
    return {
      ...environment,
      containerIdAtValidation: inspected.id,
      lastValidatedAt: new Date().toISOString(),
      lastError: null,
    };
  }

  let next = environment;
  if (next.workspace?.create === true) {
    const createdPath = mkdirSync(next.workspace.hostPath, { recursive: true });
    next = {
      ...next,
      workspace: {
        ...next.workspace,
        createdAt:
          next.workspace.createdAt ?? (createdPath === undefined ? null : new Date().toISOString()),
      },
    };
  }
  for (const sessionMount of next.sessionMounts) {
    mkdirSync(sessionMount.hostPath, { recursive: true });
  }
  let startedContainer = false;
  let inspectedManaged: InspectSummary | null = null;
  if (next.containerId === null) {
    try {
      const inspected = await inspectContainer(next, next.containerName, {
        signal: options.signal,
      });
      if (!inspected.running) {
        throw new ExecutionEnvironmentError(`container ${next.containerName} is not running`);
      }
      next = {
        ...next,
        containerId: inspected.id,
        cleanup: {
          ...next.cleanup,
          cleanedAt: null,
          lastError: null,
        },
      };
      inspectedManaged = inspected;
    } catch (error) {
      if (!(error instanceof ExecutionEnvironmentError)) {
        throw error;
      }
      try {
        next = await startManagedContainer(next, { signal: options.signal });
        startedContainer = true;
        inspectedManaged = await inspectContainer(next, next.containerId ?? next.containerName, {
          signal: options.signal,
        });
        assertStartedContainerRunning(next, inspectedManaged);
        next = {
          ...next,
          containerId: inspectedManaged.id,
        };
      } catch (startError) {
        if (next.lifetime === "group") {
          try {
            const inspected = await inspectContainer(next, next.containerName, {
              signal: options.signal,
            });
            if (inspected.running) {
              next = {
                ...next,
                containerId: inspected.id,
                cleanup: {
                  ...next.cleanup,
                  cleanedAt: null,
                  lastError: null,
                },
                lastError: null,
              };
              inspectedManaged = inspected;
            } else {
              throw startError;
            }
          } catch {
            if (startedContainer) {
              await cleanupStartedManagedContainer(next);
            }
            throw startError;
          }
        } else {
          if (startedContainer) {
            await cleanupStartedManagedContainer(next);
          }
          throw startError;
        }
      }
    }
  } else {
    const inspected = await inspectContainer(next, next.containerId, { signal: options.signal });
    if (!inspected.running) {
      try {
        next = await startManagedContainer(
          {
            ...next,
            containerId: null,
          },
          { signal: options.signal },
        );
        startedContainer = true;
        inspectedManaged = await inspectContainer(next, next.containerId ?? next.containerName, {
          signal: options.signal,
        });
        assertStartedContainerRunning(next, inspectedManaged);
        next = {
          ...next,
          containerId: inspectedManaged.id,
        };
      } catch (startError) {
        if (startedContainer) {
          await cleanupStartedManagedContainer(next);
        }
        throw startError;
      }
    } else {
      inspectedManaged = inspected;
    }
  }
  try {
    if (inspectedManaged === null) {
      inspectedManaged = await inspectContainer(next, next.containerId ?? next.containerName, {
        signal: options.signal,
      });
    }
    next = await runAfterStartLifecycle(next, inspectedManaged, { signal: options.signal });
    next = await runWorkspaceLifecycle(next, inspectedManaged, { signal: options.signal });
    await validateCwd(next, next.containerId ?? next.containerName, { signal: options.signal });
  } catch (error) {
    let cleanupLastError: string | null = null;
    if (startedContainer && next.containerId !== null) {
      cleanupLastError = await cleanupStartedManagedContainer(next);
    }
    if (error instanceof ExecutionEnvironmentError && error.environment !== null) {
      const failedEnvironment =
        startedContainer && error.environment.mode === "managed"
          ? {
              ...error.environment,
              containerId: null,
              cleanup:
                cleanupLastError === null
                  ? error.environment.cleanup
                  : {
                      ...error.environment.cleanup,
                      lastError: cleanupLastError,
                    },
            }
          : error.environment;
      throw new ExecutionEnvironmentError(error.message, failedEnvironment);
    }
    throw error;
  }
  return {
    ...next,
    lastValidatedAt: new Date().toISOString(),
    lastError: null,
  };
}

export function containerTarget(environment: RunExecutionEnvironment): string {
  return environment.mode === "existing"
    ? environment.container
    : (environment.containerId ?? environment.containerName);
}

export function buildEnvironmentLauncher(
  environment: RunExecutionEnvironment | null,
  env: Record<string, string>,
): ResolvedLauncherConfig | undefined {
  if (environment === null) {
    return undefined;
  }
  const forwardedEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => key.startsWith("TASK_RUNNER_")),
  );
  const args = [
    "exec",
    "-i",
    ...environment.extraExecArgs,
    "-w",
    environment.cwd,
    ...Object.entries({ ...forwardedEnv, ...environment.env }).flatMap(([key, value]) => [
      "-e",
      `${key}=${value}`,
    ]),
    containerTarget(environment),
  ];
  return {
    kind: "prefix",
    command: environment.engine,
    args,
    name: null,
    source: "inline",
  };
}

export async function cleanupExecutionEnvironment(
  environment: RunExecutionEnvironment | null,
  options: { includeManual?: boolean; throwOnFailure?: boolean } = {},
): Promise<RunExecutionEnvironment | null> {
  if (environment === null || environment.mode === "existing") {
    return environment;
  }
  if (
    environment.cleanup.cleanedAt !== null ||
    (environment.cleanup.policy !== "terminal" && options.includeManual !== true)
  ) {
    return environment;
  }
  const target = environment.containerId ?? environment.containerName;
  try {
    await runEngine(environment, ["rm", "-f", target]);
    return {
      ...environment,
      containerId: null,
      cleanup: {
        ...environment.cleanup,
        cleanedAt: new Date().toISOString(),
        lastError: null,
      },
    };
  } catch (error) {
    if (options.throwOnFailure === true) {
      throw error;
    }
    return {
      ...environment,
      cleanup: {
        ...environment.cleanup,
        lastError: (error as Error).message,
      },
      lastError: (error as Error).message,
    };
  }
}

export function groupEnvironmentHasPendingUsers(
  manifest: Pick<RunManifest, "runId" | "runGroupId" | "executionEnvironment">,
  candidates: Iterable<{
    manifest: Pick<RunManifest, "runId" | "runGroupId" | "status" | "executionEnvironment">;
  }>,
): boolean {
  const environment = manifest.executionEnvironment;
  if (environment?.mode !== "managed" || environment.lifetime !== "group") {
    return false;
  }
  for (const { manifest: candidate } of candidates) {
    if (candidate.runId === manifest.runId) {
      continue;
    }
    if (
      candidate.runGroupId !== manifest.runGroupId ||
      candidate.executionEnvironment?.mode !== "managed" ||
      candidate.executionEnvironment.lifetime !== "group" ||
      candidate.executionEnvironment.containerName !== environment.containerName
    ) {
      continue;
    }
    if (
      candidate.status === "initialized" ||
      candidate.status === "ready" ||
      candidate.status === "running"
    ) {
      return true;
    }
  }
  return false;
}
