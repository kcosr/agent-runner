import { describe, expect, it } from "vitest";
import { formatAuditEventRow } from "./audit-formatter.js";

describe("formatAuditEventRow", () => {
  it("formats hook events with hook category metadata", () => {
    const result = formatAuditEventRow({
      runId: "run-1",
      cursor: 1,
      recordedAt: "2026-04-21T12:41:02.000Z",
      event: {
        type: "run.hook_recorded",
        source: "system",
        hostMode: "embedded",
        phase: "prepare",
        hookId: "prepare:0:git-worktree",
        outcome: "continue",
      },
    });

    expect(result).toEqual({
      sentence: "Prepare hook `prepare:0:git-worktree` continue.",
      filterCategory: "Hooks",
      categoryLabel: "Hook",
    });
  });

  it("formats representative lifecycle, task, and backend events", () => {
    expect(
      formatAuditEventRow({
        runId: "run-1",
        cursor: 1,
        recordedAt: "2026-04-21T12:41:02.000Z",
        event: {
          type: "run.finished",
          source: "system",
          hostMode: "embedded",
          terminalStatus: "success",
        },
      }).sentence,
    ).toBe("Run finished with status success.");

    expect(
      formatAuditEventRow({
        runId: "run-1",
        cursor: 2,
        recordedAt: "2026-04-21T12:41:03.000Z",
        event: {
          type: "task.updated",
          source: "task_command",
          hostMode: "embedded",
          taskId: "orient",
          statusAfter: "completed",
        },
      }).sentence,
    ).toBe("Task `orient` marked completed.");

    expect(
      formatAuditEventRow({
        runId: "run-1",
        cursor: 3,
        recordedAt: "2026-04-21T12:41:04.000Z",
        event: {
          type: "run.backend_session_updated",
          source: "daemon",
          hostMode: "daemon",
        },
      }).sentence,
    ).toBe("Backend session updated.");
  });

  it("surfaces unknown audit events with an explicit fallback row", () => {
    const result = formatAuditEventRow({
      runId: "run-1",
      cursor: 99,
      recordedAt: "2026-04-21T12:41:05.000Z",
      event: {
        type: "future.event",
        source: "system",
        hostMode: "embedded",
      },
    });

    expect(result.sentence).toBe("Unhandled audit event future.event at cursor 99.");
  });
});
