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
  CloseIcon,
  PencilIcon,
  PendingIcon,
  RunningIcon,
  TrashIcon,
} from "./icons.js";
import { MarkdownContent } from "./markdown.js";
import { useNativeModalDialog } from "./native-dialog.js";

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
  const [editMode, setEditMode] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editDrafts, setEditDrafts] = useState<Map<string, TaskEditDraft>>(new Map());
  const [notesDrafts, setNotesDrafts] = useState<Map<string, string>>(new Map());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogTask, setDeleteDialogTask] = useState<RunTaskSummary | null>(null);
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
      setEditDrafts((current) => {
        const next = new Map(current);
        next.delete(variables.taskId);
        return next;
      });
      if (variables.update.notes !== undefined) {
        setNotesDrafts((current) => {
          const next = new Map(current);
          next.delete(variables.taskId);
          return next;
        });
      }
      if (
        variables.update.body !== undefined ||
        variables.update.title !== undefined ||
        variables.update.notes !== undefined
      ) {
        setEditingTaskId(null);
      }
      await invalidateTaskRun(runId);
    },
  });
  const deleteTaskMutation = useMutation({
    mutationFn: (taskId: string) => api.deleteTask(runId, taskId),
    onError: (error: Error) => setMutationError(error.message),
    onSuccess: async () => {
      setDeleteDialogTask(null);
      setMutationError(null);
      await invalidateTaskRun(runId);
    },
  });

  const mutationPending =
    createTaskMutation.isPending || updateTaskMutation.isPending || deleteTaskMutation.isPending;
  const canEditTasks =
    capabilities.canSetStatus ||
    capabilities.canEditNotes ||
    capabilities.canEditPending ||
    capabilities.canDeletePending;

  if (tasks.length === 0) {
    return (
      <>
        <TaskToolbar
          canAdd={capabilities.canAdd}
          canEdit={canEditTasks}
          editMode={editMode}
          onAdd={() => setDialogOpen(true)}
          onToggleEdit={() => toggleEditMode()}
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

  function toggleEditMode() {
    setEditMode((current) => {
      if (current) {
        setEditDrafts(new Map());
        setNotesDrafts(new Map());
        setEditingTaskId(null);
        setMutationError(null);
      }
      return !current;
    });
  }

  function taskEditDraft(task: RunTaskSummary) {
    return editDrafts.get(task.id) ?? { body: task.body, title: task.title };
  }

  function setTaskEditDraft(taskId: string, value: TaskEditDraft) {
    setEditDrafts((current) => {
      const next = new Map(current);
      next.set(taskId, value);
      return next;
    });
  }

  function resetTaskEditDraft(taskId: string) {
    setEditDrafts((current) => {
      const next = new Map(current);
      next.delete(taskId);
      return next;
    });
    setEditingTaskId(null);
    setMutationError(null);
  }

  function taskNotesDraft(task: RunTaskSummary) {
    return notesDrafts.get(task.id) ?? task.notes;
  }

  function setTaskNotesDraft(taskId: string, value: string) {
    setNotesDrafts((current) => {
      const next = new Map(current);
      next.set(taskId, value);
      return next;
    });
  }

  function resetTaskNotesDraft(taskId: string) {
    setNotesDrafts((current) => {
      const next = new Map(current);
      next.delete(taskId);
      return next;
    });
    setEditingTaskId(null);
    setMutationError(null);
  }

  function handleTaskEditKeyDown(
    event: ReactKeyboardEvent<HTMLTextAreaElement | HTMLInputElement>,
    taskId: string,
  ) {
    if (event.key === "Escape") {
      event.preventDefault();
      resetTaskEditDraft(taskId);
      resetTaskNotesDraft(taskId);
      setMutationError(null);
    }
  }

  function startTaskEdit(task: RunTaskSummary, tab: TaskTab) {
    setExpanded((current) => {
      if (current.has(task.id)) {
        return current;
      }
      const next = new Set(current);
      next.add(task.id);
      return next;
    });
    selectTab(task.id, tab);
    setEditingTaskId(task.id);
    setMutationError(null);
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
        canEdit={canEditTasks}
        editMode={editMode}
        onAdd={() => setDialogOpen(true)}
        onToggleEdit={() => toggleEditMode()}
        pending={mutationPending}
      />
      {mutationError ? (
        <div className="notice" data-tone="error">
          <span className="notice__message">{mutationError}</span>
        </div>
      ) : null}
      {tasks.map((task) => {
        const canEdit = capabilities.canEditPending && task.status === "pending";
        const canDelete = capabilities.canDeletePending && task.status === "pending";
        const canEditContent = canEdit || capabilities.canEditNotes;
        const hasDetails = Boolean(task.body || task.notes || editMode || canEditContent);
        const isExpanded = expanded.has(task.id);
        const detailsId = `task-details-${task.id}`;
        const activeTab = activeTabFor(task);
        const editDraft = taskEditDraft(task);
        const replaceNotesDraft = taskNotesDraft(task);
        const isEditingTask = editingTaskId === task.id;
        const bodyEditing = isEditingTask && canEdit && activeTab === "body";
        const notesEditing = isEditingTask && capabilities.canEditNotes && activeTab === "notes";

        return (
          <article className={isEditingTask ? "task task--editing" : "task"} key={task.id}>
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
                {editMode && capabilities.canSetStatus ? null : (
                  <span className={taskStatusBadgeClass(task.status)}>
                    {taskStatusLabel(task.status)}
                  </span>
                )}
              </button>
              <div className="task-row__actions">
                {editMode && capabilities.canSetStatus ? (
                  <>
                    <label className="sr-only" htmlFor={`task-status-${task.id}`}>
                      Task status for {task.title}
                    </label>
                    <select
                      className="task-status-select"
                      disabled={mutationPending}
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
                  </>
                ) : null}
                {editMode && canDelete ? (
                  <button
                    aria-label={`Delete ${task.title}`}
                    className="icon-btn icon-btn--small icon-btn--destructive"
                    disabled={mutationPending}
                    onClick={() => setDeleteDialogTask(task)}
                    title="Delete task"
                    type="button"
                  >
                    <TrashIcon aria-hidden="true" />
                  </button>
                ) : null}
                {editMode && canEditContent && !isEditingTask ? (
                  <button
                    aria-label={`Edit ${task.title}`}
                    className="icon-btn icon-btn--small"
                    disabled={mutationPending}
                    onClick={() => startTaskEdit(task, canEdit ? "body" : "notes")}
                    title="Edit task"
                    type="button"
                  >
                    <PencilIcon aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </div>
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
                  bodyEditing ? (
                    <div className="task-edit">
                      <label className="field task-edit__title-field">
                        <span className="sr-only">Title</span>
                        <input
                          aria-label="Title"
                          disabled={mutationPending}
                          onChange={(event) =>
                            setTaskEditDraft(task.id, { ...editDraft, title: event.target.value })
                          }
                          onKeyDown={(event) => handleTaskEditKeyDown(event, task.id)}
                          value={editDraft.title}
                        />
                      </label>
                      <label className="field task-edit__body-field">
                        <span className="sr-only">Body</span>
                        <textarea
                          aria-label="Body"
                          disabled={mutationPending}
                          onChange={(event) =>
                            setTaskEditDraft(task.id, { ...editDraft, body: event.target.value })
                          }
                          onKeyDown={(event) => handleTaskEditKeyDown(event, task.id)}
                          rows={10}
                          value={editDraft.body}
                        />
                      </label>
                      <div className="task-edit__actions">
                        <button
                          className="btn"
                          disabled={mutationPending}
                          onClick={() => resetTaskEditDraft(task.id)}
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
                          Save
                        </button>
                      </div>
                    </div>
                  ) : task.body ? (
                    <MarkdownContent className="task-markdown" text={task.body} />
                  ) : (
                    <p className="task-empty">No instructions recorded.</p>
                  )
                ) : notesEditing ? (
                  <div className="task-notes-editor">
                    <label className="field task-edit__notes-field">
                      <span className="sr-only">Notes</span>
                      <textarea
                        disabled={mutationPending}
                        onKeyDown={(event) => handleTaskEditKeyDown(event, task.id)}
                        onChange={(event) => setTaskNotesDraft(task.id, event.target.value)}
                        rows={10}
                        value={replaceNotesDraft}
                      />
                    </label>
                    <div className="task-edit__actions">
                      <button
                        className="btn"
                        disabled={mutationPending}
                        onClick={() => resetTaskNotesDraft(task.id)}
                        type="button"
                      >
                        Cancel
                      </button>
                      <button
                        className="btn btn-primary"
                        disabled={mutationPending}
                        onClick={() =>
                          updateTaskMutation.mutate({
                            taskId: task.id,
                            update: { notes: replaceNotesDraft },
                          })
                        }
                        type="button"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                ) : task.notes ? (
                  <MarkdownContent className="task-markdown" text={task.notes} />
                ) : (
                  <p className="task-empty">No notes recorded yet.</p>
                )}
              </div>
            ) : null}
          </article>
        );
      })}
      {dialogOpen ? renderCreateDialog() : null}
      {deleteDialogTask ? (
        <DeleteTaskDialog
          error={deleteTaskMutation.error?.message}
          onClose={() => setDeleteDialogTask(null)}
          onConfirm={async () => {
            await deleteTaskMutation.mutateAsync(deleteDialogTask.id);
          }}
          pending={deleteTaskMutation.isPending}
          task={deleteDialogTask}
        />
      ) : null}
    </div>
  );
}

