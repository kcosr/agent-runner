import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeConfigError, loadRuntimeConfig, runtimeConfigPath } from "./runtime-config.js";

describe("runtime config", () => {
  afterEach(() => {
    window.__AGENT_RUNNER_WEB_BASE_PATH__ = undefined;
    vi.unstubAllGlobals();
  });

  it("loads runtime config from the injected web base path", async () => {
    window.__AGENT_RUNNER_WEB_BASE_PATH__ = "/agent-runner";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            webBasePath: "/agent-runner",
          }),
          { status: 200 },
        ),
    );

    await expect(loadRuntimeConfig(fetchMock as typeof fetch)).resolves.toEqual({
      webBasePath: "/agent-runner",
      apiBasePath: "/agent-runner/api",
      runSummaryEventsPath: "/agent-runner/api/events/run-summaries",
    });
    expect(fetchMock).toHaveBeenCalledWith("/agent-runner/app-config.json", {
      headers: {
        accept: "application/json",
      },
    });
  });

  it("normalizes Vite and injected runtime config base paths", () => {
    window.__AGENT_RUNNER_WEB_BASE_PATH__ = "/agent-runner/";

    expect(runtimeConfigPath()).toBe("/agent-runner/app-config.json");
  });

  it("rejects invalid runtime config payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ apiBasePath: 42 }), { status: 200 })),
    );

    await expect(loadRuntimeConfig()).rejects.toBeInstanceOf(RuntimeConfigError);
  });

  it("rejects redundant runtime config path fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              webBasePath: "/agent-runner",
              apiBasePath: "/agent-runner/api",
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(loadRuntimeConfig()).rejects.toBeInstanceOf(RuntimeConfigError);
  });

  it("rejects malformed runtime config JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );

    await expect(loadRuntimeConfig()).rejects.toBeInstanceOf(RuntimeConfigError);
  });
});
