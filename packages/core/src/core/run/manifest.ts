import { type Dirent, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InvalidStatusReport, TaskState, TaskStatus } from "../../assignment/model.js";
import {
  isPathArg,
  resolveInputPath,
  resolveRepoRunsDir,
  resolveRunsBucketDir,
  resolveRunsRoot,
  resolveUnknownRunsDir,
} from "../../config/runtime-paths.js";
import type { RunAttachment } from "../../contracts/attachments.js";
import { writeTextFileAtomic } from "../../util/write-file-atomic.js";
import {
  type BackendSpecificConfig,
  cloneBackendSpecificConfig,
  cloneResolvedBackendArgs,
  isAbsoluteUdsSocketPath,
  isWsOrWssUrl,
} from "../backends/types.js";
import { type ResolvedLauncherConfig, cloneResolvedLauncherConfig } from "../config/launchers.js";
import type { LockableField } from "../config/schema.js";
import type { HookAuditRecord, ResolvedHookDescriptor } from "../hooks/types.js";

export type ManifestStatus =
  | "initialized"
  | "ready"
  | "running"
  | "success"
  | "blocked"
  | "exhausted"
  | "aborted"
  | "error";

const ATTEMPT_LOG_DIR = "attempts";
const MANIFEST_FILENAME = "run.json";

export function attemptLogRelativePath(attemptNumber: number): string {
  const padded = String(attemptNumber).padStart(2, "0");
  return `${ATTEMPT_LOG_DIR}/${padded}.json`;
}

export interface AttemptLog {
  schemaVersion: 2;
  runId: string;
  attemptNumber: number;
  sessionIndex: number;
  attemptIndexInSession: number;
  startedAt: string;
  endedAt: string;
  stdout: string;
  stderr: string;
}

