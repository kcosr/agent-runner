import type { RunDetail } from "@task-runner/core/contracts/runs.js";

export type RunPrimaryActionKind = "ready" | "start" | "resume";

export function getRunPrimaryAction(
  run: Pick<RunDetail, "attempts" | "capabilities" | "status">,
): RunPrimaryActionKind | null {
  if (run.capabilities.canReady) {
    return "ready";
  }
  if (!run.capabilities.canResume) {
    return null;
  }
  if (run.status === "ready" && run.attempts === 0) {
    return "start";
  }
  return "resume";
}
