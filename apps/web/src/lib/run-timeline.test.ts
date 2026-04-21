import type { RunAuditHistory, RunTimelineHistory } from "@task-runner/core/contracts/events.js";
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
        attempt: 1,
        sessionIndex: 0,
        startedAt: "2026-04-15T10:00:00.000Z",
        prompt: "Write output",
      },
    });

    expect(result.requiresReload).toBe(false);
    expect(result.history.lastCursor).toBe(1);
    expect(result.history.attempts).toEqual([
      {
        attempt: 1,
        sessionIndex: 0,
        startedAt: "2026-04-15T10:00:00.000Z",
        endedAt: null,
        prompt: "Write output",
        transcript: "",
        notices: "",
        exitCode: null,
        timedOut: false,
        live: true,
      },
    ]);
  });

  it("appends transcript deltas to the active attempt", () => {
    const result = applyEnvelope(
      makeHistory({
        attempts: [
          {
            attempt: 1,
            sessionIndex: 0,
            startedAt: "2026-04-15T10:00:00.000Z",
            endedAt: null,
            prompt: "Write output",
            transcript: "Hello",
            notices: "",
            exitCode: null,
            timedOut: false,
            live: true,
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
            attempt: 1,
            sessionIndex: 0,
            startedAt: "2026-04-15T10:00:00.000Z",
            endedAt: null,
            prompt: "Write output",
            transcript: "Hello",
            notices: "warn:",
            exitCode: null,
            timedOut: false,
            live: true,
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
