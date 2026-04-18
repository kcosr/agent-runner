import { useEffect, useRef } from "react";
import { AppShell } from "../components/app-shell.js";
import { RunFilters } from "../components/run-filters.js";
import {
  isEditableEventTarget,
  resolveBoardNeighborRunId,
  resolveRunsShortcutCommand,
} from "../lib/shortcuts.js";
import { RunDetailPanel } from "./run-detail-panel.js";
import { RunsBoardPanel } from "./runs-board-panel.js";
import { useRunsDashboardState } from "./use-runs-dashboard-state.js";

export function RunsDashboardRoute() {
  const state = useRunsDashboardState();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const navigableBoardColumns = state.boardColumns.filter(
    (column) => !state.collapsedColumnKeys.includes(column.key),
  );

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) {
        return;
      }

      const command = resolveRunsShortcutCommand(event, {
        activeBoardColumnKey: state.activeBoardColumnKey,
        boardColumns: navigableBoardColumns,
        resumeDialogOpen: state.resumeDialogOpen,
        searchFocused: document.activeElement === searchInputRef.current,
        searchValue: state.viewState.search,
        selectedRunPrimaryActionAvailable: state.selectedRunPrimaryActionAvailable,
        selectedDrawerView: state.selectedDrawerView,
        selectedRunId: state.selectedRunId,
        typingTarget: isEditableEventTarget(event.target),
      });

      if (!command) {
        return;
      }

      if (command === "ui.focusSearch") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      if (command === "ui.clearSearch") {
        event.preventDefault();
        state.updateViewState({ search: "" });
        return;
      }

      if (command === "ui.blurSearch") {
        event.preventDefault();
        searchInputRef.current?.blur();
        return;
      }

      if (command === "run.closeAttachmentPreview") {
        event.preventDefault();
        state.returnSelectedRunToAttachments();
        return;
      }

      if (command === "run.close") {
        event.preventDefault();
        state.closeRun();
        return;
      }

      if (command === "run.primaryAction") {
        event.preventDefault();
        void state.triggerSelectedRunPrimaryAction();
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
          activeBoardColumnKey: state.activeBoardColumnKey,
          boardColumns: navigableBoardColumns,
          direction,
          selectedRunId: state.selectedRunId,
        });
        if (!nextRunId || nextRunId === state.selectedRunId) {
          return;
        }

        event.preventDefault();
        state.openRun(nextRunId, { replace: true });
        return;
      }

      const exhaustiveCommand: never = command;
      throw new Error(`Unhandled shortcut command: ${exhaustiveCommand}`);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    state.activeBoardColumnKey,
    state.closeRun,
    navigableBoardColumns,
    state.openRun,
    state.resumeDialogOpen,
    state.returnSelectedRunToAttachments,
    state.selectedRunPrimaryActionAvailable,
    state.selectedDrawerView,
    state.selectedRunId,
    state.triggerSelectedRunPrimaryAction,
    state.updateViewState,
    state.viewState.search,
  ]);

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
          activeBoardColumnKey={state.activeBoardColumnKey}
          boardColumns={state.boardColumns}
          collapsedColumnKeys={state.collapsedColumnKeys}
          onExpandColumn={state.columnActions.expand}
          onActiveBoardColumnKeyChange={state.setActiveBoardColumnKey}
          onResetFilters={state.resetBoardFilters}
          onSelectRun={state.openRun}
          onToggleColumnCollapse={state.columnActions.toggleCollapse}
          runs={state.runs}
          runsQuery={state.runsQuery}
          selectedRunId={state.selectedRunId}
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
          onSelectAttachmentTab={state.updateSelectedRunAttachmentTab}
          onClearBackendSession={state.runActions.clearBackendSession}
          onRemoveDependency={state.runActions.removeDependency}
          onRemoveAttachment={state.runActions.removeAttachment}
          onReset={state.runActions.reset}
          onRename={state.runActions.rename}
          onResumeMessageDraftChange={state.setResumeMessageDraft}
          onResumeMessageExpandedChange={state.setResumeMessageExpanded}
          onSetBackendSession={state.runActions.setBackendSession}
          onSelectDetailSection={state.updateSelectedRunDetailSection}
          onSubmitResume={state.submitSelectedRunResume}
          onTriggerPrimaryAction={state.triggerSelectedRunPrimaryAction}
          onUnarchive={state.runActions.unarchive}
          onUploadAttachment={state.runActions.uploadAttachment}
          resumeDialogOpen={state.resumeDialogOpen}
          resumeMessageDraft={state.resumeMessageDraft}
          resumeMessageExpanded={state.resumeMessageExpanded}
          detailSettling={state.detailSettling}
          selectedRunGroupAttachmentsQuery={state.selectedRunGroupAttachmentsQuery}
          selectedRunId={state.selectedRunId}
          selectedRunQuery={state.selectedRunQuery}
          timelineState={state.timelineState}
        />
      }
      topNotices={topNotices.length > 0 ? topNotices : undefined}
      toolbar={
        <RunFilters
          preferences={state.preferences}
          repoOptions={state.repoOptions}
          searchInputRef={searchInputRef}
          updatePreferences={state.updatePreferences}
          updateViewState={state.updateViewState}
          viewState={state.viewState}
        />
      }
    />
  );
}
