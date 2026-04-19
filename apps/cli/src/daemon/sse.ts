import type { IncomingMessage, ServerResponse } from "node:http";

interface SerializedEvent<T> {
  data: T;
  id?: string;
}

export function streamEvents<T>(
  req: IncomingMessage,
  res: ServerResponse,
  subscribe: (publish: (payload: T) => boolean) => () => void,
  serialize: (payload: T) => SerializedEvent<T> = (payload) => ({ data: payload }),
): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders();
  res.write(": connected\n\n");

  const unsubscribe = subscribe((payload) => writeEvent(res, serialize(payload)));
  let closed = false;
  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    unsubscribe();
    if (!res.writableEnded) {
      res.end();
    }
  };

  req.on("close", cleanup);
  req.on("aborted", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
}

function writeEvent(res: ServerResponse, payload: SerializedEvent<unknown>): boolean {
  if (res.destroyed || res.writableEnded) {
    return false;
  }
  try {
    // `ServerResponse.write()` returns false on backpressure, not just failure.
    // Keep the subscriber alive unless the stream is actually closed or throws.
    const frame = `${payload.id ? `id: ${payload.id}\n` : ""}data: ${JSON.stringify(payload.data)}\n\n`;
    res.write(frame);
    return !res.destroyed && !res.writableEnded;
  } catch {
    return false;
  }
}
