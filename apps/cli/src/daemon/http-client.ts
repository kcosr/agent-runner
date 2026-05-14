import type { RunAuditHistory } from "@agent-runner/core/contracts/events.js";
import {
  runAuditHistorySchema,
  runDetailSchema,
} from "@agent-runner/core/contracts/run-schemas.js";
import type { ReconfigureRunPatch, RunDetail } from "@agent-runner/core/contracts/runs.js";
import { deriveHttpBaseUrl } from "./config.js";

interface DaemonHttpOptions {
  authHeaders?: Record<string, string>;
}

interface ErrorEnvelope {
  error?: {
    message?: string;
  };
}

export class DaemonHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DaemonHttpError";
  }
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
  throw new DaemonHttpError(message, response.status);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("daemon returned invalid JSON");
  }
}

function requestHeaders(
  baseHeaders: Record<string, string>,
  options: DaemonHttpOptions = {},
): Record<string, string> {
  return {
    ...baseHeaders,
    ...options.authHeaders,
  };
}

function parseRunAuditHistory(value: unknown): RunAuditHistory {
  const record = asRecord(value);
  const parsed = runAuditHistorySchema.safeParse(record?.history);
  if (!parsed.success) {
    throw new Error("invalid run audit history payload from daemon");
  }
  return parsed.data;
}

function parseRunDetail(value: unknown): RunDetail {
  const record = asRecord(value);
  const parsed = runDetailSchema.safeParse(record?.run);
  if (!parsed.success) {
    throw new Error("invalid run detail payload from daemon");
  }
  return parsed.data;
}

export async function daemonReconfigureRun(
  connectUrl: string,
  runId: string,
  patch: ReconfigureRunPatch,
  options: DaemonHttpOptions = {},
): Promise<RunDetail> {
  const response = await fetch(
    joinPath(deriveHttpBaseUrl(connectUrl), `/api/runs/${encodeURIComponent(runId)}/reconfigure`),
    {
      method: "POST",
      headers: requestHeaders(
        {
          "content-type": "application/json",
          accept: "application/json",
        },
        options,
      ),
      body: JSON.stringify(patch),
    },
  );
  if (!response.ok) {
    return await readError(response);
  }
  return parseRunDetail(await readJson(response));
}

export async function daemonGetRunAuditHistory(
  connectUrl: string,
  runId: string,
  options: DaemonHttpOptions & { limit?: number } = {},
): Promise<RunAuditHistory> {
  const url = new URL(
    joinPath(deriveHttpBaseUrl(connectUrl), `/api/runs/${encodeURIComponent(runId)}/audit`),
  );
  if (options.limit !== undefined) {
    url.searchParams.set("limit", String(options.limit));
  }
  const response = await fetch(url, {
    headers: requestHeaders({ accept: "application/json" }, options),
  });
  if (!response.ok) {
    return await readError(response);
  }
  return parseRunAuditHistory(await readJson(response));
}