export function writeAttemptLog(workspaceDir: string, log: AttemptLog): string {
  const relPath = attemptLogRelativePath(log.attemptNumber);
  const absPath = join(workspaceDir, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeTextFileAtomic(absPath, `${JSON.stringify(log, null, 2)}\n`);
  return relPath;
}

export interface TaskSnapshot {
  id: string;
  title: string;
  body: string;
  status: TaskStatus;
  notes: string;
}

export type RuntimeVarSourceKind = "cli" | "web" | "env" | "parent" | "default" | "hook";

export interface RuntimeVarSourceRecord {
  source: RuntimeVarSourceKind;
  envName?: string;
  inheritedFromRunId?: string;
  redacted?: boolean;
}

export interface RunResetSeed {
  backend: string;
  model: string | null;
  effort: string | null;
  backendSpecific?: BackendSpecificConfig;
  resolvedBackendArgs: string[];
  launcher: ResolvedLauncherConfig;
  cwd: string;
  lockedFields: LockableField[];
  message: string | null;
  name: string | null;
  note: string | null;
  pinned: boolean;
  dependencyRunIds: string[];
  parentRunId: string | null;
  unrestricted: boolean;
  timeoutSec: number;
  maxAttemptsPerSession: number;
  brief: string;
  runtimeVars: Record<string, unknown>;
  runtimeVarSources: Record<string, RuntimeVarSourceRecord>;
  hookState: Record<string, unknown>;
  attachments: RunAttachment[];
  finalTasks: Record<string, TaskSnapshot>;
}

export interface AttemptRecord {
  attemptNumber: number;
  sessionIndex: number;
  attemptIndexInSession: number;
  startedAt: string;
  endedAt: string;
  prompt: string;
  sessionIdAtStart: string | null;
  sessionIdCaptured: string | null;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  transcript: string | null;
  logPath: string; // relative to workspaceDir, e.g. "attempts/01.json"
  invalidStatuses: InvalidStatusReport[];
}

export interface SessionRecord {
  sessionIndex: number;
  startedAt: string;
  endedAt: string | null;
  status: ManifestStatus;
  exitCode: number | null;
  message: string | null;
  brief: string;
  firstAttemptNumber: number | null;
  lastAttemptNumber: number | null;
  maxAttemptsPerSession: number;
  backendSessionIdAtStart: string | null;
  backendSessionIdAtEnd: string | null;
}

export type RunExecutionHostMode = "embedded" | "daemon";

export type RunExecutionController =
  | {
      kind: "embedded";
    }
  | {
      kind: "daemon";
      daemonInstanceId: string;
    };

export interface RunExecution {
  hostMode: RunExecutionHostMode;
  controller: RunExecutionController;
}

export interface AssignmentInfo {
  name: string;
  sourcePath: string;
  workspacePath: string;
}

export type RunScheduleMode = "reuse" | "reset" | "clone";

export interface CronSchedule {
  type: "cron";
  expression: string;
  timezone: string;
}

export interface RunScheduleRecurrence {
  schedule: CronSchedule;
  mode: RunScheduleMode;
  continueOnFailure: boolean;
}

export interface RunSchedule {
  enabled: boolean;
  runAt: string;
  recurrence: RunScheduleRecurrence | null;
}

// The manifest is the canonical record of a run. Post-creation, task-runner
// never re-reads the agent's source file — every field needed to resume or
// inspect a run comes from here. That means first-write freezes a snapshot
// of the agent definition: `agent.instructions`, `lockedFields`, and
// `timeoutSec` are all captured at init / fresh-run time and preserved
// across all subsequent sessions.
//
// schemaVersion: 13 is the current manifest-canonical generation. Manifests written
// by earlier task-runner versions are not resumable by this version —
// `isRunManifest` rejects them and
// `resolveResumeTarget` surfaces a clear error telling the caller to
// run the manifest migration.
export interface RunManifest {
  schemaVersion: 13;
  runId: string;
  repo: string;
  agent: {
    name: string;
    // null for ad-hoc agents (synthesized from CLI overrides with no
    // source file). Otherwise the absolute path to the agent.md that
    // was loaded at first write.
    sourcePath: string | null;
    // The agent's role-instruction body at first write. Frozen here
    // so resume never re-reads the source file. Interpolation of
    // {{var}} references is already resolved.
    instructions: string;
  };
  assignment: AssignmentInfo | null;
  backend: string;
  model: string | null;
  effort: string | null;
  backendSpecific?: BackendSpecificConfig;
  resolvedBackendArgs: string[];
  launcher: ResolvedLauncherConfig;
  message: string | null;
  name: string | null;
  note: string | null;
  pinned: boolean;
  unrestricted: boolean;
  cwd: string;
  // Union of the agent's and assignment's lockedFields at first write.
  // Frozen so resume enforces the same lock set even though the source
  // files are never re-read. Assignment locks can't be added on resume
  // (--assignment is forbidden) so this union is the final word.
  lockedFields: LockableField[];
  // Per-attempt wall-clock budget in seconds. Frozen at first write.
  timeoutSec: number;
  assignmentPath: string;
  workspaceDir: string;
  startedAt: string;
  endedAt: string | null;
  archivedAt: string | null;
  status: ManifestStatus;
  dependencyRunIds: string[];
  parentRunId: string | null;
  schedule: RunSchedule | null;
  exitCode: number | null;
  totalAttemptCount: number;
  maxAttemptsPerSession: number;
  tasksCompleted: number;
  tasksTotal: number;
  backendSessionId: string | null;
  runtimeVars: Record<string, unknown>;
  runtimeVarSources: Record<string, RuntimeVarSourceRecord>;
  execution: RunExecution;
  brief: string;
  resolvedHooks: ResolvedHookDescriptor[];
  hookState: Record<string, unknown>;
  hookAudits: HookAuditRecord[];
  // Assignment-level documentation surface for the caller of
  // task-runner (the human or script invoking `run` / `init`).
  // Frozen at first write from `assignmentConfig.callerInstructions`
  // with `{{var}}` references interpolated against the same
  // injectedVars as other body fields. `null` when no assignment
  // was supplied or the assignment didn't carry the field.
  //
  // Unlike `brief`, this text is **never** sent to the
  // backend — it's strictly for the caller, printed to stderr on
  // fresh `run` and `init` and always included in
  // `status --output-format json` for later retrieval.
  callerInstructions: string | null;
  // Reset-to-init seed frozen at first write. Reset uses this instead
  // of re-reading the current agent/assignment source files.
  resetSeed: RunResetSeed;
  attachments: RunAttachment[];
  finalTasks: Record<string, TaskSnapshot>;
  totalSessionCount: number;
  sessions: SessionRecord[];
  attemptRecords: AttemptRecord[];
}

export function snapshotTasks(tasks: Map<string, TaskState>): Record<string, TaskSnapshot> {
  const out: Record<string, TaskSnapshot> = {};
  for (const [id, task] of tasks) {
    out[id] = {
      id: task.id,
      title: task.title,
      body: task.body,
      status: task.status,
      notes: task.notes,
    };
  }
  return out;
}

function cloneTaskSnapshots(tasks: Record<string, TaskSnapshot>): Record<string, TaskSnapshot> {
  const out: Record<string, TaskSnapshot> = {};
  for (const [id, task] of Object.entries(tasks)) {
    out[id] = { ...task };
  }
  return out;
}

export function cloneRuntimeVarSources(
  runtimeVarSources: Record<string, RuntimeVarSourceRecord>,
): Record<string, RuntimeVarSourceRecord> {
  const out: Record<string, RuntimeVarSourceRecord> = {};
  for (const [key, source] of Object.entries(runtimeVarSources)) {
    out[key] = { ...source };
  }
  return out;
}

export function buildRunResetSeed(seed: RunResetSeed): RunResetSeed {
  return {
    ...seed,
    backendSpecific: cloneBackendSpecificConfig(seed.backendSpecific),
    resolvedBackendArgs: cloneResolvedBackendArgs(seed.resolvedBackendArgs),
    launcher: cloneResolvedLauncherConfig(seed.launcher),
    lockedFields: [...seed.lockedFields],
    dependencyRunIds: [...seed.dependencyRunIds],
    parentRunId: seed.parentRunId,
    runtimeVars: { ...seed.runtimeVars },
    runtimeVarSources: cloneRuntimeVarSources(seed.runtimeVarSources),
    hookState: { ...seed.hookState },
    attachments: seed.attachments.map((attachment) => ({ ...attachment })),
    finalTasks: cloneTaskSnapshots(seed.finalTasks),
  };
}

export function applyRunResetSeed(manifest: RunManifest): void {
  const seed = manifest.resetSeed;
  manifest.backend = seed.backend;
  manifest.model = seed.model;
  manifest.effort = seed.effort;
  manifest.backendSpecific = cloneBackendSpecificConfig(seed.backendSpecific);
  manifest.resolvedBackendArgs = cloneResolvedBackendArgs(seed.resolvedBackendArgs);
  manifest.launcher = cloneResolvedLauncherConfig(seed.launcher);
  manifest.cwd = seed.cwd;
  manifest.lockedFields = [...seed.lockedFields];
  manifest.message = seed.message;
  manifest.name = seed.name;
  manifest.note = seed.note;
  manifest.pinned = seed.pinned;
  manifest.dependencyRunIds = [...seed.dependencyRunIds];
  manifest.parentRunId = seed.parentRunId;
  manifest.unrestricted = seed.unrestricted;
  manifest.timeoutSec = seed.timeoutSec;
  manifest.maxAttemptsPerSession = seed.maxAttemptsPerSession;
  manifest.endedAt = null;
  manifest.status = "initialized";
  manifest.exitCode = null;
  manifest.totalAttemptCount = 0;
  manifest.backendSessionId = null;
  manifest.brief = seed.brief;
  manifest.runtimeVars = { ...seed.runtimeVars };
  manifest.runtimeVarSources = cloneRuntimeVarSources(seed.runtimeVarSources);
  manifest.hookState = { ...seed.hookState };
  manifest.attachments = seed.attachments.map((attachment) => ({ ...attachment }));
  manifest.finalTasks = cloneTaskSnapshots(seed.finalTasks);
  manifest.tasksCompleted = Object.values(manifest.finalTasks).filter(
    (task) => task.status === "completed",
  ).length;
  manifest.tasksTotal = Object.keys(manifest.finalTasks).length;
  manifest.totalSessionCount = 0;
  manifest.sessions = [];
  manifest.attemptRecords = [];
}

function isManifestStatus(value: unknown): value is ManifestStatus {
  return (
    value === "initialized" ||
    value === "ready" ||
    value === "running" ||
    value === "success" ||
    value === "blocked" ||
    value === "exhausted" ||
    value === "aborted" ||
    value === "error"
  );
}

function isValidRunSchedule(value: unknown): value is RunSchedule | null {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const schedule = value as Record<string, unknown>;
  if (typeof schedule.enabled !== "boolean") return false;
  if (typeof schedule.runAt !== "string") return false;
  if (Number.isNaN(new Date(schedule.runAt).getTime())) return false;
  if (schedule.recurrence === null) return true;
  if (!schedule.recurrence || typeof schedule.recurrence !== "object") return false;
  const recurrence = schedule.recurrence as Record<string, unknown>;
  if (recurrence.mode !== "reuse" && recurrence.mode !== "reset" && recurrence.mode !== "clone") {
    return false;
  }
  if (typeof recurrence.continueOnFailure !== "boolean") return false;
  if (!recurrence.schedule || typeof recurrence.schedule !== "object") return false;
  const cron = recurrence.schedule as Record<string, unknown>;
  return (
    cron.type === "cron" && typeof cron.expression === "string" && typeof cron.timezone === "string"
  );
}

export function writeManifest(workspaceDir: string, manifest: RunManifest): void {
  const path = join(workspaceDir, MANIFEST_FILENAME);
  writeTextFileAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function manifestPath(workspaceDir: string): string {
  return join(workspaceDir, MANIFEST_FILENAME);
}

export function workspaceAssignmentPath(workspaceDir: string): string {
  return join(workspaceDir, "assignment-seed.md");
}

export function workspaceAgentPath(workspaceDir: string): string {
  return join(workspaceDir, "agent-seed.md");
}

export class ResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeError";
  }
}

