import type { RunDetail, RunSummary } from "@kcosr/agent-runner-core/contracts/runs.js";
import type { ReactNode } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AppShell } from "../components/app-shell.js";
import { useNativeModalDialog } from "../components/native-dialog.js";
import { RunFilters } from "../components/run-filters.js";
import {
  type RunActionMenuItem,
  type RunDestructiveCleanupAction,
  getRunActionMenuItems,
  getRunDestructiveCleanupAction,
} from "../lib/run-action-menu.js";
import type { DashboardPreferences } from "../lib/settings.js";
import type { DashboardViewMode } from "../lib/settings.js";
import {
  isEditableEventTarget,
  resolveBoardNeighborRunId,
  resolveListNeighborRunId,
  resolveRunsShortcutCommand,
} from "../lib/shortcuts.js";
import { RunChatView } from "./run-chat-panel.js";
import { RunDetailPanel } from "./run-detail-panel.js";
import { RunsBoardPanel } from "./runs-board-panel.js";
import { RunsListPanel } from "./runs-list-panel.js";
import { useRunsDashboardState } from "./use-runs-dashboard-state.js";

const BOARD_FILTER_PREFERENCE_KEYS = {
  "ui.toggleScheduledOnly": "showScheduledOnly",
  "ui.togglePinnedOnly": "showPinnedOnly",
  "ui.toggleNotesOnly": "showNotesOnly",
  "ui.toggleArchived": "showArchived",
  "ui.toggleHideEmptyColumns": "hideEmptyColumns",
} satisfies Record<string, keyof DashboardPreferences>;

type BoardFilterShortcutCommand = keyof typeof BOARD_FILTER_PREFERENCE_KEYS;
type RunsDashboardState = ReturnType<typeof useRunsDashboardState>;

interface DestructiveRunConfirmation {
  action: RunDestructiveCleanupAction;
  runId: string;
}

interface RunActionMenuState {
  items: RunActionMenuItem[];
  runId: string;
  selectedRunIdAtOpen?: string;
  x: number;
  y: number;
}

function isBoardFilterShortcutCommand(command: string): command is BoardFilterShortcutCommand {
  return command in BOARD_FILTER_PREFERENCE_KEYS;
}

function findDashboardRun(
  state: {
    runs: RunSummary[];
    selectedRunQuery: { data?: RunDetail };
  },
  runId: string,
): RunDetail | RunSummary | undefined {
  const selectedRun = state.selectedRunQuery.data;
  if (selectedRun?.runId === runId) {
    return selectedRun;
  }
  return state.runs.find((run) => run.runId === runId);
}

function DashboardSurfaces({
  primary,
  detail,
}: {
  primary: ReactNode;
  detail: ReactNode;
}) {
  return (
    <div className="dashboard-surfaces">
      <div className="dashboard-board-surface">{primary}</div>
      {detail ? (
        <div className="dashboard-right-surfaces">
          <div className="dashboard-panel-shell">{detail}</div>
        </div>
      ) : null}
    </div>
  );
}

interface DashboardPanelRendererProps {
  onListSelectRun: (runId: string) => void;
  onOpenRunNote: (runId: string) => void;
  onRequestActionMenu: (runId: string, point: { clientX: number; clientY: number }) => void;
  state: RunsDashboardState;
}

