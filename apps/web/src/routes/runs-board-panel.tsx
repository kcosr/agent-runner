import type { UseQueryResult } from "@tanstack/react-query";
import type { RunSummary } from "@task-runner/core/contracts/runs.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EmptyPanel } from "../components/empty-states.js";
import type { RunCardMotion } from "../components/run-card.js";
import { type BoardColumn, RunColumn } from "../components/run-column.js";
import { useHorizontalWheelGuard } from "../lib/use-horizontal-wheel-guard.js";

interface RunBoardPosition {
  columnKey: string;
  index: number;
}

function buildRunBoardPositions(boardColumns: BoardColumn[]): Record<string, RunBoardPosition> {
  const positions: Record<string, RunBoardPosition> = {};
  for (const column of boardColumns) {
    column.runs.forEach((run, index) => {
      positions[run.runId] = { columnKey: column.key, index };
    });
  }
  return positions;
}

function haveSameCardMotions(
  left: Record<string, RunCardMotion>,
  right: Record<string, RunCardMotion>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  return leftEntries.every(([runId, motion]) => {
    const candidate = right[runId];
    return candidate?.kind === motion.kind && candidate.revision === motion.revision;
  });
}

export function RunsBoardPanel({
  activeBoardColumnKey,
  boardColumns,
  collapsedColumnKeys,
  onActiveBoardColumnKeyChange,
  onExpandColumn,
  onResetFilters,
  onSelectRun,
  onToggleColumnCollapse,
  runs,
  runsQuery,
  selectedRunId,
  visibleRuns,
}: {
  activeBoardColumnKey: string | null;
  boardColumns: BoardColumn[];
  collapsedColumnKeys: string[];
  onActiveBoardColumnKeyChange: (columnKey: string | null) => void;
  onExpandColumn: (columnKey: string) => void;
  onResetFilters: () => void;
  onSelectRun: (runId: string) => void;
  onToggleColumnCollapse: (columnKey: string) => void;
  runs: RunSummary[];
  runsQuery: UseQueryResult<RunSummary[], Error>;
  selectedRunId?: string;
  visibleRuns: RunSummary[];
}) {
  const boardRef = useRef<HTMLElement | null>(null);
  const columnRefs = useRef(new Map<string, HTMLElement>());
  const columnRefCallbacks = useRef(new Map<string, (node: HTMLElement | null) => void>());
  const columnBodyRefs = useRef(new Map<string, HTMLElement>());
  const columnBodyRefCallbacks = useRef(new Map<string, (node: HTMLElement | null) => void>());
  const pendingScrollColumnKeyRef = useRef<string | undefined>(undefined);
  const pendingRestoreColumnKeyRef = useRef<string | null>(activeBoardColumnKey);
  const cardMotionRevisionRef = useRef(0);
  const previousRunBoardPositionsRef = useRef<Record<string, RunBoardPosition> | null>(null);
  const [motionsByRunId, setMotionsByRunId] = useState<Record<string, RunCardMotion>>({});
  const [showColumnJumpBar, setShowColumnJumpBar] = useState(false);
  const collapsedColumnKeySet = useMemo(() => new Set(collapsedColumnKeys), [collapsedColumnKeys]);
  const runBoardPositions = useMemo(() => buildRunBoardPositions(boardColumns), [boardColumns]);
  const jumpColumns = useMemo(
    () => boardColumns.filter((column) => column.runs.length > 0),
    [boardColumns],
  );
  useHorizontalWheelGuard(boardRef);

  useLayoutEffect(() => {
    const nextPositions = runBoardPositions;
    const previousPositions = previousRunBoardPositionsRef.current;
    previousRunBoardPositionsRef.current = nextPositions;

    if (!previousPositions) {
      return;
    }

    const nextMotions: Record<string, RunCardMotion> = {};
    for (const [runId, position] of Object.entries(nextPositions)) {
      const previousPosition = previousPositions[runId];
      if (!previousPosition) {
        cardMotionRevisionRef.current += 1;
        nextMotions[runId] = { kind: "insert", revision: cardMotionRevisionRef.current };
        continue;
      }
      if (previousPosition.columnKey !== position.columnKey) {
        cardMotionRevisionRef.current += 1;
        nextMotions[runId] = { kind: "move", revision: cardMotionRevisionRef.current };
        continue;
      }
      if (previousPosition.index !== position.index) {
        cardMotionRevisionRef.current += 1;
        nextMotions[runId] = { kind: "reorder", revision: cardMotionRevisionRef.current };
      }
    }

    setMotionsByRunId((current) =>
      haveSameCardMotions(current, nextMotions) ? current : nextMotions,
    );
  }, [runBoardPositions]);

  const resolveCenteredColumnKey = useCallback(
    (board: HTMLElement): string | null => {
      const viewportCenter = board.scrollLeft + board.clientWidth / 2;
      let bestKey: string | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;

      for (const column of boardColumns) {
        const element = columnRefs.current.get(column.key);
        if (!element) {
          continue;
        }

        const width = element.offsetWidth;
        if (width <= 0) {
          continue;
        }

        const center = element.offsetLeft + width / 2;
        const distance = Math.abs(center - viewportCenter);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestKey = column.key;
        }
      }

      return bestKey;
    },
    [boardColumns],
  );

  const scrollColumnIntoView = useCallback(
    (columnKey: string, behavior: ScrollBehavior = "smooth"): boolean => {
      const board = boardRef.current;
      const column = columnRefs.current.get(columnKey);
      if (!board || !column || column.offsetWidth <= 0) {
        return false;
      }

      const maxScrollLeft = Math.max(0, board.scrollWidth - board.clientWidth);
      const centeredLeft = column.offsetLeft - (board.clientWidth - column.offsetWidth) / 2;
      const targetLeft = Math.min(maxScrollLeft, Math.max(0, centeredLeft));

      if (typeof board.scrollTo === "function") {
        board.scrollTo({ behavior, left: targetLeft });
      } else {
        board.scrollLeft = targetLeft;
      }

      return true;
    },
    [],
  );

  const bringColumnIntoView = useCallback(
    (columnKey: string, behavior: ScrollBehavior = "smooth"): boolean => {
      if (collapsedColumnKeySet.has(columnKey)) {
        pendingScrollColumnKeyRef.current = columnKey;
        onExpandColumn(columnKey);
        return true;
      }

      pendingScrollColumnKeyRef.current = undefined;
      return scrollColumnIntoView(columnKey, behavior);
    },
    [collapsedColumnKeySet, onExpandColumn, scrollColumnIntoView],
  );

  const recomputeBoardViewportState = useCallback(() => {
    const board = boardRef.current;
    if (!board || jumpColumns.length === 0) {
      setShowColumnJumpBar(false);
      return;
    }

    const pendingRestoreColumnKey = pendingRestoreColumnKeyRef.current;
    if (pendingRestoreColumnKey && scrollColumnIntoView(pendingRestoreColumnKey, "auto")) {
      pendingRestoreColumnKeyRef.current = null;
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
    const centeredColumnKey = resolveCenteredColumnKey(board);
    if (centeredColumnKey) {
      onActiveBoardColumnKeyChange(centeredColumnKey);
    }
  }, [jumpColumns, onActiveBoardColumnKeyChange, resolveCenteredColumnKey, scrollColumnIntoView]);

  useLayoutEffect(() => {
    recomputeBoardViewportState();
  });

  useEffect(() => {
    const board = boardRef.current;
    if (!board) {
      return;
    }

    const frameId = window.requestAnimationFrame(recomputeBoardViewportState);
    board.addEventListener("scroll", recomputeBoardViewportState, { passive: true });
    window.addEventListener("resize", recomputeBoardViewportState);

    return () => {
      window.cancelAnimationFrame(frameId);
      board.removeEventListener("scroll", recomputeBoardViewportState);
      window.removeEventListener("resize", recomputeBoardViewportState);
    };
  }, [recomputeBoardViewportState]);

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
  }, [collapsedColumnKeySet, scrollColumnIntoView]);

  useEffect(() => {
    if (!selectedRunId) {
      return;
    }

    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) {
      return;
    }

    const board = boardRef.current;
    if (!board) {
      return;
    }

    const activeCard = activeElement.closest("[data-run-id]");
    const activeWithinBoard = activeCard instanceof HTMLElement && board.contains(activeCard);
    const activeIsDocumentBody = activeElement === document.body;
    if (!activeWithinBoard && !activeIsDocumentBody) {
      return;
    }

    const nextCard = board.querySelector(`[data-run-id="${CSS.escape(selectedRunId)}"]`);
    if (!(nextCard instanceof HTMLElement) || nextCard === activeCard) {
      return;
    }

    nextCard.focus({ preventScroll: true });
  }, [selectedRunId]);

  useEffect(() => {
    if (!selectedRunId) {
      return;
    }

    const selectedPosition = runBoardPositions[selectedRunId];
    if (!selectedPosition) {
      return;
    }

    const board = boardRef.current;
    const selectedColumn = columnRefs.current.get(selectedPosition.columnKey);
    const selectedColumnBody = columnBodyRefs.current.get(selectedPosition.columnKey);
    if (!board || !selectedColumn || !selectedColumnBody) {
      return;
    }

    const viewportLeft = board.scrollLeft;
    const viewportRight = viewportLeft + board.clientWidth;
    const columnLeft = selectedColumn.offsetLeft;
    const columnRight = columnLeft + selectedColumn.offsetWidth;
    const columnFullyVisible = columnLeft >= viewportLeft && columnRight <= viewportRight;
    if (!columnFullyVisible) {
      bringColumnIntoView(selectedPosition.columnKey);
    }

    const selectedCard = selectedColumnBody.querySelector(
      `[data-run-id="${CSS.escape(selectedRunId)}"]`,
    );
    if (!(selectedCard instanceof HTMLElement)) {
      return;
    }

    const bodyRect = selectedColumnBody.getBoundingClientRect();
    const cardRect = selectedCard.getBoundingClientRect();
    const relativeTop = cardRect.top - bodyRect.top;
    const relativeBottom = cardRect.bottom - bodyRect.bottom;
    if (selectedPosition.index === 0 && selectedColumnBody.scrollTop > 0) {
      if (typeof selectedColumnBody.scrollTo === "function") {
        selectedColumnBody.scrollTo({ behavior: "smooth", top: 0 });
      } else {
        selectedColumnBody.scrollTop = 0;
      }
      return;
    }

    if (relativeTop < 0) {
      const nextScrollTop = Math.max(0, selectedColumnBody.scrollTop + relativeTop);
      if (typeof selectedColumnBody.scrollTo === "function") {
        selectedColumnBody.scrollTo({ behavior: "smooth", top: nextScrollTop });
      } else {
        selectedColumnBody.scrollTop = nextScrollTop;
      }
      return;
    }

    if (relativeBottom > 0) {
      const nextScrollTop = Math.max(0, selectedColumnBody.scrollTop + relativeBottom);
      if (typeof selectedColumnBody.scrollTo === "function") {
        selectedColumnBody.scrollTo({ behavior: "smooth", top: nextScrollTop });
      } else {
        selectedColumnBody.scrollTop = nextScrollTop;
      }
    }
  }, [bringColumnIntoView, runBoardPositions, selectedRunId]);

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

  function columnBodyRefFor(columnKey: string) {
    const existing = columnBodyRefCallbacks.current.get(columnKey);
    if (existing) {
      return existing;
    }

    const callback = (node: HTMLElement | null) => {
      if (node) {
        columnBodyRefs.current.set(columnKey, node);
      } else {
        columnBodyRefs.current.delete(columnKey);
      }
    };
    columnBodyRefCallbacks.current.set(columnKey, callback);
    return callback;
  }

  function handleJumpToColumn(columnKey: string) {
    bringColumnIntoView(columnKey);
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
            bodyRef={columnBodyRefFor(column.key)}
            collapsed={collapsedColumnKeySet.has(column.key)}
            column={column}
            columnRef={columnRefFor(column.key)}
            key={column.key}
            motionsByRunId={motionsByRunId}
            onSelectRun={onSelectRun}
            onToggleCollapse={() => onToggleColumnCollapse(column.key)}
            selectedRunId={selectedRunId}
          />
        ))}
      </section>
    </div>
  );
}