export class RunNotFoundError extends ResumeError {
  constructor(arg: string, candidates: string[]) {
    super(
      `could not find run manifest for "${arg}"\n  tried:\n${candidates.map((c) => `    - ${c}`).join("\n")}`,
    );
    this.name = "RunNotFoundError";
  }
}

export interface ResolvedResumeTarget {
  workspaceDir: string;
  manifest: RunManifest;
}

export interface ListedRunManifest {
  workspaceDir: string;
  manifest: RunManifest;
}

function normalizeRunManifest(
  parsed: RunManifest & {
    archivedAt?: string | null;
    note?: string | null;
    pinned?: boolean;
    parentRunId?: string | null;
    runtimeVarSources?: Record<string, RuntimeVarSourceRecord>;
    resetSeed: RunManifest["resetSeed"] & {
      parentRunId?: string | null;
      runtimeVarSources?: Record<string, RuntimeVarSourceRecord>;
    };
  },
): RunManifest {
  return {
    ...parsed,
    launcher: cloneResolvedLauncherConfig(parsed.launcher),
    archivedAt: parsed.archivedAt ?? null,
    note: parsed.note ?? null,
    pinned: parsed.pinned ?? false,
    parentRunId: parsed.parentRunId ?? null,
    runtimeVarSources: cloneRuntimeVarSources(parsed.runtimeVarSources ?? {}),
    resetSeed: {
      ...parsed.resetSeed,
      launcher: cloneResolvedLauncherConfig(parsed.resetSeed.launcher),
      resolvedBackendArgs: cloneResolvedBackendArgs(parsed.resetSeed.resolvedBackendArgs),
      note: parsed.resetSeed.note ?? parsed.note ?? null,
      pinned: parsed.resetSeed.pinned ?? parsed.pinned ?? false,
      parentRunId: parsed.resetSeed.parentRunId ?? parsed.parentRunId ?? null,
      runtimeVarSources: cloneRuntimeVarSources(
        parsed.resetSeed.runtimeVarSources ?? parsed.runtimeVarSources ?? {},
      ),
    },
  };
}

