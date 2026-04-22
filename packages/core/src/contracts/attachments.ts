export interface RunAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  addedAt: string;
  relativePath: string;
}

export interface AttachmentListEntry extends RunAttachment {
  ownerRunId: string;
}

export type AttachmentScope = "run" | "family";

export interface AttachmentListOptions {
  scope?: AttachmentScope;
}

export interface RunAttachmentRemoveResult {
  runId: string;
  attachmentId: string;
  changed: boolean;
}

export interface RunAttachmentDownloadResult extends RunAttachment {
  outputPath: string;
}
