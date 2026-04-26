import { useEffect, useRef, useState } from "react";
import { AppShell } from "../components/app-shell.js";
import { RunFilters } from "../components/run-filters.js";
import type { DashboardPreferences } from "../lib/settings.js";
import {
  isEditableEventTarget,
  resolveBoardNeighborRunId,
  resolveRunsShortcutCommand,
} from "../lib/shortcuts.js";
import { RunDetailPanel } from "./run-detail-panel.js";
import { RunsBoardPanel } from "./runs-board-panel.js";
import { useRunsDashboardState } from "./use-runs-dashboard-state.js";

const BOARD_FILTER_PREFERENCE_KEYS = {
  "ui.toggleScheduledOnly": "showScheduledOnly",
  "ui.togglePinnedOnly": "showPinnedOnly",
  "ui.toggleNotesOnly": "showNotesOnly",
  "ui.toggleArchived": "showArchived",
  "ui.toggleHideEmptyColumns": "hideEmptyColumns",
} satisfies Record<string, keyof DashboardPreferences>;

type BoardFilterShortcutCommand = keyof typeof BOARD_FILTER_PREFERENCE_KEYS;

function isBoardFilterShortcutCommand(command: string): command is BoardFilterShortcutCommand {
  return command in BOARD_FILTER_PREFERENCE_KEYS;
}

export function RunsDashboardRoute() {
  const state = useRunsDashboardState();
  const [toggleFiltersVersion, setToggleFiltersVersion] = useState(0);
  const [openSelectedRunNoteRequest, setOpenSelectedRunNoteRequest] = useState<{
    runId: string;
    version: number;
  } | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const latestStateRef = useRef(state);
  const navigableBoardColumns = state.boardColumns.filter(
    (column) => !state.collapsedColumnKeys.includes(column.key),
  );
  const latestNavigableBoardColumnsRef = useRef(navigableBoardColumns);

  latestStateRef.current = state;
  latestNavigableBoardColumnsRef.current = navigableBoardColumns;

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
      const modalOpen = document.querySelector(".note-modal[open]") !== null;

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
        selectedDrawerView: currentState.selectedDrawerView,
        selectedRunId: currentState.selectedRunId,
        typingTarget: isEditableEventTarget(event.target),
      });

      if (!command) {
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

      if (command === "run.closeAttachmentPreview") {
        event.preventDefault();
        currentState.returnSelectedRunToAttachments();
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

      if (command === "run.openNote") {
        if (!currentState.selectedRunId || currentState.actionPending !== undefined) {
          return;
        }
        event.preventDefault();
        const selectedRunId = currentState.selectedRunId;
        setOpenSelectedRunNoteRequest((current) => ({
          runId: selectedRunId,
          version: (current?.version ?? 0) + 1,
        }));
        return;
      }

      if (command === "run.togglePinned") {
        if (!currentState.selectedRunId || currentState.actionPending !== undefined) {
          return;
        }
        const selectedRun =
          currentState.runs.find((run) => run.runId === currentState.selectedRunId) ??
          currentState.selectedRunQuery.data;
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
        const selectedRun =
          currentState.runs.find((run) => run.runId === currentState.selectedRunId) ??
          currentState.selectedRunQuery.data;
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

  return (
    <AppShell
      primary={
        <RunsBoardPanel
          actionPending={state.actionPending}
          activeBoardColumnKey={state.activeBoardColumnKey}
          boardColumns={state.boardColumns}
          collapsedColumnKeys={state.collapsedColumnKeys}
          hasActiveStructuredFilters={state.hasActiveStructuredFilters}
          openSelectedRunNoteRequest={openSelectedRunNoteRequest}
          onExpandColumn={state.columnActions.expand}
          onActiveBoardColumnKeyChange={state.setActiveBoardColumnKey}
          onResetFilters={state.resetBoardFilters}
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
      }
      bottomNotices={bottomNotices.length > 0 ? bottomNotices : undefined}
      secondary={
        <RunDetailPanel
          onAddDependency={state.runActions.addDependency}
          actionError={state.actionError}
          actionPending={state.actionPending}
          drawerFullscreen={state.viewState.drawerFullscreen}
          drawerWidth={state.viewState.drawerWidth}
          drawerView={state.selectedDrawerView}
          runs={state.runs}
          onBackToAttachments={state.returnSelectedRunToAttachments}
          onAbort={state.runActions.abort}
          onArchive={state.runActions.archive}
          onClearDependencies={state.runActions.clearDependencies}
          onClose={state.closeRun}
          onCloseResumeDialog={state.closeSelectedRunResumeDialog}
          onCopy={state.copyText}
          onDelete={state.runActions.delete}
          onDownloadAttachment={state.runActions.downloadAttachment}
          onOpenResumeDialog={state.openSelectedRunResumeDialog}
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
          onSetPinned={state.runActions.setPinned}
          onSetScheduleEnabled={state.runActions.setScheduleEnabled}
          onSelectDetailSection={state.updateSelectedRunDetailSection}
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
          selectedRunId={state.selectedRunId}
          selectedRunQuery={state.selectedRunQuery}
          auditState={state.auditState}
          timelineState={state.timelineState}
        />
      }
      topNotices={topNotices.length > 0 ? topNotices : undefined}
      toolbar={
        <RunFilters
          filterOptions={state.filterOptions}
          preferences={state.preferences}
          toggleFiltersVersion={toggleFiltersVersion}
          searchInputRef={searchInputRef}
          updatePreferences={state.updatePreferences}
          updateViewState={state.updateViewState}
          viewState={state.viewState}
        />
      }
    />
  );
}
