import type { RunDetail } from "@task-runner/core/contracts/runs.js";
import { describe, expect, it } from "vitest";
import { getRunPrimaryAction } from "./run-primary-action.js";

function makeRun(
  overrides: Partial<Pick<RunDetail, "totalAttemptCount" | "capabilities" | "status">> = {},
): Pick<RunDetail, "totalAttemptCount" | "capabilities" | "status"> {
  return {
    totalAttemptCount: 0,
    status: "ready",
    capabilities: {
      canArchive: true,
      canUnarchive: false,
      canReset: true,
      canDelete: false,
      canReady: false,
      canResume: true,
      canAbort: false,
      abortReason: "not_active_in_daemon",
      canReconfigure: false,
      taskMutation: {
        canSetStatus: false,
        canEditNotes: true,
        canAdd: false,
      },
    },
    ...overrides,
  };
}

describe("getRunPrimaryAction", () => {
  it("returns start for ready runs that are resume-capable", () => {
    expect(getRunPrimaryAction(makeRun())).toBe("start");
  });

  it("returns null when a ready run is blocked from resuming", () => {
    expect(
      getRunPrimaryAction(
        makeRun({
          capabilities: {
            ...makeRun().capabilities,
            canResume: false,
          },
        }),
      ),
    ).toBeNull();
  });
});
