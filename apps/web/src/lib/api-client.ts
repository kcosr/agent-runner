import type { AppRuntimeConfig } from "@task-runner/core/contracts/app-config.js";
import {
  runArchiveResultSchema,
  runDetailSchema,
  runSummarySchema,
} from "@task-runner/core/contracts/run-schemas.js";
import type { RunArchiveResult, RunDetail, RunSummary } from "@task-runner/core/contracts/runs.js";
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

export function createApiClient(config: AppRuntimeConfig) {
  return {
    async listRuns(): Promise<RunSummary[]> {
      const response = await fetch(joinPath(config.apiBasePath, "/runs?includeArchived=true"), {
        headers: { accept: "application/json" },
      });
      return await readRuns(response);
    },
    async getRun(runId: string): Promise<RunDetail> {
      const response = await fetch(
        joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}`),
        {
          headers: { accept: "application/json" },
        },
      );
      return await readRun(response);
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
    async resumeRun(runId: string): Promise<void> {
      const response = await fetch(
        joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}/resume`),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ overrides: {} }),
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
  };
}

export function isNotFoundError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 404;
}
