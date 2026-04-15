import type { IncomingMessage, ServerResponse } from "node:http";

export function streamEvents<T>(
  req: IncomingMessage,
  res: ServerResponse,
  subscribe: (publish: (payload: T) => boolean) => () => void,
): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders();
  res.write(": connected\n\n");

  const unsubscribe = subscribe((payload) => writeEvent(res, payload));
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

function writeEvent(res: ServerResponse, payload: unknown): boolean {
  if (res.destroyed || res.writableEnded) {
    return false;
  }
  try {
    // `ServerResponse.write()` returns false on backpressure, not just failure.
    // Keep the subscriber alive unless the stream is actually closed or throws.
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return !res.destroyed && !res.writableEnded;
  } catch {
    return false;
  }
}
