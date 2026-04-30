import type { RunSummary } from "@task-runner/core/contracts/runs.js";
import { describe, expect, it } from "vitest";
import { runQueryKeys } from "./query.js";
import {
  removeRunFromListCache,
  runBelongsInListCache,
  runListQueryMetadata,
  upsertRunSummaryInListCache,
} from "./run-list-cache.js";

function makeRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-1",
    parentRunId: null,
    runGroupId: "group-a",
    repo: "task-runner",
    status: "running",
    effectiveStatus: "running",
    archivedAt: null,
    pinned: false,
    notePresent: false,
    agentName: "implementer",
    name: "Build dashboard",
    assignmentName: "Build dashboard",
    backend: "codex",
    model: "gpt-5.4",
    cwd: "/tmp/task-runner",
    startedAt: "2026-04-13T05:00:00.000Z",
    updatedAt: "2026-04-13T05:00:00.000Z",
    endedAt: null,
    totalAttemptCount: 1,
    totalSessionCount: 1,
    maxAttemptsPerSession: 3,
    currentSession: null,
    lastSession: null,
    tasksCompleted: 1,
    tasksTotal: 4,
    attachmentCount: 0,
    queuedResumeMessageCount: 0,
    dependencyState: {
      ready: true,
      total: 0,
      satisfied: 0,
      unsatisfied: 0,
    },
    schedule: null,
    scheduleState: "none",
    activeTask: null,
    execution: {
      hostMode: "embedded",
      controller: { kind: "embedded" },
    },
    capabilities: {
      canArchive: true,
      canUnarchive: false,
      canReset: true,
      canDelete: false,
      canReady: false,
      canResume: false,
      canAbort: false,
      abortReason: "not_active_in_daemon",
      canReconfigure: false,
      taskMutation: {
        canAdd: false,
        canEditNotes: false,
        canSetStatus: false,
      },
    },
    ...overrides,
  };
}

describe("run list cache helpers", () => {
  it("keeps archived visibility in list query keys while preserving the list prefix", () => {
    const hiddenKey = runQueryKeys.list({ includeArchived: false, runGroupId: null });
    const archivedKey = runQueryKeys.list({ includeArchived: true, runGroupId: null });
    const groupKey = runQueryKeys.list({ includeArchived: false, runGroupId: "group-a" });
    const prefix = runQueryKeys.lists();

    expect(hiddenKey).not.toEqual(archivedKey);
    expect(hiddenKey).not.toEqual(groupKey);
    expect(hiddenKey.slice(0, prefix.length)).toEqual(prefix);
    expect(archivedKey.slice(0, prefix.length)).toEqual(prefix);
    expect(groupKey.slice(0, prefix.length)).toEqual(prefix);
  });

  it("reads metadata only from well-shaped list keys", () => {
    expect(
      runListQueryMetadata(runQueryKeys.list({ includeArchived: true, runGroupId: "group-a" })),
    ).toEqual({ includeArchived: true, runGroupId: "group-a" });
    expect(runListQueryMetadata(runQueryKeys.lists())).toBeNull();
    expect(
      runListQueryMetadata(["runs", "list", { includeArchived: "true", runGroupId: null }]),
    ).toBeNull();
    expect(
      runListQueryMetadata(["runs", "list", { includeArchived: true, runGroupId: 1 }]),
    ).toBeNull();
  });

  it("applies archived and run-group membership rules", () => {
    const cases: Array<{
      description: string;
      metadata: { includeArchived: boolean; runGroupId: string | null };
      summary: RunSummary;
      expected: boolean;
    }> = [
      {
        description: "active global hidden list",
        metadata: { includeArchived: false, runGroupId: null },
        summary: makeRun(),
        expected: true,
      },
      {
        description: "archived global hidden list",
        metadata: { includeArchived: false, runGroupId: null },
        summary: makeRun({
          archivedAt: "2026-04-13T06:00:00.000Z",
          runId: "run-archived",
        }),
        expected: false,
      },
      {
        description: "archived global archived-inclusive list",
        metadata: { includeArchived: true, runGroupId: null },
        summary: makeRun({
          archivedAt: "2026-04-13T06:00:00.000Z",
          runId: "run-archived",
        }),
        expected: true,
      },
      {
        description: "active matching scoped hidden list",
        metadata: { includeArchived: false, runGroupId: "group-a" },
        summary: makeRun({ runId: "run-matching" }),
        expected: true,
      },
      {
        description: "active other scoped hidden list",
        metadata: { includeArchived: false, runGroupId: "group-a" },
        summary: makeRun({ runGroupId: "group-b", runId: "run-other" }),
        expected: false,
      },
      {
        description: "archived matching scoped hidden list",
        metadata: { includeArchived: false, runGroupId: "group-a" },
        summary: makeRun({
          archivedAt: "2026-04-13T06:00:00.000Z",
          runId: "run-archived",
        }),
        expected: false,
      },
      {
        description: "archived other scoped archived-inclusive list",
        metadata: { includeArchived: true, runGroupId: "group-a" },
        summary: makeRun({
          archivedAt: "2026-04-13T06:00:00.000Z",
          runGroupId: "group-b",
          runId: "run-other-archived",
        }),
        expected: false,
      },
      {
        description: "archived matching scoped archived-inclusive list",
        metadata: { includeArchived: true, runGroupId: "group-a" },
        summary: makeRun({
          archivedAt: "2026-04-13T06:00:00.000Z",
          runId: "run-archived",
        }),
        expected: true,
      },
    ];

    for (const testCase of cases) {
      expect(runBelongsInListCache(testCase.summary, testCase.metadata), testCase.description).toBe(
        testCase.expected,
      );
    }
  });

  it("removes or upserts summaries according to cache metadata", () => {
    const current = [makeRun({ runId: "run-1" })];
    const archivedRun = makeRun({
      archivedAt: "2026-04-13T06:00:00.000Z",
      runId: "run-archived",
      startedAt: "2026-04-13T05:05:00.000Z",
    });
    const matchingRun = makeRun({
      runId: "run-new",
      startedAt: "2026-04-13T05:05:00.000Z",
    });
    const absentRemoval = removeRunFromListCache(current, "run-missing");

    expect(
      upsertRunSummaryInListCache(current, archivedRun, {
        includeArchived: false,
        runGroupId: null,
      }),
    ).toEqual(current);
    expect(
      upsertRunSummaryInListCache(current, matchingRun, {
        includeArchived: false,
        runGroupId: "group-a",
      })?.map((run) => run.runId),
    ).toEqual(["run-new", "run-1"]);
    expect(absentRemoval).toBe(current);
    expect(removeRunFromListCache([matchingRun, ...current], "run-new")).toEqual(current);
  });
});
