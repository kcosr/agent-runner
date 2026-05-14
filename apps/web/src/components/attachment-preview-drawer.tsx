import type {
  AttachmentListEntry,
  RunAttachment,
} from "@kcosr/agent-runner-core/contracts/attachments.js";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { createApiClient } from "../lib/api-client.js";
import {
  isImagePreviewMediaType,
  isPreviewableAttachment,
  normalizeAttachmentMimeType,
} from "../lib/attachments.js";
import { formatBytes, formatTimestamp } from "../lib/format.js";
import { useRuntimeConfig } from "../lib/runtime-config.js";
import { useDaemonAuthToken } from "../lib/settings.js";
import { isEditableEventTarget } from "../lib/shortcuts.js";
import { useHorizontalWheelGuard } from "../lib/use-horizontal-wheel-guard.js";
import type { RunActionPending } from "../routes/use-runs-dashboard-state.js";
import { ChevronIcon, DownloadIcon } from "./icons.js";
import { MarkdownContent } from "./markdown.js";

export function AttachmentPreviewPanel({
  actionPending,
  active,
  attachment,
  attachmentLookupError,
  attachmentLookupPending,
  fullscreen,
  onDownload,
  onNextAttachment,
  onPreviousAttachment,
  nextAttachmentName,
  previousAttachmentName,
  resumeDialogOpen,
  runId,
}: {
  actionPending?: RunActionPending;
  active: boolean;
  attachment?: RunAttachment | AttachmentListEntry;
  attachmentLookupError?: string;
  attachmentLookupPending?: boolean;
  fullscreen: boolean;
  onDownload: (attachmentId: string, name: string) => Promise<void>;
  onNextAttachment?: () => void;
  onPreviousAttachment?: () => void;
  nextAttachmentName?: string;
  previousAttachmentName?: string;
  resumeDialogOpen: boolean;
  runId?: string;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const config = useRuntimeConfig();
  const { daemonToken } = useDaemonAuthToken();
  const api = useMemo(() => createApiClient(config, { daemonToken }), [config, daemonToken]);
  const downloadPending = actionPending === "download-attachment";
  useHorizontalWheelGuard(panelRef);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const imagePreviewUrlRef = useRef<string | null>(null);
  const attachmentId = attachment?.id;
  const previewable = attachment ? isPreviewableAttachment(attachment) : false;
  const previewMediaType =
    attachment && previewable ? normalizeAttachmentMimeType(attachment.mimeType) : null;
  const previewQuery = useQuery({
    queryKey: ["attachment-preview", runId ?? null, attachmentId ?? null, previewMediaType],
    queryFn: async () => {
      if (!runId || !attachmentId) {
        throw new Error("Attachment preview selection is required");
      }
      return isImagePreviewMediaType(previewMediaType)
        ? {
            kind: "image" as const,
            blob: await api.downloadAttachment(runId, attachmentId),
          }
        : {
            kind: "text" as const,
            content: await api.readAttachmentText(runId, attachmentId),
          };
    },
    enabled:
      active &&
      attachment !== undefined &&
      previewable &&
      runId !== undefined &&
      attachmentId !== undefined,
    retry: false,
  });
  const textPreview = previewQuery.data?.kind === "text" ? previewQuery.data.content : null;

  useEffect(() => {
    if (!fullscreen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (resumeDialogOpen || event.defaultPrevented || isEditableEventTarget(event.target)) {
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
  }, [fullscreen, onNextAttachment, onPreviousAttachment, resumeDialogOpen]);

  useEffect(() => {
    if (previewQuery.data?.kind !== "image") {
      if (imagePreviewUrlRef.current !== null) {
        URL.revokeObjectURL(imagePreviewUrlRef.current);
        imagePreviewUrlRef.current = null;
        setImagePreviewUrl(null);
      }
      return;
    }

    const nextUrl = URL.createObjectURL(previewQuery.data.blob);
    if (imagePreviewUrlRef.current !== null) {
      URL.revokeObjectURL(imagePreviewUrlRef.current);
    }
    imagePreviewUrlRef.current = nextUrl;
    setImagePreviewUrl(nextUrl);
  }, [previewQuery.data]);

  useEffect(() => {
    return () => {
      if (imagePreviewUrlRef.current !== null) {
        URL.revokeObjectURL(imagePreviewUrlRef.current);
        imagePreviewUrlRef.current = null;
      }
    };
  }, []);

  function renderPreviewBody() {
    if (attachmentLookupPending) {
      return (
        <div
          aria-label="Attachment preview loading"
          className="drawer-panel-card attachment-preview-state"
        >
          <div className="skeleton-line skeleton-line--short" />
          <div className="skeleton-line skeleton-line--medium" style={{ marginTop: "12px" }} />
          <div className="skeleton-line skeleton-line--medium" style={{ marginTop: "12px" }} />
        </div>
      );
    }

    if (attachmentLookupError) {
      return (
        <div
          aria-label="Attachment preview error"
          className="drawer-panel-card attachment-preview-state"
        >
          <h4>Attachment preview failed to load</h4>
          <p>{attachmentLookupError}</p>
        </div>
      );
    }

    if (!attachment) {
      return (
        <div className="drawer-panel-card attachment-preview-state">
          <h4>No attachments available.</h4>
        </div>
      );
    }

    if (!previewable) {
      return (
        <div className="drawer-panel-card attachment-preview-state">
          <h4>Attachment preview unavailable</h4>
          <p>Download the attachment to view it.</p>
        </div>
      );
    }

    if (previewQuery.isPending) {
      return (
        <div
          aria-label="Attachment preview loading"
          className="drawer-panel-card attachment-preview-state"
        >
          <div className="skeleton-line skeleton-line--short" />
          <div className="skeleton-line skeleton-line--medium" style={{ marginTop: "12px" }} />
          <div className="skeleton-line skeleton-line--medium" style={{ marginTop: "12px" }} />
        </div>
      );
    }

    if (previewQuery.isError) {
      return (
        <div
          aria-label="Attachment preview error"
          className="drawer-panel-card attachment-preview-state"
        >
          <h4>Attachment preview failed to load</h4>
          <p>{previewQuery.error.message}</p>
        </div>
      );
    }

    if (isImagePreviewMediaType(previewMediaType)) {
      return (
        <div
          aria-label="Attachment preview content"
          className="drawer-panel-card attachment-preview-content"
        >
          {imagePreviewUrl ? (
            <img alt={attachment.name} className="attachment-preview-image" src={imagePreviewUrl} />
          ) : null}
        </div>
      );
    }

    if (previewMediaType === "text/markdown") {
      return (
        <div
          aria-label="Attachment preview content"
          className="drawer-panel-card attachment-preview-content"
        >
          <MarkdownContent renderFrontmatterAsCodeBlock text={textPreview?.text ?? ""} />
        </div>
      );
    }

    return (
      <div
        aria-label="Attachment preview content"
        className="drawer-panel-card attachment-preview-content"
      >
        <pre className="timeline-content attachment-preview-plain">
          <code>{textPreview?.text ?? ""}</code>
        </pre>
      </div>
    );
  }

  return (
    <section
      aria-label="Attachment preview"
      className="drawer-panel drawer-panel--attachment-preview attachment-preview-panel"
      ref={panelRef}
    >
      <header className="drawer-head drawer-head--preview attachment-preview-panel__head">
        <div className="attachment-preview-head">
          <div className="attachment-preview-title-row">
            <h3 className="attachment-preview-title">{attachment?.name ?? "Attachment preview"}</h3>
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
        </div>
      </header>
      <div className="attachment-preview-panel__body">{renderPreviewBody()}</div>
    </section>
  );
}
