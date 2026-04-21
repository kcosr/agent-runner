import type { AppRuntimeConfig } from "@task-runner/core/contracts/app-config.js";
import type {
  AttachmentListEntry,
  RunAttachment,
  RunAttachmentRemoveResult,
} from "@task-runner/core/contracts/attachments.js";
import type { RunAuditHistory, RunTimelineHistory } from "@task-runner/core/contracts/events.js";
import {
  attachmentListEntrySchema,
  runArchiveResultSchema,
  runAttachmentSchema,
  runAuditHistorySchema,
  runBackendSessionResultSchema,
  runDeleteResultSchema,
  runDependenciesResultSchema,
  runDetailSchema,
  runNameResultSchema,
  runNoteResultSchema,
  runPinnedResultSchema,
  runSummarySchema,
  runTimelineHistorySchema,
} from "@task-runner/core/contracts/run-schemas.js";
import type {
  RunArchiveResult,
  RunBackendSessionResult,
  RunDeleteResult,
  RunDependenciesResult,
  RunDetail,
  RunNameResult,
  RunNoteResult,
  RunPinnedResult,
  RunSummary,
} from "@task-runner/core/contracts/runs.js";
import { z } from "zod";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface AttachmentContentResult {
  mediaType: string | null;
  text: string;
}

interface RequestOptions {
  signal?: AbortSignal;
}

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

interface SafeParseSchema<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { flatten(): unknown } };
}

const INVALID_RESPONSE_CODE = "INVALID_RESPONSE";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function invalidResponse(message: string, status: number, details?: unknown): ApiError {
  return new ApiError(message, status, INVALID_RESPONSE_CODE, details);
}

function parseField<T>(
  body: unknown,
  status: number,
  key: string,
  schema: SafeParseSchema<T>,
  label: string,
): T {
  const record = asRecord(body);
  if (!record || !(key in record)) {
    throw invalidResponse(`${label} response payload is invalid`, status);
  }
  const parsed = schema.safeParse(record[key]);
  if (!parsed.success) {
    throw invalidResponse(`${label} response payload is invalid`, status, parsed.error.flatten());
  }
  return parsed.data;
}

async function parseResponseJson(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw invalidResponse(`${label} response was not valid JSON`, response.status);
  }
}

async function readError(response: Response): Promise<never> {
  let envelope: ErrorEnvelope | null = null;
  try {
    envelope = (await response.json()) as ErrorEnvelope;
  } catch {
    envelope = null;
  }
  throw new ApiError(
    envelope?.error?.message ?? `Request failed with status ${response.status}`,
    response.status,
    envelope?.error?.code,
    envelope?.error?.details,
  );
}

async function readRuns(response: Response): Promise<RunSummary[]> {
  if (!response.ok) {
    return await readError(response);
  }
  return parseField(
    await parseResponseJson(response, "Runs list"),
    response.status,
    "runs",
    z.array(runSummarySchema),
    "Runs list",
  );
}

async function readRun(response: Response): Promise<RunDetail> {
  if (!response.ok) {
    return await readError(response);
  }
  return parseField(
    await parseResponseJson(response, "Run detail"),
    response.status,
    "run",
    runDetailSchema,
    "Run detail",
  );
}

async function readRunTimelineHistory(response: Response): Promise<RunTimelineHistory> {
  if (!response.ok) {
    return await readError(response);
  }
  return parseField(
    await parseResponseJson(response, "Run timeline history"),
    response.status,
    "history",
    runTimelineHistorySchema,
    "Run timeline history",
  );
}

async function readRunAuditHistory(response: Response): Promise<RunAuditHistory> {
  if (!response.ok) {
    return await readError(response);
  }
  return parseField(
    await parseResponseJson(response, "Run audit history"),
    response.status,
    "history",
    runAuditHistorySchema,
    "Run audit history",
  );
}

async function readArchiveResult(response: Response, label: string): Promise<RunArchiveResult> {
  if (!response.ok) {
    return await readError(response);
  }
  return parseField(
    await parseResponseJson(response, label),
    response.status,
    "result",
    runArchiveResultSchema,
    label,
  );
}

