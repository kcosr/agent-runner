import type { UseQueryResult } from "@tanstack/react-query";
import type { RunSummary } from "@task-runner/core/contracts/runs.js";
import { EmptyPanel } from "../components/empty-states.js";
import { type BoardColumn, RunColumn } from "../components/run-column.js";

export function RunsBoardPanel({
  boardColumns,
  onResetFilters,
  onSelectRun,
  runs,
  runsQuery,
  selectedRunActiveTask,
  selectedRunId,
  visibleRuns,
}: {
  boardColumns: BoardColumn[];
  onResetFilters: () => void;
  onSelectRun: (runId: string) => void;
  runs: RunSummary[];
  runsQuery: UseQueryResult<RunSummary[], Error>;
  selectedRunActiveTask?: string;
  selectedRunId?: string;
  visibleRuns: RunSummary[];
}) {
  if (runsQuery.isPending) {
    return (
      <section aria-label="Run board" className="board">
        {["running", "completed", "failures"].map((key) => (
          <article className="column column-skeleton" data-status={key} key={key}>
            <header className="col-head">
              <div className="skeleton-line skeleton-line--short" />
            </header>
            <div className="col-body">
              {[0, 1, 2].map((index) => (
                <div className="card" key={index}>
                  <div className="skeleton-line skeleton-line--short" />
                  <div
                    className="skeleton-line skeleton-line--medium"
                    style={{ marginTop: "12px" }}
                  />
                  <div
                    className="skeleton-line skeleton-line--medium"
                    style={{ marginTop: "12px" }}
                  />
                </div>
              ))}
            </div>
          </article>
        ))}
      </section>
    );
  }

  if (runsQuery.isError) {
    return (
      <section className="board board-error">
        <EmptyPanel
          action={
            <button className="btn" onClick={() => void runsQuery.refetch()} type="button">
              Retry board load
            </button>
          }
          body={runsQuery.error.message}
          title="Run board failed to load"
        />
      </section>
    );
  }

  if (visibleRuns.length === 0) {
    return (
      <section className="board card-empty">
        <EmptyPanel
          action={
            runs.length > 0 ? (
              <button className="btn" onClick={onResetFilters} type="button">
                Reset filters
              </button>
            ) : undefined
          }
          body={
            runs.length === 0
              ? "No runs are available yet. Start or initialize a run, then refresh this board."
              : "Current filters are hiding all runs. Reset them to bring runs back into view."
          }
          title={runs.length === 0 ? "No runs yet" : "Filters hide every run"}
        />
      </section>
    );
  }

  return (
    <section aria-label="Run board" className="board">
      {boardColumns.map((column) => (
        <RunColumn
          column={column}
          key={column.key}
          onSelectRun={onSelectRun}
          selectedRunActiveTask={selectedRunActiveTask}
          selectedRunId={selectedRunId}
        />
      ))}
    </section>
  );
}