function readManifestCandidate(candidate: string): RunManifest {
  const raw = readFileSync(candidate, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ResumeError(`manifest at ${candidate} is not valid JSON: ${(err as Error).message}`);
  }
  // Surface a schemaVersion mismatch (e.g. v1 manifest from before
  // the manifest-canonical refactor) with a clear message instead
  // of the generic "does not look like a run.json" fallback. Hot
  // cut — old manifests are not resumable; users re-init.
  if (
    parsed &&
    typeof parsed === "object" &&
    "schemaVersion" in parsed &&
    typeof (parsed as { schemaVersion: unknown }).schemaVersion === "number" &&
    (parsed as { schemaVersion: number }).schemaVersion !== 13
  ) {
    const version = (parsed as { schemaVersion: number }).schemaVersion;
    if (version === 12) {
      throw new ResumeError(
        `manifest at ${candidate} has schemaVersion 12; this version of task-runner requires schemaVersion 13. Run scripts/migrate-manifests-v13.mjs to migrate existing workspaces.`,
      );
    }
    throw new ResumeError(
      `manifest at ${candidate} has schemaVersion ${version}; this version of task-runner requires schemaVersion 13.`,
    );
  }
  if (!isRunManifest(parsed)) {
    throw new ResumeError(`manifest at ${candidate} does not look like a task-runner run.json`);
  }
  return normalizeRunManifest(parsed);
}

