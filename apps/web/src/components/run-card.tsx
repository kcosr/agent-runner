import type { RunSummary } from "@task-runner/core/contracts/runs.js";
import { truncateEnd } from "../lib/format.js";
import { DependencyIcon, RunningIcon } from "./icons.js";
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
  const showDependencyIndicator =
    run.status === "initialized" && run.dependencyState.unsatisfied > 0;

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
            aria-label={`${run.dependencyState.unsatisfied} unmet dependencies`}
            className="dependency-indicator"
            title={`${run.dependencyState.unsatisfied} dependency run(s) not yet successful`}
          >
            <DependencyIcon aria-hidden="true" />
            {run.dependencyState.unsatisfied}
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
