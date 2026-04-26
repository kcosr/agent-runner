import { copyFileSync, rmSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { resolveBackend } from "../../backends/registry.js";
import { loadAgentConfig, loadAssignmentConfig } from "../../config/loader.js";
import type { ReconfigureRunPatch, RunDetail } from "../../contracts/runs.js";
import { toRunDetail } from "../../contracts/runs.js";
import { cloneBackendSpecificConfig, cloneResolvedBackendArgs } from "../backends/types.js";
import { cloneResolvedLauncherConfig } from "../config/launchers.js";
import { loadedAgentFromManifest } from "../config/loaded.js";
import type { LoadedAgent, LoadedAssignment } from "../config/loaded.js";
import type { LockableField, VarDef } from "../config/schema.js";
import {
  type ResolvedResumeTarget,
  ResumeError,
  type RunManifest,
  buildRunResetSeed,
  cloneRuntimeVarSources,
  readManifest,
  resolveResumeTarget,
  workspaceAgentPath,
  writeManifest,
} from "./manifest.js";
import {
  EMBEDDED_RUN_EVENT_ORIGIN,
  type RunAuditEnvelope,
  type RunEventOrigin,
  appendRunReconfiguredEvent,
  commandRunEventContext,
} from "./run-events.js";
import { LockedFieldError, VarResolutionError, runAgent } from "./run-loop.js";
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

function buildReconfigureCliVars(
  manifest: RunManifest,
  varsSchema: Record<string, VarDef>,
  patchVars: Record<string, string>,
): Record<string, string> {
  const declaredKeys = new Set(Object.keys(varsSchema));
  const unknown = Object.keys(patchVars).filter((key) => !declaredKeys.has(key));
  if (unknown.length > 0) {
    throw new VarResolutionError(
      `unknown --var key(s): ${unknown.join(", ")}. Declare them under assignment.vars or remove the extra --var flag(s).`,
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
  return {
    ...loaded,
    instructions:
      manifest.agent.sourcePath === null
        ? loaded.instructions
        : loadAgentConfig(workspaceAgentPath(manifest.workspaceDir)).instructions,
    sourcePath:
      manifest.agent.sourcePath === null ? null : workspaceAgentPath(manifest.workspaceDir),
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
  const loaded = loadAssignmentConfig(manifest.assignmentPath);
  const vars = Object.fromEntries(
    Object.entries(loaded.config.vars).map(([key, def]) => [key, withCliSource(def)]),
  );
  return {
    ...loaded,
    config: {
      ...loaded.config,
      vars,
      lockedFields: [],
      maxRetries: manifest.maxAttemptsPerSession - 1,
      message: message ?? undefined,
    },
  };
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
): RunManifest {
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
    backendSpecific: cloneBackendSpecificConfig(previous.backendSpecific),
    resolvedBackendArgs: cloneResolvedBackendArgs(previous.resolvedBackendArgs),
    launcher: cloneResolvedLauncherConfig(previous.launcher),
    name: previous.name,
    note: previous.note,
    pinned: previous.pinned,
    unrestricted: previous.unrestricted,
    cwd: previous.cwd,
    lockedFields: [...previous.lockedFields],
    timeoutSec: previous.timeoutSec,
    dependencyRunIds: [...previous.dependencyRunIds],
    parentRunId: previous.parentRunId,
    schedule: cloneJson(previous.schedule),
    backendSessionId: previous.backendSessionId,
    maxAttemptsPerSession: previous.maxAttemptsPerSession,
    execution: previous.execution,
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
    backendSpecific: cloneBackendSpecificConfig(restored.backendSpecific),
    resolvedBackendArgs: cloneResolvedBackendArgs(restored.resolvedBackendArgs),
    launcher: cloneResolvedLauncherConfig(restored.launcher),
    cwd: restored.cwd,
    lockedFields: [...restored.lockedFields],
    message: restored.message,
    name: restored.name,
    note: restored.note,
    pinned: restored.pinned,
    dependencyRunIds: [...restored.dependencyRunIds],
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
  if (loadedAssignment) {
    if (loadedAssignment.sourcePath !== manifest.assignmentPath) {
      copyFileSync(loadedAssignment.sourcePath, manifest.assignmentPath);
    }
  } else {
    rmSync(manifest.assignmentPath, { force: true });
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
  const cliVars =
    loadedAssignment === undefined
      ? buildReconfigureCliVars(previous, {}, patchVars)
      : buildReconfigureCliVars(previous, loadedAssignment.config.vars, patchVars);
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
    overrides:
      loadedAssignment === undefined && nextMessage !== null ? { message: nextMessage } : {},
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
  const manifest = restoreFrozenManifestFields(previous, outcome.manifest, patchVars);
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
