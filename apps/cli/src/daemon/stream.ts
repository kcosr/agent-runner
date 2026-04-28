import { shortId } from "@task-runner/core/util/short-id.js";
import { WebSocket } from "ws";
import type { StreamNotification } from "./protocol.js";

export const STREAM_MAX_CHUNK_BYTES = 65_536;
export const STREAM_MAX_ACTIVE_PER_CONNECTION = 8;
export const STREAM_MAX_BUFFERED_BYTES_PER_STREAM = 1_048_576;
export const STREAM_MAX_BUFFERED_BYTES_PER_CONNECTION = 4_194_304;
export const STREAM_IDLE_TIMEOUT_MS = 30_000;

export class WebSocketStreamError extends Error {
  constructor(
    message: string,
    readonly code = "STREAM_ERROR",
  ) {
    super(message);
    this.name = "WebSocketStreamError";
  }
}

type IncomingStreamState = {
  kind: "incoming";
  streamId: string;
  expectedSeq: number;
  queue: Buffer[];
  bufferedBytes: number;
  ended: boolean;
  error: Error | null;
  waiters: Array<() => void>;
  idleTimer: ReturnType<typeof setTimeout>;
};

type OutgoingStreamState = {
  kind: "outgoing";
  streamId: string;
  idleTimer: ReturnType<typeof setTimeout>;
};

type StreamState = IncomingStreamState | OutgoingStreamState;

export class WebSocketStreamRegistry {
  private readonly streams = new Map<string, StreamState>();
  private bufferedBytes = 0;

  constructor(private readonly ws: WebSocket) {}

  createStreamId(): string {
    let streamId: string;
    do {
      streamId = `stream-${shortId()}`;
    } while (this.streams.has(streamId));
    return streamId;
  }

  openIncomingStream(streamId: string): AsyncIterable<Uint8Array> {
    this.assertCanOpen(streamId);
    const state: IncomingStreamState = {
      kind: "incoming",
      streamId,
      expectedSeq: 0,
      queue: [],
      bufferedBytes: 0,
      ended: false,
      error: null,
      waiters: [],
      idleTimer: this.armIdleTimer(streamId),
    };
    this.streams.set(streamId, state);
    return this.readIncoming(state);
  }

  openOutgoingStream(streamId: string): void {
    this.assertCanOpen(streamId);
    this.streams.set(streamId, {
      kind: "outgoing",
      streamId,
      idleTimer: this.armIdleTimer(streamId),
    });
  }

  releaseStream(streamId: string): void {
    const state = this.streams.get(streamId);
    if (!state) {
      return;
    }
    clearTimeout(state.idleTimer);
    if (state.kind === "incoming") {
      this.bufferedBytes -= state.bufferedBytes;
      state.bufferedBytes = 0;
      state.queue = [];
      state.ended = true;
      this.notify(state);
    }
    this.streams.delete(streamId);
  }

  close(
    error: Error = new WebSocketStreamError("daemon connection closed", "STREAM_CLOSED"),
  ): void {
    for (const state of this.streams.values()) {
      clearTimeout(state.idleTimer);
      if (state.kind === "incoming") {
        state.error = error;
        this.bufferedBytes -= state.bufferedBytes;
        state.bufferedBytes = 0;
        state.queue = [];
        this.notify(state);
      }
    }
    this.streams.clear();
    this.bufferedBytes = 0;
  }

  handleFrame(frame: StreamNotification): void {
    switch (frame.method) {
      case "stream.data":
        this.receiveData(frame.params.streamId, frame.params.seq, frame.params.data);
        return;
      case "stream.end":
        this.receiveEnd(frame.params.streamId, frame.params.seq);
        return;
      case "stream.error":
        this.failIncoming(
          frame.params.streamId,
          new WebSocketStreamError(frame.params.message, frame.params.code),
          false,
        );
        return;
      case "stream.cancel":
        this.failIncoming(
          frame.params.streamId,
          new WebSocketStreamError(
            frame.params.reason ?? `stream ${frame.params.streamId} was cancelled`,
            "STREAM_CANCELLED",
          ),
          false,
        );
        return;
    }
  }

