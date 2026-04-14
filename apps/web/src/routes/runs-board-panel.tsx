import type { UseQueryResult } from "@tanstack/react-query";
import type { RunSummary } from "@task-runner/core/contracts/runs.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EmptyPanel } from "../components/empty-states.js";
import { type BoardColumn, RunColumn } from "../components/run-column.js";

export function RunsBoardPanel({
  boardColumns,
  collapsedColumnKeys,
  onExpandColumn,
  onResetFilters,
  onSelectRun,
  onToggleColumnCollapse,
  runs,
  runsQuery,
  selectedRunActiveTask,
  selectedRunId,
  visibleRuns,
}: {
  boardColumns: BoardColumn[];
  collapsedColumnKeys: string[];
  onExpandColumn: (columnKey: string) => void;
  onResetFilters: () => void;
  onSelectRun: (runId: string) => void;
  onToggleColumnCollapse: (columnKey: string) => void;
  runs: RunSummary[];
  runsQuery: UseQueryResult<RunSummary[], Error>;
  selectedRunActiveTask?: string;
  selectedRunId?: string;
  visibleRuns: RunSummary[];
}) {
  const boardRef = useRef<HTMLElement | null>(null);
  const columnRefs = useRef(new Map<string, HTMLElement>());
  const columnRefCallbacks = useRef(new Map<string, (node: HTMLElement | null) => void>());
  const pendingScrollColumnKeyRef = useRef<string | undefined>(undefined);
  const [showColumnJumpBar, setShowColumnJumpBar] = useState(false);
  const collapsedColumnKeySet = useMemo(() => new Set(collapsedColumnKeys), [collapsedColumnKeys]);
  const jumpColumns = useMemo(
    () => boardColumns.filter((column) => column.runs.length > 0),
    [boardColumns],
  );

  const recomputeJumpBarVisibility = useCallback(() => {
    const board = boardRef.current;
    if (!board || jumpColumns.length === 0) {
      setShowColumnJumpBar(false);
      return;
    }

    const viewportLeft = board.scrollLeft;
    const viewportRight = viewportLeft + board.clientWidth;
    const allVisible = jumpColumns.every((column) => {
      const element = columnRefs.current.get(column.key);
      if (!element) {
        return false;
      }
      const left = element.offsetLeft;
      const right = left + element.offsetWidth;
      return left >= viewportLeft && right <= viewportRight;
    });

    setShowColumnJumpBar(!allVisible);
  }, [jumpColumns]);

  useLayoutEffect(() => {
    recomputeJumpBarVisibility();
  });

  useEffect(() => {
    const board = boardRef.current;
    if (!board) {
      return;
    }

    const frameId = window.requestAnimationFrame(recomputeJumpBarVisibility);
    board.addEventListener("scroll", recomputeJumpBarVisibility, { passive: true });
    window.addEventListener("resize", recomputeJumpBarVisibility);

    return () => {
      window.cancelAnimationFrame(frameId);
      board.removeEventListener("scroll", recomputeJumpBarVisibility);
      window.removeEventListener("resize", recomputeJumpBarVisibility);
    };
  }, [recomputeJumpBarVisibility]);

  useEffect(() => {
    const pendingColumnKey = pendingScrollColumnKeyRef.current;
    if (!pendingColumnKey || collapsedColumnKeySet.has(pendingColumnKey)) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      if (pendingScrollColumnKeyRef.current !== pendingColumnKey) {
        return;
      }
      pendingScrollColumnKeyRef.current = undefined;
      scrollColumnIntoView(pendingColumnKey);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [collapsedColumnKeySet]);

  function columnRefFor(columnKey: string) {
    const existing = columnRefCallbacks.current.get(columnKey);
    if (existing) {
      return existing;
    }

    const callback = (node: HTMLElement | null) => {
      if (node) {
        columnRefs.current.set(columnKey, node);
      } else {
        columnRefs.current.delete(columnKey);
      }
    };
    columnRefCallbacks.current.set(columnKey, callback);
    return callback;
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

  function handleJumpToColumn(columnKey: string) {
    if (collapsedColumnKeySet.has(columnKey)) {
      pendingScrollColumnKeyRef.current = columnKey;
      onExpandColumn(columnKey);
      return;
    }

    pendingScrollColumnKeyRef.current = undefined;
    scrollColumnIntoView(columnKey);
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
              onClick={() => handleJumpToColumn(column.key)}
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
            collapsed={collapsedColumnKeySet.has(column.key)}
            column={column}
            columnRef={columnRefFor(column.key)}
            key={column.key}
            onSelectRun={onSelectRun}
            onToggleCollapse={() => onToggleColumnCollapse(column.key)}
            selectedRunActiveTask={selectedRunActiveTask}
            selectedRunId={selectedRunId}
          />
        ))}
      </section>
    </div>
  );
}
