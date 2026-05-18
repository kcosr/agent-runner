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
  const [editDrafts, setEditDrafts] = useState<Map<string, TaskEditDraft>>(new Map());
  const [notesDrafts, setNotesDrafts] = useState<Map<string, string>>(new Map());
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
    setMutationError(null);
  }

  function handleTaskEditKeyDown(
    event: ReactKeyboardEvent<HTMLTextAreaElement | HTMLInputElement>,
  ) {
    if (event.key === "Escape") {
      event.preventDefault();
      setEditDrafts(new Map());
      setNotesDrafts(new Map());
      setMutationError(null);
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
        const hasDetails = Boolean(task.body || task.notes || editMode);
        const isExpanded = expanded.has(task.id);
        const detailsId = `task-details-${task.id}`;
        const activeTab = activeTabFor(task);
        const canEdit = capabilities.canEditPending && task.status === "pending";
        const canDelete = capabilities.canDeletePending && task.status === "pending";
        const editDraft = taskEditDraft(task);
        const replaceNotesDraft = taskNotesDraft(task);
        const bodyEditing = editMode && canEdit && activeTab === "body";
        const notesEditing = editMode && capabilities.canEditNotes && activeTab === "notes";

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
                    onClick={() => deleteTaskMutation.mutate(task.id)}
                    title="Delete task"
                    type="button"
                  >
                    <TrashIcon aria-hidden="true" />
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
                      <label className="field">
                        <span>Title</span>
                        <input
                          aria-label="Title"
                          disabled={mutationPending}
                          onChange={(event) =>
                            setTaskEditDraft(task.id, { ...editDraft, title: event.target.value })
                          }
                          onKeyDown={handleTaskEditKeyDown}
                          value={editDraft.title}
                        />
                      </label>
                      <label className="field">
                        <span>Body</span>
                        <textarea
                          aria-label="Body"
                          disabled={mutationPending}
                          onChange={(event) =>
                            setTaskEditDraft(task.id, { ...editDraft, body: event.target.value })
                          }
                          onKeyDown={handleTaskEditKeyDown}
                          rows={5}
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
                    <label className="field">
                      <span>Notes</span>
                      <textarea
                        disabled={mutationPending}
                        onKeyDown={handleTaskEditKeyDown}
                        onChange={(event) => setTaskNotesDraft(task.id, event.target.value)}
                        rows={6}
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
    </div>
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