async function readNameResult(response: Response, label: string): Promise<RunNameResult> {
  if (!response.ok) {
    return await readError(response);
  }
  return parseField(
    await parseResponseJson(response, label),
    response.status,
    "result",
    runNameResultSchema,
    label,
  );
}

async function readNoteResult(response: Response, label: string): Promise<RunNoteResult> {
  if (!response.ok) {
    return await readError(response);
  }
  return parseField(
    await parseResponseJson(response, label),
    response.status,
    "result",
    runNoteResultSchema,
    label,
  );
}

async function readPinnedResult(response: Response, label: string): Promise<RunPinnedResult> {
  if (!response.ok) {
    return await readError(response);
  }
  return parseField(
    await parseResponseJson(response, label),
    response.status,
    "result",
    runPinnedResultSchema,
    label,
  );
}

async function readBackendSessionResult(
  response: Response,
  label: string,
): Promise<RunBackendSessionResult> {
  if (!response.ok) {
    return await readError(response);
  }
  return parseField(
    await parseResponseJson(response, label),
    response.status,
    "result",
    runBackendSessionResultSchema,
    label,
  );
}

async function readDeleteResult(response: Response, label: string): Promise<RunDeleteResult> {
  if (!response.ok) {
    return await readError(response);
  }
  return parseField(
    await parseResponseJson(response, label),
    response.status,
    "result",
    runDeleteResultSchema,
    label,
  );
}

async function readDependenciesResult(
  response: Response,
  label: string,
): Promise<RunDependenciesResult> {
  if (!response.ok) {
    return await readError(response);
  }
  return parseField(
    await parseResponseJson(response, label),
    response.status,
    "result",
    runDependenciesResultSchema,
    label,
  );
}

async function readAttachmentList(response: Response): Promise<AttachmentListEntry[]> {
  if (!response.ok) {
    return await readError(response);
  }
  return parseField(
    await parseResponseJson(response, "Attachment list"),
    response.status,
    "attachments",
    z.array(attachmentListEntrySchema),
    "Attachment list",
  );
}

async function readAttachmentResult(response: Response, label: string): Promise<RunAttachment> {
  if (!response.ok) {
    return await readError(response);
  }
  return parseField(
    await parseResponseJson(response, label),
    response.status,
    "attachment",
    runAttachmentSchema,
    label,
  );
}

async function readAttachmentRemoveResult(
  response: Response,
  label: string,
): Promise<RunAttachmentRemoveResult> {
  if (!response.ok) {
    return await readError(response);
  }
  const parsed = z
    .object({
      result: z.object({
        runId: z.string(),
        attachmentId: z.string(),
        changed: z.boolean(),
      }),
    })
    .safeParse(await parseResponseJson(response, label));
  if (!parsed.success) {
    throw invalidResponse(
      `${label} response payload is invalid`,
      response.status,
      parsed.error.flatten(),
    );
  }
  return parsed.data.result;
}

async function readRunIdResult(response: Response, label: string): Promise<string> {
  if (!response.ok) {
    return await readError(response);
  }
  const body = asRecord(await parseResponseJson(response, label));
  if (!body || typeof body.runId !== "string") {
    throw invalidResponse(`${label} response payload is invalid`, response.status);
  }
  return body.runId;
}

async function readAbortResult(response: Response): Promise<void> {
  if (!response.ok) {
    return await readError(response);
  }
  const body = asRecord(await parseResponseJson(response, "Abort run"));
  if (!body || typeof body.runId !== "string" || body.accepted !== true) {
    throw invalidResponse("Abort run response payload is invalid", response.status);
  }
}

