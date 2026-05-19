import type { AttachmentListEntry } from "@kcosr/agent-runner-core/contracts/attachments.js";
import type {
  RunDependencyRef,
  RunDetail,
  RunSummary,
} from "@kcosr/agent-runner-core/contracts/runs.js";
import type { UseQueryResult } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { ResumeRunDialog } from "../components/resume-run-dialog.js";
import { RunDetailDrawer } from "../components/run-detail-drawer.js";
import type { ReconfigureRunPatch } from "../lib/api-client.js";
import { isNotFoundError, isUnauthorizedError } from "../lib/api-client.js";
import type { RunAuditState } from "../lib/run-audit.js";
import type { RunTimelineState } from "../lib/run-timeline.js";
import type {
  AttachmentPreviewSelection,
  DashboardRightSurface,
  DrawerDetailSection,
  RunDrawerView,
} from "../lib/settings.js";
import type { DashboardNoticeTone, RunActionPending } from "./use-runs-dashboard-state.js";

export function RunDetailPanel({
  activeRightSurface,
  onAddDependency,
  actionError,
  actionPending,
  chatSurface,
  drawerFullscreen,
  drawerWidth,
  drawerView,
  attachmentPreviewSelection,
  noteEditRequestVersion,
  runs,
  onAbort,
  onArchive,
  onClearDependencies,
  onClose,
  onCloseResumeDialog,
  onCopy,
  onDelete,
  onDownloadAttachment,
  onNotify,
  onOpenAttachmentPreview,
  onReplaceAttachmentPreview,
  onSelectRun,
  onClearBackendSession,
  onClearSchedule,
  onRemoveDependency,
  onRemoveAttachment,
  onReset,
  onReconfigure,
  onRename,
  onResumeMessageDraftChange,
  onResumeMessageExpandedChange,
  onSetNote,
  onSetBackendSession,
  onSetGroup,
  onClearGroup,
  onSetPinned,
  onSetScheduleEnabled,
  onSelectDetailSection,
  onSelectRightSurface,
  onSubmitResume,
  onTriggerPrimaryAction,
  onUnarchive,
  onUploadAttachment,
  resumeDialogOpen,
  resumeRequiresMessage,
  resumeMessageDraft,
  resumeMessageExpanded,
  detailSettling,
  selectedRunGroupAttachmentsQuery,
  selectedRunQuery,
  auditState,
  timelineState,
}: {
  activeRightSurface: DashboardRightSurface;
  onAddDependency: (runId: string, dependency: RunDependencyRef) => Promise<void>;
  actionError?: string;
  actionPending?: RunActionPending;
  chatSurface: ReactNode;
  drawerFullscreen: boolean;
  drawerWidth: number;
  drawerView?: RunDrawerView;
  attachmentPreviewSelection?: AttachmentPreviewSelection;
  noteEditRequestVersion: number;
  runs: RunSummary[];
  onAbort: (runId: string) => void;
  onArchive: (runId: string) => void;
  onClearDependencies: (runId: string) => Promise<void>;
  onClose: () => void;
  onCloseResumeDialog: () => void;
  onCopy: (value: string, label: string) => Promise<void>;
  onDelete: (runId: string) => void;
  onDownloadAttachment: (runId: string, attachmentId: string, name: string) => Promise<void>;
  onNotify: (message: string, tone?: DashboardNoticeTone) => void;
  onOpenAttachmentPreview: (attachmentOwnerRunId: string, attachmentId: string) => void;
  onReplaceAttachmentPreview: (attachmentOwnerRunId: string, attachmentId: string) => void;
  onSelectRun: (runId: string) => void;
  onClearBackendSession: (runId: string) => Promise<void>;
  onClearSchedule: (runId: string) => Promise<void>;
  onRemoveDependency: (runId: string, dependency: RunDependencyRef) => Promise<void>;
  onRemoveAttachment: (runId: string, attachmentId: string) => Promise<void>;
  onReset: (runId: string) => void;
  onReconfigure: (runId: string, patch: ReconfigureRunPatch) => Promise<void>;
  onRename: (runId: string, name: string | null) => Promise<void>;
  onResumeMessageDraftChange: (value: string) => void;
  onResumeMessageExpandedChange: (expanded: boolean) => void;
  onSetNote: (runId: string, note: string | null) => Promise<void>;
  onSetBackendSession: (runId: string, backendSessionId: string) => Promise<void>;
  onSetGroup: (runId: string, runGroupId: string) => Promise<void>;
  onClearGroup: (runId: string) => Promise<void>;
  onSetPinned: (runId: string, pinned: boolean) => Promise<void>;
  onSetScheduleEnabled: (runId: string, enabled: boolean) => Promise<void>;
  onSelectDetailSection: (section: DrawerDetailSection) => void;
  onSelectRightSurface: (surface: DashboardRightSurface) => void;
  onSubmitResume: () => Promise<void>;
  onTriggerPrimaryAction: () => Promise<void>;
  onUnarchive: (runId: string) => void;
  onUploadAttachment: (runId: string, file: File) => Promise<void>;
  resumeDialogOpen: boolean;
  resumeRequiresMessage: boolean;
  resumeMessageDraft: string;
  resumeMessageExpanded: boolean;
  detailSettling: boolean;
  selectedRunGroupAttachmentsQuery: UseQueryResult<AttachmentListEntry[], Error>;
  selectedRunQuery: UseQueryResult<RunDetail, Error>;
  auditState: RunAuditState;
  timelineState: RunTimelineState;
}) {
  const navigate = useNavigate();
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

  if (selectedRunQuery.isError && isUnauthorizedError(selectedRunQuery.error)) {
    return (
      <aside aria-label="Run detail" className={drawerClassName} style={drawerStyle}>
        <div className="drawer-state">
          <h3>Daemon token required</h3>
          <p>Enter the daemon token in Settings to load this run from the daemon.</p>
          <button
            className="btn btn-primary"
            onClick={() => void navigate({ to: "/settings/general" })}
            type="button"
          >
            Open Settings
          </button>
        </div>
      </aside>
    );
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
  const resumeDialog = resumeDialogOpen ? (
    <ResumeRunDialog
      actionError={actionError}
      actionPending={actionPending}
      onClose={onCloseResumeDialog}
      onMessageDraftChange={onResumeMessageDraftChange}
      onMessageExpandedChange={onResumeMessageExpandedChange}
      onSubmit={onSubmitResume}
      resumeRequiresMessage={resumeRequiresMessage}
      resumeMessageDraft={resumeMessageDraft}
      resumeMessageExpanded={resumeMessageExpanded}
    />
  ) : null;

  const activeDetailSection = drawerView?.detailSection ?? "attachments";

  return (
    <>
      <RunDetailDrawer
        activeSection={activeDetailSection}
        activeSurface={activeRightSurface}
        attachmentPreviewSelection={attachmentPreviewSelection}
        chatSurface={chatSurface}
        dependencyCandidateRuns={runs}
        noteEditRequestVersion={noteEditRequestVersion}
        onAddDependency={(dependency) => onAddDependency(selectedRun.runId, dependency)}
        actionError={actionError}
        actionPending={actionPending}
        key={selectedRun.runId}
        onAbort={() => onAbort(selectedRun.runId)}
        onArchive={() => onArchive(selectedRun.runId)}
        onClearDependencies={() => onClearDependencies(selectedRun.runId)}
        onClose={onClose}
        onCopy={(value, label) => void onCopy(value, label)}
        onDelete={() => onDelete(selectedRun.runId)}
        groupAttachmentsQuery={selectedRunGroupAttachmentsQuery}
        onDownloadAttachment={(ownerRunId, attachmentId, name) =>
          onDownloadAttachment(ownerRunId, attachmentId, name)
        }
        onNotify={onNotify}
        onOpenAttachmentPreview={onOpenAttachmentPreview}
        onReplaceAttachmentPreview={onReplaceAttachmentPreview}
        onSelectRun={onSelectRun}
        onClearBackendSession={() => onClearBackendSession(selectedRun.runId)}
        onClearSchedule={() => onClearSchedule(selectedRun.runId)}
        onRemoveDependency={(dependency) => onRemoveDependency(selectedRun.runId, dependency)}
        onRemoveAttachment={(attachmentId) => onRemoveAttachment(selectedRun.runId, attachmentId)}
        onReset={() => onReset(selectedRun.runId)}
        onReconfigure={(patch) => onReconfigure(selectedRun.runId, patch)}
        onRename={(name) => onRename(selectedRun.runId, name)}
        onSetNote={(note) => onSetNote(selectedRun.runId, note)}
        onSetBackendSession={(backendSessionId) =>
          onSetBackendSession(selectedRun.runId, backendSessionId)
        }
        onSetGroup={(runGroupId) => onSetGroup(selectedRun.runId, runGroupId)}
        onClearGroup={() => onClearGroup(selectedRun.runId)}
        onSetPinned={(pinned) => onSetPinned(selectedRun.runId, pinned)}
        onSetScheduleEnabled={(enabled) => onSetScheduleEnabled(selectedRun.runId, enabled)}
        onSelectSection={onSelectDetailSection}
        onSelectSurface={onSelectRightSurface}
        onTriggerPrimaryAction={onTriggerPrimaryAction}
        auditState={auditState}
        timelineState={timelineState}
        onUnarchive={() => onUnarchive(selectedRun.runId)}
        onUploadAttachment={(file) => onUploadAttachment(selectedRun.runId, file)}
        resumeDialogOpen={resumeDialogOpen}
        run={selectedRun}
      />
      {resumeDialog}
    </>
  );
}
