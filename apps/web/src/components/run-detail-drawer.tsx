import type { RunDetail } from "@task-runner/core/contracts/runs.js";
import { useState } from "react";
import { formatRelativeTimestamp, formatTimestamp, truncateMiddle } from "../lib/format.js";
import { ArchiveIcon, ChevronDownIcon, CloseIcon, CopyIcon, StopIcon } from "./icons.js";
import { RunTaskList } from "./run-task-list.js";
import { StatusBadge } from "./status-badge.js";

type SectionKey = "tasks" | "timing" | "events";

function summaryRows(run: RunDetail) {
  return [
    ["Repo", run.repo],
    ["Assignment", run.assignment?.name ?? "Ad hoc"],
    ["Agent", run.agent.name],
    ["Backend", [run.backend, run.model, run.effort].filter(Boolean).join(" · ") || run.backend],
    ["Session", run.sessionName ?? "Not available"],
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
  const [openSections, setOpenSections] = useState<Record<SectionKey, boolean>>({
    tasks: false,
    timing: false,
    events: false,
  });
  const backendSessionId = run.backendSessionId;
  const sectionBaseId = `run-detail-${run.runId}`;

  function toggleSection(section: SectionKey) {
    setOpenSections((current) => ({
      ...current,
      [section]: !current[section],
    }));
  }

  return (
    <>
      <button
        aria-label="Close detail sheet"
        className="drawer-sheet-backdrop"
        onClick={onClose}
        type="button"
      />
      <aside aria-label="Run detail" className="drawer">
        <header className="drawer-head">
          <div className="drawer-title">
            <span className="run-id-large">{run.runId}</span>
            <StatusBadge status={run.status} />
          </div>
          <div className="drawer-actions">
            {run.capabilities.canArchive ? (
              <button
                className="btn"
                disabled={actionPending === "archive"}
                onClick={onArchive}
                type="button"
              >
                <ArchiveIcon aria-hidden="true" />
                {actionPending === "archive" ? "Archiving..." : "Archive"}
              </button>
            ) : null}
            {run.capabilities.canUnarchive ? (
              <button
                className="btn"
                disabled={actionPending === "unarchive"}
                onClick={onUnarchive}
                type="button"
              >
                <ArchiveIcon aria-hidden="true" />
                {actionPending === "unarchive" ? "Restoring..." : "Unarchive"}
              </button>
            ) : null}
            {run.capabilities.canResume ? (
              <button
                className="btn"
                disabled={actionPending === "resume"}
                onClick={onResume}
                type="button"
              >
                {actionPending === "resume" ? "Resuming..." : "Resume"}
              </button>
            ) : null}
            {run.isLive && run.status === "running" ? (
              <button
                className="btn btn-destructive-outline"
                disabled={actionPending === "abort"}
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
            {backendSessionId ? (
              <button
                aria-label="Copy backend session id"
                className="icon-btn"
                onClick={() => onCopy(backendSessionId, "backend session id")}
                title="Copy backend session id"
                type="button"
              >
                <CopyIcon aria-hidden="true" />
              </button>
            ) : null}
            <button aria-label="Close detail" className="icon-btn" onClick={onClose} type="button">
              <CloseIcon aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="drawer-body">
          <h3 className="drawer-section-title">{run.assignment?.name ?? "Ad hoc run"}</h3>
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

          <section className="drawer-group">
            <button
              aria-controls={`${sectionBaseId}-tasks`}
              aria-expanded={openSections.tasks}
              className="drawer-group-toggle"
              onClick={() => toggleSection("tasks")}
              type="button"
            >
              <span>
                Tasks{" "}
                <span className="tab-count">
                  {run.tasksCompleted}/{run.tasksTotal}
                </span>
              </span>
              <ChevronDownIcon
                aria-hidden="true"
                className={openSections.tasks ? "drawer-group-icon open" : "drawer-group-icon"}
              />
            </button>
            {openSections.tasks ? (
              <div
                aria-label="Tasks"
                className="drawer-group-content drawer-group-content--tasks"
                id={`${sectionBaseId}-tasks`}
              >
                <div className="drawer-group-scroll drawer-group-scroll--tasks">
                  <RunTaskList tasks={run.tasks} />
                </div>
              </div>
            ) : null}
          </section>

          <section className="drawer-group">
            <button
              aria-controls={`${sectionBaseId}-timing`}
              aria-expanded={openSections.timing}
              className="drawer-group-toggle"
              onClick={() => toggleSection("timing")}
              type="button"
            >
              <span>Timing</span>
              <ChevronDownIcon
                aria-hidden="true"
                className={openSections.timing ? "drawer-group-icon open" : "drawer-group-icon"}
              />
            </button>
            {openSections.timing ? (
              <div
                aria-label="Timing"
                className="drawer-group-content drawer-group-content--timing"
                id={`${sectionBaseId}-timing`}
              >
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
              </div>
            ) : null}
          </section>

          <section className="drawer-group">
            <button
              aria-controls={`${sectionBaseId}-events`}
              aria-expanded={openSections.events}
              className="drawer-group-toggle"
              onClick={() => toggleSection("events")}
              type="button"
            >
              <span>Events</span>
              <ChevronDownIcon
                aria-hidden="true"
                className={openSections.events ? "drawer-group-icon open" : "drawer-group-icon"}
              />
            </button>
            {openSections.events ? (
              <div
                aria-label="Events"
                className="drawer-group-content drawer-group-content--events"
                id={`${sectionBaseId}-events`}
              >
                <div className="drawer-panel-card">
                  <p className="muted-inline">
                    Live event timeline is deferred in phase 1. HTTP detail and SSE board refresh
                    are implemented in this slice.
                  </p>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </aside>
    </>
  );
}
