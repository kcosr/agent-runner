import type { RunDetail, RunSummary } from "@task-runner/core/contracts/runs.js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DashboardSettingsProvider } from "../lib/settings.js";
import { RunDetailDrawer } from "./run-detail-drawer.js";

function makeRun(): RunDetail {
  return {
    runId: "run-1",
    repo: "task-runner",
    status: "running",
    effectiveStatus: "running",
    archivedAt: null,
    note: null,
    pinned: false,
    isLive: true,
    workspaceDir: "/tmp/task-runner/.state/run-1",
    assignmentPath: "/tmp/task-runner/assignment.md",
    agent: {
      name: "implementer",
      sourcePath: null,
    },
    assignment: {
      name: "Build dashboard",
      sourcePath: "/tmp/assignment.md",
      workspacePath: "/tmp/task-runner/assignment.md",
    },
    backend: "codex",
    model: "gpt-5.4",
    effort: "high",
    name: "Build dashboard",
    backendSessionId: "thread-1",
    cwd: "/tmp/task-runner",
    unrestricted: false,
    timeoutSec: 3600,
    startedAt: "2026-04-13T05:00:00.000Z",
    endedAt: null,
    exitCode: null,
    attempts: 1,
    maxAttempts: 3,
    sessionCount: 1,
    tasksCompleted: 1,
    tasksTotal: 2,
    attachments: [],
    dependencies: [],
    dependents: [],
    tasks: [
      {
        id: "orient",
        title: "Orient",
        body: "Read the repo",
        status: "completed",
        notes: "done",
      },
      {
        id: "build",
        title: "Build UI",
        body: "Ship the web UI",
        status: "in_progress",
        notes: "working",
      },
    ],
    activeTask: {
      id: "build",
      title: "Build UI",
    },
    message: "Ship the feature.",
    pendingPrompt: null,
    callerInstructions: null,
    lockedFields: [],
    runtimeVars: {},
    execution: {
      hostMode: "embedded",
      controller: {
        kind: "embedded",
      },
    },
    capabilities: {
      canArchive: false,
      canUnarchive: false,
      canReset: false,
      canDelete: false,
      canReady: false,
      canResume: true,
      canAbort: false,
      abortReason: "not_active_in_daemon",
      taskMutation: {
        canAdd: false,
        canEditNotes: false,
        canSetStatus: false,
      },
    },
  };
}

describe("RunDetailDrawer", () => {
  it("renders Attempts/Audit tabs and filters audit rows by chip selection", async () => {
    const user = userEvent.setup();
    const dependencyCandidateRuns: RunSummary[] = [];
    render(
      <DashboardSettingsProvider>
        <RunDetailDrawer
          activeSection="events"
          dependencyCandidateRuns={dependencyCandidateRuns}
          onAddDependency={async () => {}}
          onAbort={() => {}}
          onArchive={() => {}}
          onClearDependencies={async () => {}}
          onClose={() => {}}
          onCloseResumeDialog={() => {}}
          onCopy={async () => {}}
          onDelete={() => {}}
          groupAttachmentsQuery={{ data: [], isPending: false } as never}
          onDownloadAttachment={async () => {}}
          onOpenAttachmentPreview={() => {}}
          onOpenResumeDialog={() => {}}
          onSelectRun={() => {}}
          onClearBackendSession={async () => {}}
          onRemoveDependency={async () => {}}
          onRemoveAttachment={async () => {}}
          onReset={() => {}}
          onRename={async () => {}}
          onResumeMessageDraftChange={() => {}}
          onResumeMessageExpandedChange={() => {}}
          onSetNote={async () => {}}
          onSetBackendSession={async () => {}}
          onSetPinned={async () => {}}
          onSelectSection={() => {}}
          onSubmitResume={async () => {}}
          onTriggerPrimaryAction={async () => {}}
          onUnarchive={() => {}}
          onUploadAttachment={async () => {}}
          resumeDialogOpen={false}
          resumeMessageDraft=""
          resumeMessageExpanded={false}
          auditTimelineState={{
            history: {
              runId: "run-1",
              attempts: [],
              lastCursor: 2,
              events: [
                {
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
                },
                {
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
                },
              ],
            },
            isLoading: false,
            stale: false,
          }}
          timelineState={{
            history: {
              runId: "run-1",
              attempts: [
                {
                  attempt: 1,
                  sessionIndex: 0,
                  startedAt: "2026-04-13T05:00:00.000Z",
                  endedAt: null,
                  prompt: "Do the thing",
                  transcript: "done",
                  notices: "",
                  exitCode: null,
                  timedOut: false,
                  live: true,
                },
              ],
              lastCursor: 1,
            },
            isLoading: false,
            stale: false,
          }}
          run={makeRun()}
        />
      </DashboardSettingsProvider>,
    );

    expect(screen.getByRole("tab", { name: "Attempts" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Audit" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Audit" }));

    expect(screen.getByRole("tab", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Hooks" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByText("Prepare hook `prepare:0:git-worktree` continue.")).toBeInTheDocument();
    expect(screen.getByText("Task `orient` marked completed.")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Tasks" }));

    expect(screen.queryByText("Prepare hook `prepare:0:git-worktree` continue.")).toBeNull();
    expect(screen.getByText("Task `orient` marked completed.")).toBeInTheDocument();
  });
});
