import type { RunStatus, RunSummary } from "@task-runner/core/contracts/runs.js";
import { ColumnMoreIcon } from "./icons.js";
import { RunCard } from "./run-card.js";

export interface BoardColumn {
  key: string;
  title: string;
  statuses: RunStatus[];
  subLabel?: string;
  runs: RunSummary[];
}

export function RunColumn({
  column,
  selectedRunId,
  selectedRunActiveTask,
  onSelectRun,
}: {
  column: BoardColumn;
  selectedRunId?: string;
  selectedRunActiveTask?: string;
  onSelectRun: (runId: string) => void;
}) {
  return (
    <article className="column" data-status={column.key} aria-labelledby={`col-${column.key}`}>
      <header className="col-head">
        <h2 id={`col-${column.key}`}>{column.title}</h2>
        <span className="count">{column.runs.length}</span>
        <span className="col-spacer" />
        <button className="col-action" title={`${column.title} column`} type="button">
          <ColumnMoreIcon aria-hidden="true" />
        </button>
        {column.subLabel ? <span className="col-sub">{column.subLabel}</span> : null}
      </header>
      <div className="col-body">
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
