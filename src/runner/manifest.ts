import { type Dirent, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InvalidStatusReport, TaskState, TaskStatus } from "../assignment/model.js";
import {
  isPathArg,
  resolveInputPath,
  resolveRepoRunsDir,
  resolveRunsBucketDir,
  resolveRunsRoot,
  resolveUnknownRunsDir,
} from "../config/runtime-paths.js";
import type { LockableField, TaskMode } from "../config/schema.js";
import { writeTextFileAtomic } from "../util/write-file-atomic.js";

export type ManifestStatus =
  | "initialized"
  | "running"
  | "success"
  | "blocked"
  | "exhausted"
  | "aborted"
  | "error";

const ATTEMPT_LOG_DIR = "attempts";
const MANIFEST_FILENAME = "run.json";

export function attemptLogRelativePath(attempt: number): string {
  const padded = String(attempt).padStart(2, "0");
  return `${ATTEMPT_LOG_DIR}/${padded}.json`;
}

export interface AttemptLog {
  schemaVersion: 1;
  runId: string;
  attempt: number;
  sessionIndex: number;
  startedAt: string;
  endedAt: string;
  stdout: string;
  stderr: string;
}

export function writeAttemptLog(workspaceDir: string, log: AttemptLog): string {
  const relPath = attemptLogRelativePath(log.attempt);
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

export interface RunResetSeed {
  model: string | null;
  effort: string | null;
  sessionName: string | null;
  unrestricted: boolean;
  timeoutSec: number;
  maxAttempts: number;
  taskMode?: TaskMode;
  pendingPrompt: string;
  finalTasks: Record<string, TaskSnapshot>;
}

export interface AttemptRecord {
  attempt: number;
  sessionIndex: number;
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
  tasksAfter: Record<string, TaskSnapshot>;
  invalidStatuses: InvalidStatusReport[];
}

export interface SessionRecord {
  sessionIndex: number;
  startedAt: string;
  endedAt: string | null;
  status: ManifestStatus;
  exitCode: number | null;
  message: string | null;
  firstAttempt: number | null;
  lastAttempt: number | null;
  maxAttempts: number;
  backendSessionIdAtStart: string | null;
  backendSessionIdAtEnd: string | null;
}

export interface AssignmentInfo {
  name: string;
  sourcePath: string;
  workspacePath: string;
}

// The manifest is the canonical record of a run. Post-creation, task-runner
// never re-reads the agent's source file — every field needed to resume or
// inspect a run comes from here. That means first-write freezes a snapshot
// of the agent definition: `agent.instructions`, `lockedFields`, and
// `timeoutSec` are all captured at init / fresh-run time and preserved
// across all subsequent sessions.
//
// schemaVersion: 3 is the current manifest-canonical generation. Manifests written
// by earlier task-runner versions (v1 pre-canonical, v2 pre-reset-seed) are not
// resumable by this version — `isRunManifest` rejects them and
// `resolveResumeTarget` surfaces a clear error telling the caller to
// create a fresh run.
export interface RunManifest {
  schemaVersion: 3;
  runId: string;
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
  message: string | null;
  sessionName: string | null;
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
  taskMode?: TaskMode;
  startedAt: string;
  endedAt: string | null;
  archivedAt: string | null;
  status: ManifestStatus;
  exitCode: number | null;
  attempts: number;
  maxAttempts: number;
  tasksCompleted: number;
  tasksTotal: number;
  backendSessionId: string | null;
  runtimeVars: Record<string, unknown>;
  pendingPrompt: string | null;
  // Assignment-level documentation surface for the caller of
  // task-runner (the human or script invoking `run` / `init`).
  // Frozen at first write from `assignmentConfig.callerInstructions`
  // with `{{var}}` references interpolated against the same
  // injectedVars as other body fields. `null` when no assignment
  // was supplied or the assignment didn't carry the field.
  //
  // Unlike `pendingPrompt`, this text is **never** sent to the
  // backend — it's strictly for the caller, printed to stderr on
  // fresh `run` and `init` and always included in
  // `status --output-format json` for later retrieval.
  callerInstructions: string | null;
  // Reset-to-init seed frozen at first write. Reset uses this instead
  // of re-reading the current agent/assignment source files.
  resetSeed: RunResetSeed;
  finalTasks: Record<string, TaskSnapshot>;
  sessionCount: number;
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

export function buildRunResetSeed(seed: RunResetSeed): RunResetSeed {
  return {
    ...seed,
    finalTasks: cloneTaskSnapshots(seed.finalTasks),
  };
}

export function applyRunResetSeed(manifest: RunManifest): void {
  const seed = manifest.resetSeed;
  manifest.model = seed.model;
  manifest.effort = seed.effort;
  manifest.sessionName = seed.sessionName;
  manifest.unrestricted = seed.unrestricted;
  manifest.timeoutSec = seed.timeoutSec;
  manifest.maxAttempts = seed.maxAttempts;
  manifest.taskMode = seed.taskMode;
  manifest.endedAt = null;
  manifest.status = "initialized";
  manifest.exitCode = null;
  manifest.attempts = 0;
  manifest.backendSessionId = null;
  manifest.pendingPrompt = seed.pendingPrompt;
  manifest.finalTasks = cloneTaskSnapshots(seed.finalTasks);
  manifest.tasksCompleted = Object.values(manifest.finalTasks).filter(
    (task) => task.status === "completed",
  ).length;
  manifest.tasksTotal = Object.keys(manifest.finalTasks).length;
  manifest.sessionCount = 0;
  manifest.sessions = [];
  manifest.attemptRecords = [];
}

export function writeManifest(workspaceDir: string, manifest: RunManifest): void {
  const path = join(workspaceDir, MANIFEST_FILENAME);
  writeTextFileAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function manifestPath(workspaceDir: string): string {
  return join(workspaceDir, MANIFEST_FILENAME);
}

export function workspaceAssignmentPath(workspaceDir: string): string {
  return join(workspaceDir, "assignment.md");
}

export class ResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeError";
  }
}

export interface ResolvedResumeTarget {
  workspaceDir: string;
  manifest: RunManifest;
}

export interface ListedRunManifest {
  repo: string;
  workspaceDir: string;
  manifest: RunManifest;
}

function normalizeRunManifest(parsed: RunManifest & { archivedAt?: string | null }): RunManifest {
  return {
    ...parsed,
    archivedAt: parsed.archivedAt ?? null,
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
    (parsed as { schemaVersion: number }).schemaVersion !== 3
  ) {
    const version = (parsed as { schemaVersion: number }).schemaVersion;
    throw new ResumeError(
      `manifest at ${candidate} has schemaVersion ${version}; this version of task-runner requires schemaVersion 3. Manifests from earlier versions cannot be resumed — create a fresh run (task-runner init / run).`,
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
    const expectedAssignmentPath = workspaceAssignmentPath(resolvedWorkspaceDir);
    if (parsed.workspaceDir !== resolvedWorkspaceDir) {
      throw new ResumeError(
        `manifest at ${candidate} has workspaceDir "${parsed.workspaceDir}", but it was loaded from "${resolvedWorkspaceDir}"`,
      );
    }
    if (parsed.assignmentPath !== expectedAssignmentPath) {
      throw new ResumeError(
        `manifest at ${candidate} has assignmentPath "${parsed.assignmentPath}", but expected "${expectedAssignmentPath}"`,
      );
    }
    return { workspaceDir: resolvedWorkspaceDir, manifest: parsed };
  }

  if (isPathArg(arg)) {
    throw new ResumeError(
      `could not find run manifest for "${arg}"\n  tried:\n${candidates.map((c) => `    - ${c}`).join("\n")}`,
    );
  }

  const checkedDirs = [join(resolveRepoRunsDir(cwd), arg), join(resolveUnknownRunsDir(), arg)];
  throw new ResumeError(
    `could not find run manifest for "${arg}"\n  tried:\n${checkedDirs.map((c) => `    - ${c}/`).join("\n")}`,
  );
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
        if (
          manifest.workspaceDir !== workspaceDir ||
          manifest.assignmentPath !== workspaceAssignmentPath(workspaceDir)
        ) {
          continue;
        }
        runs.push({ repo: bucket.name, workspaceDir, manifest });
      } catch {
        // Unsupported or corrupt manifests are skipped for discovery.
      }
    }
  }

  return runs;
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
  if (obj.schemaVersion !== 3) return false;
  if (typeof obj.runId !== "string") return false;

  // Top-level scalars required by downstream consumers.
  if (typeof obj.backend !== "string") return false;
  if (typeof obj.cwd !== "string") return false;
  if (typeof obj.assignmentPath !== "string") return false;
  if (typeof obj.workspaceDir !== "string") return false;
  if (typeof obj.startedAt !== "string") return false;
  if (typeof obj.status !== "string") return false;
  if (
    obj.archivedAt !== undefined &&
    obj.archivedAt !== null &&
    typeof obj.archivedAt !== "string"
  ) {
    return false;
  }
  if (typeof obj.timeoutSec !== "number") return false;
  if (typeof obj.unrestricted !== "boolean") return false;
  if (typeof obj.attempts !== "number") return false;
  if (typeof obj.maxAttempts !== "number") return false;
  if (typeof obj.tasksCompleted !== "number") return false;
  if (typeof obj.tasksTotal !== "number") return false;
  if (typeof obj.sessionCount !== "number") return false;
  if (obj.taskMode !== undefined && obj.taskMode !== "file" && obj.taskMode !== "cli") return false;

  // Arrays.
  if (!Array.isArray(obj.attemptRecords)) return false;
  if (!Array.isArray(obj.sessions)) return false;
  if (!Array.isArray(obj.lockedFields)) return false;

  // Object-valued fields that are dereferenced by key immediately
  // after resolveResumeTarget returns. `typeof null === "object"`
  // so these need explicit null rejection.
  if (!obj.finalTasks || typeof obj.finalTasks !== "object") return false;
  if (!obj.runtimeVars || typeof obj.runtimeVars !== "object") return false;
  if (!obj.resetSeed || typeof obj.resetSeed !== "object") return false;

  // callerInstructions is string | null.
  if (obj.callerInstructions !== null && typeof obj.callerInstructions !== "string") {
    return false;
  }

  const resetSeed = obj.resetSeed as Record<string, unknown>;
  if (resetSeed.model !== null && typeof resetSeed.model !== "string") return false;
  if (resetSeed.effort !== null && typeof resetSeed.effort !== "string") return false;
  if (resetSeed.sessionName !== null && typeof resetSeed.sessionName !== "string") return false;
  if (typeof resetSeed.unrestricted !== "boolean") return false;
  if (typeof resetSeed.timeoutSec !== "number") return false;
  if (typeof resetSeed.maxAttempts !== "number") return false;
  if (typeof resetSeed.pendingPrompt !== "string") return false;
  if (
    resetSeed.taskMode !== undefined &&
    resetSeed.taskMode !== "file" &&
    resetSeed.taskMode !== "cli"
  ) {
    return false;
  }
  if (!resetSeed.finalTasks || typeof resetSeed.finalTasks !== "object") return false;

  // Nested agent record.
  if (!obj.agent || typeof obj.agent !== "object") return false;
  const agent = obj.agent as Record<string, unknown>;
  if (typeof agent.name !== "string") return false;
  if (typeof agent.instructions !== "string") return false;
  // sourcePath is string | null (null for ad-hoc agents)
  if (agent.sourcePath !== null && typeof agent.sourcePath !== "string") return false;

  return true;
}