export function resolveResumeTarget(
  arg: string,
  cwd: string = process.cwd(),
): ResolvedResumeTarget {
  const candidates: string[] = [];

  if (isPathArg(arg)) {
    const abs = resolveInputPath(arg, cwd);
    if (abs.endsWith(MANIFEST_FILENAME) && existsSync(abs)) {
      candidates.push(abs);
    } else if (existsSync(abs)) {
      candidates.push(join(abs, MANIFEST_FILENAME));
    } else {
      candidates.push(abs);
    }
  } else {
    candidates.push(join(resolveRepoRunsDir(cwd), arg, MANIFEST_FILENAME));
    candidates.push(join(resolveUnknownRunsDir(), arg, MANIFEST_FILENAME));
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const parsed = readManifestCandidate(candidate);
    const resolvedWorkspaceDir = dirname(candidate);
    // workspaceDir is the discovery/resume identity anchor. assignmentPath is
    // frozen audit metadata, not a lookup invariant.
    if (parsed.workspaceDir !== resolvedWorkspaceDir) {
      throw new ResumeError(
        `manifest at ${candidate} has workspaceDir "${parsed.workspaceDir}", but it was loaded from "${resolvedWorkspaceDir}"`,
      );
    }
    return { workspaceDir: resolvedWorkspaceDir, manifest: parsed };
  }

  if (isPathArg(arg)) {
    throw new RunNotFoundError(arg, candidates);
  }

  const checkedDirs = [join(resolveRepoRunsDir(cwd), arg), join(resolveUnknownRunsDir(), arg)];
  throw new RunNotFoundError(
    arg,
    checkedDirs.map((candidate) => `${candidate}/`),
  );
}

export function readManifest(workspaceDir: string): RunManifest {
  return readManifestCandidate(manifestPath(workspaceDir));
}

