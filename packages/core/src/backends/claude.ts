import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Backend,
  BackendInvokeContext,
  BackendInvokeResult,
  EffortLevel,
  ValidateSessionContext,
  ValidateSessionResult,
} from "../core/backends/types.js";
import { runProcess } from "../util/spawn.js";
import {
  type LineFeeder,
  composePersistedTranscript,
  createLineFeeder,
  isRecord,
  normalizeBackendModel,
  silentTranscriptFallback,
  streamBoundarySeparator,
} from "./shared.js";

/**
 * Claude encodes the working directory of a session into the
 * `~/.claude/projects/<encoded>/` directory name by replacing every
 * `/` and `.` in the path with `-`. So `/home/kevin/.claude/foo.bar`
 * becomes `-home-kevin--claude-foo-bar`. Verified by sampling real
 * project dirs on disk; the rule covers every case observed.
 */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

export function claudeSessionFilePath(cwd: string, sessionId: string): string {
  return join(homedir(), ".claude", "projects", encodeClaudeProjectDir(cwd), `${sessionId}.jsonl`);
}

function mapEffortToClaude(effort: EffortLevel): string | null {
  switch (effort) {
    case "off":
      return null;
    case "minimal":
      return "low";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "max";
    case "max":
      return "max";
  }
}

const normalizeClaudeModel = normalizeBackendModel;

export function buildClaudeArgs(
  ctx: Pick<
    BackendInvokeContext,
    | "effort"
    | "model"
    | "name"
    | "prompt"
    | "resolvedBackendArgs"
    | "resumeSessionId"
    | "unrestricted"
  >,
): string[] {
  const args: string[] = ["--print", "--output-format", "stream-json", "--verbose"];

  if (ctx.model) {
    args.push("--model", normalizeClaudeModel(ctx.model));
  }
  if (ctx.effort) {
    const mapped = mapEffortToClaude(ctx.effort);
    if (mapped !== null) {
      args.push("--effort", mapped);
    }
  }
  if (ctx.unrestricted) {
    args.push("--dangerously-skip-permissions");
  }
  if (ctx.name) {
    args.push("--name", ctx.name);
  }
  if (ctx.resumeSessionId) {
    args.push("--resume", ctx.resumeSessionId);
  }
  args.push(...ctx.resolvedBackendArgs);
  if (ctx.prompt.trim().length > 0) {
    args.push(ctx.prompt);
  }
  return args;
}

interface StreamState {
  sessionId: string | null;
  resultText: string;
  assistantEventText: string;
  streamedText: string;
  sawDelta: boolean;
  /**
   * The `id` of the most recently observed message_start event. When a
   * later message_start arrives with a different id, we insert a
   * paragraph break before the next text_delta so two adjacent message
   * bodies don't get glued: "...sentence one.Sentence two...".
   */
  lastMessageId: string | null;
  pendingMessageBoundary: boolean;
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
    if (inner.type === "message_start" && isRecord(inner.message)) {
      const messageId = typeof inner.message.id === "string" ? inner.message.id : null;
      // A new message inside the same turn (e.g. after a tool result).
      // Mark a pending boundary so the first text_delta of this message
      // gets a paragraph break prepended.
      if (
        messageId !== null &&
        state.lastMessageId !== null &&
        messageId !== state.lastMessageId &&
        state.streamedText.length > 0
      ) {
        state.pendingMessageBoundary = true;
      }
      if (messageId !== null) state.lastMessageId = messageId;
      return;
    }
    if (inner.type === "content_block_delta" && isRecord(inner.delta)) {
      const delta = inner.delta;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        if (state.pendingMessageBoundary) {
          const sep = streamBoundarySeparator(state.streamedText, delta.text);
          if (sep.length > 0) {
            state.streamedText += sep;
            state.onText(sep);
          }
          state.pendingMessageBoundary = false;
        }
        state.streamedText += delta.text;
        state.sawDelta = true;
        state.onText(delta.text);
      }
    }
  }
}

function feed(lineFeeder: LineFeeder, chunk: string): void {
  lineFeeder.feed(chunk);
}

function flush(lineFeeder: LineFeeder): void {
  lineFeeder.flush();
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

async function validateClaudeSession(ctx: ValidateSessionContext): Promise<ValidateSessionResult> {
  const path = claudeSessionFilePath(ctx.cwd, ctx.sessionId);
  if (!existsSync(path)) {
    return {
      valid: false,
      reason: `claude session "${ctx.sessionId}" not found under cwd "${ctx.cwd}"\n  expected file: ${path}\n  the session must have been created with the same working directory; claude keys session storage by encoded cwd.`,
    };
  }
  return { valid: true };
}

export const claudeBackend: Backend = {
  id: "claude",
  validateSessionId: validateClaudeSession,
  async invoke(ctx: BackendInvokeContext): Promise<BackendInvokeResult> {
    const args = buildClaudeArgs(ctx);

    const state: StreamState = {
      sessionId: null,
      resultText: "",
      assistantEventText: "",
      streamedText: "",
      sawDelta: false,
      lastMessageId: null,
      pendingMessageBoundary: false,
      onText: (text) => ctx.emit?.({ type: "agent_message_delta", text }),
    };
    const lineFeeder = createLineFeeder({
      onLine: (line) => processLine(state, line),
      onPartial: (partial) => processLine(state, partial),
      onRawSegment: ctx.onRawStdoutLine,
    });

    const command = process.env.TASK_RUNNER_CLAUDE_BIN ?? "claude";

    const result = await runProcess({
      command,
      args,
      launcher: ctx.launcher,
      cwd: ctx.cwd,
      env: ctx.env,
      timeoutMs: ctx.timeoutSec * 1000,
      abortSignal: ctx.abortSignal,
      onStdout: (chunk) => feed(lineFeeder, chunk.toString("utf8")),
      onStderr: (chunk) => ctx.emit?.({ type: "backend_notice", text: chunk.toString("utf8") }),
    });
    flush(lineFeeder);

    const finalText = state.assistantEventText.trim() || state.resultText.trim() || null;
    const transcript = composePersistedTranscript(state.streamedText, finalText);

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
