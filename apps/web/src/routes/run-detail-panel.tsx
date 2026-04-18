import type { UseQueryResult } from "@tanstack/react-query";
import type { AttachmentListEntry } from "@task-runner/core/contracts/attachments.js";
import type { RunDetail, RunSummary } from "@task-runner/core/contracts/runs.js";
import type { CSSProperties } from "react";
import { AttachmentPreviewDrawer } from "../components/attachment-preview-drawer.js";
import { RunDetailDrawer } from "../components/run-detail-drawer.js";
import { isNotFoundError } from "../lib/api-client.js";
import type { RunTimelineState } from "../lib/run-timeline.js";
import type { AttachmentTab, DrawerDetailSection, RunDrawerView } from "../lib/settings.js";
import type { RunActionPending } from "./use-runs-dashboard-state.js";

export function RunDetailPanel({
  onAddDependency,
  actionError,
  actionPending,
  drawerFullscreen,
  drawerWidth,
  drawerView,
  runs,
  onBackToAttachments,
  onAbort,
  onArchive,
  onClearDependencies,
  onClose,
  onCloseResumeDialog,
  onCopy,
  onDelete,
  onDownloadAttachment,
  onOpenResumeDialog,
  onOpenAttachmentPreview,
  onSelectAttachmentTab,
  onClearBackendSession,
  onRemoveDependency,
  onRemoveAttachment,
  onReset,
  onRename,
  onResumeMessageDraftChange,
  onResumeMessageExpandedChange,
  onSetBackendSession,
  onSelectDetailSection,
  onSubmitResume,
  onTriggerPrimaryAction,
  onUnarchive,
  onUploadAttachment,
  resumeDialogOpen,
  resumeMessageDraft,
  resumeMessageExpanded,
  detailSettling,
  selectedRunGroupAttachmentsQuery,
  selectedRunId,
  selectedRunQuery,
  timelineState,
}: {
  onAddDependency: (runId: string, dependencyRunId: string) => Promise<void>;
  actionError?: string;
  actionPending?: RunActionPending;
  drawerFullscreen: boolean;
  drawerWidth: number;
  drawerView?: RunDrawerView;
  runs: RunSummary[];
  onBackToAttachments: () => void;
  onAbort: (runId: string) => void;
  onArchive: (runId: string) => void;
  onClearDependencies: (runId: string) => Promise<void>;
  onClose: () => void;
  onCloseResumeDialog: () => void;
  onCopy: (value: string, label: string) => Promise<void>;
  onDelete: (runId: string) => void;
  onDownloadAttachment: (runId: string, attachmentId: string, name: string) => Promise<void>;
  onOpenResumeDialog: () => void;
  onOpenAttachmentPreview: (
    attachmentOwnerRunId: string,
    attachmentId: string,
    attachmentTab: AttachmentTab,
  ) => void;
  onSelectAttachmentTab: (attachmentTab: AttachmentTab) => void;
  onClearBackendSession: (runId: string) => Promise<void>;
  onRemoveDependency: (runId: string, dependencyRunId: string) => Promise<void>;
  onRemoveAttachment: (runId: string, attachmentId: string) => Promise<void>;
  onReset: (runId: string) => void;
  onRename: (runId: string, name: string | null) => Promise<void>;
  onResumeMessageDraftChange: (value: string) => void;
  onResumeMessageExpandedChange: (expanded: boolean) => void;
  onSetBackendSession: (runId: string, backendSessionId: string) => Promise<void>;
  onSelectDetailSection: (section: DrawerDetailSection) => void;
  onSubmitResume: () => Promise<void>;
  onTriggerPrimaryAction: () => Promise<void>;
  onUnarchive: (runId: string) => void;
  onUploadAttachment: (runId: string, file: File) => Promise<void>;
  resumeDialogOpen: boolean;
  resumeMessageDraft: string;
  resumeMessageExpanded: boolean;
  detailSettling: boolean;
  selectedRunGroupAttachmentsQuery: UseQueryResult<AttachmentListEntry[], Error>;
  selectedRunId?: string;
  selectedRunQuery: UseQueryResult<RunDetail, Error>;
  timelineState: RunTimelineState;
}) {
  if (!selectedRunId) {
    return undefined;
  }

  const drawerStyle = { "--drawer-width": `${drawerWidth}px` } as CSSProperties;
  const drawerClassName = drawerFullscreen ? "drawer drawer--fullscreen" : "drawer";

  function renderLoadingState() {
    return (
      <aside
        aria-label="Run detail"
        className={`${drawerClassName} drawer-skeleton`}
        style={drawerStyle}
      >
        <div className="drawer-state">
          <div className="skeleton-line skeleton-line--short" />
          <div className="skeleton-line skeleton-line--medium" style={{ marginTop: "12px" }} />
          <div className="skeleton-line skeleton-line--medium" style={{ marginTop: "12px" }} />
        </div>
      </aside>
    );
  }

  if (detailSettling || selectedRunQuery.isPending) {
    return renderLoadingState();
  }

  if (selectedRunQuery.isError && !isNotFoundError(selectedRunQuery.error)) {
    return (
      <aside aria-label="Run detail" className={drawerClassName} style={drawerStyle}>
        <div className="drawer-state">
          <h3>Run detail failed to load</h3>
          <p>{selectedRunQuery.error.message}</p>
          <button className="btn" onClick={() => void selectedRunQuery.refetch()} type="button">
            Retry detail load
          </button>
        </div>
      </aside>
    );
  }

  if (!selectedRunQuery.data) {
    return undefined;
  }

  const selectedRun = selectedRunQuery.data;
  if (drawerView?.mode === "attachment") {
    const attachmentEntries =
      drawerView.attachmentTab === "run"
        ? selectedRun.attachments.map((candidate) => ({
            attachment: candidate,
            ownerRunId: selectedRun.runId,
          }))
        : (selectedRunGroupAttachmentsQuery.data ?? []).map((candidate) => ({
            attachment: candidate,
            ownerRunId: candidate.ownerRunId,
          }));
    const currentAttachmentIndex = attachmentEntries.findIndex(
      ({ attachment, ownerRunId }) =>
        attachment.id === drawerView.attachmentId && ownerRunId === drawerView.attachmentOwnerRunId,
    );
    const previousAttachment =
      currentAttachmentIndex > 0 ? attachmentEntries[currentAttachmentIndex - 1] : undefined;
    const nextAttachment =
      currentAttachmentIndex >= 0 ? attachmentEntries[currentAttachmentIndex + 1] : undefined;
    const attachment =
      drawerView.attachmentOwnerRunId === selectedRun.runId
        ? selectedRun.attachments.find((candidate) => candidate.id === drawerView.attachmentId)
        : selectedRunGroupAttachmentsQuery.data?.find(
            (candidate) =>
              candidate.id === drawerView.attachmentId &&
              candidate.ownerRunId === drawerView.attachmentOwnerRunId,
          );
    return (
      <AttachmentPreviewDrawer
        actionPending={actionPending}
        attachment={attachment}
        attachmentId={drawerView.attachmentId}
        attachmentLookupError={
          drawerView.attachmentOwnerRunId === selectedRun.runId
            ? undefined
            : selectedRunGroupAttachmentsQuery.error?.message
        }
        attachmentLookupPending={
          drawerView.attachmentOwnerRunId !== selectedRun.runId &&
          selectedRunGroupAttachmentsQuery.isPending
        }
        onBack={onBackToAttachments}
        onClose={onClose}
        onDownload={(attachmentId, name) =>
          onDownloadAttachment(drawerView.attachmentOwnerRunId, attachmentId, name)
        }
        onNextAttachment={
          nextAttachment
            ? () =>
                onOpenAttachmentPreview(
                  nextAttachment.ownerRunId,
                  nextAttachment.attachment.id,
                  drawerView.attachmentTab,
                )
            : undefined
        }
        onPreviousAttachment={
          previousAttachment
            ? () =>
                onOpenAttachmentPreview(
                  previousAttachment.ownerRunId,
                  previousAttachment.attachment.id,
                  drawerView.attachmentTab,
                )
            : undefined
        }
        nextAttachmentName={nextAttachment?.attachment.name}
        previousAttachmentName={previousAttachment?.attachment.name}
        runId={drawerView.attachmentOwnerRunId}
      />
    );
  }

  return (
    <RunDetailDrawer
      activeSection={drawerView?.detailSection ?? "tasks"}
      dependencyCandidateRuns={runs}
      onAddDependency={(dependencyRunId) => onAddDependency(selectedRun.runId, dependencyRunId)}
      actionError={actionError}
      actionPending={actionPending}
      key={selectedRun.runId}
      onAbort={() => onAbort(selectedRun.runId)}
      onArchive={() => onArchive(selectedRun.runId)}
      onClearDependencies={() => onClearDependencies(selectedRun.runId)}
      onClose={onClose}
      onCloseResumeDialog={onCloseResumeDialog}
      onCopy={(value, label) => void onCopy(value, label)}
      onDelete={() => onDelete(selectedRun.runId)}
      groupAttachmentsQuery={selectedRunGroupAttachmentsQuery}
      onDownloadAttachment={(ownerRunId, attachmentId, name) =>
        onDownloadAttachment(ownerRunId, attachmentId, name)
      }
      onOpenResumeDialog={onOpenResumeDialog}
      onOpenAttachmentPreview={onOpenAttachmentPreview}
      onClearBackendSession={() => onClearBackendSession(selectedRun.runId)}
      onRemoveDependency={(dependencyRunId) =>
        onRemoveDependency(selectedRun.runId, dependencyRunId)
      }
      onRemoveAttachment={(attachmentId) => onRemoveAttachment(selectedRun.runId, attachmentId)}
      onReset={() => onReset(selectedRun.runId)}
      onRename={(name) => onRename(selectedRun.runId, name)}
      onResumeMessageDraftChange={onResumeMessageDraftChange}
      onResumeMessageExpandedChange={onResumeMessageExpandedChange}
      onSelectAttachmentTab={onSelectAttachmentTab}
      onSetBackendSession={(backendSessionId) =>
        onSetBackendSession(selectedRun.runId, backendSessionId)
      }
      onSelectSection={onSelectDetailSection}
      onSubmitResume={onSubmitResume}
      onTriggerPrimaryAction={onTriggerPrimaryAction}
      timelineState={timelineState}
      onUnarchive={() => onUnarchive(selectedRun.runId)}
      onUploadAttachment={(file) => onUploadAttachment(selectedRun.runId, file)}
      resumeDialogOpen={resumeDialogOpen}
      resumeMessageDraft={resumeMessageDraft}
      resumeMessageExpanded={resumeMessageExpanded}
      selectedAttachmentTab={drawerView?.attachmentTab ?? "run"}
      run={selectedRun}
    />
  );
}
