import WebSocket from "ws";
import type {
  EventsSubscribeParams,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  RunEventNotificationParams,
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

export class DaemonClient {
  private nextId = 1;
  private readonly pending = new Map<string, PendingCall>();
  private readonly subscriptions = new Map<string, (params: RunEventNotificationParams) => void>();

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
    onEvent: (params: RunEventNotificationParams) => void,
  ): Promise<string> {
    const result = await this.call<{ subscriptionId: string }>("events.subscribe", params);
    this.subscriptions.set(result.subscriptionId, onEvent);
    return result.subscriptionId;
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    this.subscriptions.delete(subscriptionId);
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
    } catch {
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

    if (parsed.method !== "run.event") {
      return;
    }
    const params = parsed.params as RunEventNotificationParams;
    const handler = this.subscriptions.get(params.subscriptionId);
    if (handler) {
      handler(params);
    }
  }

  private failPending(error: Error): void {
    for (const [, pending] of this.pending) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
