import type { RunAttachment } from "@task-runner/core/contracts/attachments.js";

const IMAGE_ATTACHMENT_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

const PREVIEWABLE_ATTACHMENT_MEDIA_TYPES = new Set([
  "text/markdown",
  "text/plain",
  ...IMAGE_ATTACHMENT_MEDIA_TYPES,
]);

export function normalizeAttachmentMimeType(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
}

export function isPreviewableAttachment(attachment: Pick<RunAttachment, "mimeType">): boolean {
  return PREVIEWABLE_ATTACHMENT_MEDIA_TYPES.has(normalizeAttachmentMimeType(attachment.mimeType));
}

export function isImagePreviewMediaType(mediaType: string | null): boolean {
  return mediaType !== null && IMAGE_ATTACHMENT_MEDIA_TYPES.has(mediaType);
}
