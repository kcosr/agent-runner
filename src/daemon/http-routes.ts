import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunCommandOverrides } from "../app/service.js";
import { VALID_STATUSES } from "../assignment/model.js";
import { HttpError } from "./http-errors.js";
import { readJsonBody, sendError, sendJson } from "./http-serializers.js";
import type { DaemonInfo } from "./protocol.js";
import {
  asRecord,
  optionalEnum,
  optionalOverrides,
  optionalString,
  parseBooleanQueryValue,
  requiredString,
  stringRecord,
} from "./request-parsing.js";
import type { DaemonHandlers } from "./server.js";
import { type SseRunEventEnvelope, streamRunEvents } from "./sse.js";

interface StartRunBody {
  agent?: string;
  assignment?: string;
  definitionCwd?: string;
  callerCwd?: string;
  backendSessionId?: string;
  cliVars: Record<string, string>;
  overrides: RunCommandOverrides;
}

interface ResumeRunBody {
  overrides: RunCommandOverrides;
}

interface RouteContext extends DaemonHandlers {
  daemonInfo: DaemonInfo;
  httpBaseUrl: string;
  startManagedRun(request: StartRunBody): Promise<{ runId: string }>;
  resumeManagedRun(request: {
    target: string;
    overrides: RunCommandOverrides;
  }): Promise<{ runId: string }>;
  abortRun(target: string): { runId: string; accepted: true };
  subscribeRunEvents(
    runId: string | undefined,
    publish: (payload: SseRunEventEnvelope) => boolean,
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
      sendJson(res, 200, {
        daemon: ctx.daemonInfo,
      });
    },
  },
  {
    method: "GET",
    pattern: ["api", "runs"],
    handler: (_req, res, ctx, _params, url) => {
      sendJson(res, 200, {
        runs: ctx.getRunList({
          includeArchived: parseBooleanQueryValue(
            url.searchParams.get("includeArchived"),
            "includeArchived",
          ),
        }),
      });
    },
  },
  {
    method: "GET",
    pattern: ["api", "runs", ":runId"],
    handler: (_req, res, ctx, params) => {
      sendJson(res, 200, {
        run: ctx.getRun(routeParam(params, "runId")),
      });
    },
  },
  {
    method: "POST",
    pattern: ["api", "runs", "init"],
    handler: async (req, res, ctx) => {
      sendJson(res, 200, {
        run: await ctx.initRun(await parseStartRunBody(req)),
      });
    },
  },
  {
    method: "POST",
    pattern: ["api", "runs"],
    handler: async (req, res, ctx) => {
      const outcome = await ctx.startManagedRun(await parseStartRunBody(req));
      sendJson(res, 200, { runId: outcome.runId });
    },
  },
  {
    method: "POST",
    pattern: ["api", "runs", ":runId", "resume"],
    handler: async (req, res, ctx, params) => {
      const body = await parseResumeRunBody(req);
      const outcome = await ctx.resumeManagedRun({
        target: routeParam(params, "runId"),
        overrides: body.overrides,
      });
      sendJson(res, 200, { runId: outcome.runId });
    },
  },
  {
    method: "POST",
    pattern: ["api", "runs", ":runId", "archive"],
    handler: (_req, res, ctx, params) => {
      sendJson(res, 200, { result: ctx.archive(routeParam(params, "runId")) });
    },
  },
  {
    method: "POST",
    pattern: ["api", "runs", ":runId", "unarchive"],
    handler: (_req, res, ctx, params) => {
      sendJson(res, 200, { result: ctx.unarchive(routeParam(params, "runId")) });
    },
  },
  {
    method: "POST",
    pattern: ["api", "runs", ":runId", "abort"],
    handler: (_req, res, ctx, params) => {
      sendJson(res, 200, ctx.abortRun(routeParam(params, "runId")));
    },
  },
  {
    method: "GET",
    pattern: ["api", "runs", ":runId", "tasks"],
    handler: (_req, res, ctx, params) => {
      sendJson(res, 200, { tasks: ctx.getTaskList(routeParam(params, "runId")) });
    },
  },
  {
    method: "GET",
    pattern: ["api", "runs", ":runId", "tasks", ":taskId"],
    handler: (_req, res, ctx, params) => {
      sendJson(res, 200, {
        task: ctx.getTask(routeParam(params, "runId"), routeParam(params, "taskId")),
      });
    },
  },
  {
    method: "PATCH",
    pattern: ["api", "runs", ":runId", "tasks", ":taskId"],
    handler: async (req, res, ctx, params) => {
      const body = asRecord(await readJsonBody(req), "request body");
      sendJson(res, 200, {
        task: ctx.updateTask(routeParam(params, "runId"), routeParam(params, "taskId"), {
          status: optionalEnum(body.status, "status", VALID_STATUSES),
          notes: optionalString(body.notes, "notes"),
        }),
      });
    },
  },
  {
    method: "POST",
    pattern: ["api", "runs", ":runId", "tasks", ":taskId", "append-notes"],
    handler: async (req, res, ctx, params) => {
      const body = asRecord(await readJsonBody(req), "request body");
      sendJson(res, 200, {
        task: ctx.appendNotes(
          routeParam(params, "runId"),
          routeParam(params, "taskId"),
          requiredString(body.text, "text"),
        ),
      });
    },
  },
  {
    method: "POST",
    pattern: ["api", "runs", ":runId", "tasks"],
    handler: async (req, res, ctx, params) => {
      const body = asRecord(await readJsonBody(req), "request body");
      sendJson(res, 200, {
        task: ctx.createTask(routeParam(params, "runId"), {
          title: requiredString(body.title, "title"),
          body: optionalString(body.body, "body"),
        }),
      });
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

async function parseStartRunBody(req: IncomingMessage): Promise<StartRunBody> {
  const body = asRecord(await readJsonBody(req), "request body");
  return {
    agent: optionalString(body.agent, "agent"),
    assignment: optionalString(body.assignment, "assignment"),
    definitionCwd: optionalString(body.definitionCwd, "definitionCwd"),
    callerCwd: optionalString(body.callerCwd, "callerCwd"),
    backendSessionId: optionalString(body.backendSessionId, "backendSessionId"),
    cliVars: stringRecord(body.cliVars, "cliVars"),
    overrides: optionalOverrides(body.overrides),
  };
}

async function parseResumeRunBody(req: IncomingMessage): Promise<ResumeRunBody> {
  const body = asRecord(await readJsonBody(req), "request body");
  return {
    overrides: optionalOverrides(body.overrides),
  };
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