function joinPath(basePath: string, path: string): string {
  return `${basePath.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function normalizeResponseMediaType(value: string | null): string | null {
  const mediaType = value?.split(";")[0]?.trim().toLowerCase();
  return mediaType && mediaType.length > 0 ? mediaType : null;
}

async function readAttachmentContentResponse(
  responsePromise: Promise<Response>,
): Promise<Response> {
  const response = await responsePromise;
  if (!response.ok) {
    return await readError(response);
  }
  return response;
}

function attachmentContentPath(
  config: AppRuntimeConfig,
  runId: string,
  attachmentId: string,
): string {
  return joinPath(
    config.apiBasePath,
    `/runs/${encodeURIComponent(runId)}/attachments/${encodeURIComponent(attachmentId)}/content`,
  );
}

export function createApiClient(config: AppRuntimeConfig) {
  return {
    async listRuns(): Promise<RunSummary[]> {
      const response = await fetch(joinPath(config.apiBasePath, "/runs?includeArchived=true"), {
        headers: { accept: "application/json" },
      });
      return await readRuns(response);
    },
    async getRun(runId: string, options: RequestOptions = {}): Promise<RunDetail> {
      const response = await fetch(
        joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}`),
        {
          headers: { accept: "application/json" },
          signal: options.signal,
        },
      );
      return await readRun(response);
    },
    async getRunTimelineHistory(
      runId: string,
      options: RequestOptions = {},
    ): Promise<RunTimelineHistory> {
      const response = await fetch(
        joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}/timeline`),
        {
          headers: { accept: "application/json" },
          signal: options.signal,
        },
      );
      return await readRunTimelineHistory(response);
    },
    async getRunAuditHistory(
      runId: string,
      options: RequestOptions & { limit?: number } = {},
    ): Promise<RunAuditHistory> {
      const params = new URLSearchParams();
      if (options.limit !== undefined) {
        params.set("limit", String(options.limit));
      }
      const response = await fetch(
        joinPath(
          config.apiBasePath,
          `/runs/${encodeURIComponent(runId)}/audit${params.size > 0 ? `?${params.toString()}` : ""}`,
        ),
        {
          headers: { accept: "application/json" },
          signal: options.signal,
        },
      );
      return await readRunAuditHistory(response);
    },
    async listAttachments(
      runId: string,
      options: { cwdScope?: boolean } = {},
    ): Promise<AttachmentListEntry[]> {
      const params = new URLSearchParams();
      if (options.cwdScope !== undefined) {
        params.set("cwdScope", String(options.cwdScope));
      }
      const response = await fetch(
        joinPath(
          config.apiBasePath,
          `/runs/${encodeURIComponent(runId)}/attachments${params.size > 0 ? `?${params.toString()}` : ""}`,
        ),
        {
          headers: { accept: "application/json" },
        },
      );
      return await readAttachmentList(response);
    },
    async uploadAttachment(runId: string, file: File): Promise<RunAttachment> {
      const headers: Record<string, string> = {
        "x-task-runner-attachment-name": encodeURIComponent(file.name),
        accept: "application/json",
      };
      if (file.type) {
        headers["content-type"] = file.type;
      }
      const response = await fetch(
        joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}/attachments`),
        {
          method: "POST",
          headers,
          body: file,
        },
      );
      return await readAttachmentResult(response, "Upload attachment");
    },
    async removeAttachment(
      runId: string,
      attachmentId: string,
    ): Promise<RunAttachmentRemoveResult> {
      const response = await fetch(
        joinPath(
          config.apiBasePath,
          `/runs/${encodeURIComponent(runId)}/attachments/${encodeURIComponent(attachmentId)}`,
        ),
        {
          method: "DELETE",
          headers: { accept: "application/json" },
        },
      );
      return await readAttachmentRemoveResult(response, "Remove attachment");
    },
    async downloadAttachment(runId: string, attachmentId: string): Promise<Blob> {
      const response = await readAttachmentContentResponse(
        fetch(attachmentContentPath(config, runId, attachmentId)),
      );
      return await response.blob();
    },
    async readAttachmentText(
      runId: string,
      attachmentId: string,
    ): Promise<AttachmentContentResult> {
      const response = await readAttachmentContentResponse(
        fetch(attachmentContentPath(config, runId, attachmentId)),
      );
      return {
        mediaType: normalizeResponseMediaType(response.headers.get("content-type")),
        text: await response.text(),
      };
    },
    async archiveRun(runId: string): Promise<RunArchiveResult> {
      const response = await fetch(
        joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}/archive`),
        {
          method: "POST",
          headers: { accept: "application/json" },
        },
      );
      return await readArchiveResult(response, "Archive run");
    },
    async unarchiveRun(runId: string): Promise<RunArchiveResult> {
      const response = await fetch(
        joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}/unarchive`),
        {
          method: "POST",
          headers: { accept: "application/json" },
        },
      );
      return await readArchiveResult(response, "Unarchive run");
    },
    async resetRun(runId: string): Promise<RunDetail> {
      const response = await fetch(
        joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}/reset`),
        {
          method: "POST",
          headers: { accept: "application/json" },
        },
      );
      return await readRun(response);
    },
    async readyRun(runId: string): Promise<RunDetail> {
      const response = await fetch(
        joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}/ready`),
        {
          method: "POST",
          headers: { accept: "application/json" },
        },
      );
      return await readRun(response);
    },
    async deleteRun(runId: string): Promise<RunDeleteResult> {
      const response = await fetch(
        joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}`),
        {
          method: "DELETE",
          headers: { accept: "application/json" },
        },
      );
      return await readDeleteResult(response, "Delete run");
    },
    async resumeRun(runId: string, message?: string): Promise<void> {
      const normalizedMessage = message?.trim().length ? message : undefined;
      const response = await fetch(
        joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}/resume`),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            overrides: normalizedMessage ? { message: normalizedMessage } : {},
          }),
        },
      );
      await readRunIdResult(response, "Resume run");
    },
    async abortRun(runId: string): Promise<void> {
      const response = await fetch(
        joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}/abort`),
        {
          method: "POST",
          headers: { accept: "application/json" },
        },
      );
      await readAbortResult(response);
    },
    async setRunName(runId: string, name: string | null): Promise<RunNameResult> {
      const response = await fetch(
        joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}/name`),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ name }),
        },
      );
      return await readNameResult(response, "Rename run");
    },
    async setRunNote(runId: string, note: string | null): Promise<RunNoteResult> {
      const response = await fetch(
        joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}/note`),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ note }),
        },
      );
      return await readNoteResult(response, "Set run note");
    },
    async setRunPinned(runId: string, pinned: boolean): Promise<RunPinnedResult> {
      const response = await fetch(
        joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}/pinned`),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ pinned }),
        },
      );
      return await readPinnedResult(response, "Set run pinned");
    },
    async setBackendSession(
      runId: string,
      backendSessionId: string,
    ): Promise<RunBackendSessionResult> {
      const response = await fetch(
        joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}/backend-session`),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ backendSessionId }),
        },
      );
      return await readBackendSessionResult(response, "Set backend session");
    },
    async clearBackendSession(runId: string): Promise<RunBackendSessionResult> {
      const response = await fetch(
        joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}/backend-session/clear`),
        {
          method: "POST",
          headers: { accept: "application/json" },
        },
      );
      return await readBackendSessionResult(response, "Clear backend session");
    },
    async addDependency(runId: string, dependencyRunId: string): Promise<RunDependenciesResult> {
      const response = await fetch(
        joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}/dependencies`),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ dependencyRunId }),
        },
      );
      return await readDependenciesResult(response, "Add dependency");
    },
    async removeDependency(runId: string, dependencyRunId: string): Promise<RunDependenciesResult> {
      const response = await fetch(
        joinPath(
          config.apiBasePath,
          `/runs/${encodeURIComponent(runId)}/dependencies/${encodeURIComponent(dependencyRunId)}`,
        ),
        {
          method: "DELETE",
          headers: { accept: "application/json" },
        },
      );
      return await readDependenciesResult(response, "Remove dependency");
    },
    async clearDependencies(runId: string): Promise<RunDependenciesResult> {
      const response = await fetch(
        joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}/dependencies/clear`),
        {
          method: "POST",
          headers: { accept: "application/json" },
        },
      );
      return await readDependenciesResult(response, "Clear dependencies");
    },
  };
}

export function isNotFoundError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 404;
}
