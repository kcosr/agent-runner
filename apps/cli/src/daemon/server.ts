import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { type Socket, createServer as createNetServer } from "node:net";
import {
  appendNotes,
  archive,
  createTask,
  getDefinition,
  getDefinitionList,
  getRun,
  getRunList,
  getTask,
  getTaskList,
  initRun,
  renameRun,
  reset,
  resumeRun,
  startRun,
  unarchive,
  updateTask,
} from "@task-runner/core/app/service.js";
import { VALID_STATUSES } from "@task-runner/core/assignment/model.js";
import type {
  RunAbortReason,
  RunCapabilities,
  RunDetail,
  RunSummary,
} from "@task-runner/core/contracts/runs.js";
import { ConflictError } from "@task-runner/core/core/commands/service.js";
import type { RunEvent } from "@task-runner/core/core/run/run-loop.js";
import { shortId } from "@task-runner/core/util/short-id.js";
import { WebSocket, WebSocketServer } from "ws";
import { deriveAppRuntimeConfig, deriveHttpBaseUrl, listenSocketConfig } from "./config.js";
import { serveFrontendRequest } from "./frontend.js";
import { isKnownControlPlaneError } from "./http-errors.js";
import { handleHttpRequest } from "./http-routes.js";
import { type DaemonHandlers, createDaemonOperations } from "./operations.js";
import {
  type JsonRpcRequest,
  type JsonRpcResponse,
  RPC_ERROR_COMMAND,
  RPC_ERROR_RUNTIME,
} from "./protocol.js";
import {
  asRecord,
  optionalEnum,
  optionalOverrides,
  optionalString,
  parseRunSetNameParams,
  parseStartRunParams,
  requiredString,
} from "./request-parsing.js";

interface SubscriptionRecord {
  id: string;
  owner: object;
  runId?: string;
  publish(runId: string, event: RunEvent): boolean;
}

interface ActiveRunRecord {
  abortController: AbortController;
  done: Promise<void>;
}

function deriveDaemonAbortCapability(
  runId: string,
  status: string,
  activeRuns: Map<string, ActiveRunRecord>,
): Pick<RunCapabilities, "canAbort" | "abortReason"> {
  if (activeRuns.has(runId)) {
    return { canAbort: true };
  }

  const abortReason: RunAbortReason =
    status === "success" ||
    status === "blocked" ||
    status === "exhausted" ||
    status === "aborted" ||
    status === "error"
      ? "already_terminal"
      : "not_active_in_daemon";
  return {
    canAbort: false,
    abortReason,
  };
}

function withDaemonAbortCapability<T extends RunSummary | RunDetail>(
  run: T,
  activeRuns: Map<string, ActiveRunRecord>,
): T {
  const abortCapability = deriveDaemonAbortCapability(run.runId, run.status, activeRuns);
  const capabilities: RunCapabilities = {
    ...run.capabilities,
    ...abortCapability,
  };
  if (capabilities.canAbort) {
    capabilities.abortReason = undefined;
  }
  return {
    ...run,
    capabilities,
  };
}

function packageVersion(): string {
  const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? "0.0.0";
}

function errorResponse(id: string | number, err: unknown): JsonRpcResponse {
  const message = err instanceof Error ? err.message : String(err);
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: isKnownControlPlaneError(err) ? RPC_ERROR_COMMAND : RPC_ERROR_RUNTIME,
      message,
    },
  };
}

function rpcErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
}

function resultResponse(id: string | number, result: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function sendJson(ws: WebSocket, payload: JsonRpcResponse): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(payload));
}

export interface DaemonServerHandle {
  listenUrl: string;
  httpBaseUrl: string;
  startedAt: string;
  close(): Promise<void>;
}

