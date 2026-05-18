import type {
  RunTaskMutationCapabilities,
  RunTaskSummary,
} from "@kcosr/agent-runner-core/contracts/runs.js";
import { useMutation } from "@tanstack/react-query";
import { type KeyboardEvent as ReactKeyboardEvent, useMemo, useState } from "react";
import { createApiClient } from "../lib/api-client.js";
import { queryClient, runQueryKeys } from "../lib/query.js";
import { useRuntimeConfig } from "../lib/runtime-config.js";
import { useDaemonAuthToken } from "../lib/settings.js";
import { CreateTaskDialog } from "./create-task-dialog.js";
import {
  AlertIcon,
  CheckIcon,
  ChevronIcon,
  PencilIcon,
  PendingIcon,
  RunningIcon,
  TrashIcon,
} from "./icons.js";
import { MarkdownContent } from "./markdown.js";

function taskStatusClass(status: RunTaskSummary["status"]) {
  switch (status) {
    case "completed":
      return "task-status done";
    case "in_progress":
      return "task-status run";
    case "blocked":
      return "task-status blocked";
    default:
      return "task-status";
  }
}

function taskStatusIcon(status: RunTaskSummary["status"]) {
  switch (status) {
    case "completed":
      return <CheckIcon aria-hidden="true" />;
    case "in_progress":
      return <RunningIcon aria-hidden="true" />;
    case "blocked":
      return <AlertIcon aria-hidden="true" />;
    default:
      return <PendingIcon aria-hidden="true" />;
  }
}

type TaskTab = "body" | "notes";
type TaskStatus = RunTaskSummary["status"];

interface TaskEditDraft {
  body: string;
  title: string;
}

async function invalidateTaskRun(runId: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: runQueryKeys.detail(runId) }),
    queryClient.invalidateQueries({ queryKey: runQueryKeys.lists() }),
  ]);
}

