import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "./api-client.js";

const config = {
  apiBasePath: "/api",
  runEventsPath: "/api/events/runs",
};

describe("api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects invalid run list payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ runs: [{ runId: 42 }] }), { status: 200 })),
    );

    const api = createApiClient(config);

    await expect(api.listRuns()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      name: "ApiError",
      status: 200,
    });
  });

  it("rejects invalid resume responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 })),
    );

    const api = createApiClient(config);

    await expect(api.resumeRun("run-1")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      name: "ApiError",
      status: 200,
    });
  });
});