function DeleteTaskDialog({
  error,
  onClose,
  onConfirm,
  pending,
  task,
}: {
  error?: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  pending: boolean;
  task: RunTaskSummary;
}) {
  const { dialogProps, ref: dialogRef } = useNativeModalDialog(true, onClose);
  async function handleConfirm() {
    try {
      await onConfirm();
    } catch {
      // The mutation error is already surfaced through the dialog error prop.
    }
  }

  return (
    <dialog
      aria-labelledby="delete-task-dialog-title"
      className="resume-dialog-backdrop"
      {...dialogProps}
      ref={dialogRef}
    >
      <div className="resume-dialog delete-task-dialog">
        <div className="resume-dialog__header">
          <h3 className="resume-dialog__title" id="delete-task-dialog-title">
            Delete task?
          </h3>
          <p className="resume-dialog__copy">
            Delete <strong>{task.title}</strong>. This removes the task from the run.
          </p>
        </div>
        {error ? (
          <div className="notice" data-tone="error">
            <span className="notice__message">{error}</span>
          </div>
        ) : null}
        <div className="resume-dialog__actions">
          <button className="btn" disabled={pending} onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="btn btn-destructive-outline"
            disabled={pending}
            onClick={() => void handleConfirm()}
            type="button"
          >
            {pending ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>
    </dialog>
  );
}

function TaskToolbar({
  canAdd,
  canEdit,
  editMode,
  onAdd,
  onToggleEdit,
  pending,
}: {
  canAdd: boolean;
  canEdit: boolean;
  editMode: boolean;
  onAdd: () => void;
  onToggleEdit: () => void;
  pending: boolean;
}) {
  return (
    <div className="task-management-toolbar">
      <button
        aria-label={editMode ? "Exit task edit mode" : "Edit tasks"}
        aria-pressed={editMode}
        className={editMode ? "icon-btn active" : "icon-btn"}
        disabled={!canEdit || pending}
        onClick={onToggleEdit}
        title={editMode ? "Exit task edit mode" : "Edit tasks"}
        type="button"
      >
        {editMode ? <CloseIcon aria-hidden="true" /> : <PencilIcon aria-hidden="true" />}
      </button>
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
