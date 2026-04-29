import type { RunSummary } from "@task-runner/core/contracts/runs.js";
import { describe, expect, it } from "vitest";
import { createRunComparator, sortRunsWithPinnedFirst } from "./run-order.js";

function run(overrides: Partial<RunSummary> & Pick<RunSummary, "runId">): RunSummary {
  const { runId, ...rest } = overrides;
  return {
    runId,
    parentRunId: null,
    runGroupId: runId,
    repo: "task-runner",
    status: "running",
    effectiveStatus: "running",
    archivedAt: null,
    pinned: false,
    notePresent: false,
    agentName: "implementer",
    assignmentName: "Build dashboard",
    backend: "codex",
    model: "gpt-5.4",
    name: overrides.runId,
    cwd: "/tmp/task-runner",
    startedAt: "2026-04-13T05:00:00.000Z",
    updatedAt: "2026-04-13T05:00:00.000Z",
    endedAt: null,
    totalAttemptCount: 1,
    totalSessionCount: 1,
    maxAttemptsPerSession: 3,
    currentSession: null,
    lastSession: null,
    tasksCompleted: 0,
    tasksTotal: 1,
    attachmentCount: 0,
    dependencyState: {
      ready: true,
      total: 0,
      satisfied: 0,
      unsatisfied: 0,
    },
    schedule: null,
    scheduleState: "none",
    activeTask: null,
    capabilities: {
      canArchive: false,
      canUnarchive: false,
      canReset: true,
      canDelete: false,
      canReady: false,
      canResume: true,
      canAbort: false,
      abortReason: "not_active_in_daemon",
      canReconfigure: false,
      taskMutation: {
        canAdd: false,
        canEditNotes: false,
        canSetStatus: false,
      },
    },
    execution: {
      hostMode: "embedded",
      controller: {
        kind: "embedded",
      },
    },
    ...rest,
  };
}

function ids(runs: RunSummary[]): string[] {
  return runs.map((entry) => entry.runId);
}

describe("run ordering", () => {
  it("sorts by startedAt in both directions with runId ties", () => {
    const runs = [
      run({ runId: "b", startedAt: "2026-04-13T05:00:00.000Z" }),
      run({ runId: "c", startedAt: "2026-04-13T05:05:00.000Z" }),
      run({ runId: "a", startedAt: "2026-04-13T05:00:00.000Z" }),
    ];

    expect(ids([...runs].sort(createRunComparator("startedAt", "desc")))).toEqual(["c", "a", "b"]);
    expect(ids([...runs].sort(createRunComparator("startedAt", "asc")))).toEqual(["a", "b", "c"]);
  });

  it("sorts by updatedAt in both directions and falls back to newest startedAt", () => {
    const runs = [
      run({
        runId: "older",
        startedAt: "2026-04-13T05:10:00.000Z",
        updatedAt: "2026-04-13T05:00:00.000Z",
      }),
      run({
        runId: "newer",
        startedAt: "2026-04-13T05:00:00.000Z",
        updatedAt: "2026-04-13T05:10:00.000Z",
      }),
      run({
        runId: "tie-started-newer",
        startedAt: "2026-04-13T05:20:00.000Z",
        updatedAt: "2026-04-13T05:00:00.000Z",
      }),
    ];

    expect(ids([...runs].sort(createRunComparator("updatedAt", "desc")))).toEqual([
      "newer",
      "tie-started-newer",
      "older",
    ]);
    expect(ids([...runs].sort(createRunComparator("updatedAt", "asc")))).toEqual([
      "tie-started-newer",
      "older",
      "newer",
    ]);
  });

  it("sorts by endedAt with nulls last and updatedAt fallback", () => {
    const runs = [
      run({
        runId: "running-newer",
        updatedAt: "2026-04-13T05:30:00.000Z",
        endedAt: null,
      }),
      run({
        runId: "ended-older",
        updatedAt: "2026-04-13T05:00:00.000Z",
        endedAt: "2026-04-13T05:05:00.000Z",
      }),
      run({
        runId: "ended-newer",
        updatedAt: "2026-04-13T05:00:00.000Z",
        endedAt: "2026-04-13T05:10:00.000Z",
      }),
      run({
        runId: "running-older",
        updatedAt: "2026-04-13T05:20:00.000Z",
        endedAt: null,
      }),
    ];

    expect(ids([...runs].sort(createRunComparator("endedAt", "desc")))).toEqual([
      "ended-newer",
      "ended-older",
      "running-newer",
      "running-older",
    ]);
    expect(ids([...runs].sort(createRunComparator("endedAt", "asc")))).toEqual([
      "ended-older",
      "ended-newer",
      "running-newer",
      "running-older",
    ]);
  });

  it("keeps pinned runs first before applying the selected comparator", () => {
    const runs = [
      run({ runId: "unpinned-newer", startedAt: "2026-04-13T05:10:00.000Z" }),
      run({ runId: "pinned-older", pinned: true, startedAt: "2026-04-13T05:00:00.000Z" }),
      run({ runId: "pinned-newer", pinned: true, startedAt: "2026-04-13T05:05:00.000Z" }),
    ];

    expect(ids(sortRunsWithPinnedFirst(runs, createRunComparator("startedAt", "desc")))).toEqual([
      "pinned-newer",
      "pinned-older",
      "unpinned-newer",
    ]);
  });
});
