import type { RunEvent } from "../core/run/run-loop.js";
import type { RunDetail, RunSummary } from "./runs.js";

// Global board-projection event: consumers upsert the latest RunSummary snapshot.
export interface RunSummaryStreamEvent {
  type: "summary_upsert";
  summary: RunSummary;
}

// Per-run detail-projection event: consumers replace the selected run detail snapshot.
export interface RunDetailStreamEvent {
  type: "detail_updated";
  detail: RunDetail;
}

// Execution timeline events stay on the per-run timeline surface.
export type RunTimelineEvent = RunEvent;