const DASHBOARD_PANEL_RENDERERS = {
  board: ({ onRequestActionMenu, state }: DashboardPanelRendererProps) => (
    <RunsBoardPanel
      actionPending={state.actionPending}
      activeBoardColumnKey={state.activeBoardColumnKey}
      boardColumns={state.boardColumns}
      collapsedColumnKeys={state.collapsedColumnKeys}
      hasActiveStructuredFilters={state.hasActiveStructuredFilters}
      onExpandColumn={state.columnActions.expand}
      onActiveBoardColumnKeyChange={state.setActiveBoardColumnKey}
      onResetFilters={state.resetBoardFilters}
      onRequestActionMenu={onRequestActionMenu}
      onSetNote={state.runActions.setNote}
      onSetPinned={state.runActions.setPinned}
      onSelectRun={state.openRun}
      onStructuredFilterToggle={state.toggleStructuredFilter}
      onToggleColumnCollapse={state.columnActions.toggleCollapse}
      runs={state.runs}
      runsQuery={state.runsQuery}
      searchValue={state.viewState.search}
      selectedRunId={state.selectedRunId}
      structuredFilters={state.preferences.structuredFilters}
      visibleRuns={state.visibleRuns}
    />
  ),
  list: ({
    onListSelectRun,
    onOpenRunNote,
    onRequestActionMenu,
    state,
  }: DashboardPanelRendererProps) => (
    <RunsListPanel
      actionPending={state.actionPending}
      hasActiveStructuredFilters={state.hasActiveStructuredFilters}
      listRows={state.listRows}
      listStatusCounts={state.listStatusCounts}
      listStatusFilter={state.listStatusFilter}
      onListStatusFilterChange={state.setListStatusFilter}
      onOpenNote={onOpenRunNote}
      onRequestActionMenu={onRequestActionMenu}
      onResetFilters={state.resetBoardFilters}
      onSelectRun={onListSelectRun}
      onSetNote={state.runActions.setNote}
      onSetPinned={state.runActions.setPinned}
      onStructuredFilterToggle={state.toggleStructuredFilter}
      runs={state.runs}
      runsQuery={state.runsQuery}
      searchValue={state.viewState.search}
      selectedRunId={state.selectedRunId}
      sortField={state.preferences.sortField}
      structuredFilters={state.preferences.structuredFilters}
      visibleRuns={state.visibleRuns}
    />
  ),
} satisfies Record<DashboardViewMode, (props: DashboardPanelRendererProps) => ReactNode>;

