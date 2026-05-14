import { timingSafeEqual } from "node:crypto";
import { HttpError } from "./http-errors.js";
import { AGENT_RUNNER_DAEMON_AUTH_ENABLED_ENV, AGENT_RUNNER_DAEMON_TOKEN_ENV } from "./protocol.js";

type DaemonAuthConfig =
  | {
      enabled: false;
    }
  | {
      enabled: true;
      token: string;
    };

const AUTH_ENABLED_VALUES = new Set(["true", "1", "yes", "on"]);
const UNAUTHENTICATED_MESSAGE = "daemon authentication required";

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveDaemonAuthConfig(env: NodeJS.ProcessEnv = process.env): DaemonAuthConfig {
  const enabledRaw = env[AGENT_RUNNER_DAEMON_AUTH_ENABLED_ENV]?.trim().toLowerCase();
  if (!enabledRaw || !AUTH_ENABLED_VALUES.has(enabledRaw)) {
    return { enabled: false };
  }

  const token = nonEmpty(env[AGENT_RUNNER_DAEMON_TOKEN_ENV]);
  if (!token) {
    throw new Error(
      `${AGENT_RUNNER_DAEMON_TOKEN_ENV} is required when ${AGENT_RUNNER_DAEMON_AUTH_ENABLED_ENV} is enabled`,
    );
  }

  return {
    enabled: true,
    token,
  };
}

export function bearerAuthHeader(token: string | undefined): Record<string, string> {
  const trimmed = nonEmpty(token);
  return trimmed ? { authorization: `Bearer ${trimmed}` } : {};
}

export function assertDaemonAuthorized(
  config: DaemonAuthConfig,
  authorization: string | undefined,
): void {
  if (!config.enabled) {
    return;
  }

  const token = parseBearerToken(authorization);
  if (!token || !tokensEqual(token, config.token)) {
    throw new HttpError(401, "UNAUTHENTICATED", UNAUTHENTICATED_MESSAGE);
  }
}

function tokensEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function parseBearerToken(authorization: string | undefined): string | null {
  if (!authorization) {
    return null;
  }
  const match = /^Bearer (.+)$/.exec(authorization);
  if (!match) {
    return null;
  }
  const token = match[1]?.trim();
  return token && token.length > 0 ? token : null;
}
