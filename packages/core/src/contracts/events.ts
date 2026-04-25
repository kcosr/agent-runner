import type {
  RunAuditEnvelope,
  RunAuditEvent,
  RunAuditHistory,
  ScheduleDecisionReason,
} from "../core/run/run-events.js";
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
  attemptNumber: number;
  sessionIndex: number;
  attemptIndexInSession: number;
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

// Live per-run timeline payload shared by SSE and WebSocket subscribers.
export interface RunTimelineEnvelope {
  runId: string;
  cursor: number;
  event: RunTimelineEvent;
}

export type { RunAuditEnvelope, RunAuditEvent, RunAuditHistory, ScheduleDecisionReason };
