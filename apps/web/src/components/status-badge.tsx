import type { RunStatus } from "@task-runner/core/contracts/runs.js";

const LABELS: Record<RunStatus, string> = {
  initialized: "initialized",
  ready: "ready",
  running: "running",
  success: "completed",
  blocked: "blocked",
  exhausted: "exhausted",
  aborted: "aborted",
  error: "error",
};

const CLASSES: Record<RunStatus, string> = {
  initialized: "badge badge-pending",
  ready: "badge badge-ready",
  running: "badge badge-running",
  success: "badge badge-completed",
  blocked: "badge badge-blocked",
  exhausted: "badge badge-exhausted",
  aborted: "badge badge-aborted",
  error: "badge badge-error",
};

export function StatusBadge({ status }: { status: RunStatus }) {
  return <span className={CLASSES[status]}>{LABELS[status]}</span>;
}
