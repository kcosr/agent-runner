import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { loadEnvironmentConfig } from "../../config/loader.js";
import { resolveTaskRunnerStateDir } from "../../config/runtime-paths.js";
import type { BackendName } from "../backends/types.js";
import type { EnvironmentReference, LoadedEnvironmentDefinition } from "../config/environments.js";
import { interpolate } from "../config/interpolate.js";
import type { ResolvedLauncherConfig } from "../config/launchers.js";
import type {
  RunEnvironmentSessionMount,
  RunEnvironmentSessionMountPreset,
  RunEnvironmentWorkspace,
  RunEnvironmentWorkspaceLifecycleStep,
  RunExecutionEnvironment,
  RunExistingContainerEnvironment,
  RunManagedContainerEnvironment,
  RunManifest,
} from "./manifest.js";

const execFileAsync = promisify(execFile);
const INTERPOLATION_TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/;

export class ExecutionEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionEnvironmentError";
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
  const unresolved = interpolated.match(INTERPOLATION_TOKEN_PATTERN)?.[0];
  if (unresolved) {
    throw new ExecutionEnvironmentError(
      `execution environment interpolation could not resolve token ${unresolved}`,
    );
  }
  return interpolated;
}

function interpolateStringRecord(
  record: Record<string, string>,
  vars: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, interpolateString(value, vars)]),
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
    lifecycle: null,
  };
}

function applyWorkspaceLifecycle(
  workspace: RunEnvironmentWorkspace | null,
  lifecycle: { onCreate: RunEnvironmentWorkspaceLifecycleStep[] } | undefined,
  vars: Record<string, unknown>,
): RunEnvironmentWorkspace | null {
  if (workspace === null || lifecycle === undefined) {
    return workspace;
  }
  return {
    ...workspace,
    lifecycle: {
      onCreate: resolveWorkspaceLifecycleSteps(lifecycle.onCreate, vars),
      completedAt: null,
      lastError: null,
    },
  };
}

function resolveWorkspaceLifecycleSteps(
  steps: RunEnvironmentWorkspaceLifecycleStep[],
  vars: Record<string, unknown>,
): RunEnvironmentWorkspaceLifecycleStep[] {
  return steps.map((step) => {
    if (step.kind === "command") {
      return {
        kind: "command",
        command: interpolateString(step.command, vars),
        args: step.args.map((arg) => interpolateString(arg, vars)),
        env: interpolateStringRecord(step.env, vars),
      };
    }
    const branch = interpolateString(step.branch, vars);
    assertGitBranchName(branch);
    return {
      kind: "git-clone",
      source: interpolateString(step.source, vars),
      baseRef: interpolateString(step.baseRef, vars),
      branch,
    };
  });
}

function assertGitBranchName(branch: string): void {
  if (branch.trim().length === 0 || branch.startsWith("-")) {
    throw new ExecutionEnvironmentError(
      "workspace lifecycle git-clone branch must be non-empty and must not start with '-'",
    );
  }
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
  const workspace =
    config.mode === "managed"
      ? applyWorkspaceLifecycle(resolvedWorkspace, config.workspace?.lifecycle, environmentVars)
      : null;
  const cwd = rewriteWorkspacePath(workspace, interpolateString(config.cwd, environmentVars));
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
    workspace,
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
  running: boolean;
  mounts: { source: string; destination: string; rw: boolean }[];
}

