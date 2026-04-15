import { useQuery } from "@tanstack/react-query";
import type { RunAttachment } from "@task-runner/core/contracts/attachments.js";
import type { CSSProperties } from "react";
import { createApiClient } from "../lib/api-client.js";
import { formatBytes, formatTimestamp } from "../lib/format.js";
import { useRuntimeConfig } from "../lib/runtime-config.js";
import { useBoardSettings } from "../lib/settings.js";
import type { RunActionPending } from "../routes/use-runs-dashboard-state.js";
import { ChevronIcon, CloseIcon, DownloadIcon } from "./icons.js";
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
  onBack,
  onClose,
  onDownload,
  runId,
}: {
  actionPending?: RunActionPending;
  attachment?: RunAttachment;
  attachmentId: string;
  onBack: () => void;
  onClose: () => void;
  onDownload: (attachmentId: string, name: string) => Promise<void>;
  runId: string;
}) {
  const config = useRuntimeConfig();
  const api = createApiClient(config);
  const { settings } = useBoardSettings();
  const downloadPending = actionPending === "download-attachment";
  const drawerStyle = { "--drawer-width": `${settings.drawerWidth}px` } as CSSProperties;
  const previewQuery = useQuery({
    queryKey: ["attachment-preview", runId, attachmentId],
    queryFn: () => api.readAttachmentText(runId, attachmentId),
    enabled: attachment !== undefined,
    retry: false,
  });
  const previewMediaType =
    previewQuery.data?.mediaType ??
    (attachment ? normalizeAttachmentMimeType(attachment.mimeType) : null);

  return (
    <>
      <button
        aria-label="Close detail sheet"
        className="drawer-sheet-backdrop"
        onClick={onClose}
        type="button"
      />
      <aside aria-label="Attachment preview" className="drawer" style={drawerStyle}>
        <header className="drawer-head drawer-head--preview">
          <div className="drawer-title drawer-title--preview">
            <button aria-label="Back to attachments" className="btn" onClick={onBack} type="button">
              <ChevronIcon aria-hidden="true" className="attachment-preview-back-icon" />
              Back
            </button>
            <div className="attachment-preview-title-group">
              <span className="run-id-large">{runId}</span>
              <h3 className="drawer-section-title">
                {attachment?.name ?? "Attachment preview unavailable"}
              </h3>
            </div>
          </div>
          <div className="drawer-actions">
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
            <button aria-label="Close detail" className="icon-btn" onClick={onClose} type="button">
              <CloseIcon aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="drawer-body">
          {attachment ? (
            <section aria-label="Attachment metadata" className="meta-grid attachment-preview-meta">
              <div className="meta-cell">
                <span className="meta-label">Type</span>
                <span className="meta-value mono">{attachment.mimeType}</span>
              </div>
              <div className="meta-cell">
                <span className="meta-label">Size</span>
                <span className="meta-value">{formatBytes(attachment.size)}</span>
              </div>
              <div className="meta-cell full">
                <span className="meta-label">Added</span>
                <span className="meta-value">{formatTimestamp(attachment.addedAt)}</span>
              </div>
            </section>
          ) : null}

          {attachment === undefined ? (
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
