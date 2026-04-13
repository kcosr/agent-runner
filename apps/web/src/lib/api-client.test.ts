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

  it("sends rename requests and parses the result payload", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            result: {
              runId: "run-1",
              name: "Dashboard polish",
              changed: true,
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient(config);
    await expect(api.setRunName("run-1", "Dashboard polish")).resolves.toEqual({
      runId: "run-1",
      name: "Dashboard polish",
      changed: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs/run-1/name",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Dashboard polish" }),
      }),
    );
  });
});
