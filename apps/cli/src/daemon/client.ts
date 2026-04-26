import type { RunAuditEvent, RunTimelineEvent } from "@task-runner/core/contracts/events.js";
import {
  runAuditEventSchema,
  runDetailSchema,
  runSummarySchema,
  runTimelineEventSchema,
} from "@task-runner/core/contracts/run-schemas.js";
import WebSocket from "ws";
import { z } from "zod";
import type {
  EventsSubscribeParams,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  RunAuditNotificationParams,
  RunDetailNotificationParams,
  RunSummaryNotificationParams,
  RunTimelineNotificationParams,
} from "./protocol.js";

export class DaemonConnectionError extends Error {
  constructor(
    public readonly url: string,
    cause?: unknown,
  ) {
    const message =
      cause instanceof Error && cause.message.length > 0
        ? cause.message
        : "daemon is not reachable";
    super(`cannot connect to daemon at ${url}: ${message}`);
    this.name = "DaemonConnectionError";
  }
}

export class DaemonRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "DaemonRpcError";
  }
}

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

type DaemonSubscriptionNotification =
  | ({ method: "run.summary" } & RunSummaryNotificationParams)
  | ({ method: "run.detail" } & RunDetailNotificationParams)
  | ({ method: "run.audit" } & RunAuditNotificationParams)
  | ({ method: "run.timeline" } & RunTimelineNotificationParams);

const runSummaryNotificationSchema = z
  .object({
    method: z.literal("run.summary"),
  })
  .and(
    z.discriminatedUnion("type", [
      z.object({
        subscriptionId: z.string(),
        type: z.literal("summary_upsert"),
        summary: runSummarySchema,
      }),
      z.object({
        subscriptionId: z.string(),
        type: z.literal("summary_removed"),
        runId: z.string(),
      }),
    ]),
  );

const runDetailNotificationSchema = z.object({
  method: z.literal("run.detail"),
  subscriptionId: z.string(),
  runId: z.string(),
  detail: runDetailSchema,
});

const runTimelineNotificationSchema = z.object({
  method: z.literal("run.timeline"),
  subscriptionId: z.string(),
  runId: z.string(),
  cursor: z.number().int().positive(),
  event: runTimelineEventSchema,
});

const runAuditNotificationSchema = z.object({
  method: z.literal("run.audit"),
  subscriptionId: z.string(),
  runId: z.string(),
  cursor: z.number().int().positive(),
  event: runAuditEventSchema,
});

const runSummaryNotificationResultSchema: z.ZodType<DaemonSubscriptionNotification> =
  runSummaryNotificationSchema;
const runDetailNotificationResultSchema: z.ZodType<DaemonSubscriptionNotification> =
  runDetailNotificationSchema;
const runTimelineNotificationResultSchema = runTimelineNotificationSchema.transform(
  (value): DaemonSubscriptionNotification => ({
    method: "run.timeline",
    subscriptionId: value.subscriptionId,
    runId: value.runId,
    cursor: value.cursor,
    event: value.event as RunTimelineEvent,
  }),
);
const runAuditNotificationResultSchema = runAuditNotificationSchema.transform(
  (value): DaemonSubscriptionNotification => ({
    method: "run.audit",
    subscriptionId: value.subscriptionId,
    runId: value.runId,
    cursor: value.cursor,
    event: value.event as RunAuditEvent,
  }),
);

function parseSubscriptionNotification(
  parsed: JsonRpcNotification,
): DaemonSubscriptionNotification | null {
  switch (parsed.method) {
    case "run.summary": {
      const result = runSummaryNotificationResultSchema.safeParse({
        method: parsed.method,
        ...(parsed.params as object),
      });
      return result.success ? result.data : null;
    }
    case "run.detail": {
      const result = runDetailNotificationResultSchema.safeParse({
        method: parsed.method,
        ...(parsed.params as object),
      });
      return result.success ? result.data : null;
    }
    case "run.timeline": {
      const result = runTimelineNotificationResultSchema.safeParse({
        method: parsed.method,
        ...(parsed.params as object),
      });
      return result.success ? result.data : null;
    }
    case "run.audit": {
      const result = runAuditNotificationResultSchema.safeParse({
        method: parsed.method,
        ...(parsed.params as object),
      });
      return result.success ? result.data : null;
    }
    default:
      return null;
  }
}

export class DaemonClient {
  private nextId = 1;
  private readonly pending = new Map<string, PendingCall>();
  private readonly subscriptions = new Map<
    string,
    (params: DaemonSubscriptionNotification) => void
  >();
  private readonly queuedNotifications = new Map<string, DaemonSubscriptionNotification[]>();

  private constructor(
    private readonly ws: WebSocket,
    readonly url: string,
  ) {
    ws.on("message", (data) => this.handleMessage(data.toString()));
    ws.on("close", () => this.failPending(new Error("daemon connection closed")));
    ws.on("error", () => {
      // The connect-time error is handled by `connect()`. After the socket is
      // established, pending RPCs are rejected from the close handler.
    });
  }

  static async connect(url: string): Promise<DaemonClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const onOpen = () => {
        cleanup();
        resolve(new DaemonClient(ws, url));
      };
      const onError = (err: Error) => {
        cleanup();
        reject(new DaemonConnectionError(url, err));
      };
      const cleanup = () => {
        ws.off("open", onOpen);
        ws.off("error", onError);
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });
  }

  async call<TResult>(method: string, params?: unknown): Promise<TResult> {
    const id = String(this.nextId++);
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify(request));
    return (await result) as TResult;
  }

  async subscribe(
    params: EventsSubscribeParams,
    onEvent: (params: DaemonSubscriptionNotification) => void,
  ): Promise<string> {
    const result = await this.call<{ subscriptionId: string }>("events.subscribe", params);
    this.subscriptions.set(result.subscriptionId, onEvent);
    const queued = this.queuedNotifications.get(result.subscriptionId);
    if (queued) {
      this.queuedNotifications.delete(result.subscriptionId);
      for (const notification of queued) {
        onEvent(notification);
      }
    }
    return result.subscriptionId;
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    this.subscriptions.delete(subscriptionId);
    this.queuedNotifications.delete(subscriptionId);
    await this.call("events.unsubscribe", { subscriptionId });
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }

  private handleMessage(raw: string): void {
    let parsed: JsonRpcResponse | JsonRpcNotification;
    try {
      parsed = JSON.parse(raw) as JsonRpcResponse | JsonRpcNotification;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const error = new DaemonRpcError(-32700, `daemon emitted malformed JSON-RPC: ${detail}`);
      this.failPending(error);
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1002, "malformed JSON-RPC");
      }
      return;
    }

    if ("id" in parsed) {
      const pending = this.pending.get(String(parsed.id));
      if (!pending) {
        return;
      }
      this.pending.delete(String(parsed.id));
      if (parsed.error) {
        pending.reject(
          new DaemonRpcError(parsed.error.code, parsed.error.message, parsed.error.data),
        );
        return;
      }
      pending.resolve(parsed.result);
      return;
    }

    const params = parseSubscriptionNotification(parsed);
    if (!params) {
      return;
    }
    const handler = this.subscriptions.get(params.subscriptionId);
    if (handler) {
      handler(params);
      return;
    }
    const queued = this.queuedNotifications.get(params.subscriptionId) ?? [];
    queued.push(params);
    this.queuedNotifications.set(params.subscriptionId, queued);
  }

  private failPending(error: Error): void {
    for (const [, pending] of this.pending) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
