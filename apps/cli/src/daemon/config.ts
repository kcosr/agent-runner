import type { AppRuntimeConfig } from "@task-runner/core/contracts/app-config.js";
import { DEFAULT_DAEMON_URL, TASK_RUNNER_CONNECT_ENV, TASK_RUNNER_LISTEN_ENV } from "./protocol.js";

export type HostMode = "embedded" | "daemon";

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseDaemonUrl(raw: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid ws:// URL`);
  }
  if (parsed.protocol !== "ws:") {
    throw new Error(`${label} must use ws://`);
  }
  if (!isLoopbackHost(parsed.hostname)) {
    throw new Error(`${label} must bind/connect on loopback (127.0.0.1, localhost, or ::1)`);
  }
  if (!parsed.port) {
    throw new Error(`${label} must include an explicit port`);
  }
  return parsed;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

export function resolveListenUrl(
  listenFlag?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = nonEmpty(listenFlag) ?? nonEmpty(env[TASK_RUNNER_LISTEN_ENV]) ?? DEFAULT_DAEMON_URL;
  return parseDaemonUrl(raw, "--listen").toString();
}

export function resolveConnectUrl(
  connectFlag?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = nonEmpty(connectFlag) ?? nonEmpty(env[TASK_RUNNER_CONNECT_ENV]);
  return raw ? parseDaemonUrl(raw, "--connect").toString() : undefined;
}

export function resolveHostMode(
  connectFlag?: string,
  env: NodeJS.ProcessEnv = process.env,
): { mode: HostMode; connectUrl?: string } {
  const connectUrl = resolveConnectUrl(connectFlag, env);
  return connectUrl ? { mode: "daemon", connectUrl } : { mode: "embedded" };
}

export function listenSocketConfig(listenUrl: string): {
  host: string;
  port: number;
  path: string;
} {
  const parsed = parseDaemonUrl(listenUrl, "--listen");
  return {
    host: parsed.hostname,
    port: Number(parsed.port),
    path: parsed.pathname.length > 0 ? parsed.pathname : "/",
  };
}

export function deriveHttpBaseUrl(listenUrl: string): string {
  const parsed = parseDaemonUrl(listenUrl, "--listen");
  parsed.protocol = "http:";
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function deriveAppRuntimeConfig(): AppRuntimeConfig {
  return {
    apiBasePath: "/api",
    runEventsPath: "/api/events/runs",
  };
}
