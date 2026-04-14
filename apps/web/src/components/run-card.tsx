import type { RunSummary } from "@task-runner/core/contracts/runs.js";
import { truncateEnd } from "../lib/format.js";
import { AttachmentIcon, DependencyIcon, RunningIcon } from "./icons.js";
import { StatusBadge } from "./status-badge.js";

export function RunCard({
  run,
  selected,
  activeTaskLabel,
  onSelect,
}: {
  run: RunSummary;
  selected: boolean;
  activeTaskLabel?: string;
  onSelect: () => void;
}) {
  const progress =
    run.tasksTotal === 0 ? 0 : Math.round((run.tasksCompleted / run.tasksTotal) * 100);
  const visibleName = truncateEnd(run.name ?? "Unnamed");
  const showDependencyIndicator = run.dependencyState.total > 0;
  const dependencyIndicatorClass =
    run.dependencyState.unsatisfied > 0
      ? "meta-indicator meta-indicator--warning"
      : "meta-indicator meta-indicator--success";
  const showAttachmentIndicator = run.attachmentCount > 0;

  return (
    <button
      aria-pressed={selected}
      className={selected ? "card selected" : "card"}
      onClick={onSelect}
      title={run.name ?? "Unnamed"}
      type="button"
    >
      <div className="card-row">
        <span className="run-id">{run.runId}</span>
        <span className="card-row-spacer" />
        <StatusBadge status={run.effectiveStatus} />
      </div>
      <div className="card-row card-row--title">
        <span className="card-title">{visibleName}</span>
      </div>
      <div className="card-row card-row--subtitle">
        <span className="card-subtitle">{run.assignmentName ?? "Ad hoc run"}</span>
      </div>
      <div className="card-row card-meta">
        <span className="repo-badge">{run.repo}</span>
        <span className="meta-item">{run.agentName}</span>
        <span className="backend-badge">{run.backend}</span>
        {showDependencyIndicator ? (
          <span
            aria-label={`${run.dependencyState.satisfied} of ${run.dependencyState.total} dependencies satisfied`}
            className={dependencyIndicatorClass}
            title={`${run.dependencyState.satisfied}/${run.dependencyState.total} dependency run(s) satisfied`}
          >
            <DependencyIcon aria-hidden="true" />
            {run.dependencyState.satisfied}/{run.dependencyState.total}
          </span>
        ) : null}
        {showAttachmentIndicator ? (
          <span
            aria-label={`${run.attachmentCount} attachment${run.attachmentCount === 1 ? "" : "s"}`}
            className="meta-indicator meta-indicator--neutral"
            title={`${run.attachmentCount} attachment${run.attachmentCount === 1 ? "" : "s"}`}
          >
            <AttachmentIcon aria-hidden="true" />
          </span>
        ) : null}
      </div>
      <div className="card-row">
        <div className="progress" aria-label="task progress">
          <div className="progress-bar" style={{ width: `${progress}%` }} />
        </div>
        <span className="progress-text">
          {run.tasksCompleted} / {run.tasksTotal}
        </span>
      </div>
      {activeTaskLabel ? (
        <div className="card-row">
          <span className="active-task">
            <RunningIcon aria-hidden="true" />
            {activeTaskLabel}
          </span>
        </div>
      ) : null}
    </button>
  );
}