  async sendIterable(streamId: string, source: AsyncIterable<Uint8Array>): Promise<void> {
    const state = this.streams.get(streamId);
    if (!state || state.kind !== "outgoing") {
      throw new WebSocketStreamError(`unknown stream ${streamId}`, "STREAM_UNKNOWN");
    }
    let seq = 0;
    try {
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        for (let offset = 0; offset < buffer.byteLength; offset += STREAM_MAX_CHUNK_BYTES) {
          const slice = buffer.subarray(offset, offset + STREAM_MAX_CHUNK_BYTES);
          if (slice.byteLength === 0) {
            continue;
          }
          this.resetIdleTimer(state);
          await this.sendFrame({
            jsonrpc: "2.0",
            method: "stream.data",
            params: {
              streamId,
              seq,
              data: slice.toString("base64"),
            },
          });
          seq += 1;
        }
      }
      this.resetIdleTimer(state);
      await this.sendFrame({
        jsonrpc: "2.0",
        method: "stream.end",
        params: { streamId, seq },
      });
    } catch (error) {
      await this.sendStreamError(
        streamId,
        error instanceof Error ? error.message : String(error),
        "STREAM_PRODUCER_ERROR",
      ).catch(() => undefined);
      throw error;
    } finally {
      this.releaseStream(streamId);
    }
  }

  async sendCancel(streamId: string, reason?: string): Promise<void> {
    await this.sendFrame({
      jsonrpc: "2.0",
      method: "stream.cancel",
      params: { streamId, reason },
    });
    this.releaseStream(streamId);
  }

  async sendStreamError(streamId: string, message: string, code?: string): Promise<void> {
    await this.sendFrame({
      jsonrpc: "2.0",
      method: "stream.error",
      params: { streamId, message, code },
    });
    this.releaseStream(streamId);
  }

  private assertCanOpen(streamId: string): void {
    if (this.streams.has(streamId)) {
      throw new WebSocketStreamError(`stream ${streamId} already exists`, "STREAM_EXISTS");
    }
    if (this.streams.size >= STREAM_MAX_ACTIVE_PER_CONNECTION) {
      throw new WebSocketStreamError(
        `too many active streams on this connection (max ${STREAM_MAX_ACTIVE_PER_CONNECTION})`,
        "STREAM_LIMIT",
      );
    }
  }

  private armIdleTimer(streamId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.failIncoming(
        streamId,
        new WebSocketStreamError(`stream ${streamId} timed out`, "STREAM_TIMEOUT"),
        true,
      );
    }, STREAM_IDLE_TIMEOUT_MS);
    timer.unref?.();
    return timer;
  }

  private resetIdleTimer(state: StreamState): void {
    clearTimeout(state.idleTimer);
    state.idleTimer = this.armIdleTimer(state.streamId);
  }

  private receiveData(streamId: string, seq: number, data: string): void {
    const state = this.streams.get(streamId);
    if (!state || state.kind !== "incoming") {
      void this.sendStreamError(streamId, `unknown stream ${streamId}`, "STREAM_UNKNOWN").catch(
        () => undefined,
      );
      return;
    }
    if (seq !== state.expectedSeq) {
      this.failIncoming(
        streamId,
        new WebSocketStreamError(
          `stream ${streamId} expected sequence ${state.expectedSeq} but received ${seq}`,
          "STREAM_BAD_SEQUENCE",
        ),
        true,
      );
      return;
    }

    const bytes = Buffer.from(data, "base64");
    if (bytes.byteLength < 1 || bytes.byteLength > STREAM_MAX_CHUNK_BYTES) {
      this.failIncoming(
        streamId,
        new WebSocketStreamError(
          `stream ${streamId} data chunk must decode to 1..${STREAM_MAX_CHUNK_BYTES} bytes`,
          "STREAM_CHUNK_SIZE",
        ),
        true,
      );
      return;
    }
    if (state.bufferedBytes + bytes.byteLength > STREAM_MAX_BUFFERED_BYTES_PER_STREAM) {
      this.failIncoming(
        streamId,
        new WebSocketStreamError(
          `stream ${streamId} exceeded buffered byte limit`,
          "STREAM_BUFFER_LIMIT",
        ),
        true,
      );
      return;
    }
    if (this.bufferedBytes + bytes.byteLength > STREAM_MAX_BUFFERED_BYTES_PER_CONNECTION) {
      this.failIncoming(
        streamId,
        new WebSocketStreamError("connection exceeded buffered byte limit", "STREAM_BUFFER_LIMIT"),
        true,
      );
      return;
    }

    this.resetIdleTimer(state);
    state.expectedSeq += 1;
    state.queue.push(bytes);
    state.bufferedBytes += bytes.byteLength;
    this.bufferedBytes += bytes.byteLength;
    this.notify(state);
  }

  private receiveEnd(streamId: string, seq: number): void {
    const state = this.streams.get(streamId);
    if (!state || state.kind !== "incoming") {
      void this.sendStreamError(streamId, `unknown stream ${streamId}`, "STREAM_UNKNOWN").catch(
        () => undefined,
      );
      return;
    }
    if (seq !== state.expectedSeq) {
      this.failIncoming(
        streamId,
        new WebSocketStreamError(
          `stream ${streamId} expected end sequence ${state.expectedSeq} but received ${seq}`,
          "STREAM_BAD_SEQUENCE",
        ),
        true,
      );
      return;
    }
    clearTimeout(state.idleTimer);
    state.ended = true;
    this.notify(state);
  }

  private failIncoming(streamId: string, error: Error, notifyPeer: boolean): void {
    const state = this.streams.get(streamId);
    if (!state) {
      if (notifyPeer) {
        void this.sendStreamError(
          streamId,
          error.message,
          error instanceof WebSocketStreamError ? error.code : undefined,
        ).catch(() => undefined);
      }
      return;
    }
    clearTimeout(state.idleTimer);
    if (state.kind === "incoming") {
      state.error = error;
      this.bufferedBytes -= state.bufferedBytes;
      state.bufferedBytes = 0;
      state.queue = [];
      this.notify(state);
    }
    this.streams.delete(streamId);
    if (notifyPeer) {
      void this.sendFrame({
        jsonrpc: "2.0",
        method: "stream.error",
        params: {
          streamId,
          message: error.message,
          code: error instanceof WebSocketStreamError ? error.code : undefined,
        },
      }).catch(() => undefined);
    }
  }

  private async *readIncoming(state: IncomingStreamState): AsyncIterable<Uint8Array> {
    try {
      while (true) {
        if (state.queue.length > 0) {
          const chunk = state.queue.shift();
          if (chunk) {
            state.bufferedBytes -= chunk.byteLength;
            this.bufferedBytes -= chunk.byteLength;
            yield chunk;
            continue;
          }
        }
        if (state.error) {
          throw state.error;
        }
        if (state.ended) {
          return;
        }
        await new Promise<void>((resolve) => {
          state.waiters.push(resolve);
        });
      }
    } finally {
      this.releaseStream(state.streamId);
    }
  }

  private notify(state: IncomingStreamState): void {
    const waiters = state.waiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }

  private async sendFrame(frame: StreamNotification): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new WebSocketStreamError("daemon connection closed", "STREAM_CLOSED");
    }
    await new Promise<void>((resolve, reject) => {
      this.ws.send(JSON.stringify(frame), (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}
