import type { AppRuntimeConfig } from "@kcosr/agent-runner-core/contracts/app-config.js";
import {
  AGENT_RUNNER_CONNECT_ENV,
  AGENT_RUNNER_CONNECT_HOST_ENV,
  AGENT_RUNNER_CONNECT_LOCAL_PORT_ENV,
  AGENT_RUNNER_LISTEN_ENV,
  DEFAULT_DAEMON_URL,
} from "./protocol.js";

export type HostMode = "embedded" | "daemon";
interface DaemonConnectHostConfig {
  host: string;
  localPort: number;
  targetHost: string;
  targetPort: number;
}

export type ResolvedHostMode =
  | {
      mode: "embedded";
    }
  | {
      mode: "daemon";
      connectUrl: string;
      effectiveConnectUrl: string;
      connectHost?: DaemonConnectHostConfig;
    };

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
  if (!parsed.port) {
    throw new Error(`${label} must include an explicit port`);
  }
  return parsed;
}

export function resolveListenUrl(
  listenFlag?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = nonEmpty(listenFlag) ?? nonEmpty(env[AGENT_RUNNER_LISTEN_ENV]) ?? DEFAULT_DAEMON_URL;
  return parseDaemonUrl(raw, "--listen").toString();
}

export function resolveConnectUrl(
  connectFlag?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = nonEmpty(connectFlag) ?? nonEmpty(env[AGENT_RUNNER_CONNECT_ENV]);
  return raw ? parseDaemonUrl(raw, "--connect").toString() : undefined;
}

function parseConnectLocalPort(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error("--connect-local-port must be an integer between 1 and 65535");
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("--connect-local-port must be an integer between 1 and 65535");
  }
  return port;
}

function deriveEffectiveConnectUrl(connectUrl: string, localPort: number): string {
  const parsed = new URL(connectUrl);
  parsed.hostname = "127.0.0.1";
  parsed.port = String(localPort);
  return parsed.toString();
}

export function resolveHostMode(
  connectFlag?: string,
  connectHostFlag?: string,
  connectLocalPortFlag?: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedHostMode {
  const connectUrl = resolveConnectUrl(connectFlag, env);
  const connectHost = nonEmpty(connectHostFlag) ?? nonEmpty(env[AGENT_RUNNER_CONNECT_HOST_ENV]);
  const connectLocalPortRaw =
    nonEmpty(connectLocalPortFlag) ?? nonEmpty(env[AGENT_RUNNER_CONNECT_LOCAL_PORT_ENV]);

  if (connectHost && !connectUrl) {
    throw new Error("--connect-host requires --connect or AGENT_RUNNER_CONNECT");
  }
  if (connectLocalPortRaw && !connectHost) {
    throw new Error("--connect-local-port requires --connect-host or AGENT_RUNNER_CONNECT_HOST");
  }
  if (!connectUrl) {
    return { mode: "embedded" };
  }
  if (!connectHost) {
    return {
      mode: "daemon",
      connectUrl,
      effectiveConnectUrl: connectUrl,
    };
  }

  const parsed = new URL(connectUrl);
  const targetPort = Number(parsed.port);
  const localPort = connectLocalPortRaw ? parseConnectLocalPort(connectLocalPortRaw) : targetPort;
  return {
    mode: "daemon",
    connectUrl,
    effectiveConnectUrl: deriveEffectiveConnectUrl(connectUrl, localPort),
    connectHost: {
      host: connectHost,
      localPort,
      targetHost: parsed.hostname,
      targetPort,
    },
  };
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
    runSummaryEventsPath: "/api/events/run-summaries",
  };
}
