import type { RunDetail } from "@task-runner/core/contracts/runs.js";
import { type CSSProperties, type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { formatRelativeTimestamp, formatTimestamp, truncateMiddle } from "../lib/format.js";
import {
  DRAWER_WIDTH_MAX,
  DRAWER_WIDTH_MIN,
  clampDrawerWidth,
  useBoardSettings,
} from "../lib/settings.js";
import { ArchiveIcon, CloseIcon, CopyIcon, StopIcon } from "./icons.js";
import { RunTaskList } from "./run-task-list.js";
import { StatusBadge } from "./status-badge.js";

type SectionKey = "tasks" | "timing" | "events";

interface DragState {
  pointerId: number;
  startX: number;
  startWidth: number;
}

function summaryRows(run: RunDetail) {
  return [
    ["Repo", run.repo],
    ["Assignment", run.assignment?.name ?? "Ad hoc"],
    ["Agent", run.agent.name],
    ["Backend", [run.backend, run.model, run.effort].filter(Boolean).join(" · ") || run.backend],
    ["Started", `${formatTimestamp(run.startedAt)} ${formatRelativeTimestamp(run.startedAt)}`],
    ["Attempts", `${run.attempts} / ${run.maxAttempts}`],
    ["Sessions", String(run.sessionCount)],
  ] as const;
}

export function RunDetailDrawer({
  actionError,
  actionPending,
  onAbort,
  onArchive,
  onClose,
  onCopy,
  onResume,
  onUnarchive,
  run,
}: {
  actionError?: string;
  actionPending?: string;
  onAbort: () => void;
  onArchive: () => void;
  onClose: () => void;
  onCopy: (value: string, label: string) => void;
  onResume: () => void;
  onUnarchive: () => void;
  run: RunDetail;
}) {
  const [section, setSection] = useState<SectionKey>("tasks");
  const { settings, updateSettings } = useBoardSettings();
  const dragRef = useRef<DragState | null>(null);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? settings.drawerWidth;
  const drawerStyle = { "--drawer-width": `${width}px` } as CSSProperties;
  const backendSessionId = run.backendSessionId;
  const actionsLocked = actionPending !== undefined;

  function handleResizeStart(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: width,
    };
  }

  function handleResizeMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const next = clampDrawerWidth(drag.startWidth + (drag.startX - event.clientX));
    setDragWidth(next);
  }

  function handleResizeKey(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 40 : 10;
    let next: number | null = null;
    if (event.key === "ArrowLeft") {
      next = clampDrawerWidth(width + step);
    } else if (event.key === "ArrowRight") {
      next = clampDrawerWidth(width - step);
    } else if (event.key === "Home") {
      next = DRAWER_WIDTH_MIN;
    } else if (event.key === "End") {
      next = DRAWER_WIDTH_MAX;
    }
    if (next !== null) {
      event.preventDefault();
      updateSettings({ drawerWidth: next });
    }
  }

  function handleResizeEnd(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const final = clampDrawerWidth(drag.startWidth + (drag.startX - event.clientX));
    dragRef.current = null;
    setDragWidth(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (final !== settings.drawerWidth) {
      updateSettings({ drawerWidth: final });
    }
  }

  function handleResizeCancel(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    setDragWidth(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <>
      <button
        aria-label="Close detail sheet"
        className="drawer-sheet-backdrop"
        onClick={onClose}
        type="button"
      />
      <aside aria-label="Run detail" className="drawer" style={drawerStyle}>
        <div
          aria-label="Resize detail drawer"
          aria-orientation="vertical"
          aria-valuemax={DRAWER_WIDTH_MAX}
          aria-valuemin={DRAWER_WIDTH_MIN}
          aria-valuenow={width}
          className={dragWidth !== null ? "drawer-resize active" : "drawer-resize"}
          onKeyDown={handleResizeKey}
          onPointerCancel={handleResizeCancel}
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          role="separator"
          tabIndex={0}
        />
        <header className="drawer-head">
          <div className="drawer-title">
            <span className="run-id-large">{run.runId}</span>
            <StatusBadge status={run.status} />
          </div>
          <div className="drawer-actions">
            {run.capabilities.canArchive ? (
              <button className="btn" disabled={actionsLocked} onClick={onArchive} type="button">
                <ArchiveIcon aria-hidden="true" />
                {actionPending === "archive" ? "Archiving..." : "Archive"}
              </button>
            ) : null}
            {run.capabilities.canUnarchive ? (
              <button className="btn" disabled={actionsLocked} onClick={onUnarchive} type="button">
                <ArchiveIcon aria-hidden="true" />
                {actionPending === "unarchive" ? "Restoring..." : "Unarchive"}
              </button>
            ) : null}
            {run.capabilities.canResume ? (
              <button className="btn" disabled={actionsLocked} onClick={onResume} type="button">
                {actionPending === "resume" ? "Resuming..." : "Resume"}
              </button>
            ) : null}
            {run.isLive && run.status === "running" ? (
              <button
                className="btn btn-destructive-outline"
                disabled={actionsLocked}
                onClick={onAbort}
                type="button"
              >
                <StopIcon aria-hidden="true" />
                {actionPending === "abort" ? "Aborting..." : "Abort"}
              </button>
            ) : null}
            <button
              aria-label="Copy run id"
              className="icon-btn"
              onClick={() => onCopy(run.runId, "run id")}
              title="Copy run id"
              type="button"
            >
              <CopyIcon aria-hidden="true" />
            </button>
            <button aria-label="Close detail" className="icon-btn" onClick={onClose} type="button">
              <CloseIcon aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="drawer-body">
          <div className="drawer-title-block">
            <h3 className="drawer-section-title">{run.name ?? "Unnamed"}</h3>
            <p className="drawer-subtitle">Assignment: {run.assignment?.name ?? "Ad hoc run"}</p>
          </div>
          <section aria-label="Run summary" className="meta-grid">
            {summaryRows(run).map(([label, value]) => (
              <div className="meta-cell" key={label}>
                <span className="meta-label">{label}</span>
                <span className="meta-value">{value}</span>
              </div>
            ))}
            <div className="meta-cell full">
              <span className="meta-label">Workspace</span>
              <span className="meta-value mono">
                {truncateMiddle(run.workspaceDir)}
                <button
                  aria-label="Copy workspace path"
                  className="copy"
                  onClick={() => onCopy(run.workspaceDir, "workspace path")}
                  type="button"
                >
                  <CopyIcon aria-hidden="true" />
                </button>
              </span>
            </div>
            {backendSessionId ? (
              <div className="meta-cell full">
                <span className="meta-label">Backend session</span>
                <span className="meta-value mono">
                  {truncateMiddle(backendSessionId)}
                  <button
                    aria-label="Copy backend session id"
                    className="copy"
                    onClick={() => onCopy(backendSessionId, "backend session id")}
                    type="button"
                  >
                    <CopyIcon aria-hidden="true" />
                  </button>
                </span>
              </div>
            ) : null}
          </section>

          {actionError ? (
            <div className="notice" data-tone="error">
              <span className="notice__message">{actionError}</span>
            </div>
          ) : null}

          <nav aria-label="Run sections" className="tabs">
            <button
              aria-selected={section === "tasks"}
              className={section === "tasks" ? "tab active" : "tab"}
              onClick={() => setSection("tasks")}
              type="button"
            >
              Tasks{" "}
              <span className="tab-count">
                {run.tasksCompleted}/{run.tasksTotal}
              </span>
            </button>
            <button
              aria-selected={section === "timing"}
              className={section === "timing" ? "tab active" : "tab"}
              onClick={() => setSection("timing")}
              type="button"
            >
              Timing
            </button>
            <button
              aria-selected={section === "events"}
              className={section === "events" ? "tab active" : "tab"}
              onClick={() => setSection("events")}
              type="button"
            >
              Events
            </button>
          </nav>

          {section === "tasks" ? (
            <section aria-label="Tasks" className="drawer-panel drawer-panel--tasks">
              <RunTaskList tasks={run.tasks} />
            </section>
          ) : null}

          {section === "timing" ? (
            <section aria-label="Timing" className="drawer-panel drawer-panel--timing">
              <div className="drawer-panel-card">
                <div className="timing-grid">
                  <div className="timing-row">
                    <span className="timing-label">Started</span>
                    <span className="timing-value">{formatTimestamp(run.startedAt)}</span>
                  </div>
                  <div className="timing-row">
                    <span className="timing-label">Ended</span>
                    <span className="timing-value">{formatTimestamp(run.endedAt)}</span>
                  </div>
                  <div className="timing-row">
                    <span className="timing-label">Exit code</span>
                    <span className="timing-value">
                      {run.exitCode === null ? "Not available" : String(run.exitCode)}
                    </span>
                  </div>
                  <div className="timing-row">
                    <span className="timing-label">CWD</span>
                    <span className="timing-value">{truncateMiddle(run.cwd)}</span>
                  </div>
                  <div className="timing-row">
                    <span className="timing-label">Assignment path</span>
                    <span className="timing-value">{truncateMiddle(run.assignmentPath)}</span>
                  </div>
                  <div className="timing-row">
                    <span className="timing-label">Task mode</span>
                    <span className="timing-value">{run.taskMode}</span>
                  </div>
                </div>
              </div>
            </section>
          ) : null}

          {section === "events" ? (
            <section aria-label="Events" className="drawer-panel drawer-panel--events">
              <div className="drawer-panel-card">
                <p className="muted-inline">
                  Live event timeline is deferred in phase 1. HTTP detail and SSE board refresh are
                  implemented in this slice.
                </p>
              </div>
            </section>
          ) : null}
        </div>
      </aside>
    </>
  );
}
