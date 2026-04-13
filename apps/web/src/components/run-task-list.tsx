import type { RunTaskSummary } from "@task-runner/core/contracts/runs.js";
import { AlertIcon, CheckIcon, PendingIcon, RunningIcon } from "./icons.js";
import { StatusBadge } from "./status-badge.js";

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

export function RunTaskList({ tasks }: { tasks: RunTaskSummary[] }) {
  return (
    <div className="tasks">
      {tasks.map((task) => (
        <article className="task" key={task.id}>
          <span className={taskStatusClass(task.status)} aria-label={task.status}>
            {taskStatusIcon(task.status)}
          </span>
          <div className="task-body">
            <div className="task-title">
              {task.title}
              <span className="task-id">#{task.id}</span>
            </div>
            {task.body ? <div className="task-meta">{task.body}</div> : null}
            {task.notes ? <div className="task-notes">{task.notes}</div> : null}
          </div>
          <div className="task-side">
            <StatusBadge status={taskStatusToRunStatus(task.status)} />
          </div>
        </article>
      ))}
    </div>
  );
}

function taskStatusToRunStatus(status: RunTaskSummary["status"]) {
  switch (status) {
    case "pending":
      return "initialized";
    case "in_progress":
      return "running";
    case "completed":
      return "success";
    case "blocked":
      return "blocked";
  }
}