function DestructiveRunConfirmationDialog({
  action,
  actionPending,
  onCancel,
  onConfirm,
}: {
  action: RunDestructiveCleanupAction;
  actionPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const { dialogProps, ref: dialogRef } = useNativeModalDialog(true, onCancel);
  const title = action === "archive-delete" ? "Archive and delete run?" : "Delete run?";
  const body =
    action === "archive-delete"
      ? "This will archive the run first, then delete it using the existing delete guardrails."
      : "This will delete the archived run using the existing delete guardrails.";
  const confirmLabel = action === "archive-delete" ? "Archive + Delete" : "Delete";

  return (
    <dialog
      aria-labelledby={titleId}
      className="note-dialog-backdrop"
      {...dialogProps}
      ref={dialogRef}
    >
      <div className="note-dialog note-dialog--confirm" role="document">
        <div className="note-dialog__header">
          <div>
            <h3 className="note-dialog__title" id={titleId}>
              {title}
            </h3>
            <p className="note-dialog__copy">{body}</p>
          </div>
        </div>
        <div className="note-editor__actions">
          <button
            className="btn btn--quiet"
            disabled={actionPending}
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            className="btn btn-destructive-outline"
            disabled={actionPending}
            onClick={onConfirm}
            type="button"
          >
            {actionPending ? "Working..." : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

function RunActionMenu({
  items,
  onActivate,
  onClose,
  runId,
  x,
  y,
}: {
  items: RunActionMenuItem[];
  onActivate: (item: RunActionMenuItem) => void;
  onClose: () => void;
  runId: string;
  x: number;
  y: number;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });

    function handlePointerDown(event: globalThis.PointerEvent) {
      const menu = menuRef.current;
      if (!menu || !(event.target instanceof Node) || menu.contains(event.target)) {
        return;
      }
      onClose();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onClose]);

  return (
    <div
      aria-label={`Run actions for ${runId}`}
      className="run-action-menu"
      ref={menuRef}
      role="menu"
      style={{ left: x, top: y }}
      tabIndex={-1}
    >
      {items.length === 0 ? (
        <div aria-disabled="true" className="run-action-menu__empty" role="menuitem" tabIndex={-1}>
          No available actions
        </div>
      ) : (
        items.map((item) => (
          <button
            className={
              item.kind === "archive-delete" || item.kind === "delete"
                ? "run-action-menu__item run-action-menu__item--destructive"
                : "run-action-menu__item"
            }
            key={item.action}
            onClick={() => onActivate(item)}
            role="menuitem"
            type="button"
          >
            {item.label}
          </button>
        ))
      )}
    </div>
  );
}

export function RunsDashboardRoute() {
  const state = useRunsDashboardState();
  const [destructiveConfirmation, setDestructiveConfirmation] =
    useState<DestructiveRunConfirmation | null>(null);
  const [runActionMenu, setRunActionMenu] = useState<RunActionMenuState | null>(null);
  const [toggleFiltersVersion, setToggleFiltersVersion] = useState(0);
  const [noteEditRequestVersion, setNoteEditRequestVersion] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const latestStateRef = useRef(state);
  const navigableBoardColumns = state.boardColumns.filter(
    (column) => !state.collapsedColumnKeys.includes(column.key),
  );
  const latestNavigableBoardColumnsRef = useRef(navigableBoardColumns);
  const listKeyboardSelectedRunIdRef = useRef<string | undefined>(state.selectedRunId);

  latestStateRef.current = state;
  latestNavigableBoardColumnsRef.current = navigableBoardColumns;

  useEffect(() => {
    if (state.viewMode !== "list") {
      listKeyboardSelectedRunIdRef.current = state.selectedRunId;
    }
  }, [state.selectedRunId, state.viewMode]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) {
        return;
      }

      const currentState = latestStateRef.current;
      const currentBoardColumns = latestNavigableBoardColumnsRef.current;
      const drawerFullscreen =
        currentState.viewState.drawerFullscreen ||
        document.querySelector(".drawer--fullscreen") !== null;
      const modalOpen = document.querySelector('dialog[open][data-modal="true"]') !== null;
      const typingTarget =
        isEditableEventTarget(event.target) || isEditableEventTarget(document.activeElement);

      const command = resolveRunsShortcutCommand(event, {
        activeBoardColumnKey: currentState.activeBoardColumnKey,
        boardColumns: currentBoardColumns,
        drawerFullscreen,
        hasActiveStructuredFilters: currentState.hasActiveStructuredFilters,
        modalOpen,
        resumeDialogOpen: currentState.resumeDialogOpen,
        searchFocused: document.activeElement === searchInputRef.current,
        searchValue: currentState.viewState.search,
        selectedRunPrimaryActionAvailable: currentState.selectedRunPrimaryActionAvailable,
        selectedRunId: currentState.selectedRunId,
        typingTarget,
        actionPending: currentState.actionPending !== undefined,
        viewMode: currentState.viewMode,
      });

      if (!command) {
        return;
      }

      if (command === "run.destructiveCleanup") {
        if (!currentState.selectedRunId || currentState.actionPending !== undefined) {
          return;
        }
        const selectedRun = findDashboardRun(currentState, currentState.selectedRunId);
        if (!selectedRun) {
          return;
        }
        const action = getRunDestructiveCleanupAction(selectedRun);
        if (action === null) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        setRunActionMenu(null);
        setDestructiveConfirmation({ action, runId: selectedRun.runId });
        return;
      }

      event.stopImmediatePropagation();

      if (command === "ui.focusSearch") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      if (command === "ui.toggleFilters") {
        event.preventDefault();
        setToggleFiltersVersion((current) => current + 1);
        return;
      }

      if (command === "ui.cycleViewMode") {
        event.preventDefault();
        currentState.cycleViewMode();
        return;
      }

      if (isBoardFilterShortcutCommand(command)) {
        event.preventDefault();
        const key = BOARD_FILTER_PREFERENCE_KEYS[command];
        currentState.updatePreferences({
          [key]: !currentState.preferences[key],
        } as Partial<DashboardPreferences>);
        return;
      }

      if (command === "ui.toggleDrawerFullscreen") {
        event.preventDefault();
        currentState.toggleDrawerFullscreen();
        return;
      }

      if (command === "ui.clearSearch") {
        event.preventDefault();
        currentState.updateViewState({ search: "" });
        return;
      }

      if (command === "ui.blurSearch") {
        event.preventDefault();
        searchInputRef.current?.blur();
        return;
      }

      if (command === "ui.clearStructuredFilters") {
        event.preventDefault();
        currentState.clearStructuredFilters();
        return;
      }

      if (command === "run.close") {
        event.preventDefault();
        currentState.closeRun();
        return;
      }

      if (command === "run.primaryAction") {
        event.preventDefault();
        void currentState.triggerSelectedRunPrimaryAction();
        return;
      }

      if (command === "run.showAttachments") {
        event.preventDefault();
        currentState.setActiveRightSurface("attachments");
        return;
      }

      if (command === "run.showChat") {
        event.preventDefault();
        if (currentState.activeRightSurface === "chat") {
          document.getElementById("run-chat-message")?.focus();
          return;
        }
        currentState.setActiveRightSurface("chat");
        return;
      }

      if (command === "run.showDetail") {
        event.preventDefault();
        currentState.setActiveRightSurface("detail");
        return;
      }

      if (command === "run.showNotes") {
        event.preventDefault();
        if (currentState.activeRightSurface === "notes") {
          setNoteEditRequestVersion((current) => current + 1);
          return;
        }
        currentState.setActiveRightSurface("notes");
        return;
      }

      if (command === "run.showTasks") {
        event.preventDefault();
        currentState.setActiveRightSurface("tasks");
        return;
      }

      if (command === "run.togglePinned") {
        if (!currentState.selectedRunId || currentState.actionPending !== undefined) {
          return;
        }
        const selectedRun = findDashboardRun(currentState, currentState.selectedRunId);
        if (!selectedRun) {
          return;
        }
        event.preventDefault();
        void currentState.runActions.setPinned(selectedRun.runId, !selectedRun.pinned);
        return;
      }

      if (command === "run.toggleArchived") {
        if (!currentState.selectedRunId || currentState.actionPending !== undefined) {
          return;
        }
        const selectedRun = findDashboardRun(currentState, currentState.selectedRunId);
        if (!selectedRun) {
          return;
        }
        if (selectedRun.archivedAt) {
          if (!selectedRun.capabilities.canUnarchive) {
            return;
          }
          event.preventDefault();
          currentState.runActions.unarchive(selectedRun.runId);
          return;
        }
        if (!selectedRun.capabilities.canArchive) {
          return;
        }
        event.preventDefault();
        currentState.runActions.archive(selectedRun.runId);
        return;
      }

      if (command === "list.moveUp" || command === "list.moveDown") {
        const listRunIds = currentState.listRows.map((run) => run.runId);
        const keyboardRunId = listKeyboardSelectedRunIdRef.current;
        const currentListRunId =
          keyboardRunId && listRunIds.includes(keyboardRunId)
            ? keyboardRunId
            : currentState.selectedRunId;
        const nextRunId = resolveListNeighborRunId({
          direction: command === "list.moveUp" ? "up" : "down",
          listRunIds,
          selectedRunId: currentListRunId,
        });
        if (!nextRunId || nextRunId === currentListRunId) {
          return;
        }

        event.preventDefault();
        listKeyboardSelectedRunIdRef.current = nextRunId;
        currentState.openRun(nextRunId, { replace: true });
        return;
      }

      if (
        command === "board.moveUp" ||
        command === "board.moveDown" ||
        command === "board.moveLeft" ||
        command === "board.moveRight"
      ) {
        const direction =
          command === "board.moveUp"
            ? "up"
            : command === "board.moveDown"
              ? "down"
              : command === "board.moveLeft"
                ? "left"
                : "right";

        const nextRunId = resolveBoardNeighborRunId({
          activeBoardColumnKey: currentState.activeBoardColumnKey,
          boardColumns: currentBoardColumns,
          direction,
          selectedRunId: currentState.selectedRunId,
        });
        if (!nextRunId || nextRunId === currentState.selectedRunId) {
          return;
        }

        event.preventDefault();
        currentState.openRun(nextRunId, { replace: true });
        return;
      }

      const exhaustiveCommand: never = command;
      throw new Error(`Unhandled shortcut command: ${exhaustiveCommand}`);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!destructiveConfirmation) {
      return;
    }
    if (findDashboardRun(state, destructiveConfirmation.runId)) {
      return;
    }
    setDestructiveConfirmation(null);
  }, [destructiveConfirmation, state]);

  useEffect(() => {
    if (!runActionMenu) {
      return;
    }
    if (!findDashboardRun(state, runActionMenu.runId)) {
      setRunActionMenu(null);
      return;
    }
    if (state.selectedRunId === runActionMenu.selectedRunIdAtOpen) {
      return;
    }
    setRunActionMenu(null);
  }, [runActionMenu, state]);

  useEffect(() => {
    if (state.actionPending !== undefined) {
      setRunActionMenu(null);
    }
  }, [state.actionPending]);

  const closeRunActionMenu = useCallback(() => {
    setRunActionMenu(null);
  }, []);

  async function submitDestructiveConfirmation() {
    const confirmation = destructiveConfirmation;
    if (!confirmation || state.actionPending !== undefined) {
      return;
    }

    const currentState = latestStateRef.current;
    const currentRun = findDashboardRun(currentState, confirmation.runId);
    const currentAction = currentRun ? getRunDestructiveCleanupAction(currentRun) : null;
    if (currentAction !== confirmation.action) {
      setDestructiveConfirmation(null);
      return;
    }

    setDestructiveConfirmation(null);
    try {
      if (confirmation.action === "archive-delete") {
        await currentState.runActions.archiveThenDelete(confirmation.runId);
      } else {
        await currentState.runActions.deleteConfirmed(confirmation.runId);
      }
    } catch {
      // actionError is surfaced by the shared mutation handlers.
    }
  }

  function openRunActionMenu(runId: string, point: { clientX: number; clientY: number }) {
    const currentState = latestStateRef.current;
    const run = findDashboardRun(currentState, runId);
    setRunActionMenu(null);

    if (!run) {
      return;
    }
    const items = getRunActionMenuItems(run);

    const width = 220;
    const height = items.length === 0 ? 44 : Math.min(360, items.length * 36 + 12);
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const clientX = Number.isFinite(point.clientX) ? point.clientX : 8;
    const clientY = Number.isFinite(point.clientY) ? point.clientY : 8;
    const nextMenu = {
      items,
      runId,
      selectedRunIdAtOpen: currentState.selectedRunId,
      x: Math.min(Math.max(8, clientX), Math.max(8, viewportWidth - width - 8)),
      y: Math.min(Math.max(8, clientY), Math.max(8, viewportHeight - height - 8)),
    };
    setRunActionMenu(nextMenu);
  }

  const activateRunActionMenuItem = useCallback(
    (item: RunActionMenuItem) => {
      const menu = runActionMenu;
      const currentState = latestStateRef.current;
      if (!menu || currentState.actionPending !== undefined) {
        return;
      }
      setRunActionMenu(null);

      switch (item.action) {
        case "archive":
          currentState.runActions.archive(menu.runId);
          return;
        case "unarchive":
          currentState.runActions.unarchive(menu.runId);
          return;
        case "archive-delete":
        case "delete":
          setDestructiveConfirmation({ action: item.action, runId: menu.runId });
          return;
        case "ready":
        case "start":
        case "resume":
          void currentState.triggerRunPrimaryAction(menu.runId);
          return;
      }

      const exhaustiveAction: never = item.action;
      throw new Error(`Unhandled run action menu item: ${exhaustiveAction}`);
    },
    [runActionMenu],
  );

  const topNotices = [
    state.streamStale ? (
      <div className="notice" data-tone="warning" key="stream-stale">
        <span className="notice__message">
          Live updates are temporarily stale. The board stays usable and falls back to HTTP refetch.
        </span>
        <div className="notice__actions">
          <button className="btn" onClick={() => void state.runsQuery.refetch()} type="button">
            Refetch now
          </button>
        </div>
      </div>
    ) : null,
  ].filter(Boolean);

  const bottomNotices = state.notices.map((notice) => (
    <div className="notice" data-tone={notice.tone} key={notice.id}>
      <span className="notice__message">{notice.message}</span>
      <div className="notice__actions">
        <button
          aria-label="Dismiss notice"
          className="icon-btn icon-btn--small"
          onClick={() => state.dismissNotice(notice.id)}
          type="button"
        >
          ×
        </button>
      </div>
    </div>
  ));
  const renderDashboardPanel = DASHBOARD_PANEL_RENDERERS[state.viewMode];
  const selectRunFromList = useCallback(
    (runId: string) => {
      listKeyboardSelectedRunIdRef.current = runId;
      state.openRun(runId);
    },
    [state],
  );
  const openRunNoteFromList = useCallback(
    (runId: string) => {
      listKeyboardSelectedRunIdRef.current = runId;
      state.openRun(runId);
      state.setActiveRightSurface("notes");
      setNoteEditRequestVersion((current) => current + 1);
    },
    [state],
  );

  return (
    <>
      <AppShell
        primary={
          <DashboardSurfaces
            primary={renderDashboardPanel({
              onListSelectRun: selectRunFromList,
              onOpenRunNote: openRunNoteFromList,
              onRequestActionMenu: openRunActionMenu,
              state,
            })}
            detail={
              state.selectedRunId ? (
                <RunDetailPanel
                  activeRightSurface={state.activeRightSurface}
                  onAddDependency={state.runActions.addDependency}
                  actionError={state.actionError}
                  actionPending={state.actionPending}
                  chatSurface={
                    <RunChatView
                      detailSettling={state.detailSettling}
                      onDownloadAttachment={state.runActions.downloadAttachment}
                      onOpenAttachmentPreview={state.openSelectedRunAttachmentPreview}
                      onRemoveQueuedMessage={state.runActions.removeQueuedResumeMessage}
                      onQueueMessage={state.runActions.queueResumeMessage}
                      onSubmitResume={state.runActions.resume}
                      queuePending={state.queueResumeMessagePendingRunId === state.selectedRunId}
                      removingQueuedMessageId={state.removeQueuedResumeMessagePendingId}
                      resumePending={state.resumePendingRunId === state.selectedRunId}
                      selectedRunId={state.selectedRunId}
                      selectedRunQuery={state.selectedRunQuery}
                      timelineState={state.timelineState}
                    />
                  }
                  drawerFullscreen={state.viewState.drawerFullscreen}
                  drawerWidth={state.viewState.drawerWidth}
                  drawerView={state.selectedDrawerView}
                  attachmentPreviewSelection={state.selectedAttachmentPreview}
                  noteEditRequestVersion={noteEditRequestVersion}
                  runs={state.runs}
                  onAbort={state.runActions.abort}
                  onArchive={state.runActions.archive}
                  onClearDependencies={state.runActions.clearDependencies}
                  onClose={state.closeRun}
                  onCloseResumeDialog={state.closeSelectedRunResumeDialog}
                  onCopy={state.copyText}
                  onDelete={state.runActions.delete}
                  onDownloadAttachment={state.runActions.downloadAttachment}
                  onOpenAttachmentPreview={state.openSelectedRunAttachmentPreview}
                  onReplaceAttachmentPreview={state.replaceSelectedRunAttachmentPreview}
                  onSelectRun={state.openRun}
                  onClearBackendSession={state.runActions.clearBackendSession}
                  onClearSchedule={state.runActions.clearSchedule}
                  onRemoveDependency={state.runActions.removeDependency}
                  onRemoveAttachment={state.runActions.removeAttachment}
                  onReset={state.runActions.reset}
                  onReconfigure={state.runActions.reconfigure}
                  onRename={state.runActions.rename}
                  onResumeMessageDraftChange={state.setResumeMessageDraft}
                  onResumeMessageExpandedChange={state.setResumeMessageExpanded}
                  onSetNote={state.runActions.setNote}
                  onSetBackendSession={state.runActions.setBackendSession}
                  onSetGroup={state.runActions.setGroup}
                  onClearGroup={state.runActions.clearGroup}
                  onSetPinned={state.runActions.setPinned}
                  onSetScheduleEnabled={state.runActions.setScheduleEnabled}
                  onSelectDetailSection={state.updateSelectedRunDetailSection}
                  onSelectRightSurface={state.setActiveRightSurface}
                  onSubmitResume={state.submitSelectedRunResume}
                  onTriggerPrimaryAction={state.triggerSelectedRunPrimaryAction}
                  onUnarchive={state.runActions.unarchive}
                  onUploadAttachment={state.runActions.uploadAttachment}
                  resumeDialogOpen={state.resumeDialogOpen}
                  resumeRequiresMessage={state.selectedRunResumeRequiresMessage}
                  resumeMessageDraft={state.resumeMessageDraft}
                  resumeMessageExpanded={state.resumeMessageExpanded}
                  detailSettling={state.detailSettling}
                  selectedRunGroupAttachmentsQuery={state.selectedRunGroupAttachmentsQuery}
                  selectedRunQuery={state.selectedRunQuery}
                  auditState={state.auditState}
                  timelineState={state.timelineState}
                />
              ) : null
            }
          />
        }
        bottomNotices={bottomNotices.length > 0 ? bottomNotices : undefined}
        topNotices={topNotices.length > 0 ? topNotices : undefined}
        toolbar={
          <RunFilters
            filterOptions={state.filterOptions}
            preferences={state.preferences}
            toggleFiltersVersion={toggleFiltersVersion}
            searchInputRef={searchInputRef}
            onViewModeChange={state.setViewMode}
            updatePreferences={state.updatePreferences}
            updateViewState={state.updateViewState}
            viewState={state.viewState}
          />
        }
      />
      {destructiveConfirmation ? (
        <DestructiveRunConfirmationDialog
          action={destructiveConfirmation.action}
          actionPending={state.actionPending !== undefined}
          onCancel={() => setDestructiveConfirmation(null)}
          onConfirm={() => void submitDestructiveConfirmation()}
        />
      ) : null}
      {runActionMenu ? (
        <RunActionMenu
          items={runActionMenu.items}
          onActivate={activateRunActionMenuItem}
          onClose={closeRunActionMenu}
          runId={runActionMenu.runId}
          x={runActionMenu.x}
          y={runActionMenu.y}
        />
      ) : null}
    </>
  );
}
