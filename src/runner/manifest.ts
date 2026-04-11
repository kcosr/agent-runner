import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { InvalidStatusReport, TaskState, TaskStatus } from "../assignment/model.js";
import type { LockableField } from "../config/schema.js";

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
  writeFileSync(absPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  return relPath;
}

export interface TaskSnapshot {
  id: string;
  title: string;
  body: string;
  status: TaskStatus;
  notes: string;
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
// schemaVersion: 2 is the manifest-canonical generation. Manifests written
// by earlier task-runner versions have schemaVersion: 1 and are not
// resumable by this version — `isRunManifest` rejects them and
// `resolveResumeTarget` surfaces a clear error telling the caller to
// create a fresh run.
export interface RunManifest {
  schemaVersion: 2;
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
  startedAt: string;
  endedAt: string | null;
  status: ManifestStatus;
  exitCode: number | null;
  attempts: number;
  maxAttempts: number;
  tasksCompleted: number;
  tasksTotal: number;
  backendSessionId: string | null;
  runtimeVars: Record<string, unknown>;
  pendingPrompt: string | null;
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

export function writeManifest(workspaceDir: string, manifest: RunManifest): void {
  const path = join(workspaceDir, MANIFEST_FILENAME);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function manifestPath(workspaceDir: string): string {
  return join(workspaceDir, MANIFEST_FILENAME);
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

export function resolveResumeTarget(
  arg: string,
  cwd: string = process.cwd(),
): ResolvedResumeTarget {
  const candidates: string[] = [];
  const looksLikePath = arg.includes("/") || arg.includes("\\") || arg.startsWith(".");

  if (looksLikePath) {
    const abs = isAbsolute(arg) ? arg : resolve(cwd, arg);
    if (abs.endsWith(MANIFEST_FILENAME) && existsSync(abs)) {
      candidates.push(abs);
    } else if (existsSync(abs)) {
      candidates.push(join(abs, MANIFEST_FILENAME));
    } else {
      candidates.push(abs);
    }
  } else {
    candidates.push(resolve(cwd, ".task-runner", arg, MANIFEST_FILENAME));
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const raw = readFileSync(candidate, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ResumeError(
        `manifest at ${candidate} is not valid JSON: ${(err as Error).message}`,
      );
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
      (parsed as { schemaVersion: number }).schemaVersion !== 2
    ) {
      const version = (parsed as { schemaVersion: number }).schemaVersion;
      throw new ResumeError(
        `manifest at ${candidate} has schemaVersion ${version}; this version of task-runner requires schemaVersion 2. Manifests from earlier versions cannot be resumed — create a fresh run (task-runner init / run).`,
      );
    }
    if (!isRunManifest(parsed)) {
      throw new ResumeError(`manifest at ${candidate} does not look like a task-runner run.json`);
    }
    return { workspaceDir: dirname(candidate), manifest: parsed };
  }

  throw new ResumeError(
    `could not find run manifest for "${arg}"\n  tried:\n${candidates.map((c) => `    - ${c}`).join("\n")}`,
  );
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
  if (obj.schemaVersion !== 2) return false;
  if (typeof obj.runId !== "string") return false;

  // Top-level scalars required by downstream consumers.
  if (typeof obj.backend !== "string") return false;
  if (typeof obj.cwd !== "string") return false;
  if (typeof obj.assignmentPath !== "string") return false;
  if (typeof obj.workspaceDir !== "string") return false;
  if (typeof obj.startedAt !== "string") return false;
  if (typeof obj.status !== "string") return false;
  if (typeof obj.timeoutSec !== "number") return false;
  if (typeof obj.unrestricted !== "boolean") return false;
  if (typeof obj.attempts !== "number") return false;
  if (typeof obj.maxAttempts !== "number") return false;
  if (typeof obj.tasksCompleted !== "number") return false;
  if (typeof obj.tasksTotal !== "number") return false;
  if (typeof obj.sessionCount !== "number") return false;

  // Arrays.
  if (!Array.isArray(obj.attemptRecords)) return false;
  if (!Array.isArray(obj.sessions)) return false;
  if (!Array.isArray(obj.lockedFields)) return false;

  // Object-valued fields that are dereferenced by key immediately
  // after resolveResumeTarget returns. `typeof null === "object"`
  // so these need explicit null rejection.
  if (!obj.finalTasks || typeof obj.finalTasks !== "object") return false;
  if (!obj.runtimeVars || typeof obj.runtimeVars !== "object") return false;

  // Nested agent record.
  if (!obj.agent || typeof obj.agent !== "object") return false;
  const agent = obj.agent as Record<string, unknown>;
  if (typeof agent.name !== "string") return false;
  if (typeof agent.instructions !== "string") return false;
  // sourcePath is string | null (null for ad-hoc agents)
  if (agent.sourcePath !== null && typeof agent.sourcePath !== "string") return false;

  return true;
}