export function listRunManifests(env: NodeJS.ProcessEnv = process.env): ListedRunManifest[] {
  const root = resolveRunsRoot(env);
  if (!existsSync(root)) {
    return [];
  }

  const runs: ListedRunManifest[] = [];
  for (const bucket of readdirSync(root, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue;
    const bucketDir = resolveRunsBucketDir(bucket.name, env);
    let runEntries: Dirent[];
    try {
      runEntries = readdirSync(bucketDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const runDir of runEntries) {
      if (!runDir.isDirectory()) continue;
      const workspaceDir = join(bucketDir, runDir.name);
      const candidate = manifestPath(workspaceDir);
      if (!existsSync(candidate)) continue;
      try {
        const manifest = readManifestCandidate(candidate);
        // workspaceDir anchors manifest identity during discovery. Persisted
        // assignmentPath captures audit metadata and is not required to match.
        if (manifest.workspaceDir !== workspaceDir) {
          continue;
        }
        runs.push({ workspaceDir, manifest });
      } catch (err) {
        // Unsupported or corrupt manifests are skipped for discovery,
        // but unexpected failures should still surface.
        if (err instanceof ResumeError) {
          continue;
        }
        throw err;
      }
    }
  }

  return runs;
}

export function findRunManifestsById(
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): ListedRunManifest[] {
  const root = resolveRunsRoot(env);
  if (!existsSync(root)) {
    return [];
  }

  const matches: ListedRunManifest[] = [];
  for (const bucket of readdirSync(root, { withFileTypes: true })) {
    if (!bucket.isDirectory()) {
      continue;
    }
    const workspaceDir = join(resolveRunsBucketDir(bucket.name, env), runId);
    if (!existsSync(workspaceDir) || !statSync(workspaceDir).isDirectory()) {
      continue;
    }
    const candidate = manifestPath(workspaceDir);
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      const manifest = readManifestCandidate(candidate);
      // workspaceDir anchors manifest identity during discovery. Persisted
      // assignmentPath captures audit metadata and is not required to match.
      if (manifest.workspaceDir !== workspaceDir) {
        continue;
      }
      matches.push({ workspaceDir, manifest });
    } catch (err) {
      if (err instanceof ResumeError) {
        continue;
      }
      throw err;
    }
  }

  return matches;
}

// Structural validation for a run.json candidate. Shallow checks
// deliberately — we confirm that every field `resolveResumeTarget`
// consumers immediately dereference is present with the expected
// type, so a truncated / partially-written manifest surfaces a
// clear error at resume time instead of an unrelated TypeError
// later in the run-loop or the status renderer.
//
// `typeof null === "object"` is the classic trap; every object-valued
// field below also checks `!== null` explicitly. `finalTasks` is the
// most dangerous — both run-loop and the status output iterate its
// keys immediately and would throw if it were `null`.
function isRunManifest(value: unknown): value is RunManifest {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion !== 13) return false;
  if (typeof obj.runId !== "string") return false;
  if (typeof obj.repo !== "string") return false;

  // Top-level scalars required by downstream consumers.
  if (typeof obj.backend !== "string") return false;
  if (obj.name !== null && typeof obj.name !== "string") return false;
  if (obj.note !== undefined && obj.note !== null && typeof obj.note !== "string") return false;
  if (obj.pinned !== undefined && typeof obj.pinned !== "boolean") return false;
  if (typeof obj.cwd !== "string") return false;
  if (typeof obj.assignmentPath !== "string") return false;
  if (typeof obj.workspaceDir !== "string") return false;
  if (typeof obj.startedAt !== "string") return false;
  if (!isManifestStatus(obj.status)) return false;
  if (
    !Array.isArray(obj.dependencyRunIds) ||
    !obj.dependencyRunIds.every((runId) => typeof runId === "string")
  ) {
    return false;
  }
  if (
    obj.parentRunId !== undefined &&
    obj.parentRunId !== null &&
    typeof obj.parentRunId !== "string"
  ) {
    return false;
  }
  if (
    obj.archivedAt !== undefined &&
    obj.archivedAt !== null &&
    typeof obj.archivedAt !== "string"
  ) {
    return false;
  }
  if (!isValidRunSchedule(obj.schedule)) return false;
  if (typeof obj.timeoutSec !== "number") return false;
  if (typeof obj.unrestricted !== "boolean") return false;
  if (typeof obj.totalAttemptCount !== "number") return false;
  if (typeof obj.maxAttemptsPerSession !== "number") return false;
  if (typeof obj.tasksCompleted !== "number") return false;
  if (typeof obj.tasksTotal !== "number") return false;
  if (typeof obj.totalSessionCount !== "number") return false;
  if (typeof obj.brief !== "string") return false;
  if (!Array.isArray(obj.resolvedHooks)) return false;
  if (!Array.isArray(obj.hookAudits)) return false;
  if (
    obj.hookAudits.some((audit) => {
      if (!audit || typeof audit !== "object") {
        return true;
      }
      const record = audit as Record<string, unknown>;
      return (
        typeof record.phase !== "string" ||
        typeof record.hookId !== "string" ||
        typeof record.startedAt !== "string" ||
        typeof record.endedAt !== "string" ||
        typeof record.outcome !== "string" ||
        (record.sessionIndex !== null && typeof record.sessionIndex !== "number") ||
        (record.attemptNumber !== null && typeof record.attemptNumber !== "number") ||
        (record.taskId !== null && typeof record.taskId !== "string") ||
        (record.summary !== null && typeof record.summary !== "string")
      );
    })
  ) {
    return false;
  }

  // Arrays.
  if (!Array.isArray(obj.attemptRecords)) return false;
  if (!Array.isArray(obj.sessions)) return false;
  if (
    obj.attemptRecords.some((attempt) => {
      if (!attempt || typeof attempt !== "object") {
        return true;
      }
      const record = attempt as Record<string, unknown>;
      return (
        typeof record.attemptNumber !== "number" ||
        typeof record.sessionIndex !== "number" ||
        typeof record.attemptIndexInSession !== "number" ||
        typeof record.startedAt !== "string" ||
        typeof record.endedAt !== "string" ||
        typeof record.prompt !== "string" ||
        (record.sessionIdAtStart !== null && typeof record.sessionIdAtStart !== "string") ||
        (record.sessionIdCaptured !== null && typeof record.sessionIdCaptured !== "string") ||
        (record.exitCode !== null && typeof record.exitCode !== "number") ||
        (record.signal !== null && typeof record.signal !== "string") ||
        typeof record.timedOut !== "boolean" ||
        (record.transcript !== null && typeof record.transcript !== "string") ||
        typeof record.logPath !== "string" ||
        !Array.isArray(record.invalidStatuses)
      );
    })
  ) {
    return false;
  }
  if (
    obj.sessions.some((session) => {
      if (!session || typeof session !== "object") {
        return true;
      }
      const record = session as Record<string, unknown>;
      return (
        typeof record.sessionIndex !== "number" ||
        typeof record.startedAt !== "string" ||
        (record.endedAt !== null && typeof record.endedAt !== "string") ||
        !isManifestStatus(record.status) ||
        (record.exitCode !== null && typeof record.exitCode !== "number") ||
        (record.message !== null && typeof record.message !== "string") ||
        typeof record.brief !== "string" ||
        (record.firstAttemptNumber !== null && typeof record.firstAttemptNumber !== "number") ||
        (record.lastAttemptNumber !== null && typeof record.lastAttemptNumber !== "number") ||
        typeof record.maxAttemptsPerSession !== "number" ||
        (record.backendSessionIdAtStart !== null &&
          typeof record.backendSessionIdAtStart !== "string") ||
        (record.backendSessionIdAtEnd !== null && typeof record.backendSessionIdAtEnd !== "string")
      );
    })
  ) {
    return false;
  }
  if (!Array.isArray(obj.lockedFields)) return false;
  if (!Array.isArray(obj.attachments)) return false;
  if (
    obj.attachments.some((attachment) => {
      if (!attachment || typeof attachment !== "object") {
        return true;
      }
      const record = attachment as Record<string, unknown>;
      return (
        typeof record.id !== "string" ||
        typeof record.name !== "string" ||
        typeof record.mimeType !== "string" ||
        typeof record.size !== "number" ||
        typeof record.sha256 !== "string" ||
        typeof record.addedAt !== "string" ||
        typeof record.relativePath !== "string"
      );
    })
  ) {
    return false;
  }

  // Object-valued fields that are dereferenced by key immediately
  // after resolveResumeTarget returns. `typeof null === "object"`
  // so these need explicit null rejection.
  if (!obj.finalTasks || typeof obj.finalTasks !== "object") return false;
  if (!obj.runtimeVars || typeof obj.runtimeVars !== "object") return false;
  if (
    obj.runtimeVarSources !== undefined &&
    (!obj.runtimeVarSources || typeof obj.runtimeVarSources !== "object")
  ) {
    return false;
  }
  if (!obj.hookState || typeof obj.hookState !== "object") return false;
  if (!obj.resetSeed || typeof obj.resetSeed !== "object") return false;
  if (!obj.execution || typeof obj.execution !== "object") return false;
  if (!isValidPersistedBackendSpecific(obj.backendSpecific, false)) return false;
  if (!isValidResolvedBackendArgs(obj.resolvedBackendArgs)) return false;
  if (!isValidResolvedLauncherConfig(obj.launcher)) return false;

  // callerInstructions is string | null.
  if (obj.callerInstructions !== null && typeof obj.callerInstructions !== "string") {
    return false;
  }

  const resetSeed = obj.resetSeed as Record<string, unknown>;
  if (typeof resetSeed.backend !== "string") return false;
  if (resetSeed.model !== null && typeof resetSeed.model !== "string") return false;
  if (resetSeed.effort !== null && typeof resetSeed.effort !== "string") return false;
  if (!isValidPersistedBackendSpecific(resetSeed.backendSpecific, false)) {
    return false;
  }
  if (!isValidResolvedBackendArgs(resetSeed.resolvedBackendArgs)) return false;
  if (!isValidResolvedLauncherConfig(resetSeed.launcher)) return false;
  if (typeof resetSeed.cwd !== "string") return false;
  if (!Array.isArray(resetSeed.lockedFields)) return false;
  if (resetSeed.message !== null && typeof resetSeed.message !== "string") return false;
  if (resetSeed.name !== null && typeof resetSeed.name !== "string") return false;
  if (
    resetSeed.note !== undefined &&
    resetSeed.note !== null &&
    typeof resetSeed.note !== "string"
  ) {
    return false;
  }
  if (resetSeed.pinned !== undefined && typeof resetSeed.pinned !== "boolean") return false;
  if (
    !Array.isArray(resetSeed.dependencyRunIds) ||
    !resetSeed.dependencyRunIds.every((runId) => typeof runId === "string")
  ) {
    return false;
  }
  if (
    resetSeed.parentRunId !== undefined &&
    resetSeed.parentRunId !== null &&
    typeof resetSeed.parentRunId !== "string"
  ) {
    return false;
  }
  if (typeof resetSeed.unrestricted !== "boolean") return false;
  if (typeof resetSeed.timeoutSec !== "number") return false;
  if (typeof resetSeed.maxAttemptsPerSession !== "number") return false;
  if (typeof resetSeed.brief !== "string") return false;
  if (!resetSeed.runtimeVars || typeof resetSeed.runtimeVars !== "object") return false;
  if (
    resetSeed.runtimeVarSources !== undefined &&
    (!resetSeed.runtimeVarSources || typeof resetSeed.runtimeVarSources !== "object")
  ) {
    return false;
  }
  if (!resetSeed.hookState || typeof resetSeed.hookState !== "object") return false;
  if (!Array.isArray(resetSeed.attachments)) return false;
  if (!resetSeed.finalTasks || typeof resetSeed.finalTasks !== "object") return false;

  // Nested agent record.
  if (!obj.agent || typeof obj.agent !== "object") return false;
  const agent = obj.agent as Record<string, unknown>;
  if (typeof agent.name !== "string") return false;
  if (typeof agent.instructions !== "string") return false;
  // sourcePath is string | null (null for ad-hoc agents)
  if (agent.sourcePath !== null && typeof agent.sourcePath !== "string") return false;

  const execution = obj.execution as Record<string, unknown>;
  if (execution.hostMode !== "embedded" && execution.hostMode !== "daemon") return false;
  if (!execution.controller || typeof execution.controller !== "object") return false;
  const controller = execution.controller as Record<string, unknown>;
  if (controller.kind === "embedded") {
    return execution.hostMode === "embedded";
  }
  if (controller.kind === "daemon") {
    return execution.hostMode === "daemon" && typeof controller.daemonInstanceId === "string";
  }

  return false;
}

