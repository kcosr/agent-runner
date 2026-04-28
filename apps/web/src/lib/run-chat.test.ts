import type { RunTimelineAttempt, RunTimelineHistory } from "@task-runner/core/contracts/events.js";
import type { RunDetail, RunSessionSummary } from "@task-runner/core/contracts/runs.js";
import { describe, expect, it } from "vitest";
import { deriveRunChatRows } from "./run-chat.js";

function makeSession(overrides: Partial<RunSessionSummary>): RunSessionSummary {
  return {
    sessionIndex: 0,
    status: "success",
    startedAt: "2026-04-28T10:00:00.000Z",
    endedAt: "2026-04-28T10:05:00.000Z",
    exitCode: 0,
    message: null,
    firstAttemptNumber: null,
    lastAttemptNumber: null,
    attemptCount: 0,
    maxAttemptsPerSession: 3,
    backendSessionIdAtStart: null,
    backendSessionIdAtEnd: null,
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<RunTimelineAttempt>): RunTimelineAttempt {
  return {
    attemptNumber: 1,
    sessionIndex: 0,
    attemptIndexInSession: 0,
    startedAt: "2026-04-28T10:00:00.000Z",
    endedAt: "2026-04-28T10:05:00.000Z",
    prompt: "Prompt text",
    transcript: "Assistant response",
    notices: "",
    exitCode: 0,
    timedOut: false,
    live: false,
    ...overrides,
  };
}

function makeHistory(attempts: RunTimelineAttempt[]): RunTimelineHistory {
  return {
    runId: "run-1",
    attempts,
    lastCursor: 1,
  };
}

function makeRun(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    runId: "run-1",
    parentRunId: null,
    runGroupId: "run-1",
    repo: "task-runner",
    status: "success",
    effectiveStatus: "success",
    archivedAt: null,
    isLive: false,
    workspaceDir: "/tmp/task-runner/run-1",
    agent: {
      name: "implementer",
      sourcePath: null,
    },
    assignment: null,
    backend: "codex",
    model: "gpt-5",
    effort: "medium",
    name: null,
    note: null,
    pinned: false,
    backendSessionId: null,
    cwd: "/tmp/task-runner",
    unrestricted: false,
    timeoutSec: 3600,
    startedAt: "2026-04-28T10:00:00.000Z",
    endedAt: "2026-04-28T10:05:00.000Z",
    exitCode: 0,
    totalAttemptCount: 0,
    totalSessionCount: 0,
    maxAttemptsPerSession: 3,
    sessions: [],
    currentSession: null,
    lastSession: null,
    tasksCompleted: 0,
    tasksTotal: 0,
    attachments: [],
    dependencies: [],
    dependents: [],
    schedule: null,
    scheduleState: "none",
    tasks: [],
    activeTask: null,
    message: null,
    pendingPrompt: null,
    callerInstructions: null,
    lockedFields: [],
    runtimeVars: {},
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
    ...overrides,
  };
}

describe("deriveRunChatRows", () => {
  it("does not derive user rows from run or session messages before attempts exist", () => {
    const rows = deriveRunChatRows(
      makeRun({
        message: "  Initial request  ",
        sessions: [
          makeSession({ sessionIndex: 0, message: null }),
          makeSession({ sessionIndex: 1, message: "   " }),
          makeSession({ sessionIndex: 2, message: " Follow-up " }),
        ],
      }),
      null,
    );

    expect(rows).toEqual([]);
  });

  it("sorts sessions and attempts, promotes the latest attempt, and keeps retries as details", () => {
    const rows = deriveRunChatRows(
      makeRun({
        message: "Initial",
        sessions: [
          makeSession({ sessionIndex: 2, message: "Second resume" }),
          makeSession({ sessionIndex: 0, message: null }),
          makeSession({ sessionIndex: 1, message: "First resume" }),
        ],
      }),
      makeHistory([
        makeAttempt({ sessionIndex: 1, attemptNumber: 4, transcript: "latest session 1" }),
        makeAttempt({ sessionIndex: 0, attemptNumber: 2, transcript: "latest session 0" }),
        makeAttempt({ sessionIndex: 1, attemptNumber: 3, transcript: "prior session 1" }),
        makeAttempt({ sessionIndex: 0, attemptNumber: 1, transcript: "prior session 0" }),
      ]),
    );

    expect(rows.map((row) => row.id)).toEqual([
      "session:0:user",
      "session:0:assistant:2",
      "session:1:user",
      "session:1:assistant:4",
    ]);
    expect(rows[0]).toMatchObject({
      kind: "user",
      text: "Prompt text",
    });
    expect(rows[2]).toMatchObject({
      kind: "user",
      text: "Prompt text",
    });
    expect(rows[1]).toMatchObject({
      kind: "assistant",
      attemptNumber: 2,
      transcript: "latest session 0",
      retryAttempts: [{ attemptNumber: 1, transcript: "prior session 0" }],
    });
    expect(rows[3]).toMatchObject({
      kind: "assistant",
      attemptNumber: 4,
      transcript: "latest session 1",
      retryAttempts: [{ attemptNumber: 3, transcript: "prior session 1" }],
    });
  });

  it("uses stored run and session messages only as attempt prompt fallbacks", () => {
    const rows = deriveRunChatRows(
      makeRun({
        message: "Initial fallback",
        sessions: [
          makeSession({ sessionIndex: 0, message: null }),
          makeSession({ sessionIndex: 1, message: "Resume fallback" }),
          makeSession({ sessionIndex: 2, message: "Hidden until attempted" }),
        ],
      }),
      makeHistory([
        makeAttempt({ sessionIndex: 0, attemptNumber: 1, prompt: "  " }),
        makeAttempt({ sessionIndex: 1, attemptNumber: 2, prompt: "" }),
      ]),
    );

    expect(rows.map((row) => row.id)).toEqual([
      "session:0:user",
      "session:0:assistant:1",
      "session:1:user",
      "session:1:assistant:2",
    ]);
    expect(rows[0]).toMatchObject({ kind: "user", text: "Initial fallback" });
    expect(rows[2]).toMatchObject({ kind: "user", text: "Resume fallback" });
  });

  it("renders attempt prompts as user rows and retains live or empty transcript states", () => {
    const rows = deriveRunChatRows(
      makeRun({
        sessions: [makeSession({ sessionIndex: 0, message: null })],
      }),
      makeHistory([
        makeAttempt({
          attemptNumber: 1,
          transcript: "",
          notices: "backend notice",
          prompt: "first prompt",
          live: false,
        }),
        makeAttempt({
          attemptNumber: 2,
          transcript: "   ",
          notices: "live notice",
          prompt: "live prompt",
          live: true,
          endedAt: null,
          exitCode: null,
        }),
      ]),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: "user",
      text: "live prompt",
    });
    expect(rows[1]).toMatchObject({
      kind: "assistant",
      attemptNumber: 2,
      transcript: "   ",
      emptyState: "waiting_live_response",
      retryAttempts: [
        {
          attemptNumber: 1,
          transcript: "",
          emptyState: "no_response_recorded",
        },
      ],
    });
  });
});