export async function serveDaemon(
  listenUrl: string,
  handlers: Partial<DaemonHandlers> = {},
): Promise<DaemonServerHandle> {
  const { host, port, path } = listenSocketConfig(listenUrl);
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const startedAt = new Date().toISOString();
  const daemonInstanceId = `daemon-${shortId()}`;
  const version = packageVersion();
  const subscriptions = new Map<string, SubscriptionRecord>();
  const activeRuns = new Map<string, ActiveRunRecord>();
  const sockets = new Set<Socket>();
  const wsClients = new Set<WebSocket>();

  const app: DaemonHandlers = {
    getRun,
    getRunList,
    getTask,
    getTaskList,
    getDefinition,
    getDefinitionList,
    archive,
    unarchive,
    renameRun,
    reset,
    updateTask,
    appendNotes,
    createTask,
    initRun,
    startRun,
    resumeRun,
    ...handlers,
  };

  const getDaemonRun = (target: string): RunDetail =>
    withDaemonAbortCapability(app.getRun(target), activeRuns);
  const getDaemonRunList = (opts?: Parameters<typeof app.getRunList>[0]): RunSummary[] =>
    app.getRunList(opts).map((run) => withDaemonAbortCapability(run, activeRuns));

  await new Promise<void>((resolve, reject) => {
    const probe = createNetServer();
    const onListening = () => {
      cleanup();
      probe.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    };
    const onError = (error: Error) => {
      cleanup();
      probe.close(() => {
        reject(error);
      });
    };
    const cleanup = () => {
      probe.off("listening", onListening);
      probe.off("error", onError);
    };
    probe.once("listening", onListening);
    probe.once("error", onError);
    probe.listen(port, host);
  });

  const subscribeRunEvents = (
    owner: object,
    runId: string | undefined,
    publish: (runId: string, event: RunEvent) => boolean,
  ): { subscriptionId: string; unsubscribe(): void } => {
    const subscriptionId = `sub-${shortId()}`;
    subscriptions.set(subscriptionId, {
      id: subscriptionId,
      owner,
      runId,
      publish,
    });
    return {
      subscriptionId,
      unsubscribe: () => {
        subscriptions.delete(subscriptionId);
      },
    };
  };

  const removeSubscriptionsByOwner = (owner: object): void => {
    for (const [id, subscription] of subscriptions) {
      if (subscription.owner === owner) {
        subscriptions.delete(id);
      }
    }
  };

  const broadcastRunEvent = (runId: string, event: RunEvent): void => {
    for (const [id, subscription] of subscriptions) {
      if (subscription.runId && subscription.runId !== runId) {
        continue;
      }
      const keep = subscription.publish(runId, event);
      if (!keep) {
        subscriptions.delete(id);
      }
    }
  };

  const executeManagedRun = async (
    startManagedRun: (
      emitEvent: (event: RunEvent) => void,
      abortSignal: AbortSignal,
    ) => Promise<{ runId: string }>,
  ): Promise<{ runId: string }> => {
    const abortController = new AbortController();
    let runId: string | undefined;
    let resolveRunId: ((value: string) => void) | undefined;
    let rejectRunId: ((reason: unknown) => void) | undefined;
    let resolveDone: (() => void) | undefined;
    const runIdPromise = new Promise<string>((resolve, reject) => {
      resolveRunId = resolve;
      rejectRunId = reject;
    });
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    void startManagedRun((event) => {
      if ((event.type === "run_started" || event.type === "run_initialized") && !runId) {
        runId = event.runId;
        activeRuns.set(runId, { abortController, done });
        resolveRunId?.(runId);
      }
      const resolvedRunId =
        runId ?? (event.type === "run_finished" ? event.summary.runId : undefined);
      if (resolvedRunId) {
        broadcastRunEvent(resolvedRunId, event);
      }
    }, abortController.signal)
      .then((outcome) => {
        if (!runId) {
          runId = outcome.runId;
          activeRuns.set(runId, { abortController, done });
          resolveRunId?.(runId);
        }
      })
      .catch((err) => {
        if (!runId) {
          rejectRunId?.(err);
          return;
        }
        broadcastRunEvent(runId, {
          type: "backend_notice",
          text: `task-runner: ${err instanceof Error ? err.message : String(err)}\n`,
        });
      })
      .finally(() => {
        if (runId) {
          activeRuns.delete(runId);
        }
        resolveDone?.();
      });

    return { runId: await runIdPromise };
  };

  const abortRun = (target: string): { runId: string; accepted: true } => {
    const active = activeRuns.get(target);
    if (!active) {
      throw new ConflictError(`run ${target} is not active in this daemon process`);
    }
    active.abortController.abort();
    return { runId: target, accepted: true };
  };

  const operations = createDaemonOperations({
    ...app,
    getRun: getDaemonRun,
    getRunList: getDaemonRunList,
    initRun: (request) =>
      app.initRun({
        ...request,
        execution: {
          hostMode: "daemon",
          controller: {
            kind: "daemon",
            daemonInstanceId,
          },
        },
      }),
    daemonInfo: {
      daemonInstanceId,
      pid: process.pid,
      listenUrl,
      version,
      startedAt,
    },
    startManagedRun: (request) =>
      executeManagedRun((emitEvent, abortSignal) =>
        app.startRun({
          ...request,
          execution: {
            hostMode: "daemon",
            controller: {
              kind: "daemon",
              daemonInstanceId,
            },
          },
          abortSignal,
          emitEvent,
        }),
      ),
    resumeManagedRun: (request) =>
      executeManagedRun((emitEvent, abortSignal) =>
        app.resumeRun({
          ...request,
          execution: {
            hostMode: "daemon",
            controller: {
              kind: "daemon",
              daemonInstanceId,
            },
          },
          abortSignal,
          emitEvent,
        }),
      ),
    abortRun,
  });

  const httpServer = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", httpBaseUrl).pathname;

    if (pathname === "/app-config.json") {
      res.setHeader("cache-control", "no-cache");
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(deriveAppRuntimeConfig()));
      return;
    }

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      void handleHttpRequest(req, res, {
        operations,
        httpBaseUrl,
        subscribeRunEvents: (runId, publish) =>
          subscribeRunEvents(res, runId, (eventRunId, event) =>
            publish({ runId: eventRunId, event }),
          ).unsubscribe,
      });
      return;
    }

    serveFrontendRequest(req, res, pathname);
  });
  const wsServer = new WebSocketServer({ server: httpServer, path });

  httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onListening = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      void new Promise<void>((closeResolve) => wsServer.close(() => closeResolve()));
      reject(error);
    };
    const cleanup = () => {
      httpServer.off("listening", onListening);
      httpServer.off("error", onError);
    };
    httpServer.once("listening", onListening);
    httpServer.once("error", onError);
    httpServer.listen(port, host);
  });

  const handleRpcRequest = async (ws: WebSocket, request: JsonRpcRequest): Promise<void> => {
    try {
      const params = request.params;
      switch (request.method) {
        case "daemon.info":
          sendJson(ws, resultResponse(request.id, operations.readDaemonInfo().daemon));
          return;
        case "runs.list": {
          const parsed = params ? asRecord(params, "runs.list params") : {};
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.listRuns({ includeArchived: parsed.includeArchived === true }),
            ),
          );
          return;
        }
        case "runs.get":
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.getRun(
                requiredString(asRecord(params, "runs.get params").target, "target"),
              ),
            ),
          );
          return;
        case "tasks.list":
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.listTasks(
                requiredString(asRecord(params, "tasks.list params").target, "target"),
              ),
            ),
          );
          return;
        case "tasks.get": {
          const parsed = asRecord(params, "tasks.get params");
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.getTask(
                requiredString(parsed.target, "target"),
                requiredString(parsed.taskId, "taskId"),
              ),
            ),
          );
          return;
        }
        case "agents.list":
          sendJson(ws, resultResponse(request.id, operations.listAgents()));
          return;
        case "agents.get": {
          const parsed = asRecord(params, "agents.get params");
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.getAgent({
                target: requiredString(parsed.target, "target"),
                cwd: optionalString(parsed.cwd, "cwd"),
              }),
            ),
          );
          return;
        }
        case "assignments.list":
          sendJson(ws, resultResponse(request.id, operations.listAssignments()));
          return;
        case "assignments.get": {
          const parsed = asRecord(params, "assignments.get params");
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.getAssignment({
                target: requiredString(parsed.target, "target"),
                cwd: optionalString(parsed.cwd, "cwd"),
              }),
            ),
          );
          return;
        }
        case "runs.archive":
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.archiveRun(
                requiredString(asRecord(params, "runs.archive params").target, "target"),
              ),
            ),
          );
          return;
        case "runs.unarchive":
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.unarchiveRun(
                requiredString(asRecord(params, "runs.unarchive params").target, "target"),
              ),
            ),
          );
          return;
        case "runs.reset":
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.resetRun(
                requiredString(asRecord(params, "runs.reset params").target, "target"),
              ),
            ),
          );
          return;
        case "runs.setName": {
          const parsed = parseRunSetNameParams(params, "runs.setName params");
          sendJson(
            ws,
            resultResponse(
              request.id,
              await operations.setRunName(parsed.target, {
                name: parsed.name,
              }),
            ),
          );
          return;
        }
        case "tasks.set": {
          const parsed = asRecord(params, "tasks.set params");
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.updateTask(
                requiredString(parsed.target, "target"),
                requiredString(parsed.taskId, "taskId"),
                {
                  status: optionalEnum(parsed.status, "status", VALID_STATUSES),
                  notes: optionalString(parsed.notes, "notes"),
                },
              ),
            ),
          );
          return;
        }
        case "tasks.appendNotes": {
          const parsed = asRecord(params, "tasks.appendNotes params");
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.appendTaskNotes(
                requiredString(parsed.target, "target"),
                requiredString(parsed.taskId, "taskId"),
                requiredString(parsed.text, "text"),
              ),
            ),
          );
          return;
        }
        case "tasks.add": {
          const parsed = asRecord(params, "tasks.add params");
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.createTask(requiredString(parsed.target, "target"), {
                title: requiredString(parsed.title, "title"),
                body: optionalString(parsed.body, "body"),
              }),
            ),
          );
          return;
        }
        case "runs.init": {
          const parsed = parseStartRunParams(params, "runs.init params");
          sendJson(ws, resultResponse(request.id, await operations.initRun(parsed)));
          return;
        }
        case "runs.start": {
          const parsed = parseStartRunParams(params, "runs.start params");
          sendJson(ws, resultResponse(request.id, await operations.startRun(parsed)));
          return;
        }
        case "runs.resume": {
          const parsed = asRecord(params, "runs.resume params");
          sendJson(
            ws,
            resultResponse(
              request.id,
              await operations.resumeRun({
                target: requiredString(parsed.target, "target"),
                overrides: optionalOverrides(parsed.overrides),
              }),
            ),
          );
          return;
        }
        case "runs.abort": {
          const target = requiredString(asRecord(params, "runs.abort params").target, "target");
          sendJson(ws, resultResponse(request.id, operations.abortRun(target)));
          return;
        }
        case "events.subscribe": {
          const parsed: Record<string, unknown> = params
            ? asRecord(params, "events.subscribe params")
            : {};
          const subscription = subscribeRunEvents(
            ws,
            optionalString(parsed.runId, "runId"),
            (runId, event) => {
              if (ws.readyState !== WebSocket.OPEN) {
                return false;
              }
              try {
                ws.send(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    method: "run.event",
                    params: {
                      subscriptionId: subscription.subscriptionId,
                      runId,
                      event,
                    },
                  }),
                );
                return true;
              } catch {
                return false;
              }
            },
          );
          sendJson(ws, resultResponse(request.id, { subscriptionId: subscription.subscriptionId }));
          return;
        }
        case "events.unsubscribe": {
          const parsed = asRecord(params, "events.unsubscribe params");
          subscriptions.delete(requiredString(parsed.subscriptionId, "subscriptionId"));
          sendJson(ws, resultResponse(request.id, { unsubscribed: true }));
          return;
        }
        default:
          sendJson(
            ws,
            rpcErrorResponse(request.id, -32601, `unknown daemon method: ${request.method}`),
          );
      }
    } catch (err) {
      try {
        sendJson(ws, errorResponse(request.id, err));
      } catch {
        // Ignore disconnect races while attempting to report an error.
      }
    }
  };

  wsServer.on("connection", (ws) => {
    wsClients.add(ws);
    ws.on("message", (payload) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload.toString()) as unknown;
      } catch {
        sendJson(ws, rpcErrorResponse(null, -32700, "parse error"));
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        sendJson(ws, rpcErrorResponse(null, -32600, "invalid request"));
        return;
      }
      const request = parsed as Partial<JsonRpcRequest>;
      if (request.jsonrpc !== "2.0") {
        sendJson(ws, rpcErrorResponse(request.id ?? null, -32600, "invalid request"));
        return;
      }
      if (request.id === undefined || typeof request.method !== "string") {
        sendJson(ws, rpcErrorResponse(request.id ?? null, -32600, "invalid request"));
        return;
      }
      void handleRpcRequest(ws, request as JsonRpcRequest);
    });

    ws.on("close", () => {
      wsClients.delete(ws);
      removeSubscriptionsByOwner(ws);
    });
  });

  return {
    listenUrl,
    httpBaseUrl,
    startedAt,
    close: async () => {
      const wsClosePromise = new Promise<void>((resolve) => wsServer.close(() => resolve()));
      const httpClosePromise = new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err && !(err instanceof Error && err.message === "Server is not running.")) {
            reject(err);
            return;
          }
          resolve();
        });
      });
      const active = [...activeRuns.values()];
      for (const record of active) {
        record.abortController.abort();
      }
      await Promise.allSettled(active.map((record) => record.done));
      subscriptions.clear();
      for (const ws of wsClients) {
        ws.terminate();
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      await Promise.all([wsClosePromise, httpClosePromise]);
    },
  };
}
