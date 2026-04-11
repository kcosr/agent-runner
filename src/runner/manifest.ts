import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { InvalidStatusReport, TaskState, TaskStatus } from "../assignment/model.js";

export type ManifestStatus = "running" | "success" | "blocked" | "exhausted" | "error";

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

export interface RunManifest {
  schemaVersion: 1;
  runId: string;
  agent: {
    name: string;
    sourcePath: string;
  };
  assignment: AssignmentInfo | null;
  backend: string;
  model: string | null;
  effort: string | null;
  message: string | null;
  unrestricted: boolean;
  cwd: string;
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
    if (!isRunManifest(parsed)) {
      throw new ResumeError(`manifest at ${candidate} does not look like a task-runner run.json`);
    }
    return { workspaceDir: dirname(candidate), manifest: parsed };
  }

  throw new ResumeError(
    `could not find run manifest for "${arg}"\n  tried:\n${candidates.map((c) => `    - ${c}`).join("\n")}`,
  );
}

function isRunManifest(value: unknown): value is RunManifest {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    obj.schemaVersion === 1 &&
    typeof obj.runId === "string" &&
    Array.isArray(obj.attemptRecords) &&
    Array.isArray(obj.sessions) &&
    typeof obj.finalTasks === "object"
  );
}
