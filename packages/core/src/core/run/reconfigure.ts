import { copyFileSync, existsSync, rmSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { resolveBackend } from "../../backends/registry.js";
import {
  loadAgentConfig,
  loadAssignmentConfig,
  loadEnvironmentConfig,
  loadLauncherConfig,
} from "../../config/loader.js";
import type { ReconfigureRunPatch, RunDetail } from "../../contracts/runs.js";
import { toRunDetail } from "../../contracts/runs.js";
import { cloneBackendConfig, cloneResolvedBackendArgs } from "../backends/types.js";
import { cloneResolvedLauncherConfig } from "../config/launchers.js";
import { loadedAgentFromManifest } from "../config/loaded.js";
import type { LoadedAgent, LoadedAssignment } from "../config/loaded.js";
import type { LockableField, VarDef } from "../config/schema.js";
import {
  type ResolvedResumeTarget,
  ResumeError,
  type RunManifest,
  buildRunResetSeed,
  cloneBackendSessionSyncState,
  cloneRunDependencyRefs,
  cloneRunExecutionEnvironment,
  cloneRuntimeVarSources,
  readManifest,
  resolveResumeTarget,
  workspaceAgentPath,
  workspaceAssignmentPath,
  workspaceEnvironmentPath,
  writeManifest,
} from "./manifest.js";
import {
  EMBEDDED_RUN_EVENT_ORIGIN,
  type RunAuditEnvelope,
  type RunEventOrigin,
  appendRunReconfiguredEvent,
  commandRunEventContext,
} from "./run-events.js";
import { LockedFieldError, type RunOverrides, VarResolutionError, runAgent } from "./run-loop.js";
import { withTaskStateLockAsync } from "./workspace-state.js";

type AuditEnvelopeEmitter = (envelope: RunAuditEnvelope) => void;

export class ReconfigureLockedFieldError extends Error {
  constructor(public readonly field: LockableField) {
    super(`cannot reconfigure locked field: ${field}`);
    this.name = "ReconfigureLockedFieldError";
  }
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function toCliVarString(key: string, value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  throw new VarResolutionError(
    `cannot reconfigure var "${key}" because the current value is not a scalar assignment value`,
  );
}

function withCliSource(def: VarDef): VarDef {
  return {
    ...def,
    sources: ["cli", ...def.sources.filter((source) => source !== "cli")],
  };
}

function inferCliEditableVarDef(value: unknown): VarDef | null {
  switch (typeof value) {
    case "string":
      return { type: "string", required: false, requiredAt: "initial", sources: ["cli"] };
    case "number":
      return Number.isFinite(value)
        ? { type: "number", required: false, requiredAt: "initial", sources: ["cli"] }
        : null;
    case "boolean":
      return { type: "boolean", required: false, requiredAt: "initial", sources: ["cli"] };
    default:
      return null;
  }
}

function buildReconfigureVarsSchema(
  manifest: RunManifest,
  loadedAssignment: LoadedAssignment | undefined,
): Record<string, VarDef> {
  const schema =
    loadedAssignment === undefined
      ? {}
      : Object.fromEntries(
          Object.entries(loadedAssignment.config.vars).map(([key, def]) => [
            key,
            withCliSource(def),
          ]),
        );
  for (const [key, value] of Object.entries(manifest.runtimeVars)) {
    if (schema[key] !== undefined || manifest.runtimeVarSources[key]?.source === "hook") {
      continue;
    }
    const inferred = inferCliEditableVarDef(value);
    if (inferred !== null) {
      schema[key] = inferred;
    }
  }
  return schema;
}

function environmentVarKeys(manifest: RunManifest): Set<string> {
  if (manifest.executionEnvironment === null) {
    return new Set();
  }
  const environmentSeedPath = workspaceEnvironmentPath(manifest.workspaceDir);
  if (!existsSync(environmentSeedPath)) {
    return new Set();
  }
  return new Set(Object.keys(loadEnvironmentConfig(environmentSeedPath).config.vars));
}

function buildReconfigureCliVars(
  manifest: RunManifest,
  varsSchema: Record<string, VarDef>,
  patchVars: Record<string, string>,
): Record<string, string> {
  const declaredKeys = new Set(Object.keys(varsSchema));
  const unknown = Object.keys(patchVars).filter((key) => !declaredKeys.has(key));
  if (unknown.length > 0) {
    throw new VarResolutionError(
      `unknown --var key(s): ${unknown.join(", ")}. Declare them under assignment.vars or environment.vars, or remove the extra --var flag(s).`,
    );
  }

  const vars: Record<string, string> = {};
  for (const key of declaredKeys) {
    if (manifest.runtimeVarSources[key]?.source === "hook") {
      continue;
    }
    const value = manifest.runtimeVars[key];
    if (value !== undefined) {
      vars[key] = toCliVarString(key, value);
    }
  }
  return {
    ...vars,
    ...patchVars,
  };
}

function buildLoadedAgent(manifest: RunManifest): LoadedAgent {
  const loaded = loadedAgentFromManifest(manifest);
  const executionEnvironment =
    manifest.executionEnvironment === null ||
    !existsSync(workspaceEnvironmentPath(manifest.workspaceDir))
      ? undefined
      : {
          kind: "path" as const,
          ref: workspaceEnvironmentPath(manifest.workspaceDir),
          path: workspaceEnvironmentPath(manifest.workspaceDir),
        };
  if (manifest.agent.sourcePath === null) {
    return {
      ...loaded,
      executionEnvironment,
    };
  }
  const sourceLoaded = loadAgentConfig(workspaceAgentPath(manifest.workspaceDir));
  return {
    ...loaded,
    instructions: sourceLoaded.instructions,
    launcher: sourceLoaded.launcher,
    executionEnvironment,
    sourcePath: workspaceAgentPath(manifest.workspaceDir),
    config: {
      ...loaded.config,
      lockedFields: [],
    },
  };
}

function buildLoadedAssignment(
  manifest: RunManifest,
  message: string | null,
): LoadedAssignment | undefined {
  if (manifest.assignment === null) {
    return undefined;
  }
  const loaded = loadAssignmentConfig(workspaceAssignmentPath(manifest.workspaceDir));
  return {
    ...loaded,
    config: {
      ...loaded.config,
      lockedFields: [],
      maxRetries: manifest.maxAttemptsPerSession - 1,
      message: message ?? undefined,
    },
  };
}

function agentOwnsFrozenNamedLauncher(loaded: LoadedAgent, launcherName: string): boolean {
  const launcher = loaded.launcher;
  if (launcher === undefined) {
    return false;
  }
  switch (launcher.kind) {
    case "name":
      return launcher.name === launcherName;
    case "path": {
      const loadedLauncher = loadLauncherConfig(launcher.path);
      return loadedLauncher.kind === "prefix" && loadedLauncher.name === launcherName;
    }
    case "inline":
      return false;
    default: {
      const unreachable: never = launcher;
      return unreachable;
    }
  }
}

function buildReconfigureOverrides(
  previous: RunManifest,
  loaded: LoadedAgent,
  loadedAssignment: LoadedAssignment | undefined,
  nextMessage: string | null,
): RunOverrides {
  const overrides: RunOverrides =
    loadedAssignment === undefined && nextMessage !== null ? { message: nextMessage } : {};
  if (
    previous.launcher.kind === "prefix" &&
    previous.launcher.source === "named" &&
    previous.launcher.name !== null &&
    !agentOwnsFrozenNamedLauncher(loaded, previous.launcher.name)
  ) {
    overrides.launcher = previous.launcher.name;
  }
  return overrides;
}

function lockedFieldValue(manifest: RunManifest, field: LockableField): unknown {
  switch (field) {
    case "cwd":
      return manifest.cwd;
    case "backend":
      return manifest.backend;
    case "model":
      return manifest.model;
    case "effort":
      return manifest.effort;
    case "instructions":
      return manifest.agent.instructions;
    case "message":
      return manifest.message;
    case "timeoutSec":
      return manifest.timeoutSec;
    case "unrestricted":
      return manifest.unrestricted;
    case "maxRetries":
      return manifest.maxAttemptsPerSession - 1;
    case "tasks":
      return manifest.finalTasks;
    case "schedule":
      return manifest.schedule;
    default: {
      const unreachable: never = field;
      return unreachable;
    }
  }
}

function assertReconfigureLockedFields(previous: RunManifest, next: RunManifest): void {
  for (const field of previous.lockedFields) {
    if (field === "message") {
      continue;
    }
    if (!isDeepStrictEqual(lockedFieldValue(previous, field), lockedFieldValue(next, field))) {
      throw new ReconfigureLockedFieldError(field);
    }
  }
}

function restoreFrozenManifestFields(
  previous: RunManifest,
  next: RunManifest,
  patchVars: Record<string, string>,
  environmentVarsChanged: boolean,
): RunManifest {
  const executionEnvironment = environmentVarsChanged
    ? cloneRunExecutionEnvironment(next.executionEnvironment)
    : cloneRunExecutionEnvironment(previous.executionEnvironment);
  if (
    executionEnvironment !== null &&
    previous.executionEnvironment !== null &&
    environmentVarsChanged
  ) {
    executionEnvironment.name = previous.executionEnvironment.name;
    executionEnvironment.sourcePath = previous.executionEnvironment.sourcePath;
  }
  const restored: RunManifest = {
    ...next,
    startedAt: previous.startedAt,
    assignment: previous.assignment
      ? {
          ...previous.assignment,
        }
      : null,
    backend: previous.backend,
    model: previous.model,
    effort: previous.effort,
    backendConfig: cloneBackendConfig(previous.backendConfig),
    resolvedBackendArgs: cloneResolvedBackendArgs(previous.resolvedBackendArgs),
    launcher: cloneResolvedLauncherConfig(next.launcher),
    name: previous.name,
    note: previous.note,
    pinned: previous.pinned,
    unrestricted: previous.unrestricted,
    cwd: previous.cwd,
    lockedFields: [...previous.lockedFields],
    timeoutSec: previous.timeoutSec,
    runGroupId: previous.runGroupId,
    dependencies: cloneRunDependencyRefs(previous.dependencies),
    parentRunId: previous.parentRunId,
    schedule: cloneJson(previous.schedule),
    backendSessionId: previous.backendSessionId,
    backendSessionSync: cloneBackendSessionSyncState(previous.backendSessionSync),
    maxAttemptsPerSession: previous.maxAttemptsPerSession,
    execution: previous.execution,
    executionEnvironment,
    attachments: previous.attachments.map((attachment) => ({ ...attachment })),
  };

  const runtimeVarSources = cloneRuntimeVarSources(next.runtimeVarSources);
  for (const [key, source] of Object.entries(previous.runtimeVarSources)) {
    if (patchVars[key] === undefined && next.runtimeVarSources[key]?.source === "cli") {
      runtimeVarSources[key] = { ...source };
    }
  }
  restored.runtimeVarSources = runtimeVarSources;
  restored.resetSeed = buildRunResetSeed({
    ...next.resetSeed,
    backend: restored.backend,
    model: restored.model,
    effort: restored.effort,
    backendConfig: cloneBackendConfig(restored.backendConfig),
    resolvedBackendArgs: cloneResolvedBackendArgs(restored.resolvedBackendArgs),
    launcher: cloneResolvedLauncherConfig(restored.launcher),
    executionEnvironment: cloneRunExecutionEnvironment(restored.executionEnvironment),
    cwd: restored.cwd,
    lockedFields: [...restored.lockedFields],
    message: restored.message,
    name: restored.name,
    note: restored.note,
    pinned: restored.pinned,
    runGroupId: restored.runGroupId,
    dependencies: cloneRunDependencyRefs(restored.dependencies),
    parentRunId: restored.parentRunId,
    unrestricted: restored.unrestricted,
    timeoutSec: restored.timeoutSec,
    maxAttemptsPerSession: restored.maxAttemptsPerSession,
    brief: restored.brief,
    runtimeVars: { ...restored.runtimeVars },
    runtimeVarSources: cloneRuntimeVarSources(restored.runtimeVarSources),
    hookState: { ...restored.hookState },
    attachments: restored.attachments.map((attachment) => ({ ...attachment })),
    finalTasks: { ...restored.finalTasks },
  });
  return restored;
}

function persistReconfiguredManifest(
  resolved: ResolvedResumeTarget,
  manifest: RunManifest,
  loadedAssignment: LoadedAssignment | undefined,
  auditOrigin: RunEventOrigin,
  emitAuditEnvelope: AuditEnvelopeEmitter | undefined,
  auditFields: { changedVarKeys: string[]; messageChanged: boolean },
): void {
  const assignmentSeedPath = workspaceAssignmentPath(manifest.workspaceDir);
  if (loadedAssignment) {
    if (loadedAssignment.sourcePath !== assignmentSeedPath) {
      copyFileSync(loadedAssignment.sourcePath, assignmentSeedPath);
    }
  } else {
    rmSync(assignmentSeedPath, { force: true });
  }

  writeManifest(resolved.workspaceDir, manifest);
  const envelope = appendRunReconfiguredEvent({
    manifest,
    context: commandRunEventContext(auditOrigin),
    changedVarKeys: auditFields.changedVarKeys,
    messageChanged: auditFields.messageChanged,
  });
  emitAuditEnvelope?.(envelope);
}

async function reconfigureResolvedRun(
  resolved: ResolvedResumeTarget,
  patch: ReconfigureRunPatch,
  auditOrigin: RunEventOrigin,
  emitAuditEnvelope: AuditEnvelopeEmitter | undefined,
): Promise<RunDetail> {
  const previous = resolved.manifest;
  if (previous.archivedAt !== null) {
    throw new ResumeError(`cannot reconfigure archived run ${previous.runId}`);
  }
  if (previous.status !== "initialized") {
    throw new ResumeError(`cannot reconfigure run ${previous.runId} unless it is initialized`);
  }
  if (patch.message !== undefined && previous.lockedFields.includes("message")) {
    throw new LockedFieldError("message", previous.message);
  }

  const patchVars = patch.vars ?? {};
  const messageChanged = patch.message !== undefined && patch.message !== previous.message;
  if (Object.keys(patchVars).length === 0 && !messageChanged) {
    return toRunDetail({ manifest: previous, isLive: false });
  }
  const nextMessage = patch.message ?? previous.message;
  const loaded = buildLoadedAgent(previous);
  const loadedAssignment = buildLoadedAssignment(previous, nextMessage);
  const varsSchema = buildReconfigureVarsSchema(previous, loadedAssignment);
  const declaredEnvironmentVars = environmentVarKeys(previous);
  const environmentVarsChanged = Object.keys(patchVars).some((key) =>
    declaredEnvironmentVars.has(key),
  );
  const cliVars = buildReconfigureCliVars(previous, varsSchema, patchVars);
  const outcome = await runAgent({
    loaded,
    loadedAssignment,
    cliVars,
    webVars: {},
    parentRunId: previous.parentRunId,
    backend: resolveBackend(previous.backend),
    callerCwd: previous.cwd,
    resume: resolved,
    initialize: true,
    stageInitialize: true,
    resolvedHooksOverride: previous.resolvedHooks.map((descriptor) => ({
      ...descriptor,
      source: { ...descriptor.source },
      when: descriptor.when ? { ...descriptor.when } : null,
    })),
    varsSchemaOverride: varsSchema,
    overrides: buildReconfigureOverrides(previous, loaded, loadedAssignment, nextMessage),
  });

  assertReconfigureLockedFields(previous, outcome.manifest);
  const changedVarKeys = Object.keys(patchVars)
    .filter(
      (key) => !isDeepStrictEqual(previous.runtimeVars[key], outcome.manifest.runtimeVars[key]),
    )
    .sort();
  if (changedVarKeys.length === 0 && !messageChanged) {
    return toRunDetail({ manifest: previous, isLive: false });
  }
  const manifest = restoreFrozenManifestFields(
    previous,
    outcome.manifest,
    patchVars,
    environmentVarsChanged,
  );
  persistReconfiguredManifest(
    resolved,
    manifest,
    loadedAssignment,
    auditOrigin,
    emitAuditEnvelope,
    {
      changedVarKeys,
      messageChanged,
    },
  );
  return toRunDetail({ manifest, isLive: false });
}

export async function reconfigureInitializedRun(
  target: string,
  patch: ReconfigureRunPatch,
  auditOrigin: RunEventOrigin = EMBEDDED_RUN_EVENT_ORIGIN,
  emitAuditEnvelope?: AuditEnvelopeEmitter,
): Promise<RunDetail> {
  const resolved = resolveResumeTarget(target);
  return await withTaskStateLockAsync(resolved.workspaceDir, async () =>
    reconfigureResolvedRun(
      {
        workspaceDir: resolved.workspaceDir,
        manifest: readManifest(resolved.workspaceDir),
      },
      patch,
      auditOrigin,
      emitAuditEnvelope,
    ),
  );
}
