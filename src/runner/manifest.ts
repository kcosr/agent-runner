import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InvalidStatusReport, TaskState, TaskStatus } from "../plan/model.js";

export type ManifestStatus = "running" | "success" | "blocked" | "exhausted" | "error";

const ATTEMPT_LOG_DIR = "attempts";

export function attemptLogRelativePath(attempt: number): string {
  const padded = String(attempt).padStart(2, "0");
  return `${ATTEMPT_LOG_DIR}/${padded}.json`;
}

export interface AttemptLog {
  schemaVersion: 1;
  runId: string;
  attempt: number;
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

export interface RunManifest {
  schemaVersion: 1;
  runId: string;
  agent: {
    name: string;
    sourcePath: string;
  };
  backend: string;
  model: string | null;
  effort: string | null;
  unrestricted: boolean;
  cwd: string;
  planPath: string;
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
  finalTasks: Record<string, TaskSnapshot>;
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
  const path = join(workspaceDir, "run.json");
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function manifestPath(workspaceDir: string): string {
  return join(workspaceDir, "run.json");
}
