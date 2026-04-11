import { runProcess } from "../util/spawn.js";
import type { Backend, BackendInvokeContext, BackendInvokeResult } from "./types.js";

function normalizeClaudeModel(model: string): string {
  const idx = model.indexOf("/");
  if (idx < 0) return model;
  const stripped = model.slice(idx + 1);
  return stripped.length > 0 ? stripped : model;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

interface StreamState {
  sessionId: string | null;
  resultText: string;
  assistantEventText: string;
  streamedText: string;
  sawDelta: boolean;
  buffer: string;
  onText: (text: string) => void;
}

function captureSessionId(state: StreamState, event: Record<string, unknown>): void {
  if (state.sessionId) return;

  const direct =
    (typeof event.session_id === "string" && event.session_id) ||
    (typeof event.sessionId === "string" && event.sessionId) ||
    null;
  if (direct) {
    state.sessionId = direct;
    return;
  }

  const nested = event.session;
  if (isRecord(nested) && typeof nested.id === "string") {
    state.sessionId = nested.id;
  }
}

function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let combined = "";
  for (const item of content) {
    if (isRecord(item) && typeof item.text === "string") {
      combined += item.text;
    }
  }
  return combined;
}

function processLine(state: StreamState, line: string): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return;

  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (!isRecord(event)) return;

  captureSessionId(state, event);

  if (event.type === "result" && typeof event.result === "string") {
    state.resultText = event.result;
    return;
  }

  if (event.type === "assistant" && isRecord(event.message)) {
    const text = extractAssistantText(event.message.content);
    if (text) {
      state.assistantEventText += text;
      if (!state.sawDelta) {
        state.onText(`${text}\n`);
      }
    }
    return;
  }

  if (event.type === "stream_event" && isRecord(event.event)) {
    const inner = event.event;
    if (inner.type === "content_block_delta" && isRecord(inner.delta)) {
      const delta = inner.delta;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        state.streamedText += delta.text;
        state.sawDelta = true;
        state.onText(delta.text);
      }
    }
  }
}

function feed(state: StreamState, chunk: string): void {
  state.buffer += chunk;
  let newlineIdx: number;
  while ((newlineIdx = state.buffer.indexOf("\n")) >= 0) {
    const line = state.buffer.slice(0, newlineIdx);
    state.buffer = state.buffer.slice(newlineIdx + 1);
    processLine(state, line);
  }
}

function flush(state: StreamState): void {
  if (state.buffer.length > 0) {
    processLine(state, state.buffer);
    state.buffer = "";
  }
}

export function isResumeFailure(stderr: string, exitCode: number | null): boolean {
  if (exitCode === 0 || exitCode === null) return false;
  const text = stderr.toLowerCase();
  return (
    text.includes("session not found") ||
    text.includes("no such session") ||
    text.includes("could not find session") ||
    text.includes("unknown session")
  );
}

export const claudeBackend: Backend = {
  id: "claude",
  async invoke(ctx: BackendInvokeContext): Promise<BackendInvokeResult> {
    const args: string[] = ["--print", "--output-format", "stream-json", "--verbose"];

    if (ctx.model) {
      args.push("--model", normalizeClaudeModel(ctx.model));
    }
    if (ctx.effort) {
      args.push("--effort", ctx.effort);
    }
    if (ctx.unrestricted) {
      args.push("--dangerously-skip-permissions");
    }
    if (ctx.resumeSessionId) {
      args.push("--resume", ctx.resumeSessionId);
    }
    if (ctx.prompt.trim().length > 0) {
      args.push(ctx.prompt);
    }

    const state: StreamState = {
      sessionId: null,
      resultText: "",
      assistantEventText: "",
      streamedText: "",
      sawDelta: false,
      buffer: "",
      onText: (text) => ctx.onStdoutText?.(text),
    };

    const command = process.env.TASK_RUNNER_CLAUDE_BIN ?? "claude";

    const result = await runProcess({
      command,
      args,
      cwd: ctx.cwd,
      env: ctx.env,
      timeoutMs: ctx.timeoutSec * 1000,
      onStdout: (chunk) => feed(state, chunk.toString("utf8")),
      onStderr: (chunk) => ctx.onStderrText?.(chunk.toString("utf8")),
    });
    flush(state);

    const finalMessage =
      state.resultText.trim() ||
      state.streamedText.trim() ||
      state.assistantEventText.trim() ||
      null;

    return {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      sessionId: state.sessionId,
      assistantMessage: finalMessage,
      rawStdout: result.stdoutText,
      rawStderr: result.stderrText,
    };
  },
};
