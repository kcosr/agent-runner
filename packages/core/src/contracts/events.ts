import type { RunEvent } from "../core/run/run-loop.js";
import type { RunDetail, RunSummary } from "./runs.js";

// Global board-projection events: consumers either upsert or remove one run summary row.
export type RunSummaryStreamEvent =
  | {
      type: "summary_upsert";
      summary: RunSummary;
    }
  | {
      type: "summary_removed";
      runId: string;
    };

// Per-run detail-projection event: consumers replace the selected run detail snapshot.
export interface RunDetailStreamEvent {
  type: "detail_updated";
  detail: RunDetail;
}

// Execution timeline events stay on the per-run timeline surface.
export type RunTimelineEvent = RunEvent;

// One normalized attempt snapshot in the per-run timeline history response.
export interface RunTimelineAttempt {
  attempt: number;
  sessionIndex: number;
  startedAt: string;
  endedAt: string | null;
  prompt: string;
  transcript: string;
  notices: string;
  exitCode: number | null;
  timedOut: boolean;
  live: boolean;
}

// Bootstrap payload for per-run timeline consumers before live continuation.
export interface RunTimelineHistory {
  runId: string;
  attempts: RunTimelineAttempt[];
  lastCursor: number;
}

// Persisted run-audit events expanded from run-events.jsonl for history/bootstrap.
export interface RunAuditEvent {
  type: string;
  source: "system" | "cli" | "daemon" | "task_command";
  hostMode: "embedded" | "daemon";
  controllerInstanceId?: string;
  sessionIndex?: number;
  attempt?: number;
  [key: string]: unknown;
}

export interface RunTimelineAuditEvent {
  runId: string;
  cursor: number;
  recordedAt: string;
  event: RunAuditEvent;
}

export interface RunAuditTimelineHistory {
  runId: string;
  attempts: RunTimelineAttempt[];
  events: RunTimelineAuditEvent[];
  lastCursor: number;
}

// Live per-run timeline payload shared by SSE and WebSocket subscribers.
export interface RunTimelineEnvelope {
  runId: string;
  cursor: number;
  event: RunTimelineEvent;
}
