import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunCommandOverrides } from "@task-runner/core/app/service.js";
import { VALID_STATUSES } from "@task-runner/core/assignment/model.js";
import type {
  RunDetailStreamEvent,
  RunSummaryStreamEvent,
  RunTimelineEnvelope,
} from "@task-runner/core/contracts/events.js";
import { HttpError } from "./http-errors.js";
import { readJsonBody, sendBuffer, sendError, sendJson } from "./http-serializers.js";
import type { DaemonOperations } from "./operations.js";
import type {
  RunSetBackendSessionParams,
  RunSetNameParams,
  RunSetNoteParams,
  RunSetPinnedParams,
  RunsListParams,
  RunsStartParams,
} from "./protocol.js";
import {
  RequestValidationError,
  asRecord,
  optionalEnum,
  optionalHeaderString,
  optionalOverrides,
  optionalString,
  parseBooleanQueryValue,
  parseRunSetBackendSessionParams,
  parseRunSetNameParams,
  parseRunSetNoteParams,
  parseRunSetPinnedParams,
  parseStartRunParams,
  requiredHeaderString,
  requiredRunIdString,
  requiredString,
} from "./request-parsing.js";
import { streamEvents } from "./sse.js";

interface ResumeRunBody {
  overrides: RunCommandOverrides;
}

interface RouteContext {
  operations: DaemonOperations;
  httpBaseUrl: string;
  subscribeRunSummaries(publish: (payload: RunSummaryStreamEvent) => boolean): () => void;
  subscribeRunDetail(
    runId: string,
    publish: (payload: RunDetailStreamEvent) => boolean,
  ): () => void;
  subscribeRunTimeline(
    runId: string,
    publish: (payload: RunTimelineEnvelope) => boolean,
  ): () => void;
}

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  params: Record<string, string>,
  url: URL,
) => Promise<void> | void;

interface RouteDefinition {
  method: string;
  pattern: string[];
  handler: RouteHandler;
}

