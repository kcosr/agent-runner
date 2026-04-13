import type { AppRuntimeConfig } from "@task-runner/core/contracts/app-config.js";
import type { RunEventEnvelope } from "@task-runner/core/contracts/events.js";

export interface RunEventsSubscriptionOptions {
  onEvent: (payload: RunEventEnvelope) => void;
  onOpen?: () => void;
  onStaleChange?: (stale: boolean) => void;
}

export function subscribeToRunEvents(
  config: AppRuntimeConfig,
  options: RunEventsSubscriptionOptions,
): () => void {
  const source = new EventSource(config.runEventsPath);

  source.onopen = () => {
    options.onOpen?.();
  };

  source.onerror = () => {
    options.onStaleChange?.(true);
  };

  source.onmessage = (message) => {
    try {
      const payload = JSON.parse(message.data);
      if (!isRunEventEnvelope(payload)) {
        options.onStaleChange?.(true);
        return;
      }
      options.onEvent(payload);
    } catch {
      options.onStaleChange?.(true);
    }
  };

  return () => {
    source.close();
  };
}

function isRunEventEnvelope(value: unknown): value is RunEventEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const envelope = value as Record<string, unknown>;
  if (typeof envelope.runId !== "string") {
    return false;
  }
  if (!envelope.event || typeof envelope.event !== "object" || Array.isArray(envelope.event)) {
    return false;
  }

  return typeof (envelope.event as Record<string, unknown>).type === "string";
}