export function RunTaskList({
  capabilities,
  runId,
  tasks,
}: {
  capabilities: RunTaskMutationCapabilities;
  runId: string;
  tasks: RunTaskSummary[];
}) {
  const config = useRuntimeConfig();
  const { daemonToken } = useDaemonAuthToken();
  const api = useMemo(() => createApiClient(config, { daemonToken }), [config, daemonToken]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activeTabs, setActiveTabs] = useState<Map<string, TaskTab>>(new Map());
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<TaskEditDraft>({ body: "", title: "" });
  const [replaceNotesDrafts, setReplaceNotesDrafts] = useState<Map<string, string>>(new Map());
  const [appendNotesDrafts, setAppendNotesDrafts] = useState<Map<string, string>>(new Map());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const createTaskMutation = useMutation({
    mutationFn: (input: { body: string; title: string }) => api.createTask(runId, input),
    onError: (error: Error) => setMutationError(error.message),
    onSuccess: async () => {
      setDialogOpen(false);
      setMutationError(null);
      await invalidateTaskRun(runId);
    },
  });
  const updateTaskMutation = useMutation({
    mutationFn: ({
      taskId,
      update,
    }: {
      taskId: string;
      update: { body?: string; notes?: string; status?: TaskStatus; title?: string };
    }) => api.updateTask(runId, taskId, update),
    onError: (error: Error) => setMutationError(error.message),
    onSuccess: async (_task, variables) => {
      setMutationError(null);
      setEditingTaskId((current) => (current === variables.taskId ? null : current));
      if (variables.update.notes !== undefined) {
        setReplaceNotesDrafts((current) => {
          const next = new Map(current);
          next.set(variables.taskId, "");
          return next;
        });
      }
      await invalidateTaskRun(runId);
    },
  });
  const appendNotesMutation = useMutation({
    mutationFn: ({ taskId, text }: { taskId: string; text: string }) =>
      api.appendTaskNotes(runId, taskId, text),
    onError: (error: Error) => setMutationError(error.message),
    onSuccess: async (_task, variables) => {
      setMutationError(null);
      setAppendNotesDrafts((current) => {
        const next = new Map(current);
        next.set(variables.taskId, "");
        return next;
      });
      await invalidateTaskRun(runId);
    },
  });
  const deleteTaskMutation = useMutation({
    mutationFn: (taskId: string) => api.deleteTask(runId, taskId),
    onError: (error: Error) => setMutationError(error.message),
    onSuccess: async () => {
      setMutationError(null);
      await invalidateTaskRun(runId);
    },
  });

  const mutationPending =
    createTaskMutation.isPending ||
    updateTaskMutation.isPending ||
    appendNotesMutation.isPending ||
    deleteTaskMutation.isPending;

  if (tasks.length === 0) {
    return (
      <>
        <TaskToolbar
          canAdd={capabilities.canAdd}
          onAdd={() => setDialogOpen(true)}
          pending={mutationPending}
        />
        <div className="drawer-state">
          <h3>No tasks configured</h3>
          <p>No tasks are configured for this run.</p>
        </div>
        {dialogOpen ? renderCreateDialog() : null}
      </>
    );
  }

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function selectTab(id: string, tab: TaskTab) {
    setActiveTabs((prev) => {
      const next = new Map(prev);
      next.set(id, tab);
      return next;
    });
  }

  function activeTabFor(task: RunTaskSummary): TaskTab {
    const choice = activeTabs.get(task.id);
    if (choice) {
      return choice;
    }
    return task.body ? "body" : "notes";
  }

  function startEdit(task: RunTaskSummary) {
    setEditingTaskId(task.id);
    setEditDraft({ body: task.body, title: task.title });
    setMutationError(null);
  }

  function cancelEdit() {
    setEditingTaskId(null);
    setMutationError(null);
  }

  function taskNotesDraft(task: RunTaskSummary) {
    return replaceNotesDrafts.get(task.id) ?? "";
  }

  function setTaskNotesDraft(taskId: string, value: string) {
    setReplaceNotesDrafts((current) => {
      const next = new Map(current);
      next.set(taskId, value);
      return next;
    });
  }

  function appendDraft(taskId: string) {
    return appendNotesDrafts.get(taskId) ?? "";
  }

  function setAppendDraft(taskId: string, value: string) {
    setAppendNotesDrafts((current) => {
      const next = new Map(current);
      next.set(taskId, value);
      return next;
    });
  }

  function handleTaskEditKeyDown(
    event: ReactKeyboardEvent<HTMLTextAreaElement | HTMLInputElement>,
  ) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
    }
  }

  function renderCreateDialog() {
    return (
      <CreateTaskDialog
        initialTitle="New task"
        onClose={() => setDialogOpen(false)}
        onSubmit={async (input) => {
          await createTaskMutation.mutateAsync(input);
        }}
        pending={createTaskMutation.isPending}
        reference={null}
        submitError={createTaskMutation.error?.message}
      />
    );
  }

  return (
    <div className="tasks">
      <TaskToolbar
        canAdd={capabilities.canAdd}
        onAdd={() => setDialogOpen(true)}
        pending={mutationPending}
      />
      {mutationError ? (
        <div className="notice" data-tone="error">
          <span className="notice__message">{mutationError}</span>
        </div>
      ) : null}
      {tasks.map((task) => {
        const hasDetails = Boolean(task.body || task.notes);
        const isExpanded = expanded.has(task.id);
        const detailsId = `task-details-${task.id}`;
        const activeTab = activeTabFor(task);
        const editing = editingTaskId === task.id;
        const canEdit = capabilities.canEditPending && task.status === "pending";
        const canDelete = capabilities.canDeletePending && task.status === "pending";
        const replaceNotesDraft = taskNotesDraft(task);
        const appendNotesDraft = appendDraft(task.id);

        return (
          <article className="task" key={task.id}>
            <div className="task-row">
              <button
                aria-controls={hasDetails ? detailsId : undefined}
                aria-expanded={hasDetails ? isExpanded : undefined}
                className="task-header"
                disabled={!hasDetails}
                onClick={() => toggle(task.id)}
                type="button"
              >
                <span className={taskStatusClass(task.status)} aria-label={task.status}>
                  {taskStatusIcon(task.status)}
                </span>
                <span className="task-title">
                  {task.title}
                  <span className="task-id">#{task.id}</span>
                </span>
                {hasDetails ? (
                  <ChevronIcon
                    aria-hidden="true"
                    className={isExpanded ? "task-chevron expanded" : "task-chevron"}
                  />
                ) : (
                  <span className="task-chevron-spacer" aria-hidden="true" />
                )}
                <span className={taskStatusBadgeClass(task.status)}>
                  {taskStatusLabel(task.status)}
                </span>
              </button>
              <div className="task-row__actions">
                <label className="sr-only" htmlFor={`task-status-${task.id}`}>
                  Task status for {task.title}
                </label>
                <select
                  className="task-status-select"
                  disabled={!capabilities.canSetStatus || mutationPending}
                  id={`task-status-${task.id}`}
                  onChange={(event) =>
                    updateTaskMutation.mutate({
                      taskId: task.id,
                      update: { status: event.target.value as TaskStatus },
                    })
                  }
                  value={task.status}
                >
                  <option value="pending">Pending</option>
                  <option value="in_progress">In progress</option>
                  <option value="completed">Completed</option>
                  <option value="blocked">Blocked</option>
                </select>
                {canEdit ? (
                  <button
                    aria-label={`Edit ${task.title}`}
                    className="icon-btn icon-btn--small"
                    disabled={mutationPending}
                    onClick={() => startEdit(task)}
                    title="Edit task"
                    type="button"
                  >
                    <PencilIcon aria-hidden="true" />
                  </button>
                ) : null}
                {canDelete ? (
                  <button
                    aria-label={`Delete ${task.title}`}
                    className="icon-btn icon-btn--small icon-btn--destructive"
                    disabled={mutationPending}
                    onClick={() => deleteTaskMutation.mutate(task.id)}
                    title="Delete task"
                    type="button"
                  >
                    <TrashIcon aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </div>
            {editing ? (
              <div className="task-edit">
                <label className="field">
                  <span>Title</span>
                  <input
                    disabled={mutationPending}
                    onChange={(event) => setEditDraft({ ...editDraft, title: event.target.value })}
                    onKeyDown={handleTaskEditKeyDown}
                    value={editDraft.title}
                  />
                </label>
                <label className="field">
                  <span>Body</span>
                  <textarea
                    disabled={mutationPending}
                    onChange={(event) => setEditDraft({ ...editDraft, body: event.target.value })}
                    onKeyDown={handleTaskEditKeyDown}
                    rows={5}
                    value={editDraft.body}
                  />
                </label>
                <div className="task-edit__actions">
                  <button
                    className="btn"
                    disabled={mutationPending}
                    onClick={cancelEdit}
                    type="button"
                  >
                    Cancel
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={mutationPending || editDraft.title.trim().length === 0}
                    onClick={() =>
                      updateTaskMutation.mutate({
                        taskId: task.id,
                        update: { body: editDraft.body, title: editDraft.title.trim() },
                      })
                    }
                    type="button"
                  >
                    Save task
                  </button>
                </div>
              </div>
            ) : null}
            {isExpanded && hasDetails ? (
              <div className="task-details" id={detailsId}>
                <nav aria-label="Task content sections" className="task-tabs">
                  <button
                    aria-selected={activeTab === "body"}
                    className={activeTab === "body" ? "task-tab active" : "task-tab"}
                    onClick={() => selectTab(task.id, "body")}
                    type="button"
                  >
                    Instructions
                  </button>
                  <button
                    aria-label="Task notes"
                    aria-selected={activeTab === "notes"}
                    className={activeTab === "notes" ? "task-tab active" : "task-tab"}
                    onClick={() => selectTab(task.id, "notes")}
                    type="button"
                  >
                    Notes
                  </button>
                </nav>
                {activeTab === "body" ? (
                  task.body ? (
                    <MarkdownContent className="task-markdown" text={task.body} />
                  ) : (
                    <p className="task-empty">No instructions recorded.</p>
                  )
                ) : task.notes ? (
                  <MarkdownContent className="task-markdown" text={task.notes} />
                ) : (
                  <p className="task-empty">No notes recorded yet.</p>
                )}
                {activeTab === "notes" ? (
                  <div className="task-notes-editor">
                    <label className="field">
                      <span>Replace notes</span>
                      <textarea
                        disabled={!capabilities.canEditNotes || mutationPending}
                        onChange={(event) => setTaskNotesDraft(task.id, event.target.value)}
                        rows={3}
                        value={replaceNotesDraft}
                        placeholder="Replace task notes"
                      />
                    </label>
                    <div className="task-edit__actions">
                      <button
                        className="btn"
                        disabled={!capabilities.canEditNotes || mutationPending}
                        onClick={() =>
                          updateTaskMutation.mutate({
                            taskId: task.id,
                            update: { notes: replaceNotesDraft },
                          })
                        }
                        type="button"
                      >
                        Replace notes
                      </button>
                    </div>
                    <label className="field">
                      <span>Append notes</span>
                      <textarea
                        disabled={!capabilities.canEditNotes || mutationPending}
                        onChange={(event) => setAppendDraft(task.id, event.target.value)}
                        rows={2}
                        value={appendNotesDraft}
                      />
                    </label>
                    <div className="task-edit__actions">
                      <button
                        className="btn"
                        disabled={
                          !capabilities.canEditNotes ||
                          mutationPending ||
                          appendNotesDraft.trim().length === 0
                        }
                        onClick={() =>
                          appendNotesMutation.mutate({
                            taskId: task.id,
                            text: appendNotesDraft,
                          })
                        }
                        type="button"
                      >
                        Append notes
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </article>
        );
      })}
      {dialogOpen ? renderCreateDialog() : null}
    </div>
  );
}

function TaskToolbar({
  canAdd,
  onAdd,
  pending,
}: {
  canAdd: boolean;
  onAdd: () => void;
  pending: boolean;
}) {
  return (
    <div className="task-management-toolbar">
      <button
        className="btn btn-primary"
        disabled={!canAdd || pending}
        onClick={onAdd}
        type="button"
      >
        Add task
      </button>
    </div>
  );
}

function taskStatusLabel(status: RunTaskSummary["status"]) {
  switch (status) {
    case "pending":
      return "pending";
    case "in_progress":
      return "in progress";
    case "completed":
      return "completed";
    case "blocked":
      return "blocked";
  }
}

function taskStatusBadgeClass(status: RunTaskSummary["status"]) {
  switch (status) {
    case "pending":
      return "badge badge-pending";
    case "in_progress":
      return "badge badge-running";
    case "completed":
      return "badge badge-completed";
    case "blocked":
      return "badge badge-blocked";
  }
}
