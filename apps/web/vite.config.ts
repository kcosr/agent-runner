import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const WEB_BASE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9-]+$/;

function daemonProxyTarget() {
  return process.env.AGENT_RUNNER_WEB_PROXY_TARGET ?? "http://127.0.0.1:4773";
}

export function webBasePath() {
  const raw = process.env.AGENT_RUNNER_WEB_BASE_PATH?.trim();
  if (!raw || raw === "/") {
    return "/";
  }
  if (!raw.startsWith("/") || raw.includes("?") || raw.includes("#")) {
    throw new Error("AGENT_RUNNER_WEB_BASE_PATH must be an absolute path like /agent-runner");
  }
  const segments = raw.replace(/^\/+|\/+$/g, "").split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => !WEB_BASE_PATH_SEGMENT_PATTERN.test(segment))
  ) {
    throw new Error(
      "AGENT_RUNNER_WEB_BASE_PATH must contain only alphanumeric or hyphenated path segments",
    );
  }
  return `/${segments.join("/")}/`;
}

export function devProxy() {
  const target = daemonProxyTarget();
  const base = webBasePath();
  const prefix = base === "/" ? "" : base.replace(/\/$/, "");
  return {
    "/api": {
      target,
      changeOrigin: false,
    },
    "/app-config.json": {
      target,
      changeOrigin: false,
    },
    ...(prefix
      ? {
          [`${prefix}/api`]: {
            target,
            changeOrigin: false,
          },
          [`${prefix}/app-config.json`]: {
            target,
            changeOrigin: false,
          },
        }
      : {}),
  };
}

export default defineConfig({
  base: webBasePath(),
  plugins: [react()],
  server: {
    port: 4174,
    proxy: devProxy(),
  },
  preview: {
    port: 4174,
  },
});
