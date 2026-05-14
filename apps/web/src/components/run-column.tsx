import type { RunStatus, RunSummary } from "@kcosr/agent-runner-core/contracts/runs.js";
import type { KeyboardEvent, MouseEvent } from "react";
import type { DashboardStructuredFilters } from "../lib/settings.js";
import type { RunActionPending } from "../routes/use-runs-dashboard-state.js";
import { ChevronIcon } from "./icons.js";
import { RunCard, type RunCardMotion } from "./run-card.js";

export interface BoardColumn {
  key: string;
  title: string;
  statuses: RunStatus[];
  subLabel?: string;
  runs: RunSummary[];
}

export function RunColumn({
  actionPending,
  bodyRef,
  collapsed,
  column,
  columnRef,
  motionsByRunId,
  onSetNote,
  onSetPinned,
  onRequestActionMenu,
  selectedRunId,
  onToggleCollapse,
  onSelectRun,
  onStructuredFilterToggle,
  structuredFilters,
}: {
  actionPending?: RunActionPending;
  bodyRef?: (node: HTMLElement | null) => void;
  collapsed: boolean;
  column: BoardColumn;
  columnRef?: (node: HTMLElement | null) => void;
  motionsByRunId: Record<string, RunCardMotion>;
  onSetNote: (runId: string, note: string | null) => Promise<void>;
  onSetPinned: (runId: string, pinned: boolean) => Promise<void>;
  selectedRunId?: string;
  onToggleCollapse: () => void;
  onSelectRun: (runId: string) => void;
  onRequestActionMenu: (runId: string, point: { clientX: number; clientY: number }) => void;
  onStructuredFilterToggle: (key: keyof DashboardStructuredFilters, value: string) => void;
  structuredFilters: DashboardStructuredFilters;
}) {
  const bodyId = `col-body-${column.key}`;
  const collapseLabel = `Collapse ${column.title} column`;
  const expandLabel = `Expand ${column.title} column`;

  function handleColumnClick(event: MouseEvent<HTMLElement>) {
    if (!collapsed) {
      return;
    }
    if (event.target instanceof Element && event.target.closest("button")) {
      return;
    }
    onToggleCollapse();
  }

  function handleColumnKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!collapsed) {
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    onToggleCollapse();
  }

  return (
    <article
      aria-labelledby={`col-${column.key}`}
      className="column"
      data-collapsed={collapsed ? "true" : "false"}
      data-status={column.key}
      onClick={handleColumnClick}
      onKeyDown={handleColumnKeyDown}
      ref={columnRef}
      tabIndex={collapsed ? 0 : undefined}
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
        {column.runs.length > 0 ? (
          <span aria-hidden="true" className="col-collapsed-count">
            {column.runs.length}
          </span>
        ) : null}
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
      <div className="col-body" id={bodyId} ref={bodyRef}>
        {column.runs.map((run) => (
          <RunCard
            actionPending={actionPending}
            key={run.runId}
            motion={motionsByRunId[run.runId]}
            onSetNote={(note) => onSetNote(run.runId, note)}
            onSetPinned={(pinned) => onSetPinned(run.runId, pinned)}
            onRequestActionMenu={(point) => onRequestActionMenu(run.runId, point)}
            onSelect={() => onSelectRun(run.runId)}
            onStructuredFilterToggle={onStructuredFilterToggle}
            run={run}
            selected={run.runId === selectedRunId}
            structuredFilters={structuredFilters}
          />
        ))}
      </div>
    </article>
  );
}
