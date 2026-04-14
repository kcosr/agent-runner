import type { RunStatus, RunSummary } from "@task-runner/core/contracts/runs.js";
import { ChevronIcon } from "./icons.js";
import { RunCard } from "./run-card.js";

export interface BoardColumn {
  key: string;
  title: string;
  statuses: RunStatus[];
  subLabel?: string;
  runs: RunSummary[];
}

export function RunColumn({
  collapsed,
  column,
  columnRef,
  selectedRunId,
  selectedRunActiveTask,
  onToggleCollapse,
  onSelectRun,
}: {
  collapsed: boolean;
  column: BoardColumn;
  columnRef?: (node: HTMLElement | null) => void;
  selectedRunId?: string;
  selectedRunActiveTask?: string;
  onToggleCollapse: () => void;
  onSelectRun: (runId: string) => void;
}) {
  const bodyId = `col-body-${column.key}`;
  const collapseLabel = `Collapse ${column.title} column`;
  const expandLabel = `Expand ${column.title} column`;

  return (
    <article
      aria-labelledby={`col-${column.key}`}
      className="column"
      data-collapsed={collapsed ? "true" : "false"}
      data-status={column.key}
      ref={columnRef}
    >
      <header className="col-head">
        <button
          aria-controls={bodyId}
          aria-expanded={!collapsed}
          aria-label={expandLabel}
          className="col-expand nav-item"
          onClick={onToggleCollapse}
          title={expandLabel}
          type="button"
        >
          <ChevronIcon aria-hidden="true" className="col-expand__icon" />
        </button>
        <h2 id={`col-${column.key}`}>{column.title}</h2>
        <span className="count">{column.runs.length}</span>
        <span className="col-spacer" />
        <button
          aria-controls={bodyId}
          aria-expanded={!collapsed}
          aria-label={collapseLabel}
          className="col-action icon-btn"
          onClick={onToggleCollapse}
          title={collapseLabel}
          type="button"
        >
          <ChevronIcon aria-hidden="true" className="col-action__icon" />
        </button>
        {column.subLabel ? <span className="col-sub">{column.subLabel}</span> : null}
      </header>
      <div className="col-body" id={bodyId}>
        {column.runs.map((run) => (
          <RunCard
            activeTaskLabel={run.runId === selectedRunId ? selectedRunActiveTask : undefined}
            key={run.runId}
            onSelect={() => onSelectRun(run.runId)}
            run={run}
            selected={run.runId === selectedRunId}
          />
        ))}
      </div>
    </article>
  );
}
