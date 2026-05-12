import type { RunCapabilities, RunStatus, RunSummary } from "@task-runner/core/contracts/runs.js";
import { describe, expect, it } from "vitest";
import { getRunActionMenuItems } from "./run-action-menu.js";

function makeCapabilities(overrides: Partial<RunCapabilities> = {}): RunCapabilities {
  return {
    abortReason: "not_active_in_daemon",
    canAbort: false,
    canArchive: false,
    canDelete: false,
    canReady: false,
    canReconfigure: false,
    canReset: false,
    canResume: false,
    canUnarchive: false,
    taskMutation: {
      canAdd: false,
      canEditNotes: true,
      canSetStatus: false,
    },
    ...overrides,
  };
}

function makeRun(
  overrides: Partial<Pick<RunSummary, "capabilities" | "status" | "totalAttemptCount">> = {},
): Pick<RunSummary, "capabilities" | "status" | "totalAttemptCount"> {
  return {
    capabilities: makeCapabilities(),
    status: "success" satisfies RunStatus,
    totalAttemptCount: 1,
    ...overrides,
  };
}

describe("getRunActionMenuItems", () => {
  it("returns no items when no primary or capability-gated actions apply", () => {
    expect(getRunActionMenuItems(makeRun())).toEqual([]);
  });

  it("returns exactly one primary action label when ready is available", () => {
    expect(
      getRunActionMenuItems(
        makeRun({
          capabilities: makeCapabilities({ canReady: true, canResume: true }),
          status: "initialized",
          totalAttemptCount: 0,
        }),
      ).filter((item) => item.kind === "primary"),
    ).toEqual([{ action: "ready", kind: "primary", label: "Ready" }]);
  });

  it("returns exactly one primary Start action for a fresh ready run", () => {
    expect(
      getRunActionMenuItems(
        makeRun({
          capabilities: makeCapabilities({ canResume: true }),
          status: "ready",
          totalAttemptCount: 0,
        }),
      ).filter((item) => item.kind === "primary"),
    ).toEqual([{ action: "start", kind: "primary", label: "Start" }]);
  });

  it("returns exactly one primary Resume action for a resumable attempted run", () => {
    expect(
      getRunActionMenuItems(
        makeRun({
          capabilities: makeCapabilities({ canResume: true }),
          status: "ready",
          totalAttemptCount: 1,
        }),
      ).filter((item) => item.kind === "primary"),
    ).toEqual([{ action: "resume", kind: "primary", label: "Resume" }]);
  });

  it("shows Archive and Archive + Delete when canArchive is true", () => {
    expect(
      getRunActionMenuItems(
        makeRun({
          capabilities: makeCapabilities({ canArchive: true }),
        }),
      ),
    ).toEqual([
      { action: "archive", kind: "archive", label: "Archive" },
      { action: "archive-delete", kind: "archive-delete", label: "Archive + Delete" },
    ]);
  });

  it("shows Unarchive and Delete when canUnarchive and canDelete are true", () => {
    expect(
      getRunActionMenuItems(
        makeRun({
          capabilities: makeCapabilities({ canDelete: true, canUnarchive: true }),
        }),
      ),
    ).toEqual([
      { action: "unarchive", kind: "unarchive", label: "Unarchive" },
      { action: "delete", kind: "delete", label: "Delete" },
    ]);
  });

  it("never shows both Archive and Unarchive when both capabilities are true", () => {
    const actions = getRunActionMenuItems(
      makeRun({
        capabilities: makeCapabilities({ canArchive: true, canUnarchive: true }),
      }),
    ).map((item) => item.action);

    expect(actions).toContain("archive");
    expect(actions).not.toContain("unarchive");
  });

  it("never shows both Archive + Delete and Delete when both capabilities are true", () => {
    const actions = getRunActionMenuItems(
      makeRun({
        capabilities: makeCapabilities({ canArchive: true, canDelete: true }),
      }),
    ).map((item) => item.action);

    expect(actions).toContain("archive-delete");
    expect(actions).not.toContain("delete");
  });
});
