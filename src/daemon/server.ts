import { readFileSync } from "node:fs";
import { WebSocket, WebSocketServer } from "ws";
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
} from "../app/service.js";
import type { RunCommandOverrides } from "../app/service.js";
import { CommandError, isCommandError } from "../core/commands/service.js";
import {
  EmptyPromptError,
  InvalidAddedTaskError,
  InvalidBackendSessionError,
  LockedFieldError,
  RecursionDepthError,
  VarResolutionError,
} from "../core/run/run-loop.js";
import {
  AgentConfigError,
  AgentNotFoundError,
  AssignmentConfigError,
  AssignmentNotFoundError,
  ResumeError,
  RunCommandError,
  UnknownBackendError,
} from "../run-command.js";
import { shortId } from "../util/short-id.js";
import { listenSocketConfig } from "./config.js";
import {
  type EventsSubscribeParams,
  type EventsUnsubscribeParams,
  type JsonRpcRequest,
  type JsonRpcResponse,
  RPC_ERROR_COMMAND,
  RPC_ERROR_RUNTIME,
} from "./protocol.js";

interface SubscriptionRecord {
  id: string;
  ws: WebSocket;
  runId?: string;
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

function isKnownCommandError(err: unknown): boolean {
  return (
    isCommandError(err) ||
    err instanceof CommandError ||
    err instanceof UnknownBackendError ||
    err instanceof AgentNotFoundError ||
    err instanceof AgentConfigError ||
    err instanceof AssignmentNotFoundError ||
    err instanceof AssignmentConfigError ||
    err instanceof RunCommandError ||
    err instanceof VarResolutionError ||
    err instanceof LockedFieldError ||
    err instanceof ResumeError ||
    err instanceof InvalidAddedTaskError ||
    err instanceof EmptyPromptError ||
    err instanceof RecursionDepthError ||
    err instanceof InvalidBackendSessionError
  );
}

function errorResponse(id: string | number, err: unknown): JsonRpcResponse {
  const message = err instanceof Error ? err.message : String(err);
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: isKnownCommandError(err) ? RPC_ERROR_COMMAND : RPC_ERROR_RUNTIME,
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

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CommandError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new CommandError(`${label} must be a string`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  const stringValue = optionalString(value, label);
  if (stringValue === undefined) {
    throw new CommandError(`${label} is required`);
  }
  return stringValue;
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  const record = asRecord(value, label);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string") {
      throw new CommandError(`${label}.${key} must be a string`);
    }
    result[key] = entry;
  }
  return result;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new CommandError(`${label} must be a boolean`);
  }
  return value;
}

function optionalFiniteNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CommandError(`${label} must be a finite number`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new CommandError(`${label} must be a positive integer`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new CommandError(`${label} must be a non-negative integer`);
  }
  return value;
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new CommandError(`${label} must be an array of strings`);
  }
  return [...value];
}

