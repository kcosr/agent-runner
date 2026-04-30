import type { AppRuntimeConfig } from "@task-runner/core/contracts/app-config.js";
import type {
  RunAuditEnvelope,
  RunDetailStreamEvent,
  RunSummaryStreamEvent,
  RunTimelineEnvelope,
} from "@task-runner/core/contracts/events.js";
import {
  runAuditEnvelopeSchema,
  runDetailStreamEventSchema,
  runSummaryStreamEventSchema,
  runTimelineEnvelopeSchema,
} from "@task-runner/core/contracts/run-schemas.js";
import type { z } from "zod";
import { daemonAuthHeaders, normalizeDaemonToken } from "./daemon-token.js";

const FETCH_SSE_RECONNECT_DELAY_MS = 3000;

interface SseSubscriptionOptions<T> {
  daemonToken?: string | null;
  onEvent: (payload: T) => void;
  onOpen?: () => void;
  onStaleChange?: (stale: boolean) => void;
}

type SummaryEventsSubscriptionOptions = SseSubscriptionOptions<RunSummaryStreamEvent>;
type DetailEventsSubscriptionOptions = SseSubscriptionOptions<RunDetailStreamEvent>;
type TimelineEventsSubscriptionOptions = SseSubscriptionOptions<RunTimelineEnvelope>;
type AuditEventsSubscriptionOptions = SseSubscriptionOptions<RunAuditEnvelope>;

function joinPath(basePath: string, path: string): string {
  return `${basePath.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function subscribeToFetchSse<T>(
  url: string,
  schema: z.ZodType<T>,
  options: SseSubscriptionOptions<T>,
): () => void {
  const controller = new AbortController();
  const decoder = new TextDecoder();

  const processEvent = (rawEvent: string) => {
    const data = rawEvent
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) {
      return;
    }
    try {
      const parsed = schema.safeParse(JSON.parse(data));
      if (parsed.success) {
        options.onEvent(parsed.data);
        return;
      }
      options.onStaleChange?.(true);
    } catch {
      options.onStaleChange?.(true);
    }
  };

  const waitForReconnect = () =>
    new Promise<void>((resolve) => {
      const onAbort = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      const timeout = window.setTimeout(() => {
        controller.signal.removeEventListener("abort", onAbort);
        resolve();
      }, FETCH_SSE_RECONNECT_DELAY_MS);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });

  const consumeOnce = async (): Promise<boolean> => {
    let buffer = "";
    try {
      const response = await fetch(url, {
        headers: daemonAuthHeaders(options.daemonToken),
        signal: controller.signal,
      });
      if (response.status === 401) {
        options.onStaleChange?.(true);
        return false;
      }
      if (!response.ok || !response.body) {
        options.onStaleChange?.(true);
        return true;
      }
      options.onOpen?.();

      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let eventEnd = buffer.search(/\r?\n\r?\n/);
        while (eventEnd !== -1) {
          const rawEvent = buffer.slice(0, eventEnd);
          buffer = buffer.slice(eventEnd + (buffer[eventEnd] === "\r" ? 4 : 2));
          processEvent(rawEvent);
          eventEnd = buffer.search(/\r?\n\r?\n/);
        }
      }
      buffer += decoder.decode();
      if (!controller.signal.aborted) {
        if (buffer.length > 0) {
          processEvent(buffer);
        }
        options.onStaleChange?.(true);
      }
      return true;
    } catch {
      if (!controller.signal.aborted) {
        options.onStaleChange?.(true);
      }
      return true;
    }
  };

  const consume = async () => {
    while (!controller.signal.aborted) {
      const shouldReconnect = await consumeOnce();
      if (!shouldReconnect || controller.signal.aborted) {
        return;
      }
      await waitForReconnect();
    }
  };

  void consume();

  return () => {
    controller.abort();
  };
}

function subscribeToNativeEventSource<T>(
  url: string,
  schema: z.ZodType<T>,
  options: SseSubscriptionOptions<T>,
): () => void {
  const source = new EventSource(url);

  source.onopen = () => {
    options.onOpen?.();
  };

  source.onerror = () => {
    options.onStaleChange?.(true);
  };

  source.onmessage = (message) => {
    try {
      const parsed = schema.safeParse(JSON.parse(message.data));
      if (!parsed.success) {
        options.onStaleChange?.(true);
        return;
      }
      options.onEvent(parsed.data);
    } catch {
      options.onStaleChange?.(true);
    }
  };

  return () => {
    source.close();
  };
}

function subscribeToSse<T>(
  url: string,
  schema: z.ZodType<T>,
  options: SseSubscriptionOptions<T>,
): () => void {
  if (normalizeDaemonToken(options.daemonToken)) {
    return subscribeToFetchSse(url, schema, options);
  }
  return subscribeToNativeEventSource(url, schema, options);
}

export function subscribeToRunSummaryEvents(
  config: AppRuntimeConfig,
  options: SummaryEventsSubscriptionOptions,
): () => void {
  return subscribeToSse(config.runSummaryEventsPath, runSummaryStreamEventSchema, options);
}

export function subscribeToRunDetailEvents(
  config: AppRuntimeConfig,
  runId: string,
  options: DetailEventsSubscriptionOptions,
): () => void {
  return subscribeToSse(
    joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}/events/detail`),
    runDetailStreamEventSchema,
    options,
  );
}

export function subscribeToRunTimelineEvents(
  config: AppRuntimeConfig,
  runId: string,
  options: TimelineEventsSubscriptionOptions,
): () => void {
  return subscribeToSse(
    joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}/events/timeline`),
    runTimelineEnvelopeSchema,
    options,
  );
}

export function subscribeToRunAuditEvents(
  config: AppRuntimeConfig,
  runId: string,
  options: AuditEventsSubscriptionOptions,
): () => void {
  return subscribeToSse(
    joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}/events/audit`),
    runAuditEnvelopeSchema,
    options,
  );
}