async function runEngine(
  environment: RunExecutionEnvironment,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(environment.engine, args, {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      signal: options.signal,
      timeout: options.timeoutMs ?? ENGINE_DEFAULT_TIMEOUT_MS,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const err = error as Error & { stderr?: string; stdout?: string };
    const detail = err.stderr?.trim() || err.stdout?.trim() || err.message;
    throw new ExecutionEnvironmentError(`${environment.engine} ${args[0]} failed: ${detail}`);
  }
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
  return {
    id: typeof record.Id === "string" ? record.Id : container,
    running: state?.Running === true,
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
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  await runEngine(
    environment,
    [
      "exec",
      "-i",
      ...environment.extraExecArgs,
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

function readWorkspaceLifecycleMarker(stateDir: string): string | null {
  const markerPath = join(stateDir, WORKSPACE_LIFECYCLE_MARKER);
  if (!existsSync(markerPath)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(markerPath, "utf8"));
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

function writeWorkspaceLifecycleMarker(stateDir: string, completedAt: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, WORKSPACE_LIFECYCLE_MARKER),
    `${JSON.stringify({ completedAt }, null, 2)}\n`,
  );
}

async function acquireWorkspaceLifecycleLock(
  stateDir: string,
  staleAfterMs: number,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  mkdirSync(stateDir, { recursive: true });
  const lockPath = join(stateDir, WORKSPACE_LIFECYCLE_LOCK);
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

interface WorkspaceLifecycleLockMetadata {
  pid: number;
  acquiredAt: string;
}

function writeWorkspaceLifecycleLockMetadata(lockPath: string): void {
  const metadata: WorkspaceLifecycleLockMetadata = {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  writeFileSync(
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

function workspaceLifecycleLockStaleAfterMs(stepCount: number): number {
  return (
    Math.max(1, stepCount) * WORKSPACE_LIFECYCLE_STEP_TIMEOUT_MS +
    WORKSPACE_LIFECYCLE_LOCK_STALE_BUFFER_MS
  );
}

async function runWorkspaceLifecycleStep(
  environment: RunManagedContainerEnvironment,
  workspace: RunEnvironmentWorkspace,
  container: string,
  step: RunEnvironmentWorkspaceLifecycleStep,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (step.kind === "command") {
    await runContainerCommand(
      environment,
      container,
      workspace.containerPath,
      step.env,
      step.command,
      step.args,
      {
        signal: options.signal,
        timeoutMs: WORKSPACE_LIFECYCLE_STEP_TIMEOUT_MS,
      },
    );
    return;
  }
  await runContainerCommand(
    environment,
    container,
    workspace.containerPath,
    {},
    "git",
    ["-c", "protocol.ext.allow=never", "clone", "--", step.source, "."],
    {
      signal: options.signal,
      timeoutMs: WORKSPACE_LIFECYCLE_STEP_TIMEOUT_MS,
    },
  );
  await runContainerCommand(
    environment,
    container,
    workspace.containerPath,
    {},
    "git",
    ["checkout", "-B", step.branch, step.baseRef],
    {
      signal: options.signal,
      timeoutMs: WORKSPACE_LIFECYCLE_STEP_TIMEOUT_MS,
    },
  );
}

async function runWorkspaceLifecycle(
  environment: RunManagedContainerEnvironment,
  options: { signal?: AbortSignal } = {},
): Promise<RunManagedContainerEnvironment> {
  const workspace = environment.workspace;
  if (workspace === null || workspace.lifecycle === null) {
    return environment;
  }
  const lifecycleStateDir = workspaceLifecycleStateDir(workspace);
  const completedAt = readWorkspaceLifecycleMarker(lifecycleStateDir);
  if (completedAt !== null) {
    return {
      ...environment,
      workspace: {
        ...workspace,
        lifecycle: {
          ...workspace.lifecycle,
          completedAt,
          lastError: null,
        },
      },
    };
  }

  const lockPath = await acquireWorkspaceLifecycleLock(
    lifecycleStateDir,
    workspaceLifecycleLockStaleAfterMs(workspace.lifecycle.onCreate.length),
    options,
  );
  try {
    const lockedCompletedAt = readWorkspaceLifecycleMarker(lifecycleStateDir);
    if (lockedCompletedAt !== null) {
      return {
        ...environment,
        workspace: {
          ...workspace,
          lifecycle: {
            ...workspace.lifecycle,
            completedAt: lockedCompletedAt,
            lastError: null,
          },
        },
      };
    }

    const container = containerTarget(environment);
    try {
      for (const [index, step] of workspace.lifecycle.onCreate.entries()) {
        try {
          await runWorkspaceLifecycleStep(environment, workspace, container, step, options);
        } catch (error) {
          const label = step.kind === "command" ? `${step.kind}: ${step.command}` : step.kind;
          throw new ExecutionEnvironmentError(
            `workspace lifecycle step ${index} (${label}) failed: ${(error as Error).message}`,
          );
        }
      }
      const lifecycleCompletedAt = new Date().toISOString();
      writeWorkspaceLifecycleMarker(lifecycleStateDir, lifecycleCompletedAt);
      return {
        ...environment,
        workspace: {
          ...workspace,
          lifecycle: {
            ...workspace.lifecycle,
            completedAt: lifecycleCompletedAt,
            lastError: null,
          },
        },
      };
    } catch (error) {
      throw new ExecutionEnvironmentError(
        `workspace lifecycle failed: ${(error as Error).message}`,
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
    environment.workspace?.lifecycle === null || environment.workspace === null
      ? environment.cwd
      : environment.workspace.containerPath,
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
    const existed = existsSync(next.workspace.hostPath);
    mkdirSync(next.workspace.hostPath, { recursive: true });
    next = {
      ...next,
      workspace: {
        ...next.workspace,
        createdAt: next.workspace.createdAt ?? (existed ? null : new Date().toISOString()),
      },
    };
  }
  for (const sessionMount of next.sessionMounts) {
    mkdirSync(sessionMount.hostPath, { recursive: true });
  }
  let startedContainer = false;
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
    } catch (error) {
      if (!(error instanceof ExecutionEnvironmentError)) {
        throw error;
      }
      try {
        next = await startManagedContainer(next, { signal: options.signal });
        startedContainer = true;
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
            } else {
              throw startError;
            }
          } catch {
            throw startError;
          }
        } else {
          throw startError;
        }
      }
    }
  } else {
    const inspected = await inspectContainer(next, next.containerId, { signal: options.signal });
    if (!inspected.running) {
      next = await startManagedContainer(
        {
          ...next,
          containerId: null,
        },
        { signal: options.signal },
      );
      startedContainer = true;
    }
  }
  try {
    next = await runWorkspaceLifecycle(next, { signal: options.signal });
    await validateCwd(next, next.containerId ?? next.containerName, { signal: options.signal });
  } catch (error) {
    if (startedContainer && next.containerId !== null) {
      await runEngine(next, ["rm", "-f", next.containerId], {
        signal: options.signal,
      }).catch(() => undefined);
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
