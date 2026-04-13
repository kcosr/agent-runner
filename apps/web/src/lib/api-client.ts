import type { AppRuntimeConfig } from "@task-runner/core/contracts/app-config.js";
import type { RunArchiveResult, RunDetail, RunSummary } from "@task-runner/core/contracts/runs.js";

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

interface RunsResponse {
  runs: RunSummary[];
}

interface RunResponse {
  run: RunDetail;
}

interface ArchiveResponse {
  result: RunArchiveResult;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
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

  return (await response.json()) as T;
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
      return (await readJson<RunsResponse>(response)).runs;
    },
    async getRun(runId: string): Promise<RunDetail> {
      const response = await fetch(
        joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}`),
        {
          headers: { accept: "application/json" },
        },
      );
      return (await readJson<RunResponse>(response)).run;
    },
    async archiveRun(runId: string): Promise<RunArchiveResult> {
      const response = await fetch(
        joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}/archive`),
        {
          method: "POST",
          headers: { accept: "application/json" },
        },
      );
      return (await readJson<ArchiveResponse>(response)).result;
    },
    async unarchiveRun(runId: string): Promise<RunArchiveResult> {
      const response = await fetch(
        joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}/unarchive`),
        {
          method: "POST",
          headers: { accept: "application/json" },
        },
      );
      return (await readJson<ArchiveResponse>(response)).result;
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
      await readJson<Record<string, never>>(response);
    },
    async abortRun(runId: string): Promise<void> {
      const response = await fetch(
        joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}/abort`),
        {
          method: "POST",
          headers: { accept: "application/json" },
        },
      );
      await readJson<Record<string, never>>(response);
    },
  };
}

export function isNotFoundError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 404;
}