function optionalEnum<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new CommandError(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function optionalOverrides(value: unknown): RunCommandOverrides {
  if (value === undefined) {
    return {};
  }
  const record = asRecord(value, "overrides");
  const allowedKeys = new Set([
    "cwd",
    "backend",
    "model",
    "effort",
    "taskMode",
    "message",
    "sessionName",
    "timeoutSec",
    "unrestricted",
    "maxRetries",
    "addedTasks",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new CommandError(`overrides.${key} is not supported`);
    }
  }
  return {
    cwd: optionalString(record.cwd, "overrides.cwd"),
    backend: optionalEnum(record.backend, "overrides.backend", ["claude", "codex", "passive"]),
    model: optionalString(record.model, "overrides.model"),
    effort: optionalEnum(record.effort, "overrides.effort", [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]),
    taskMode: optionalEnum(record.taskMode, "overrides.taskMode", ["file", "cli"]),
    message: optionalString(record.message, "overrides.message"),
    sessionName: optionalString(record.sessionName, "overrides.sessionName"),
    timeoutSec: optionalPositiveInteger(record.timeoutSec, "overrides.timeoutSec"),
    unrestricted: optionalBoolean(record.unrestricted, "overrides.unrestricted"),
    maxRetries: optionalNonNegativeInteger(record.maxRetries, "overrides.maxRetries"),
    addedTasks: optionalStringArray(record.addedTasks, "overrides.addedTasks"),
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
  const startedAt = new Date().toISOString();
  const subscriptions = new Map<string, SubscriptionRecord>();
  const activeRuns = new Map<string, ActiveRunRecord>();
  const sockets = new Set<WebSocket>();
  const version = packageVersion();
  const server = new WebSocketServer({ host, port, path });
  await new Promise<void>((resolve, reject) => {
    const onListening = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      server.off("listening", onListening);
      server.off("error", onError);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
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

  const broadcastRunEvent = (runId: string, event: unknown) => {
    for (const [, subscription] of subscriptions) {
      if (subscription.runId && subscription.runId !== runId) {
        continue;
      }
      if (subscription.ws.readyState !== WebSocket.OPEN) {
        subscriptions.delete(subscription.id);
        continue;
      }
      try {
        subscription.ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "run.event",
            params: {
              subscriptionId: subscription.id,
              runId,
              event,
            },
          }),
        );
      } catch {
        subscriptions.delete(subscription.id);
      }
    }
  };

  const executeManagedRun = async (
    start: (
      emitEvent: (event: unknown) => void,
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

    void start((event) => {
      const eventRecord = event as Record<string, unknown>;
      if (
        (eventRecord.type === "run_started" || eventRecord.type === "run_initialized") &&
        !runId
      ) {
        runId = requiredString(eventRecord.runId, "event.runId");
        activeRuns.set(runId, { abortController, done });
        resolveRunId?.(runId);
      }
      const resolvedRunId =
        runId ??
        (eventRecord.type === "run_finished"
          ? requiredString(asRecord(eventRecord.summary, "summary").runId, "summary.runId")
          : undefined);
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

  const handleRequest = async (ws: WebSocket, request: JsonRpcRequest): Promise<void> => {
    try {
      const params = request.params;
      switch (request.method) {
        case "daemon.info":
          ws.send(
            JSON.stringify(
              resultResponse(request.id, {
                pid: process.pid,
                listenUrl,
                version,
                startedAt,
              }),
            ),
          );
          return;
        case "runs.list": {
          const parsed = params ? asRecord(params, "runs.list params") : {};
          ws.send(
            JSON.stringify(
              resultResponse(request.id, {
                runs: app.getRunList({
                  includeArchived: parsed.includeArchived === true,
                }),
              }),
            ),
          );
          return;
        }
        case "runs.get":
          ws.send(
            JSON.stringify(
              resultResponse(request.id, {
                run: app.getRun(
                  requiredString(asRecord(params, "runs.get params").target, "target"),
                ),
              }),
            ),
          );
          return;
        case "tasks.list":
          ws.send(
            JSON.stringify(
              resultResponse(request.id, {
                tasks: app.getTaskList(
                  requiredString(asRecord(params, "tasks.list params").target, "target"),
                ),
              }),
            ),
          );
          return;
        case "tasks.get": {
          const parsed = asRecord(params, "tasks.get params");
          ws.send(
            JSON.stringify(
              resultResponse(request.id, {
                task: app.getTask(
                  requiredString(parsed.target, "target"),
                  requiredString(parsed.taskId, "taskId"),
                ),
              }),
            ),
          );
          return;
        }
        case "agents.list":
          ws.send(
            JSON.stringify(resultResponse(request.id, { agents: app.getDefinitionList("agent") })),
          );
          return;
        case "agents.get": {
          const parsed = asRecord(params, "agents.get params");
          ws.send(
            JSON.stringify(
              resultResponse(request.id, {
                agent: app.getDefinition(
                  "agent",
                  requiredString(parsed.target, "target"),
                  optionalString(parsed.cwd, "cwd"),
                ),
              }),
            ),
          );
          return;
        }
        case "assignments.list":
          ws.send(
            JSON.stringify(
              resultResponse(request.id, { assignments: app.getDefinitionList("assignment") }),
            ),
          );
          return;
        case "assignments.get": {
          const parsed = asRecord(params, "assignments.get params");
          ws.send(
            JSON.stringify(
              resultResponse(request.id, {
                assignment: app.getDefinition(
                  "assignment",
                  requiredString(parsed.target, "target"),
                  optionalString(parsed.cwd, "cwd"),
                ),
              }),
            ),
          );
          return;
        }
        case "runs.archive":
          ws.send(
            JSON.stringify(
              resultResponse(request.id, {
                result: app.archive(
                  requiredString(asRecord(params, "runs.archive params").target, "target"),
                ),
              }),
            ),
          );
          return;
        case "runs.unarchive":
          ws.send(
            JSON.stringify(
              resultResponse(request.id, {
                result: app.unarchive(
                  requiredString(asRecord(params, "runs.unarchive params").target, "target"),
                ),
              }),
            ),
          );
          return;
        case "runs.reset":
          ws.send(
            JSON.stringify(
              resultResponse(request.id, {
                run: app.reset(
                  requiredString(asRecord(params, "runs.reset params").target, "target"),
                ),
              }),
            ),
          );
          return;
        case "tasks.set": {
          const parsed = asRecord(params, "tasks.set params");
          ws.send(
            JSON.stringify(
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
            ),
          );
          return;
        }
        case "tasks.appendNotes": {
          const parsed = asRecord(params, "tasks.appendNotes params");
          ws.send(
            JSON.stringify(
              resultResponse(request.id, {
                task: app.appendNotes(
                  requiredString(parsed.target, "target"),
                  requiredString(parsed.taskId, "taskId"),
                  requiredString(parsed.text, "text"),
                ),
              }),
            ),
          );
          return;
        }
        case "tasks.add": {
          const parsed = asRecord(params, "tasks.add params");
          ws.send(
            JSON.stringify(
              resultResponse(request.id, {
                task: app.createTask(requiredString(parsed.target, "target"), {
                  title: requiredString(parsed.title, "title"),
                  body: optionalString(parsed.body, "body"),
                }),
              }),
            ),
          );
          return;
        }
        case "runs.init": {
          const parsed = asRecord(params, "runs.init params");
          ws.send(
            JSON.stringify(
              resultResponse(request.id, {
                run: await app.initRun({
                  agent: optionalString(parsed.agent, "agent"),
                  assignment: optionalString(parsed.assignment, "assignment"),
                  definitionCwd: optionalString(parsed.definitionCwd, "definitionCwd"),
                  callerCwd: optionalString(parsed.callerCwd, "callerCwd"),
                  backendSessionId: optionalString(parsed.backendSessionId, "backendSessionId"),
                  cliVars: stringRecord(parsed.cliVars, "cliVars"),
                  overrides: optionalOverrides(parsed.overrides),
                }),
              }),
            ),
          );
          return;
        }
        case "runs.start": {
          const parsed = asRecord(params, "runs.start params");
          ws.send(
            JSON.stringify(
              resultResponse(
                request.id,
                await executeManagedRun((emitEvent, abortSignal) =>
                  app.startRun({
                    agent: optionalString(parsed.agent, "agent"),
                    assignment: optionalString(parsed.assignment, "assignment"),
                    definitionCwd: optionalString(parsed.definitionCwd, "definitionCwd"),
                    callerCwd: optionalString(parsed.callerCwd, "callerCwd"),
                    backendSessionId: optionalString(parsed.backendSessionId, "backendSessionId"),
                    cliVars: stringRecord(parsed.cliVars, "cliVars"),
                    overrides: optionalOverrides(parsed.overrides),
                    abortSignal,
                    emitEvent,
                  }),
                ),
              ),
            ),
          );
          return;
        }
        case "runs.resume": {
          const parsed = asRecord(params, "runs.resume params");
          ws.send(
            JSON.stringify(
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
            ),
          );
          return;
        }
        case "runs.abort": {
          const parsed = asRecord(params, "runs.abort params");
          const target = requiredString(parsed.target, "target");
          const active = activeRuns.get(target);
          if (!active) {
            throw new CommandError(`run ${target} is not active in this daemon process`);
          }
          active.abortController.abort();
          sendJson(ws, resultResponse(request.id, { runId: target, accepted: true }));
          return;
        }
        case "events.subscribe": {
          const parsed = params
            ? (asRecord(params, "events.subscribe params") as EventsSubscribeParams)
            : {};
          const subscriptionId = `sub-${shortId()}`;
          subscriptions.set(subscriptionId, {
            id: subscriptionId,
            ws,
            runId: optionalString(parsed.runId, "runId"),
          });
          sendJson(ws, resultResponse(request.id, { subscriptionId }));
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

  server.on("connection", (ws) => {
    sockets.add(ws);
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
      void handleRequest(ws, request as JsonRpcRequest);
    });

    ws.on("close", () => {
      sockets.delete(ws);
      for (const [id, subscription] of subscriptions) {
        if (subscription.ws === ws) {
          subscriptions.delete(id);
        }
      }
    });
  });

  return {
    listenUrl,
    startedAt,
    close: async () => {
      const active = [...activeRuns.values()];
      for (const record of active) {
        record.abortController.abort();
      }
      await Promise.allSettled(active.map((record) => record.done));
      for (const ws of sockets) {
        ws.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    },
  };
}
