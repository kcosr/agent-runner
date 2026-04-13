import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function daemonProxyTarget() {
  return process.env.TASK_RUNNER_WEB_PROXY_TARGET ?? "http://127.0.0.1:4773";
}

export default defineConfig({
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
