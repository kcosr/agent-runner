import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeConfigError, loadRuntimeConfig } from "./runtime-config.js";

describe("runtime config", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects invalid runtime config payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ apiBasePath: 42 }), { status: 200 })),
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
