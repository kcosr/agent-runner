import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function daemonProxyTarget() {
  return process.env.AGENT_RUNNER_WEB_PROXY_TARGET ?? "http://127.0.0.1:4773";
}

function webBasePath() {
  const raw = process.env.AGENT_RUNNER_WEB_BASE_PATH?.trim();
  if (!raw || raw === "/") {
    return "/";
  }
  if (!raw.startsWith("/") || raw.includes("?") || raw.includes("#")) {
    throw new Error("AGENT_RUNNER_WEB_BASE_PATH must be an absolute path like /agent-runner");
  }
  const trimmed = raw.replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}/` : "/";
}

export default defineConfig({
  base: webBasePath(),
  plugins: [react()],
  server: {
    port: 4174,
    proxy: {
      "/api": {
        target: daemonProxyTarget(),
        changeOrigin: false,
      },
      "/app-config.json": {
        target: daemonProxyTarget(),
        changeOrigin: false,
      },
    },
  },
  preview: {
    port: 4174,
  },
});
