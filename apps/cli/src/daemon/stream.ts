import { shortId } from "@kcosr/agent-runner-core/util/short-id.js";
import type { StreamNotification } from "./protocol.js";

export const STREAM_MAX_CHUNK_BYTES = 65_536;
export const STREAM_MAX_ACTIVE_PER_CONNECTION = 8;
export const STREAM_MAX_BUFFERED_BYTES_PER_STREAM = 1_048_576;
export const STREAM_MAX_BUFFERED_BYTES_PER_CONNECTION = 4_194_304;
export const STREAM_INITIAL_WINDOW_BYTES =
  STREAM_MAX_BUFFERED_BYTES_PER_CONNECTION / STREAM_MAX_ACTIVE_PER_CONNECTION;
export const STREAM_IDLE_TIMEOUT_MS = 30_000;

const WEBSOCKET_OPEN = 1;

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
  error: Error | null;
  sending: boolean;
  availableWindowBytes: number;
  windowWaiters: Array<() => void>;
};

type StreamState = IncomingStreamState | OutgoingStreamState;

interface WebSocketLike {
  readonly readyState: number;
  send(data: string, cb: (error?: Error) => void): void;
}

export class WebSocketStreamRegistry {
  private readonly streams = new Map<string, StreamState>();
  private bufferedBytes = 0;

  constructor(private readonly ws: WebSocketLike) {}

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
      error: null,
      sending: false,
      availableWindowBytes: STREAM_INITIAL_WINDOW_BYTES,
      windowWaiters: [],
    });
  }

  releaseStream(streamId: string, error?: Error): void {
    const state = this.streams.get(streamId);
    if (!state) {
      return;
    }
    clearTimeout(state.idleTimer);
    if (state.kind === "incoming") {
      this.dropIncoming(state, error ? { error } : { ended: true });
    } else {
      if (error) {
        state.error = error;
      }
      this.notifyOutgoing(state);
    }
    this.streams.delete(streamId);
  }

  close(
    error: Error = new WebSocketStreamError("daemon connection closed", "STREAM_CLOSED"),
  ): void {
    for (const state of this.streams.values()) {
      clearTimeout(state.idleTimer);
      if (state.kind === "incoming") {
        this.dropIncoming(state, { error });
      } else {
        state.error = error;
        this.notifyOutgoing(state);
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
        this.failStream(
          frame.params.streamId,
          new WebSocketStreamError(frame.params.message, frame.params.code),
          false,
        );
        return;
      case "stream.cancel":
        this.failStream(
          frame.params.streamId,
          new WebSocketStreamError(
            frame.params.reason ?? `stream ${frame.params.streamId} was cancelled`,
            "STREAM_CANCELLED",
          ),
          false,
        );
        return;
      case "stream.window":
        this.receiveWindow(frame.params.streamId, frame.params.bytes);
        return;
    }
  }

  async sendIterable(streamId: string, source: AsyncIterable<Uint8Array>): Promise<void> {
    const state = this.streams.get(streamId);
    if (!state || state.kind !== "outgoing") {
      throw new WebSocketStreamError(`unknown stream ${streamId}`, "STREAM_UNKNOWN");
    }
    if (state.sending) {
      throw new WebSocketStreamError(`stream ${streamId} is already sending`, "STREAM_BUSY");
    }
    state.sending = true;
    let seq = 0;
    try {
      for await (const chunk of source) {
        this.assertOutgoingActive(streamId, state);
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        for (let offset = 0; offset < buffer.byteLength; offset += STREAM_MAX_CHUNK_BYTES) {
          this.assertOutgoingActive(streamId, state);
          const slice = buffer.subarray(offset, offset + STREAM_MAX_CHUNK_BYTES);
          if (slice.byteLength === 0) {
            continue;
          }
          await this.waitForWindow(streamId, state, slice.byteLength);
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
      this.assertOutgoingActive(streamId, state);
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
    try {
      await this.sendFrame({
        jsonrpc: "2.0",
        method: "stream.cancel",
        params: { streamId, reason },
      });
    } finally {
      this.releaseStream(
        streamId,
        new WebSocketStreamError(reason ?? `stream ${streamId} was cancelled`, "STREAM_CANCELLED"),
      );
    }
  }

  async sendStreamError(streamId: string, message: string, code?: string): Promise<void> {
    try {
      await this.sendFrame({
        jsonrpc: "2.0",
        method: "stream.error",
        params: { streamId, message, code },
      });
    } finally {
      this.releaseStream(streamId, new WebSocketStreamError(message, code));
    }
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
      this.failStream(
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
    if (state.ended) {
      this.failStream(
        streamId,
        new WebSocketStreamError(
          `stream ${streamId} received data after end`,
          "STREAM_BAD_SEQUENCE",
        ),
        true,
      );
      return;
    }
    if (seq !== state.expectedSeq) {
      this.failStream(
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
      this.failStream(
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
      this.failStream(
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
      this.failStream(
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

  private receiveWindow(streamId: string, bytes: number): void {
    const state = this.streams.get(streamId);
    if (!state || state.kind !== "outgoing") {
      return;
    }
    this.resetIdleTimer(state);
    state.availableWindowBytes += bytes;
    this.notifyOutgoing(state);
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
      this.failStream(
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

  private failStream(streamId: string, error: Error, notifyPeer: boolean): void {
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
      this.dropIncoming(state, { error });
    } else {
      state.error = error;
      this.notifyOutgoing(state);
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

  private dropIncoming(
    state: IncomingStreamState,
    finalState: { ended: true } | { error: Error },
  ): void {
    if ("error" in finalState) {
      state.error = finalState.error;
      state.ended = false;
    } else {
      state.ended = true;
    }
    this.bufferedBytes -= state.bufferedBytes;
    state.bufferedBytes = 0;
    state.queue = [];
    this.notify(state);
  }

  private assertOutgoingActive(streamId: string, state: OutgoingStreamState): void {
    if (state.error) {
      throw state.error;
    }
    if (this.streams.get(streamId) !== state) {
      throw new WebSocketStreamError(`stream ${streamId} is no longer active`, "STREAM_CLOSED");
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
            this.sendWindow(state.streamId, chunk.byteLength);
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

  private notifyOutgoing(state: OutgoingStreamState): void {
    const waiters = state.windowWaiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }

  private async waitForWindow(
    streamId: string,
    state: OutgoingStreamState,
    bytes: number,
  ): Promise<void> {
    while (state.availableWindowBytes < bytes) {
      this.assertOutgoingActive(streamId, state);
      await new Promise<void>((resolve) => {
        state.windowWaiters.push(resolve);
      });
      this.assertOutgoingActive(streamId, state);
    }
    this.assertOutgoingActive(streamId, state);
    state.availableWindowBytes -= bytes;
  }

  private sendWindow(streamId: string, bytes: number): void {
    void this.sendFrame({
      jsonrpc: "2.0",
      method: "stream.window",
      params: { streamId, bytes },
    }).catch(() => undefined);
  }

  private async sendFrame(frame: StreamNotification): Promise<void> {
    if (this.ws.readyState !== WEBSOCKET_OPEN) {
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