const routes: RouteDefinition[] = [
  {
    method: "GET",
    pattern: ["api", "daemon"],
    handler: (_req, res, ctx) => {
      sendJson(res, 200, ctx.operations.readDaemonInfo());
    },
  },
  {
    method: "GET",
    pattern: ["api", "runs"],
    handler: (_req, res, ctx, _params, url) => {
      sendJson(res, 200, ctx.operations.listRuns(parseRunListQuery(url)));
    },
  },
  {
    method: "GET",
    pattern: ["api", "runs", ":runId"],
    handler: (_req, res, ctx, params) => {
      sendJson(res, 200, ctx.operations.getRun(routeParam(params, "runId")));
    },
  },
  {
    method: "GET",
    pattern: ["api", "runs", ":runId", "timeline"],
    handler: (_req, res, ctx, params) => {
      sendJson(res, 200, ctx.operations.getRunTimelineHistory(routeParam(params, "runId")));
    },
  },
  {
    method: "POST",
    pattern: ["api", "runs", "init"],
    handler: async (req, res, ctx) => {
      sendJson(res, 200, await ctx.operations.initRun(await parseStartRunBody(req)));
    },
  },
  {
    method: "POST",
    pattern: ["api", "runs"],
    handler: async (req, res, ctx) => {
      sendJson(res, 200, await ctx.operations.startRun(await parseStartRunBody(req)));
    },
  },
  {
    method: "POST",
    pattern: ["api", "runs", ":runId", "resume"],
    handler: async (req, res, ctx, params) => {
      const body = await parseResumeRunBody(req);
      sendJson(
        res,
        200,
        await ctx.operations.resumeRun({
          target: routeParam(params, "runId"),
          overrides: body.overrides,
        }),
      );
    },
  },
  {
    method: "POST",
    pattern: ["api", "runs", ":runId", "archive"],
    handler: (_req, res, ctx, params) => {
      sendJson(res, 200, ctx.operations.archiveRun(routeParam(params, "runId")));
    },
  },
  {
    method: "POST",
    pattern: ["api", "runs", ":runId", "unarchive"],
    handler: (_req, res, ctx, params) => {
      sendJson(res, 200, ctx.operations.unarchiveRun(routeParam(params, "runId")));
    },
  },
  {
    method: "POST",
    pattern: ["api", "runs", ":runId", "reset"],
    handler: (_req, res, ctx, params) => {
      sendJson(res, 200, ctx.operations.resetRun(routeParam(params, "runId")));
    },
  },
  {
    method: "DELETE",
    pattern: ["api", "runs", ":runId"],
    handler: (_req, res, ctx, params) => {
      sendJson(res, 200, ctx.operations.deleteRun(routeParam(params, "runId")));
    },
  },
  {
    method: "POST",
    pattern: ["api", "runs", ":runId", "name"],
    handler: async (req, res, ctx, params) => {
      const body = await parseRunSetNameBody(req, routeParam(params, "runId"));
      sendJson(
        res,
        200,
        await ctx.operations.setRunName(body.target, {
          name: body.name,
        }),
      );
    },
  },
  {
    method: "POST",
    pattern: ["api", "runs", ":runId", "note"],
    handler: async (req, res, ctx, params) => {
      const body = await parseRunSetNoteBody(req, routeParam(params, "runId"));
      sendJson(
        res,
        200,
        ctx.operations.setRunNote(body.target, {
          note: body.note,
        }),
      );
    },
  },
  {
    method: "POST",
    pattern: ["api", "runs", ":runId", "pinned"],
    handler: async (req, res, ctx, params) => {
      const body = await parseRunSetPinnedBody(req, routeParam(params, "runId"));
      const result = ctx.operations.setRunPinned(body.target, {
        pinned: body.pinned,
      });
      sendJson(res, 200, result);
    },
  },
  {
    method: "POST",
    pattern: ["api", "runs", ":runId", "backend-session"],
    handler: async (req, res, ctx, params) => {
      const body = await parseRunSetBackendSessionBody(req, routeParam(params, "runId"));
      sendJson(
        res,
        200,
        ctx.operations.setRunBackendSession(body.target, {
          backendSessionId: body.backendSessionId,
        }),
      );
    },
  },
  {
    method: "POST",
    pattern: ["api", "runs", ":runId", "backend-session", "clear"],
    handler: (_req, res, ctx, params) => {
      sendJson(res, 200, ctx.operations.clearBackendSession(routeParam(params, "runId")));
    },
  },
  {
    method: "POST",
    pattern: ["api", "runs", ":runId", "dependencies"],
    handler: async (req, res, ctx, params) => {
      const body = asRecord(await readJsonBody(req), "request body");
      sendJson(
        res,
        200,
        ctx.operations.addDependency(
          routeParam(params, "runId"),
          requiredRunIdString(body.dependencyRunId, "dependencyRunId"),
        ),
      );
    },
  },
  {
    method: "DELETE",
    pattern: ["api", "runs", ":runId", "dependencies", ":dependencyRunId"],
    handler: (_req, res, ctx, params) => {
      sendJson(
        res,
        200,
        ctx.operations.removeDependency(
          routeParam(params, "runId"),
          routeParam(params, "dependencyRunId"),
        ),
      );
    },
  },
  {
    method: "POST",
    pattern: ["api", "runs", ":runId", "dependencies", "clear"],
    handler: (_req, res, ctx, params) => {
      sendJson(res, 200, ctx.operations.clearDependencies(routeParam(params, "runId")));
    },
  },
  {
    method: "POST",
    pattern: ["api", "runs", ":runId", "abort"],
    handler: (_req, res, ctx, params) => {
      sendJson(res, 200, ctx.operations.abortRun(routeParam(params, "runId")));
    },
  },
  {
    method: "GET",
    pattern: ["api", "runs", ":runId", "attachments"],
    handler: (_req, res, ctx, params, url) => {
      sendJson(
        res,
        200,
        ctx.operations.listAttachments(routeParam(params, "runId"), {
          cwdScope: parseBooleanQueryValue(url.searchParams.get("cwdScope"), "cwdScope"),
        }),
      );
    },
  },
  {
    method: "POST",
    pattern: ["api", "runs", ":runId", "attachments"],
    handler: async (req, res, ctx, params) => {
      const rawName = requiredHeaderString(
        req.headers["x-task-runner-attachment-name"],
        "x-task-runner-attachment-name",
      );
      let name: string;
      try {
        name = decodeURIComponent(rawName);
      } catch {
        throw new RequestValidationError("x-task-runner-attachment-name must be percent-encoded");
      }
      const mimeType =
        optionalHeaderString(req.headers["content-type"], "content-type")?.trim() || undefined;
      sendJson(
        res,
        200,
        await ctx.operations.addAttachment(routeParam(params, "runId"), {
          name,
          source: req,
          mimeType,
        }),
      );
    },
  },
  {
    method: "DELETE",
    pattern: ["api", "runs", ":runId", "attachments", ":attachmentId"],
    handler: (_req, res, ctx, params) => {
      sendJson(
        res,
        200,
        ctx.operations.removeAttachment(
          routeParam(params, "runId"),
          routeParam(params, "attachmentId"),
        ),
      );
    },
  },
  {
    method: "GET",
    pattern: ["api", "runs", ":runId", "attachments", ":attachmentId", "content"],
    handler: (_req, res, ctx, params) => {
      const result = ctx.operations.getAttachment(
        routeParam(params, "runId"),
        routeParam(params, "attachmentId"),
      );
      sendBuffer(res, 200, readFileSync(result.absolutePath), result.attachment.mimeType, {
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.attachment.name)}`,
        "x-task-runner-attachment-id": result.attachment.id,
        "x-task-runner-sha256": result.attachment.sha256,
      });
    },
  },
  {
    method: "GET",
    pattern: ["api", "runs", ":runId", "tasks"],
    handler: (_req, res, ctx, params) => {
      sendJson(res, 200, ctx.operations.listTasks(routeParam(params, "runId")));
    },
  },
  {
    method: "GET",
    pattern: ["api", "runs", ":runId", "tasks", ":taskId"],
    handler: (_req, res, ctx, params) => {
      sendJson(
        res,
        200,
        ctx.operations.getTask(routeParam(params, "runId"), routeParam(params, "taskId")),
      );
    },
  },
  {
    method: "PATCH",
    pattern: ["api", "runs", ":runId", "tasks", ":taskId"],
    handler: async (req, res, ctx, params) => {
      const body = asRecord(await readJsonBody(req), "request body");
      sendJson(
        res,
        200,
        await ctx.operations.updateTask(routeParam(params, "runId"), routeParam(params, "taskId"), {
          status: optionalEnum(body.status, "status", VALID_STATUSES),
          notes: optionalString(body.notes, "notes"),
        }),
      );
    },
  },
  {
    method: "POST",
    pattern: ["api", "runs", ":runId", "tasks", ":taskId", "append-notes"],
    handler: async (req, res, ctx, params) => {
      const body = asRecord(await readJsonBody(req), "request body");
      sendJson(
        res,
        200,
        await ctx.operations.appendTaskNotes(
          routeParam(params, "runId"),
          routeParam(params, "taskId"),
          requiredString(body.text, "text"),
        ),
      );
    },
  },
  {
    method: "POST",
    pattern: ["api", "runs", ":runId", "tasks"],
    handler: async (req, res, ctx, params) => {
      const body = asRecord(await readJsonBody(req), "request body");
      sendJson(
        res,
        200,
        await ctx.operations.createTask(routeParam(params, "runId"), {
          title: requiredString(body.title, "title"),
          body: optionalString(body.body, "body"),
        }),
      );
    },
  },
  {
    method: "GET",
    pattern: ["api", "events", "run-summaries"],
    handler: (req, res, ctx) => {
      streamEvents(req, res, (publish) => ctx.subscribeRunSummaries(publish));
    },
  },
  {
    method: "GET",
    pattern: ["api", "runs", ":runId", "events", "detail"],
    handler: (req, res, ctx, params) => {
      const runId = routeParam(params, "runId");
      ctx.operations.getRun(runId);
      streamEvents(req, res, (publish) => ctx.subscribeRunDetail(runId, publish));
    },
  },
  {
    method: "GET",
    pattern: ["api", "runs", ":runId", "events", "timeline"],
    handler: (req, res, ctx, params) => {
      const runId = routeParam(params, "runId");
      ctx.operations.getRun(runId);
      streamEvents(
        req,
        res,
        (publish) => ctx.subscribeRunTimeline(runId, publish),
        (payload: RunTimelineEnvelope) => ({
          id: String(payload.cursor),
          data: payload,
        }),
      );
    },
  },
];

export async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  try {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", ctx.httpBaseUrl);
    const path = splitPath(url.pathname);

    for (const route of routes) {
      if (route.method !== method) {
        continue;
      }
      const params = matchPath(path, route.pattern);
      if (!params) {
        continue;
      }
      await route.handler(req, res, ctx, params, url);
      return;
    }

    throw new HttpError(404, "NOT_FOUND", `route not found: ${method} ${url.pathname}`);
  } catch (err) {
    try {
      sendError(res, err);
    } catch {
      if (!res.writableEnded) {
        res.end();
      }
    }
  }
}

async function parseStartRunBody(req: IncomingMessage): Promise<RunsStartParams> {
  return parseStartRunParams(await readJsonBody(req), "request body");
}

async function parseResumeRunBody(req: IncomingMessage): Promise<ResumeRunBody> {
  const body = asRecord(await readJsonBody(req), "request body");
  return {
    overrides: optionalOverrides(body.overrides),
  };
}

async function parseRunSetNameBody(req: IncomingMessage, runId: string): Promise<RunSetNameParams> {
  const body = asRecord(await readJsonBody(req), "request body");
  return parseRunSetNameParams({ ...body, target: runId }, "request body");
}

async function parseRunSetNoteBody(req: IncomingMessage, runId: string): Promise<RunSetNoteParams> {
  const body = asRecord(await readJsonBody(req), "request body");
  return parseRunSetNoteParams({ ...body, target: runId }, "request body");
}

async function parseRunSetPinnedBody(
  req: IncomingMessage,
  runId: string,
): Promise<RunSetPinnedParams> {
  const body = asRecord(await readJsonBody(req), "request body");
  return parseRunSetPinnedParams({ ...body, target: runId }, "request body");
}

async function parseRunSetBackendSessionBody(
  req: IncomingMessage,
  runId: string,
): Promise<RunSetBackendSessionParams> {
  const body = asRecord(await readJsonBody(req), "request body");
  return parseRunSetBackendSessionParams({ ...body, target: runId }, "request body");
}

function splitPath(pathname: string): string[] {
  return pathname.split("/").filter((segment) => segment.length > 0);
}

function matchPath(path: string[], pattern: string[]): Record<string, string> | null {
  if (path.length !== pattern.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (const [index, part] of pattern.entries()) {
    const segment = path[index];
    if (segment === undefined) {
      return null;
    }
    if (part.startsWith(":")) {
      params[part.slice(1)] = decodeURIComponent(segment);
      continue;
    }
    if (segment !== part) {
      return null;
    }
  }
  return params;
}

function routeParam(params: Record<string, string>, key: string): string {
  const value = params[key];
  if (value === undefined) {
    throw new HttpError(500, "INTERNAL_ERROR", `missing route param: ${key}`);
  }
  if (value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new HttpError(404, "NOT_FOUND", "resource not found");
  }
  return value;
}

function parseRunListQuery(url: URL): RunsListParams {
  const includeArchived = parseBooleanQueryValue(
    url.searchParams.get("includeArchived"),
    "includeArchived",
  );
  const cwd = url.searchParams.get("cwd");
  const repo = url.searchParams.get("repo");
  const global = parseBooleanQueryValue(url.searchParams.get("global"), "global");
  const scopeCount = Number(cwd !== null) + Number(repo !== null) + Number(global === true);

  if (scopeCount > 1) {
    throw new RequestValidationError("runs.list accepts only one of cwd, repo, or global=true");
  }
  if (cwd !== null) {
    return {
      includeArchived,
      scope: {
        kind: "cwd",
        cwd,
      },
    };
  }
  if (repo !== null) {
    return {
      includeArchived,
      scope: {
        kind: "repo",
        repo,
      },
    };
  }
  if (global === true) {
    return {
      includeArchived,
      scope: { kind: "global" },
    };
  }
  return { includeArchived };
}
