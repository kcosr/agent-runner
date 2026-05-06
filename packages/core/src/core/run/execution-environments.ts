import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { loadEnvironmentConfig } from "../../config/loader.js";
import type { BackendName } from "../backends/types.js";
import type { EnvironmentReference, LoadedEnvironmentDefinition } from "../config/environments.js";
import { interpolate } from "../config/interpolate.js";
import type { ResolvedLauncherConfig } from "../config/launchers.js";
import type {
  RunEnvironmentSessionMount,
  RunEnvironmentSessionMountPreset,
  RunEnvironmentWorkspace,
  RunExecutionEnvironment,
  RunExistingContainerEnvironment,
  RunManagedContainerEnvironment,
} from "./manifest.js";

const execFileAsync = promisify(execFile);
const INTERPOLATION_TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/;

export class ExecutionEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionEnvironmentError";
  }
}

interface ResolveEnvironmentOptions {
  reference: EnvironmentReference | undefined;
  overrideEnvironment?: string;
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
  };
}

function resolveEnvironmentConfig(
  loaded: LoadedEnvironmentDefinition,
  vars: Record<string, unknown>,
  runId: string,
  runGroupId: string,
  backend: BackendName,
): RunExecutionEnvironment {
  const config = loaded.config;
  const workspace =
    config.mode === "managed" ? resolveWorkspace(config.workspace, vars, runId, runGroupId) : null;
  const environmentVars =
    workspace === null
      ? vars
      : {
          ...vars,
          workspace_host_path: workspace.hostPath,
          workspace_container_path: workspace.containerPath,
        };
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
    options.overrideEnvironment !== undefined
      ? loadEnvironmentConfig(options.overrideEnvironment, options.cwd)
      : options.reference === undefined
        ? null
        : loadReferencedEnvironment(options.reference, options.cwd);
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
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(environment.engine, args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
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
): Promise<InspectSummary> {
  const result = await runEngine(environment, ["inspect", container]);
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

async function validateCwd(environment: RunExecutionEnvironment, container: string): Promise<void> {
  await runEngine(environment, ["exec", container, "test", "-d", environment.cwd]);
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
    environment.cwd,
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
  const started = await runEngine(environment, args);
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
): Promise<RunExecutionEnvironment | null> {
  if (environment === null) {
    return null;
  }
  if (environment.mode === "existing") {
    const inspected = await inspectContainer(environment, environment.container);
    if (!inspected.running) {
      throw new ExecutionEnvironmentError(`container ${environment.container} is not running`);
    }
    validateExpectedMounts(environment, inspected);
    await validateCwd(environment, environment.container);
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
  if (next.containerId === null) {
    try {
      const inspected = await inspectContainer(next, next.containerName);
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
      next = await startManagedContainer(next);
    }
  } else {
    const inspected = await inspectContainer(next, next.containerId);
    if (!inspected.running) {
      next = await startManagedContainer({
        ...next,
        containerId: null,
      });
    }
  }
  await validateCwd(next, next.containerId ?? next.containerName);
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
  const args = [
    "exec",
    "-i",
    ...environment.extraExecArgs,
    "-w",
    environment.cwd,
    ...Object.entries({ ...env, ...environment.env }).flatMap(([key, value]) => [
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
  options: { includeManual?: boolean } = {},
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
