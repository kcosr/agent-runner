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

type TaskTab = "body" | "notes";

export function RunTaskList({ tasks }: { tasks: RunTaskSummary[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activeTabs, setActiveTabs] = useState<Map<string, TaskTab>>(new Map());

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
    if (choice === "body" && task.body) {
      return "body";
    }
    if (choice === "notes" && task.notes) {
      return "notes";
    }
    return task.body ? "body" : "notes";
  }

  return (
    <div className="tasks">
      {tasks.map((task) => {
        const hasDetails = Boolean(task.body || task.notes);
        const isExpanded = expanded.has(task.id);
        const detailsId = `task-details-${task.id}`;
        const activeTab = activeTabFor(task);

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
                {task.body && task.notes ? (
                  <nav aria-label="Task content sections" className="task-tabs">
                    <button
                      aria-selected={activeTab === "body"}
                      className={activeTab === "body" ? "task-tab active" : "task-tab"}
                      onClick={() => selectTab(task.id, "body")}
                      type="button"
                    >
                      Description
                    </button>
                    <button
                      aria-selected={activeTab === "notes"}
                      className={activeTab === "notes" ? "task-tab active" : "task-tab"}
                      onClick={() => selectTab(task.id, "notes")}
                      type="button"
                    >
                      Notes
                    </button>
                  </nav>
                ) : null}
                <MarkdownContent
                  className="task-markdown"
                  text={activeTab === "body" ? task.body : task.notes}
                />
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
