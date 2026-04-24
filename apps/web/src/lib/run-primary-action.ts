import type { RunDetail } from "@task-runner/core/contracts/runs.js";

export type RunPrimaryActionKind = "ready" | "start" | "resume";

export function getRunPrimaryAction(
  run: Pick<RunDetail, "totalAttemptCount" | "capabilities" | "status">,
): RunPrimaryActionKind | null {
  if (run.capabilities.canReady) {
    return "ready";
  }
  if (!run.capabilities.canResume) {
    return null;
  }
  if (run.status === "ready" && run.totalAttemptCount === 0) {
    return "start";
  }
  return "resume";
}
