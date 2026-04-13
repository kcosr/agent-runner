import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunCommandOverrides } from "@task-runner/core/app/service.js";
import { VALID_STATUSES } from "@task-runner/core/assignment/model.js";
import type { RunEventEnvelope } from "@task-runner/core/contracts/events.js";
import { HttpError } from "./http-errors.js";
import { readJsonBody, sendError, sendJson } from "./http-serializers.js";
import type { DaemonOperations } from "./operations.js";
import type { RunSetNameParams, RunsStartParams } from "./protocol.js";
import {
  asRecord,
  optionalEnum,
  optionalOverrides,
  optionalString,
  parseBooleanQueryValue,
  parseRunSetNameParams,
  parseStartRunParams,
  requiredString,
} from "./request-parsing.js";
import { streamRunEvents } from "./sse.js";

interface ResumeRunBody {
  overrides: RunCommandOverrides;
}

interface RouteContext {
  operations: DaemonOperations;
  httpBaseUrl: string;
  subscribeRunEvents(
    runId: string | undefined,
    publish: (payload: RunEventEnvelope) => boolean,
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
      sendJson(
        res,
        200,
        ctx.operations.listRuns({
          includeArchived: parseBooleanQueryValue(
            url.searchParams.get("includeArchived"),
            "includeArchived",
          ),
        }),
      );
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
    pattern: ["api", "runs", ":runId", "name"],
    handler: async (req, res, ctx, params) => {
      const body = await parseRunSetNameBody(req, routeParam(params, "runId"));
      sendJson(
        res,
        200,
        await ctx.operations.setRunName(body.target, {
          name: body.clear ? null : (body.name ?? null),
        }),
      );
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
        ctx.operations.updateTask(routeParam(params, "runId"), routeParam(params, "taskId"), {
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
        ctx.operations.appendTaskNotes(
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
        ctx.operations.createTask(routeParam(params, "runId"), {
          title: requiredString(body.title, "title"),
          body: optionalString(body.body, "body"),
        }),
      );
    },
  },
  {
    method: "GET",
    pattern: ["api", "events", "runs"],
    handler: (req, res, ctx) => {
      streamRunEvents(req, res, (publish) => ctx.subscribeRunEvents(undefined, publish));
    },
  },
  {
    method: "GET",
    pattern: ["api", "events", "runs", ":runId"],
    handler: (req, res, ctx, params) => {
      streamRunEvents(req, res, (publish) =>
        ctx.subscribeRunEvents(routeParam(params, "runId"), publish),
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
