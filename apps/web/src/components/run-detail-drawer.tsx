import type { RunDetail, RunSummary } from "@task-runner/core/contracts/runs.js";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { formatRelativeTimestamp, formatTimestamp, truncateMiddle } from "../lib/format.js";
import {
  DRAWER_WIDTH_MAX,
  DRAWER_WIDTH_MIN,
  clampDrawerWidth,
  useBoardSettings,
} from "../lib/settings.js";
import { ArchiveIcon, CloseIcon, CopyIcon, PencilIcon, StopIcon } from "./icons.js";
import { RunTaskList } from "./run-task-list.js";
import { StatusBadge } from "./status-badge.js";

type SectionKey = "tasks" | "dependencies" | "timing" | "events";

interface DragState {
  pointerId: number;
  startX: number;
  startWidth: number;
}

function dependencyCandidateTitle(run: RunSummary) {
  return run.name ?? run.assignmentName ?? "Unnamed";
}

function dependencyCandidateMeta(run: RunSummary) {
  const parts: string[] = [];
  if (run.assignmentName && run.assignmentName !== run.name) {
    parts.push(run.assignmentName);
  }
  if (run.archivedAt) {
    parts.push("Archived");
  }
  parts.push(run.effectiveStatus, run.runId);
  return parts.join(" · ");
}

function dependencyCandidateLabel(run: RunSummary) {
  return `${dependencyCandidateTitle(run)} · ${dependencyCandidateMeta(run)}`;
}

