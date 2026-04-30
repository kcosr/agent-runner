import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeToRunSummaryEvents } from "./sse.js";

const config = {
  apiBasePath: "/api",
  runSummaryEventsPath: "/api/events/run-summaries",
};

function sseResponse(frames: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(frames));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    },
  );
}

describe("SSE subscriptions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("uses fetch with Authorization when a daemon token is configured", async () => {
    const events: unknown[] = [];
    const staleChanges: boolean[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sseResponse(
          [": connected", "", 'data: {"type":"summary_removed","runId":"run-1"}', "", ""].join(
            "\n",
          ),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const unsubscribe = subscribeToRunSummaryEvents(config, {
      daemonToken: "  web-sse-secret  ",
      onEvent: (payload) => events.push(payload),
      onStaleChange: (stale) => staleChanges.push(stale),
    });

    await vi.waitFor(() => {
      expect(events).toEqual([
        {
          type: "summary_removed",
          runId: "run-1",
        },
      ]);
    });
    unsubscribe();

    expect(fetchMock).toHaveBeenCalledWith("/api/events/run-summaries", {
      headers: { authorization: "Bearer web-sse-secret" },
      signal: expect.any(AbortSignal),
    });
    expect(staleChanges).toContain(true);
  });

  it("reconnects fetch-based SSE streams after they close", async () => {
    vi.useFakeTimers();
    const events: unknown[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse(['data: {"type":"summary_removed","runId":"run-1"}', "", ""].join("\n")),
      )
      .mockResolvedValueOnce(
        sseResponse(['data: {"type":"summary_removed","runId":"run-2"}', "", ""].join("\n")),
      );
    vi.stubGlobal("fetch", fetchMock);

    const unsubscribe = subscribeToRunSummaryEvents(config, {
      daemonToken: "web-sse-secret",
      onEvent: (payload) => events.push(payload),
    });

    await vi.waitFor(() => {
      expect(events).toEqual([{ type: "summary_removed", runId: "run-1" }]);
    });

    await vi.advanceTimersByTimeAsync(3000);

    await vi.waitFor(() => {
      expect(events).toEqual([
        { type: "summary_removed", runId: "run-1" },
        { type: "summary_removed", runId: "run-2" },
      ]);
    });

    unsubscribe();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
