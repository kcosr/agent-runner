import { describe, expect, it } from "vitest";
import { formatAuditEvent } from "./audit-formatter.js";

describe("formatAuditEvent", () => {
  it("returns structured message parts for known audit events", () => {
    const formatted = formatAuditEvent({
      type: "run.finished",
      recordedAt: "2026-04-15T10:00:00.000Z",
      source: "system",
      hostMode: "embedded",
      fields: {
        terminalStatus: "success",
        exitCode: 0,
        tasksCompleted: 2,
        tasksTotal: 2,
      },
    });

    expect(formatted.message).toEqual([
      { type: "text", text: "Finished run as " },
      { type: "status", status: "success" },
      { type: "text", text: " with " },
      { type: "code", text: "2" },
      { type: "text", text: "/" },
      { type: "code", text: "2" },
      { type: "text", text: " tasks complete." },
    ]);
  });

  it("falls back to a raw code fragment for unknown event types", () => {
    const formatted = formatAuditEvent({
      type: "custom.future_event",
      recordedAt: "2026-04-15T10:00:00.000Z",
      source: "system",
      hostMode: "embedded",
      fields: {
        reason: "future",
      },
    } as never);

    expect(formatted.message).toEqual([
      { type: "text", text: "Recorded " },
      { type: "code", text: "custom.future_event" },
      { type: "text", text: "." },
    ]);
  });

  it("renders task status transitions with task-status badges", () => {
    const formatted = formatAuditEvent({
      type: "task.updated",
      recordedAt: "2026-04-21T16:09:00.000Z",
      source: "task_command",
      hostMode: "embedded",
      fields: {
        taskTitle: "Apply agreed review fixes and request delta re-review",
        command: "set",
        statusBefore: "in_progress",
        statusAfter: "completed",
        notesChanged: true,
      },
    } as never);

    expect(formatted.message).toEqual([
      { type: "text", text: "Updated task " },
      { type: "strong", text: "Apply agreed review fixes and request delta re-review" },
      { type: "text", text: " from " },
      { type: "task_status", status: "in_progress" },
      { type: "text", text: " to " },
      { type: "task_status", status: "completed" },
      { type: "text", text: " via " },
      { type: "code", text: "set" },
      { type: "text", text: "." },
    ]);
  });

  it("formats hook audit events with resolved hook names, task titles, and summaries", () => {
    const formatted = formatAuditEvent(
      {
        type: "run.hook_recorded",
        recordedAt: "2026-04-21T16:09:00.000Z",
        source: "system",
        hostMode: "embedded",
        fields: {
          phase: "taskTransition",
          hookId: "taskTransition:0:require-children-success",
          outcome: "rejected",
          taskId: "apply_review_fixes",
          summary: "Child runs are incomplete",
        },
      },
      {
        resolvedHooks: [
          {
            hookId: "taskTransition:0:require-children-success",
            phase: "taskTransition",
            source: {
              name: "require-children-success",
            },
            resolvedPath: null,
            taskScopeId: null,
            when: null,
            config: {},
          },
        ],
        tasks: [
          {
            id: "apply_review_fixes",
            title: "Apply review fixes",
            body: "Do the work",
            status: "pending",
            notes: "",
          },
        ],
      },
    );

    expect(formatted.message).toEqual([
      { type: "text", text: "Hook " },
      { type: "code", text: "require-children-success" },
      { type: "text", text: " rejected task transition for " },
      { type: "strong", text: "Apply review fixes" },
      { type: "text", text: ": " },
      { type: "text", text: "Child runs are incomplete" },
      { type: "text", text: "." },
    ]);
  });

  it("falls back to the raw task id when a hook task cannot be resolved", () => {
    const formatted = formatAuditEvent({
      type: "run.hook_recorded",
      recordedAt: "2026-04-21T16:09:00.000Z",
      source: "system",
      hostMode: "embedded",
      fields: {
        phase: "taskTransition",
        hookId: "taskTransition:0:require-children-success",
        outcome: "accepted",
        taskId: "apply_review_fixes",
      },
    });

    expect(formatted.message).toEqual([
      { type: "text", text: "Hook " },
      { type: "code", text: "require-children-success" },
      { type: "text", text: " accepted task transition for " },
      { type: "strong", text: "apply_review_fixes" },
      { type: "text", text: "." },
    ]);
  });
});
