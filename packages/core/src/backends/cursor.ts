import type { Backend, BackendInvokeContext, BackendInvokeResult } from "../core/backends/types.js";
import { runProcess } from "../util/spawn.js";
import {
  composePersistedTranscript,
  isRecord,
  normalizeBackendModel,
  silentTranscriptFallback,
  streamBoundarySeparator,
} from "./shared.js";

function findSessionId(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findSessionId(entry);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;

  const direct =
    (typeof value.session_id === "string" && value.session_id) ||
    (typeof value.sessionId === "string" && value.sessionId) ||
    null;
  if (direct) return direct;

  for (const entry of Object.values(value)) {
    const found = findSessionId(entry);
    if (found) return found;
  }
  return null;
}

export const normalizeCursorModel = normalizeBackendModel;

export function buildCursorArgs(
  ctx: Pick<BackendInvokeContext, "cwd" | "model" | "prompt" | "resumeSessionId" | "unrestricted">,
): string[] {
  const args = [
    "-p",
    "--trust",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--workspace",
    ctx.cwd,
  ];

  if (ctx.model) {
    args.push("--model", normalizeCursorModel(ctx.model));
  }
  if (ctx.unrestricted) {
    args.push("--force");
  }
  if (ctx.resumeSessionId) {
    args.push("--resume", ctx.resumeSessionId);
  }
  if (ctx.prompt.trim().length > 0) {
    args.push(ctx.prompt);
  }
  return args;
}

interface StreamState {
  sessionId: string | null;
  resultText: string | null;
  streamedText: string;
  pendingBoundary: boolean;
  buffer: string;
  parseError: Error | null;
  onText: (text: string) => void;
}

function captureSessionId(state: StreamState, event: Record<string, unknown>): void {
  if (state.sessionId) return;
  state.sessionId = findSessionId(event);
}

function parseResultText(event: Record<string, unknown>): string | null {
  if (!isRecord(event.result)) return null;
  return typeof event.result.result === "string" ? event.result.result : null;
}

function processLine(state: StreamState, line: string): void {
  if (state.parseError) return;
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  if (!trimmed.startsWith("{")) {
    state.parseError = new Error(`cursor stream-json emitted a non-JSON line: ${trimmed}`);
    return;
  }

  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch (error) {
    state.parseError = new Error(
      `cursor stream-json emitted malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (!isRecord(event)) {
    state.parseError = new Error("cursor stream-json emitted a non-object JSON record");
    return;
  }

  captureSessionId(state, event);

  if (event.type === "partial_output") {
    if (typeof event.text !== "string") {
      state.parseError = new Error("cursor partial_output record is missing string text");
      return;
    }
    const delta = event.text;
    if (state.pendingBoundary) {
      const separator = streamBoundarySeparator(state.streamedText, delta);
      if (separator.length > 0) {
        state.streamedText += separator;
        state.onText(separator);
      }
      state.pendingBoundary = false;
    }
    state.streamedText += delta;
    state.onText(delta);
    return;
  }

  if (event.type === "assistant" || event.type === "tool_call") {
    if (state.streamedText.length > 0) {
      state.pendingBoundary = true;
    }
    return;
  }

  if (event.type === "result") {
    state.resultText = parseResultText(event);
  }
}

function feed(state: StreamState, chunk: string): void {
  if (state.parseError) return;
  state.buffer += chunk;
  let newlineIdx = state.buffer.indexOf("\n");
  while (newlineIdx >= 0) {
    processLine(state, state.buffer.slice(0, newlineIdx));
    state.buffer = state.buffer.slice(newlineIdx + 1);
    newlineIdx = state.buffer.indexOf("\n");
  }
}

function flush(state: StreamState): void {
  if (state.parseError) return;
  if (state.buffer.length > 0) {
    processLine(state, state.buffer);
    state.buffer = "";
  }
}

export const cursorBackend: Backend = {
  id: "cursor",
  supportsBootstrapSessionImport: false,
  async invoke(ctx: BackendInvokeContext): Promise<BackendInvokeResult> {
    const state: StreamState = {
      sessionId: null,
      resultText: null,
      streamedText: "",
      pendingBoundary: false,
      buffer: "",
      parseError: null,
      onText: (text) => ctx.emit?.({ type: "agent_message_delta", text }),
    };

    const result = await runProcess({
      command: process.env.TASK_RUNNER_CURSOR_BIN ?? "cursor-agent",
      args: buildCursorArgs(ctx),
      cwd: ctx.cwd,
      env: ctx.env,
      timeoutMs: ctx.timeoutSec * 1000,
      abortSignal: ctx.abortSignal,
      onStdout: (chunk) => feed(state, chunk.toString("utf8")),
      onStderr: (chunk) => ctx.emit?.({ type: "backend_notice", text: chunk.toString("utf8") }),
    });
    flush(state);

    if (state.parseError) {
      throw state.parseError;
    }
    if (result.exitCode === 0 && state.resultText === null) {
      throw new Error(
        "cursor stream-json completed successfully without a valid final result.result string",
      );
    }

    const transcript =
      result.exitCode === 0
        ? composePersistedTranscript(state.streamedText, state.resultText)
        : state.resultText;
    const fallbackDelta = silentTranscriptFallback(state.streamedText, transcript);
    if (fallbackDelta) {
      ctx.emit?.({ type: "agent_message_delta", text: fallbackDelta });
    }

    return {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      aborted: result.aborted,
      sessionId: state.sessionId,
      transcript,
      rawStdout: result.stdoutText,
      rawStderr: result.stderrText,
    };
  },
};