function isValidResolvedBackendArgs(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isValidResolvedLauncherConfig(value: unknown): value is ResolvedLauncherConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "direct") {
    return record.name === "direct";
  }
  if (record.kind !== "prefix") {
    return false;
  }
  return (
    typeof record.command === "string" &&
    Array.isArray(record.args) &&
    record.args.every((entry) => typeof entry === "string") &&
    (record.name === null || typeof record.name === "string") &&
    (record.source === "builtin" || record.source === "named" || record.source === "inline")
  );
}

function isValidPersistedBackendSpecific(
  value: unknown,
  requireCodexTransport: boolean,
): value is BackendSpecificConfig | undefined {
  if (value === undefined) {
    return !requireCodexTransport;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "codex")) {
    return false;
  }
  if (record.codex === undefined) {
    return !requireCodexTransport;
  }
  if (!record.codex || typeof record.codex !== "object" || Array.isArray(record.codex)) {
    return false;
  }
  const codex = record.codex as Record<string, unknown>;
  if (Object.keys(codex).some((key) => key !== "transport")) {
    return false;
  }
  if (codex.transport === undefined) {
    return !requireCodexTransport;
  }
  return isValidCodexTransport(codex.transport);
}

function isValidCodexTransport(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "stdio") {
    return Object.keys(record).length === 1;
  }
  if (record.type === "ws") {
    if (Object.keys(record).some((key) => key !== "type" && key !== "url")) {
      return false;
    }
    if (typeof record.url !== "string" || record.url.trim().length === 0) {
      return false;
    }
    return isWsOrWssUrl(record.url);
  }
  if (record.type === "uds") {
    if (Object.keys(record).some((key) => key !== "type" && key !== "path")) {
      return false;
    }
    return typeof record.path === "string" && isAbsoluteUdsSocketPath(record.path);
  }
  return false;
}
