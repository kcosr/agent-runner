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
  reset,
  resumeRun,
  startRun,
  unarchive,
  updateTask,
} from "@task-runner/core/app/service.js";
import { ConflictError } from "@task-runner/core/core/commands/service.js";
import type { RunEvent } from "@task-runner/core/core/run/run-loop.js";
import { shortId } from "@task-runner/core/util/short-id.js";
import { WebSocket, WebSocketServer } from "ws";
import { deriveHttpBaseUrl, listenSocketConfig } from "./config.js";
import { isKnownControlPlaneError } from "./http-errors.js";
import { handleHttpRequest } from "./http-routes.js";
import {
  type EventsSubscribeParams,
  type JsonRpcRequest,
  type JsonRpcResponse,
  RPC_ERROR_COMMAND,
  RPC_ERROR_RUNTIME,
} from "./protocol.js";
import {
  asRecord,
  optionalOverrides,
  optionalString,
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

export interface DaemonHandlers {
  getRun: typeof getRun;
  getRunList: typeof getRunList;
  getTask: typeof getTask;
  getTaskList: typeof getTaskList;
  getDefinition: typeof getDefinition;
  getDefinitionList: typeof getDefinitionList;
  archive: typeof archive;
  unarchive: typeof unarchive;
  reset: typeof reset;
  updateTask: typeof updateTask;
  appendNotes: typeof appendNotes;
  createTask: typeof createTask;
  initRun: typeof initRun;
  startRun: typeof startRun;
  resumeRun: typeof resumeRun;
}

export async function serveDaemon(
  listenUrl: string,
  handlers: Partial<DaemonHandlers> = {},
): Promise<DaemonServerHandle> {
  const { host, port, path } = listenSocketConfig(listenUrl);
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const startedAt = new Date().toISOString();
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
    reset,
    updateTask,
    appendNotes,
    createTask,
    initRun,
    startRun,
    resumeRun,
    ...handlers,
  };

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

  const httpServer = createServer((req, res) => {
    void handleHttpRequest(req, res, {
      ...app,
      daemonInfo: {
        pid: process.pid,
        listenUrl,
        version,
        startedAt,
      },
      httpBaseUrl,
      startManagedRun: (request) =>
        executeManagedRun((emitEvent, abortSignal) =>
          app.startRun({
            ...request,
            abortSignal,
            emitEvent,
          }),
        ),
      resumeManagedRun: (request) =>
        executeManagedRun((emitEvent, abortSignal) =>
          app.resumeRun({
            ...request,
            abortSignal,
            emitEvent,
          }),
        ),
      abortRun,
      subscribeRunEvents: (runId, publish) =>
        subscribeRunEvents(res, runId, (eventRunId, event) => publish({ runId: eventRunId, event }))
          .unsubscribe,
    });
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
          sendJson(
            ws,
            resultResponse(request.id, {
              pid: process.pid,
              listenUrl,
              version,
              startedAt,
            }),
          );
          return;
        case "runs.list": {
          const parsed = params ? asRecord(params, "runs.list params") : {};
          sendJson(
            ws,
            resultResponse(request.id, {
              runs: app.getRunList({
                includeArchived: parsed.includeArchived === true,
              }),
            }),
          );
          return;
        }
        case "runs.get":
          sendJson(
            ws,
            resultResponse(request.id, {
              run: app.getRun(requiredString(asRecord(params, "runs.get params").target, "target")),
            }),
          );
          return;
        case "tasks.list":
          sendJson(
            ws,
            resultResponse(request.id, {
              tasks: app.getTaskList(
                requiredString(asRecord(params, "tasks.list params").target, "target"),
              ),
            }),
          );
          return;
        case "tasks.get": {
          const parsed = asRecord(params, "tasks.get params");
          sendJson(
            ws,
            resultResponse(request.id, {
              task: app.getTask(
                requiredString(parsed.target, "target"),
                requiredString(parsed.taskId, "taskId"),
              ),
            }),
          );
          return;
        }
        case "agents.list":
          sendJson(ws, resultResponse(request.id, { agents: app.getDefinitionList("agent") }));
          return;
        case "agents.get": {
          const parsed = asRecord(params, "agents.get params");
          sendJson(
            ws,
            resultResponse(request.id, {
              agent: app.getDefinition(
                "agent",
                requiredString(parsed.target, "target"),
                optionalString(parsed.cwd, "cwd"),
              ),
            }),
          );
          return;
        }
        case "assignments.list":
          sendJson(
            ws,
            resultResponse(request.id, { assignments: app.getDefinitionList("assignment") }),
          );
          return;
        case "assignments.get": {
          const parsed = asRecord(params, "assignments.get params");
          sendJson(
            ws,
            resultResponse(request.id, {
              assignment: app.getDefinition(
                "assignment",
                requiredString(parsed.target, "target"),
                optionalString(parsed.cwd, "cwd"),
              ),
            }),
          );
          return;
        }
        case "runs.archive":
          sendJson(
            ws,
            resultResponse(request.id, {
              result: app.archive(
                requiredString(asRecord(params, "runs.archive params").target, "target"),
              ),
            }),
          );
          return;
        case "runs.unarchive":
          sendJson(
            ws,
            resultResponse(request.id, {
              result: app.unarchive(
                requiredString(asRecord(params, "runs.unarchive params").target, "target"),
              ),
            }),
          );
          return;
        case "runs.reset":
          sendJson(
            ws,
            resultResponse(request.id, {
              run: app.reset(
                requiredString(asRecord(params, "runs.reset params").target, "target"),
              ),
            }),
          );
          return;
        case "tasks.set": {
          const parsed = asRecord(params, "tasks.set params");
          sendJson(
            ws,
            resultResponse(request.id, {
              task: app.updateTask(
                requiredString(parsed.target, "target"),
                requiredString(parsed.taskId, "taskId"),
                {
                  status: optionalString(parsed.status, "status"),
                  notes: optionalString(parsed.notes, "notes"),
                },
              ),
            }),
          );
          return;
        }
        case "tasks.appendNotes": {
          const parsed = asRecord(params, "tasks.appendNotes params");
          sendJson(
            ws,
            resultResponse(request.id, {
              task: app.appendNotes(
                requiredString(parsed.target, "target"),
                requiredString(parsed.taskId, "taskId"),
                requiredString(parsed.text, "text"),
              ),
            }),
          );
          return;
        }
        case "tasks.add": {
          const parsed = asRecord(params, "tasks.add params");
          sendJson(
            ws,
            resultResponse(request.id, {
              task: app.createTask(requiredString(parsed.target, "target"), {
                title: requiredString(parsed.title, "title"),
                body: optionalString(parsed.body, "body"),
              }),
            }),
          );
          return;
        }
        case "runs.init": {
          const parsed = parseStartRunParams(params, "runs.init params");
          sendJson(
            ws,
            resultResponse(request.id, {
              run: await app.initRun({
                ...parsed,
              }),
            }),
          );
          return;
        }
        case "runs.start": {
          const parsed = parseStartRunParams(params, "runs.start params");
          sendJson(
            ws,
            resultResponse(
              request.id,
              await executeManagedRun((emitEvent, abortSignal) =>
                app.startRun({
                  ...parsed,
                  abortSignal,
                  emitEvent,
                }),
              ),
            ),
          );
          return;
        }
        case "runs.resume": {
          const parsed = asRecord(params, "runs.resume params");
          sendJson(
            ws,
            resultResponse(
              request.id,
              await executeManagedRun((emitEvent, abortSignal) =>
                app.resumeRun({
                  target: requiredString(parsed.target, "target"),
                  overrides: optionalOverrides(parsed.overrides),
                  abortSignal,
                  emitEvent,
                }),
              ),
            ),
          );
          return;
        }
        case "runs.abort": {
          const target = requiredString(asRecord(params, "runs.abort params").target, "target");
          sendJson(ws, resultResponse(request.id, abortRun(target)));
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
