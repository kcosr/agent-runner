import { readFileSync, writeFileSync } from "node:fs";
import type {
  RunAttachment,
  RunAttachmentDownloadResult,
  RunAttachmentRemoveResult,
} from "@task-runner/core/contracts/attachments.js";
import { resolveAttachmentOutputPath } from "@task-runner/core/core/run/attachments.js";
import { deriveHttpBaseUrl } from "./config.js";

interface ErrorEnvelope {
  error?: {
    message?: string;
  };
}

function joinPath(baseUrl: string, path: string): string {
  return new URL(path, baseUrl).toString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseAttachment(value: unknown): RunAttachment {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.id !== "string" ||
    typeof record.name !== "string" ||
    typeof record.mimeType !== "string" ||
    typeof record.size !== "number" ||
    typeof record.sha256 !== "string" ||
    typeof record.addedAt !== "string" ||
    typeof record.relativePath !== "string"
  ) {
    throw new Error("invalid attachment payload from daemon");
  }
  return {
    id: record.id,
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    sha256: record.sha256,
    addedAt: record.addedAt,
    relativePath: record.relativePath,
  };
}

async function readError(response: Response): Promise<never> {
  let message = `Request failed with status ${response.status}`;
  try {
    const body = (await response.json()) as ErrorEnvelope;
    if (body.error?.message) {
      message = body.error.message;
    }
  } catch {
    // Keep the status-derived fallback.
  }
  throw new Error(message);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("daemon returned invalid JSON");
  }
}

export async function daemonListAttachments(
  connectUrl: string,
  runId: string,
): Promise<RunAttachment[]> {
  const response = await fetch(
    joinPath(deriveHttpBaseUrl(connectUrl), `/api/runs/${encodeURIComponent(runId)}/attachments`),
    {
      headers: { accept: "application/json" },
    },
  );
  if (!response.ok) {
    return await readError(response);
  }
  const body = asRecord(await readJson(response));
  if (!body || !Array.isArray(body.attachments)) {
    throw new Error("invalid attachment list payload from daemon");
  }
  return body.attachments.map(parseAttachment);
}

export async function daemonAddAttachment(
  connectUrl: string,
  runId: string,
  input: { sourcePath: string; name: string; mimeType?: string },
): Promise<RunAttachment> {
  const headers: Record<string, string> = {
    "x-task-runner-attachment-name": input.name,
    accept: "application/json",
  };
  if (input.mimeType) {
    headers["content-type"] = input.mimeType;
  }
  const response = await fetch(
    joinPath(deriveHttpBaseUrl(connectUrl), `/api/runs/${encodeURIComponent(runId)}/attachments`),
    {
      method: "POST",
      headers,
      body: readFileSync(input.sourcePath),
    },
  );
  if (!response.ok) {
    return await readError(response);
  }
  const body = asRecord(await readJson(response));
  if (!body || !("attachment" in body)) {
    throw new Error("invalid attachment add payload from daemon");
  }
  return parseAttachment(body.attachment);
}

export async function daemonRemoveAttachment(
  connectUrl: string,
  runId: string,
  attachmentId: string,
): Promise<RunAttachmentRemoveResult> {
  const response = await fetch(
    joinPath(
      deriveHttpBaseUrl(connectUrl),
      `/api/runs/${encodeURIComponent(runId)}/attachments/${encodeURIComponent(attachmentId)}`,
    ),
    {
      method: "DELETE",
      headers: { accept: "application/json" },
    },
  );
  if (!response.ok) {
    return await readError(response);
  }
  const body = asRecord(await readJson(response));
  const result = asRecord(body?.result);
  if (
    !result ||
    typeof result.runId !== "string" ||
    typeof result.attachmentId !== "string" ||
    typeof result.changed !== "boolean"
  ) {
    throw new Error("invalid attachment remove payload from daemon");
  }
  return {
    runId: result.runId,
    attachmentId: result.attachmentId,
    changed: result.changed,
  };
}

export async function daemonDownloadAttachment(
  connectUrl: string,
  runId: string,
  attachment: RunAttachment,
  outputPath: string,
): Promise<RunAttachmentDownloadResult> {
  const resolvedOutputPath = resolveAttachmentOutputPath(outputPath, attachment.name);
  const response = await fetch(
    joinPath(
      deriveHttpBaseUrl(connectUrl),
      `/api/runs/${encodeURIComponent(runId)}/attachments/${encodeURIComponent(attachment.id)}/content`,
    ),
  );
  if (!response.ok) {
    return await readError(response);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(resolvedOutputPath, bytes, { flag: "wx" });
  return {
    ...attachment,
    outputPath: resolvedOutputPath,
  };
}
