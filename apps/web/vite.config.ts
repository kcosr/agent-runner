import {
  normalizeWebBasePath,
  webPathPrefix,
} from "@kcosr/agent-runner-core/contracts/app-config.js";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function daemonProxyTarget() {
  return process.env.AGENT_RUNNER_WEB_PROXY_TARGET ?? "http://127.0.0.1:4773";
}

export function webBasePath() {
  const normalized = normalizeWebBasePath(
    process.env.AGENT_RUNNER_WEB_BASE_PATH,
    "AGENT_RUNNER_WEB_BASE_PATH",
  );
  return normalized === "/" ? "/" : `${normalized}/`;
}

export function devProxy() {
  const target = daemonProxyTarget();
  const base = webBasePath();
  const prefix = webPathPrefix(base);
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
