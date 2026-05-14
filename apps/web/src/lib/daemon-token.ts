export const DAEMON_TOKEN_STORAGE_KEY = "agent-runner.daemonToken";

export function normalizeDaemonToken(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function readStoredDaemonToken(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return normalizeDaemonToken(window.localStorage.getItem(DAEMON_TOKEN_STORAGE_KEY));
}

export function daemonAuthHeaders(token: string | null | undefined): Record<string, string> {
  const normalized = normalizeDaemonToken(token);
  return normalized ? { authorization: `Bearer ${normalized}` } : {};
}
