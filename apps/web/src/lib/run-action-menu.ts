import type { RunDetail, RunSummary } from "@kcosr/agent-runner-core/contracts/runs.js";
import { getRunPrimaryAction } from "./run-primary-action.js";

type RunActionMenuItemKind = "primary" | "archive" | "unarchive" | "archive-delete" | "delete";

type RunActionMenuAction =
  | "ready"
  | "start"
  | "resume"
  | "archive"
  | "unarchive"
  | "archive-delete"
  | "delete";

export type RunDestructiveCleanupAction = Extract<RunActionMenuAction, "archive-delete" | "delete">;

export interface RunActionMenuItem {
  action: RunActionMenuAction;
  kind: RunActionMenuItemKind;
  label: string;
}

type RunActionMenuRun = Pick<
  RunDetail | RunSummary,
  "capabilities" | "status" | "totalAttemptCount"
>;

const PRIMARY_LABELS = {
  ready: "Ready",
  resume: "Resume",
  start: "Start",
} satisfies Record<NonNullable<ReturnType<typeof getRunPrimaryAction>>, string>;

const DESTRUCTIVE_LABELS = {
  "archive-delete": "Archive + Delete",
  delete: "Delete",
} satisfies Record<RunDestructiveCleanupAction, string>;

export function getRunDestructiveCleanupAction(
  run: RunActionMenuRun,
): RunDestructiveCleanupAction | null {
  if (run.capabilities.canArchive) {
    return "archive-delete";
  }
  if (run.capabilities.canDelete) {
    return "delete";
  }
  return null;
}

export function getRunActionMenuItems(run: RunActionMenuRun): RunActionMenuItem[] {
  const items: RunActionMenuItem[] = [];
  const primaryAction = getRunPrimaryAction(run);

  if (primaryAction !== null) {
    items.push({
      action: primaryAction,
      kind: "primary",
      label: PRIMARY_LABELS[primaryAction],
    });
  }

  if (run.capabilities.canArchive) {
    items.push({ action: "archive", kind: "archive", label: "Archive" });
  } else if (run.capabilities.canUnarchive) {
    items.push({ action: "unarchive", kind: "unarchive", label: "Unarchive" });
  }

  const destructiveCleanupAction = getRunDestructiveCleanupAction(run);
  if (destructiveCleanupAction !== null) {
    items.push({
      action: destructiveCleanupAction,
      kind: destructiveCleanupAction,
      label: DESTRUCTIVE_LABELS[destructiveCleanupAction],
    });
  }

  return items;
}
