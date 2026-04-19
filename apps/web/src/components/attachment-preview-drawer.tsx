import { useQuery } from "@tanstack/react-query";
import type {
  AttachmentListEntry,
  RunAttachment,
} from "@task-runner/core/contracts/attachments.js";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef } from "react";
import { createApiClient } from "../lib/api-client.js";
import { formatBytes, formatTimestamp } from "../lib/format.js";
import { useRuntimeConfig } from "../lib/runtime-config.js";
import { isEditableEventTarget } from "../lib/shortcuts.js";
import { useDrawerResize } from "../lib/use-drawer-resize.js";
import { useHorizontalWheelGuard } from "../lib/use-horizontal-wheel-guard.js";
import type { RunActionPending } from "../routes/use-runs-dashboard-state.js";
import { DrawerResizeHandle } from "./drawer-resize-handle.js";
import { ChevronIcon, CloseIcon, CollapseIcon, DownloadIcon, ExpandIcon } from "./icons.js";
import { MarkdownContent } from "./markdown.js";

export function normalizeAttachmentMimeType(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
}

export function isPreviewableAttachment(attachment: Pick<RunAttachment, "mimeType">): boolean {
  const mediaType = normalizeAttachmentMimeType(attachment.mimeType);
  return mediaType === "text/markdown" || mediaType === "text/plain";
}

