import type { UseQueryResult } from "@tanstack/react-query";
import type { RunSummary } from "@task-runner/core/contracts/runs.js";
import { useEffect, useMemo, useRef, useState } from "react";
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
  const boardRef = useRef<HTMLElement | null>(null);
  const columnRefs = useRef(new Map<string, HTMLElement>());
  const [showColumnJumpBar, setShowColumnJumpBar] = useState(false);
  const jumpColumns = useMemo(
    () => boardColumns.filter((column) => column.runs.length > 0),
    [boardColumns],
  );

  useEffect(() => {
    const board = boardRef.current;
    if (!board) {
      setShowColumnJumpBar(false);
      return;
    }
    const boardElement = board;

    function recomputeJumpBarVisibility() {
      if (jumpColumns.length === 0) {
        setShowColumnJumpBar(false);
        return;
      }

      const viewportLeft = boardElement.scrollLeft;
      const viewportRight = viewportLeft + boardElement.clientWidth;
      const allVisible = jumpColumns.every((column) => {
        const element = columnRefs.current.get(column.key);
        if (!element) {
          return true;
        }
        const left = element.offsetLeft;
        const right = left + element.offsetWidth;
        return left >= viewportLeft && right <= viewportRight;
      });

      setShowColumnJumpBar(!allVisible);
    }

    const frameId = window.requestAnimationFrame(recomputeJumpBarVisibility);
    boardElement.addEventListener("scroll", recomputeJumpBarVisibility, { passive: true });
    window.addEventListener("resize", recomputeJumpBarVisibility);

    return () => {
      window.cancelAnimationFrame(frameId);
      boardElement.removeEventListener("scroll", recomputeJumpBarVisibility);
      window.removeEventListener("resize", recomputeJumpBarVisibility);
    };
  }, [jumpColumns]);

  function setColumnRef(columnKey: string) {
    return (node: HTMLElement | null) => {
      if (node) {
        columnRefs.current.set(columnKey, node);
      } else {
        columnRefs.current.delete(columnKey);
      }
    };
  }

  function scrollColumnIntoView(columnKey: string) {
    const board = boardRef.current;
    const column = columnRefs.current.get(columnKey);
    if (!board || !column) {
      return;
    }

    const maxScrollLeft = Math.max(0, board.scrollWidth - board.clientWidth);
    const centeredLeft = column.offsetLeft - (board.clientWidth - column.offsetWidth) / 2;
    const targetLeft = Math.min(maxScrollLeft, Math.max(0, centeredLeft));

    if (typeof board.scrollTo === "function") {
      board.scrollTo({ behavior: "smooth", left: targetLeft });
      return;
    }

    board.scrollLeft = targetLeft;
  }

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
    <div className="board-region">
      {showColumnJumpBar ? (
        <div aria-label="Board columns" className="board-jumpbar" role="toolbar">
          {jumpColumns.map((column) => (
            <button
              className="board-jumpbar__button"
              key={column.key}
              onClick={() => scrollColumnIntoView(column.key)}
              type="button"
            >
              {column.title} ({column.runs.length})
            </button>
          ))}
        </div>
      ) : null}
      <section aria-label="Run board" className="board" ref={boardRef}>
        {boardColumns.map((column) => (
          <RunColumn
            column={column}
            columnRef={setColumnRef(column.key)}
            key={column.key}
            onSelectRun={onSelectRun}
            selectedRunActiveTask={selectedRunActiveTask}
            selectedRunId={selectedRunId}
          />
        ))}
      </section>
    </div>
  );
}