function matchesDependencyCandidate(run: RunSummary, search: string) {
  if (!search) {
    return true;
  }
  const haystack = [
    run.runId,
    run.name,
    run.assignmentName,
    run.repo,
    run.backend,
    run.agentName,
    run.effectiveStatus,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(search.toLowerCase());
}

function summaryRows(run: RunDetail) {
  const rows = [
    ["Repo", run.repo],
    ["Assignment", run.assignment?.name ?? "Ad hoc"],
    ["Agent", run.agent.name],
    ["Backend", [run.backend, run.model, run.effort].filter(Boolean).join(" · ") || run.backend],
    ["Started", `${formatTimestamp(run.startedAt)} ${formatRelativeTimestamp(run.startedAt)}`],
    ["Attempts", `${run.attempts} / ${run.maxAttempts}`],
    ["Sessions", String(run.sessionCount)],
  ] as const;

  if (run.effectiveStatus !== run.status) {
    return [...rows.slice(0, 4), ["Lifecycle status", run.status], ...rows.slice(4)] as const;
  }

  return rows;
}

export function RunDetailDrawer({
  dependencyCandidateRuns,
  onAddDependency,
  actionError,
  actionPending,
  onAbort,
  onArchive,
  onClearDependencies,
  onClose,
  onCopy,
  onRemoveDependency,
  onRename,
  onResume,
  onUnarchive,
  run,
}: {
  dependencyCandidateRuns: RunSummary[];
  onAddDependency: (dependencyRunId: string) => Promise<void>;
  actionError?: string;
  actionPending?: string;
  onAbort: () => void;
  onArchive: () => void;
  onClearDependencies: () => Promise<void>;
  onClose: () => void;
  onCopy: (value: string, label: string) => void;
  onRemoveDependency: (dependencyRunId: string) => Promise<void>;
  onRename: (name: string | null) => Promise<void>;
  onResume: () => void;
  onUnarchive: () => void;
  run: RunDetail;
}) {
  const [section, setSection] = useState<SectionKey>("tasks");
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(run.name ?? "");
  const [dependencyDraft, setDependencyDraft] = useState("");
  const [selectedDependencyRunId, setSelectedDependencyRunId] = useState<string | null>(null);
  const { settings, updateSettings } = useBoardSettings();
  const dragRef = useRef<DragState | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? settings.drawerWidth;
  const drawerStyle = { "--drawer-width": `${width}px` } as CSSProperties;
  const backendSessionId = run.backendSessionId;
  const actionsLocked = actionPending !== undefined;
  const renamePending = actionPending === "rename";
  const visibleName = run.name ?? "Unnamed";
  const canEditDependencies = run.status === "initialized";
  const addDependencyPending = actionPending === "add-dependency";
  const removeDependencyPending = actionPending === "remove-dependency";
  const clearDependenciesPending = actionPending === "clear-dependencies";
  const satisfiedDependencies = run.dependencies.filter(
    (dependency) => dependency.satisfied,
  ).length;
  const configuredDependencyIds = new Set(run.dependencies.map((dependency) => dependency.runId));
  const eligibleDependencyCandidates = dependencyCandidateRuns.filter(
    (candidate) => candidate.runId !== run.runId && !configuredDependencyIds.has(candidate.runId),
  );
  const normalizedDependencyDraft = dependencyDraft.trim();
  const matchingDependencyCandidates =
    normalizedDependencyDraft.length === 0
      ? []
      : eligibleDependencyCandidates
          .filter((candidate) => matchesDependencyCandidate(candidate, normalizedDependencyDraft))
          .slice(0, 8);
  const resolvedDependencyRunId =
    selectedDependencyRunId ??
    eligibleDependencyCandidates.find(
      (candidate) => candidate.runId.toLowerCase() === normalizedDependencyDraft.toLowerCase(),
    )?.runId;

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

  function startNameEdit() {
    if (actionsLocked) {
      return;
    }
    setNameDraft(run.name ?? "");
    setEditingName(true);
  }

  function cancelNameEdit() {
    if (renamePending) {
      return;
    }
    setNameDraft(run.name ?? "");
    setEditingName(false);
  }

  async function submitNameEdit() {
    if (renamePending) {
      return;
    }
    const trimmed = nameDraft.trim();
    const nextName = trimmed.length === 0 ? null : trimmed;
    if (nextName === run.name) {
      setEditingName(false);
      return;
    }
    try {
      await onRename(nextName);
      setEditingName(false);
    } catch {
      // actionError is surfaced by the shared mutation handler.
    }
  }

  function handleNameInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void submitNameEdit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelNameEdit();
    }
  }

  useEffect(() => {
    if (editingName) {
      nameInputRef.current?.focus();
    }
  }, [editingName]);

  async function submitDependencyAdd() {
    if (!resolvedDependencyRunId || addDependencyPending) {
      return;
    }
    try {
      await onAddDependency(resolvedDependencyRunId);
      setDependencyDraft("");
      setSelectedDependencyRunId(null);
    } catch {
      // actionError is surfaced by the shared mutation handler.
    }
  }

  function updateDependencyDraft(nextDraft: string) {
    setDependencyDraft(nextDraft);
    const exactRunId = eligibleDependencyCandidates.find(
      (candidate) => candidate.runId.toLowerCase() === nextDraft.trim().toLowerCase(),
    );
    setSelectedDependencyRunId(exactRunId?.runId ?? null);
  }

  function selectDependencyCandidate(candidate: RunSummary) {
    setDependencyDraft(dependencyCandidateLabel(candidate));
    setSelectedDependencyRunId(candidate.runId);
  }

  async function submitDependencyRemove(dependencyRunId: string) {
    if (removeDependencyPending) {
      return;
    }
    try {
      await onRemoveDependency(dependencyRunId);
    } catch {
      // actionError is surfaced by the shared mutation handler.
    }
  }

  async function submitDependencyClear() {
    if (clearDependenciesPending) {
      return;
    }
    try {
      await onClearDependencies();
    } catch {
      // actionError is surfaced by the shared mutation handler.
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
            <StatusBadge status={run.effectiveStatus} />
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
            {run.capabilities.canAbort ? (
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
            {editingName ? (
              <div className="drawer-title-edit">
                <label className="field drawer-title-field">
                  <input
                    aria-label="Run name"
                    disabled={renamePending}
                    onChange={(event) => setNameDraft(event.target.value)}
                    onKeyDown={handleNameInputKeyDown}
                    placeholder="Unnamed"
                    ref={nameInputRef}
                    value={nameDraft}
                  />
                </label>
                <button
                  className="btn"
                  disabled={renamePending}
                  onClick={() => void submitNameEdit()}
                  type="button"
                >
                  {renamePending ? "Saving..." : "Save"}
                </button>
                <button
                  className="btn"
                  disabled={renamePending}
                  onClick={cancelNameEdit}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="drawer-title-inline">
                <h3 className="drawer-section-title">{visibleName}</h3>
                <button
                  aria-label="Edit run name"
                  className="icon-btn icon-btn--small drawer-title-edit-trigger"
                  disabled={actionsLocked}
                  onClick={startNameEdit}
                  title="Edit run name"
                  type="button"
                >
                  <PencilIcon aria-hidden="true" />
                </button>
              </div>
            )}
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
              aria-selected={section === "dependencies"}
              className={section === "dependencies" ? "tab active" : "tab"}
              onClick={() => setSection("dependencies")}
              type="button"
            >
              Dependencies{" "}
              <span className="tab-count">
                {satisfiedDependencies}/{run.dependencies.length}
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

          {section === "dependencies" ? (
            <section aria-label="Dependencies" className="drawer-panel drawer-panel--dependencies">
              <div className="drawer-panel-card dependency-panel">
                <div className="dependency-summary">
                  <span>
                    {run.dependencies.length === 0
                      ? "No dependencies configured."
                      : `${satisfiedDependencies}/${run.dependencies.length} dependencies satisfied.`}
                  </span>
                  {canEditDependencies && run.dependencies.length > 0 ? (
                    <button
                      className="btn"
                      disabled={actionsLocked}
                      onClick={() => void submitDependencyClear()}
                      type="button"
                    >
                      {clearDependenciesPending ? "Clearing..." : "Clear all"}
                    </button>
                  ) : null}
                </div>

                {canEditDependencies ? (
                  <div className="dependency-add-stack">
                    <div className="dependency-add-row">
                      <label className="field dependency-field">
                        <input
                          aria-label="Dependency run search"
                          disabled={actionsLocked}
                          onChange={(event) => updateDependencyDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void submitDependencyAdd();
                            }
                          }}
                          placeholder="Search by name, assignment, or run id"
                          value={dependencyDraft}
                        />
                      </label>
                      <button
                        className="btn"
                        disabled={actionsLocked || !resolvedDependencyRunId}
                        onClick={() => void submitDependencyAdd()}
                        type="button"
                      >
                        {addDependencyPending ? "Adding..." : "Add dependency"}
                      </button>
                    </div>
                    {normalizedDependencyDraft.length > 0 ? (
                      matchingDependencyCandidates.length > 0 ? (
                        <ul
                          aria-label="Dependency suggestions"
                          className="dependency-suggestion-list"
                        >
                          {matchingDependencyCandidates.map((candidate) => (
                            <li key={candidate.runId}>
                              <button
                                aria-pressed={candidate.runId === resolvedDependencyRunId}
                                className={
                                  candidate.runId === resolvedDependencyRunId
                                    ? "dependency-suggestion active"
                                    : "dependency-suggestion"
                                }
                                disabled={actionsLocked}
                                onClick={() => selectDependencyCandidate(candidate)}
                                type="button"
                              >
                                <span className="dependency-suggestion-title">
                                  {dependencyCandidateTitle(candidate)}
                                </span>
                                <span className="dependency-suggestion-meta">
                                  {dependencyCandidateMeta(candidate)}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted-inline">
                          No matching runs. Search by name, assignment, or run id.
                        </p>
                      )
                    ) : null}
                  </div>
                ) : null}

                <div className="dependency-section">
                  <h4 className="drawer-section-title">Depends on</h4>
                  {run.dependencies.length === 0 ? (
                    <p className="muted-inline">No dependencies.</p>
                  ) : (
                    <ul className="dependency-list">
                      {run.dependencies.map((dependency) => (
                        <li className="dependency-row" key={dependency.runId}>
                          <div className="dependency-copy">
                            <span className="dependency-name">{dependency.name ?? "Unnamed"}</span>
                            <span className="dependency-meta">
                              {dependency.runId} ·{" "}
                              {dependency.missing
                                ? "Missing"
                                : dependency.satisfied
                                  ? "Satisfied"
                                  : dependency.effectiveStatus}
                            </span>
                          </div>
                          {canEditDependencies ? (
                            <button
                              aria-label={`Remove dependency ${dependency.runId}`}
                              className="btn"
                              disabled={actionsLocked}
                              onClick={() => void submitDependencyRemove(dependency.runId)}
                              type="button"
                            >
                              {removeDependencyPending ? "Removing..." : "Remove"}
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="dependency-section">
                  <h4 className="drawer-section-title">Required by</h4>
                  {run.dependents.length === 0 ? (
                    <p className="muted-inline">No dependents.</p>
                  ) : (
                    <ul className="dependency-list">
                      {run.dependents.map((dependent) => (
                        <li className="dependency-row" key={dependent.runId}>
                          <div className="dependency-copy">
                            <span className="dependency-name">{dependent.name ?? "Unnamed"}</span>
                            <span className="dependency-meta">
                              {dependent.runId} · {dependent.effectiveStatus}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
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
