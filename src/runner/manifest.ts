import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InvalidStatusReport, TaskState, TaskStatus } from "../plan/model.js";

export type ManifestStatus = "running" | "success" | "blocked" | "exhausted" | "error";

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
  assistantMessage: string | null;
  rawStdout: string;
  rawStderr: string;
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
