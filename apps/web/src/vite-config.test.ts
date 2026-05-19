import { afterEach, describe, expect, it } from "vitest";
import { devProxy, webBasePath } from "../vite.config.js";

describe("vite config", () => {
  const originalWebBasePath = process.env.AGENT_RUNNER_WEB_BASE_PATH;

  afterEach(() => {
    if (originalWebBasePath === undefined) {
      Reflect.deleteProperty(process.env, "AGENT_RUNNER_WEB_BASE_PATH");
      return;
    }
    process.env.AGENT_RUNNER_WEB_BASE_PATH = originalWebBasePath;
  });

  it("adds dev proxy entries for the configured web base path", () => {
    process.env.AGENT_RUNNER_WEB_BASE_PATH = "/agent-runner/";

    expect(webBasePath()).toBe("/agent-runner/");
    expect(Object.keys(devProxy())).toEqual([
      "/api",
      "/app-config.json",
      "/agent-runner/api",
      "/agent-runner/app-config.json",
    ]);
  });

  it("rejects unsafe web base path values", () => {
    process.env.AGENT_RUNNER_WEB_BASE_PATH = "/agent-runner/../other";

    expect(() => webBasePath()).toThrow(/alphanumeric or hyphenated path segments/);
  });
});