export function AttachmentPreviewDrawer({
  actionPending,
  attachment,
  attachmentId,
  attachmentLookupError,
  attachmentLookupPending,
  onBack,
  onClose,
  onDownload,
  onNextAttachment,
  onPreviousAttachment,
  nextAttachmentName,
  previousAttachmentName,
  runId,
}: {
  actionPending?: RunActionPending;
  attachment?: RunAttachment | AttachmentListEntry;
  attachmentId: string;
  attachmentLookupError?: string;
  attachmentLookupPending?: boolean;
  onBack: () => void;
  onClose: () => void;
  onDownload: (attachmentId: string, name: string) => Promise<void>;
  onNextAttachment?: () => void;
  onPreviousAttachment?: () => void;
  nextAttachmentName?: string;
  previousAttachmentName?: string;
  runId: string;
}) {
  const drawerRef = useRef<HTMLElement | null>(null);
  const config = useRuntimeConfig();
  const api = createApiClient(config);
  const resize = useDrawerResize();
  const { drawerStyle, isFullscreen, toggleFullscreen } = resize;
  const downloadPending = actionPending === "download-attachment";
  useHorizontalWheelGuard(drawerRef);
  const previewQuery = useQuery({
    queryKey: ["attachment-preview", runId, attachmentId],
    queryFn: () => api.readAttachmentText(runId, attachmentId),
    enabled: attachment !== undefined,
    retry: false,
  });
  const previewMediaType =
    previewQuery.data?.mediaType ??
    (attachment ? normalizeAttachmentMimeType(attachment.mimeType) : null);

  useEffect(() => {
    if (!isFullscreen) {
      return;
    }
    drawerRef.current?.focus();
  }, [isFullscreen]);

  useEffect(() => {
    if (!isFullscreen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || isEditableEventTarget(event.target)) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        toggleFullscreen();
        return;
      }

      if (event.key === "ArrowLeft" && onPreviousAttachment) {
        event.preventDefault();
        onPreviousAttachment();
        return;
      }

      if (event.key === "ArrowRight" && onNextAttachment) {
        event.preventDefault();
        onNextAttachment();
      }
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [isFullscreen, onNextAttachment, onPreviousAttachment, toggleFullscreen]);

  function handleDrawerKeyDownCapture(event: ReactKeyboardEvent<HTMLElement>) {
    if (!isFullscreen || event.defaultPrevented || isEditableEventTarget(event.target)) {
      return;
    }
    if (event.key !== "Escape") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    toggleFullscreen();
  }

  return (
    <>
      <button
        aria-label="Close detail sheet"
        className="drawer-sheet-backdrop"
        onClick={onClose}
        type="button"
      />
      <aside
        aria-label="Attachment preview"
        className={isFullscreen ? "drawer drawer--fullscreen" : "drawer"}
        onKeyDownCapture={handleDrawerKeyDownCapture}
        ref={drawerRef}
        style={drawerStyle}
        tabIndex={-1}
      >
        <DrawerResizeHandle label="Resize attachment preview drawer" resize={resize} />
        <header className="drawer-head drawer-head--preview">
          <button
            aria-label="Back to attachments"
            className="icon-btn attachment-preview-back"
            onClick={onBack}
            type="button"
          >
            <ChevronIcon aria-hidden="true" className="attachment-preview-back-icon" />
          </button>
          <div className="attachment-preview-head">
            <div className="attachment-preview-title-row">
              <span className="attachment-preview-run-id">{runId}</span>
              <span aria-hidden="true" className="attachment-preview-title-separator">
                /
              </span>
              <h3 className="attachment-preview-title">
                {attachment?.name ?? "Attachment preview unavailable"}
              </h3>
            </div>
            {attachment ? (
              <div className="attachment-preview-meta-inline">
                <span>{formatBytes(attachment.size)}</span>
                <span aria-hidden="true">·</span>
                <span>{formatTimestamp(attachment.addedAt)}</span>
              </div>
            ) : null}
          </div>
          <div className="drawer-actions">
            <div className="attachment-preview-nav">
              <button
                aria-label={
                  previousAttachmentName
                    ? `Previous attachment: ${previousAttachmentName}`
                    : "Previous attachment"
                }
                className="icon-btn"
                disabled={!onPreviousAttachment}
                onClick={onPreviousAttachment}
                type="button"
              >
                <ChevronIcon
                  aria-hidden="true"
                  className="attachment-preview-chevron attachment-preview-chevron--left"
                />
              </button>
              <button
                aria-label={
                  nextAttachmentName ? `Next attachment: ${nextAttachmentName}` : "Next attachment"
                }
                className="icon-btn"
                disabled={!onNextAttachment}
                onClick={onNextAttachment}
                type="button"
              >
                <ChevronIcon
                  aria-hidden="true"
                  className="attachment-preview-chevron attachment-preview-chevron--right"
                />
              </button>
            </div>
            {attachment ? (
              <button
                className="btn"
                disabled={downloadPending}
                onClick={() => void onDownload(attachment.id, attachment.name)}
                type="button"
              >
                <DownloadIcon aria-hidden="true" />
                {downloadPending ? "Downloading..." : "Download"}
              </button>
            ) : null}
            <button
              aria-label={isFullscreen ? "Exit full-width drawer" : "Expand drawer to full width"}
              aria-pressed={isFullscreen}
              className="icon-btn drawer-fullscreen-toggle"
              onClick={toggleFullscreen}
              title={isFullscreen ? "Restore drawer width" : "Expand to full width"}
              type="button"
            >
              {isFullscreen ? (
                <CollapseIcon aria-hidden="true" />
              ) : (
                <ExpandIcon aria-hidden="true" />
              )}
            </button>
            <button aria-label="Close detail" className="icon-btn" onClick={onClose} type="button">
              <CloseIcon aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="drawer-body">
          {attachmentLookupPending ? (
            <section aria-label="Attachment preview loading" className="drawer-panel">
              <div className="drawer-panel-card attachment-preview-state">
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
            </section>
          ) : attachmentLookupError ? (
            <section aria-label="Attachment preview error" className="drawer-panel">
              <div className="drawer-panel-card attachment-preview-state">
                <h4>Attachment preview failed to load</h4>
                <p>{attachmentLookupError}</p>
              </div>
            </section>
          ) : attachment === undefined ? (
            <section aria-label="Attachment preview error" className="drawer-panel">
              <div className="drawer-panel-card attachment-preview-state">
                <h4>Attachment preview unavailable</h4>
                <p>
                  The selected attachment is no longer available in this run. Use Back to return to
                  the attachments list.
                </p>
              </div>
            </section>
          ) : previewQuery.isPending ? (
            <section aria-label="Attachment preview loading" className="drawer-panel">
              <div className="drawer-panel-card attachment-preview-state">
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
            </section>
          ) : previewQuery.isError ? (
            <section aria-label="Attachment preview error" className="drawer-panel">
              <div className="drawer-panel-card attachment-preview-state">
                <h4>Attachment preview failed to load</h4>
                <p>{previewQuery.error.message}</p>
              </div>
            </section>
          ) : previewMediaType === "text/markdown" ? (
            <section aria-label="Attachment preview content" className="drawer-panel">
              <div className="drawer-panel-card attachment-preview-content">
                <MarkdownContent text={previewQuery.data.text} />
              </div>
            </section>
          ) : (
            <section aria-label="Attachment preview content" className="drawer-panel">
              <div className="drawer-panel-card attachment-preview-content">
                <pre className="timeline-content attachment-preview-plain">
                  <code>{previewQuery.data.text}</code>
                </pre>
              </div>
            </section>
          )}
        </div>
      </aside>
    </>
  );
}
