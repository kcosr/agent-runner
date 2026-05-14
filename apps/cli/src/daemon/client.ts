import { createReadStream, createWriteStream, rmSync, statSync } from "node:fs";
import type { ClientRequest, IncomingMessage } from "node:http";
import { pipeline } from "node:stream/promises";
import type {
  AttachmentScope,
  RunAttachmentDownloadResult,
} from "@agent-runner/core/contracts/attachments.js";
import type { RunAuditEvent, RunTimelineEvent } from "@agent-runner/core/contracts/events.js";
import {
  runAuditEventSchema,
  runDetailSchema,
  runSummarySchema,
  runTimelineEventSchema,
} from "@agent-runner/core/contracts/run-schemas.js";
import { resolveAttachmentOutputPath } from "@agent-runner/core/core/run/attachments.js";
import WebSocket from "ws";
import { z } from "zod";
import type {
  AttachmentsDownloadResult,
  AttachmentsListResult,
  AttachmentsRemoveResult,
  AttachmentsUploadFinishResult,
  AttachmentsUploadOpenResult,
  EventsSubscribeParams,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  RunAuditNotificationParams,
  RunDetailNotificationParams,
  RunSummaryNotificationParams,
  RunTimelineNotificationParams,
} from "./protocol.js";
import { parseStreamNotification } from "./request-parsing.js";
import { WebSocketStreamRegistry } from "./stream.js";

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

interface DaemonClientConnectOptions {
  headers?: Record<string, string>;
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
  private readonly streams: WebSocketStreamRegistry;

  private constructor(
    private readonly ws: WebSocket,
    readonly url: string,
  ) {
    this.streams = new WebSocketStreamRegistry(ws);
    ws.on("message", (data) => this.handleMessage(data.toString()));
    ws.on("close", () => {
      const error = new Error("daemon connection closed");
      this.failPending(error);
      this.streams.close(error);
    });
    ws.on("error", () => {
      // The connect-time error is handled by `connect()`. After the socket is
      // established, pending RPCs are rejected from the close handler.
    });
  }

  static async connect(
    url: string,
    options: DaemonClientConnectOptions = {},
  ): Promise<DaemonClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: options.headers });
      let settled = false;
      const onOpen = () => {
        settled = true;
        cleanup();
        resolve(new DaemonClient(ws, url));
      };
      const rejectConnection = (cause: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new DaemonConnectionError(url, cause));
      };
      const onError = (err: Error) => {
        rejectConnection(err);
      };
      const onUnexpectedResponse = (_request: ClientRequest, response: IncomingMessage) => {
        response.destroy();
        const status = response.statusCode ?? "unknown";
        rejectConnection(new Error(`Unexpected server response: ${status}`));
      };
      const onClose = () => {
        rejectConnection(new Error("daemon connection closed"));
      };
      const cleanup = () => {
        ws.off("open", onOpen);
        ws.off("error", onError);
        ws.off("unexpected-response", onUnexpectedResponse);
        ws.off("close", onClose);
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
      ws.once("unexpected-response", onUnexpectedResponse);
      ws.once("close", onClose);
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

  async listAttachments(
    runId: string,
    options: { scope?: AttachmentScope } = {},
  ): Promise<AttachmentsListResult["attachments"]> {
    return (
      await this.call<AttachmentsListResult>("attachments.list", {
        runId,
        scope: options.scope,
      })
    ).attachments;
  }

  async addAttachment(
    runId: string,
    input: { sourcePath: string; name: string; mimeType?: string },
  ): Promise<AttachmentsUploadFinishResult["attachment"]> {
    const sourceStat = statSync(input.sourcePath);
    const opened = await this.call<AttachmentsUploadOpenResult>("attachments.upload.open", {
      runId,
      name: input.name,
      mimeType: input.mimeType,
      size: sourceStat.size,
    });
    this.streams.openOutgoingStream(opened.streamId);
    await this.streams.sendIterable(opened.streamId, createReadStream(input.sourcePath));
    return (
      await this.call<AttachmentsUploadFinishResult>("attachments.upload.finish", {
        streamId: opened.streamId,
      })
    ).attachment;
  }

  async removeAttachment(
    runId: string,
    attachmentId: string,
  ): Promise<AttachmentsRemoveResult["result"]> {
    return (
      await this.call<AttachmentsRemoveResult>("attachments.remove", {
        runId,
        attachmentId,
      })
    ).result;
  }

  async downloadAttachment(
    runId: string,
    attachmentId: string,
    outputPath: string,
  ): Promise<RunAttachmentDownloadResult> {
    const opened = await this.call<AttachmentsDownloadResult>("attachments.download", {
      runId,
      attachmentId,
    });
    let resolvedOutputPath: string;
    try {
      resolvedOutputPath = resolveAttachmentOutputPath(outputPath, opened.attachment.name);
    } catch (error) {
      await this.streams
        .sendCancel(opened.streamId, error instanceof Error ? error.message : String(error))
        .catch(() => undefined);
      throw error;
    }
    let createdOutput = false;
    try {
      const stream = this.streams.openIncomingStream(opened.streamId);
      const output = createWriteStream(resolvedOutputPath, { flags: "wx", autoClose: true });
      output.once("open", () => {
        createdOutput = true;
      });
      await pipeline(stream, output);
    } catch (error) {
      if (createdOutput) {
        rmSync(resolvedOutputPath, { force: true });
      }
      await this.streams
        .sendCancel(opened.streamId, error instanceof Error ? error.message : String(error))
        .catch(() => undefined);
      throw error;
    }
    return {
      ...opened.attachment,
      outputPath: resolvedOutputPath,
    };
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const error = new DaemonRpcError(-32700, `daemon emitted malformed JSON-RPC: ${detail}`);
      this.failPending(error);
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1002, "malformed JSON-RPC");
      }
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }

    const message = parsed as JsonRpcResponse | JsonRpcNotification;
    if ("id" in message) {
      const pending = this.pending.get(String(message.id));
      if (!pending) {
        return;
      }
      this.pending.delete(String(message.id));
      if (message.error) {
        pending.reject(
          new DaemonRpcError(message.error.code, message.error.message, message.error.data),
        );
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if (message.method?.startsWith("stream.")) {
      try {
        this.streams.handleFrame(parseStreamNotification(message));
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.failPending(
          new DaemonRpcError(-32600, `daemon emitted invalid stream frame: ${detail}`),
        );
        this.ws.close(1002, "invalid stream frame");
      }
      return;
    }

    const params = parseSubscriptionNotification(message);
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
