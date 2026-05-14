import type {
  RunAuditHistory,
  RunTimelineHistory,
} from "@kcosr/agent-runner-core/contracts/events.js";
import { describe, expect, it } from "vitest";
import { applyAuditEnvelope } from "./run-audit.js";
import { applyEnvelope } from "./run-timeline.js";

function makeHistory(overrides: Partial<RunTimelineHistory> = {}): RunTimelineHistory {
  return {
    runId: "run-1",
    attempts: [],
    lastCursor: 0,
    ...overrides,
  };
}

function makeAuditHistory(overrides: Partial<RunAuditHistory> = {}): RunAuditHistory {
  return {
    runId: "run-1",
    events: [],
    lastCursor: 0,
    ...overrides,
  };
}

describe("applyEnvelope", () => {
  it("adds a live attempt when an attempt starts", () => {
    const result = applyEnvelope(makeHistory(), {
      runId: "run-1",
      cursor: 1,
      event: {
        type: "attempt_started",
        attemptNumber: 1,

        attemptIndexInSession: 0,
        sessionIndex: 0,
        startedAt: "2026-04-15T10:00:00.000Z",
        prompt: "Write output",
      },
    });

    expect(result.requiresReload).toBe(false);
    expect(result.history.lastCursor).toBe(1);
    expect(result.history.attempts).toEqual([
      {
        attemptNumber: 1,

        attemptIndexInSession: 0,
        sessionIndex: 0,
        startedAt: "2026-04-15T10:00:00.000Z",
        endedAt: null,
        prompt: "Write output",
        transcript: "",
        notices: "",
        exitCode: null,
        timedOut: false,
        live: true,
        provenance: { kind: "task_runner" },
      },
    ]);
  });

  it("appends transcript deltas to the active attempt", () => {
    const result = applyEnvelope(
      makeHistory({
        attempts: [
          {
            attemptNumber: 1,

            attemptIndexInSession: 0,
            sessionIndex: 0,
            startedAt: "2026-04-15T10:00:00.000Z",
            endedAt: null,
            prompt: "Write output",
            transcript: "Hello",
            notices: "",
            exitCode: null,
            timedOut: false,
            live: true,
            provenance: { kind: "task_runner" },
          },
        ],
        lastCursor: 1,
      }),
      {
        runId: "run-1",
        cursor: 2,
        event: {
          type: "agent_message_delta",
          text: " world",
        },
      },
    );

    expect(result.requiresReload).toBe(false);
    expect(result.history.attempts[0]?.transcript).toBe("Hello world");
  });

  it("appends backend notices to the active attempt notices", () => {
    const result = applyEnvelope(
      makeHistory({
        attempts: [
          {
            attemptNumber: 1,

            attemptIndexInSession: 0,
            sessionIndex: 0,
            startedAt: "2026-04-15T10:00:00.000Z",
            endedAt: null,
            prompt: "Write output",
            transcript: "Hello",
            notices: "warn:",
            exitCode: null,
            timedOut: false,
            live: true,
            provenance: { kind: "task_runner" },
          },
        ],
        lastCursor: 1,
      }),
      {
        runId: "run-1",
        cursor: 2,
        event: {
          type: "backend_notice",
          text: " disk nearly full",
        },
      },
    );

    expect(result.requiresReload).toBe(false);
    expect(result.history.attempts[0]?.notices).toBe("warn: disk nearly full");
    expect(result.history.attempts[0]?.transcript).toBe("Hello");
  });

  it("treats unknown event types as requiring a reload", () => {
    const result = applyEnvelope(makeHistory({ lastCursor: 1 }), {
      runId: "run-1",
      cursor: 2,
      event: {
        type: "new_event_type",
      } as unknown as Parameters<typeof applyEnvelope>[1]["event"],
    });

    expect(result.requiresReload).toBe(true);
    expect(result.showStaleWarning).toBe(true);
    expect(result.history.lastCursor).toBe(1);
  });

  it("treats cursor gaps as requiring a stale-warning reload", () => {
    const result = applyEnvelope(makeHistory({ lastCursor: 1 }), {
      runId: "run-1",
      cursor: 3,
      event: {
        type: "agent_message_delta",
        text: " world",
      },
    });

    expect(result.requiresReload).toBe(true);
    expect(result.showStaleWarning).toBe(true);
    expect(result.history.lastCursor).toBe(1);
  });

  it("reloads silently when backend-owned history changes", () => {
    const result = applyEnvelope(makeHistory({ lastCursor: 1 }), {
      runId: "run-1",
      cursor: 2,
      event: {
        type: "timeline_invalidated",
        reason: "backend_session_sync",
      },
    });

    expect(result.requiresReload).toBe(true);
    expect(result.showStaleWarning).toBe(false);
    expect(result.history.lastCursor).toBe(1);
  });

  it("reloads silently when a run finishes", () => {
    const result = applyEnvelope(
      makeHistory({
        attempts: [
          {
            attemptNumber: 1,

            attemptIndexInSession: 0,
            sessionIndex: 0,
            startedAt: "2026-04-15T10:00:00.000Z",
            endedAt: null,
            prompt: "Write output",
            transcript: "Hello world",
            notices: "",
            exitCode: null,
            timedOut: false,
            live: true,
            provenance: { kind: "task_runner" },
          },
        ],
        lastCursor: 1,
      }),
      {
        runId: "run-1",
        cursor: 2,
        event: {
          type: "run_finished",
          summary: {
            status: "success",
            sessionAttemptCount: 1,
            maxAttemptsPerSession: 3,
            totalAttemptCount: 1,
            totalSessionCount: 1,
            tasksCompleted: 1,
            tasksTotal: 1,
            tasks: [],
            runId: "run-1",
          },
        },
      },
    );

    expect(result.requiresReload).toBe(true);
    expect(result.showStaleWarning).toBe(false);
    expect(result.history.lastCursor).toBe(1);
  });
});

describe("applyAuditEnvelope", () => {
  it("appends audit envelopes in cursor order", () => {
    const result = applyAuditEnvelope(makeAuditHistory(), {
      runId: "run-1",
      cursor: 1,
      event: {
        type: "run.ready",
        recordedAt: "2026-04-15T10:00:00.000Z",
        source: "cli",
        hostMode: "embedded",
        fields: {
          previousStatus: "initialized",
        },
      },
    });

    expect(result.requiresReload).toBe(false);
    expect(result.history.lastCursor).toBe(1);
    expect(result.history.events).toHaveLength(1);
    expect(result.history.events[0]?.event.type).toBe("run.ready");
  });

  it("treats audit cursor gaps as requiring a reload", () => {
    const result = applyAuditEnvelope(
      makeAuditHistory({
        lastCursor: 1,
        events: [
          {
            runId: "run-1",
            cursor: 1,
            event: {
              type: "run.ready",
              recordedAt: "2026-04-15T10:00:00.000Z",
              source: "cli",
              hostMode: "embedded",
              fields: {
                previousStatus: "initialized",
              },
            },
          },
        ],
      }),
      {
        runId: "run-1",
        cursor: 3,
        event: {
          type: "run.finished",
          recordedAt: "2026-04-15T10:05:00.000Z",
          source: "system",
          hostMode: "embedded",
          fields: {
            terminalStatus: "success",
            exitCode: 0,
            tasksCompleted: 1,
            tasksTotal: 1,
          },
        },
      },
    );

    expect(result.requiresReload).toBe(true);
    expect(result.history.lastCursor).toBe(1);
    expect(result.history.events).toHaveLength(1);
  });
});
