import type { RunTaskSummary } from "@task-runner/core/contracts/runs.js";
import { useState } from "react";
import { AlertIcon, CheckIcon, ChevronIcon, PendingIcon, RunningIcon } from "./icons.js";
import { MarkdownContent } from "./markdown.js";
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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

  return (
    <div className="tasks">
      {tasks.map((task) => {
        const hasDetails = Boolean(task.body || task.notes);
        const isExpanded = expanded.has(task.id);
        const detailsId = `task-details-${task.id}`;

        return (
          <article className="task" key={task.id}>
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
              <StatusBadge status={taskStatusToRunStatus(task.status)} />
            </button>
            {isExpanded && hasDetails ? (
              <div className="task-details" id={detailsId}>
                {task.body ? (
                  <section className="task-section">
                    <h4 className="task-section-label">Description</h4>
                    <MarkdownContent className="task-meta" text={task.body} />
                  </section>
                ) : null}
                {task.notes ? (
                  <section className="task-section task-section--notes">
                    <h4 className="task-section-label">Notes</h4>
                    <MarkdownContent className="task-notes" text={task.notes} />
                  </section>
                ) : null}
              </div>
            ) : null}
          </article>
        );
      })}
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
