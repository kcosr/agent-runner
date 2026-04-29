export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeBackendModel(model: string): string {
  const slashIndex = model.indexOf("/");
  if (slashIndex < 0) return model;
  const stripped = model.slice(slashIndex + 1);
  return stripped.length > 0 ? stripped : model;
}

/**
 * Compute a paragraph-break separator to insert before `delta` so that
 * two adjacent streamed message bodies don't get glued together.
 *
 * Returns the separator string only ("" if no padding is needed). The
 * caller is responsible for emitting `separator + delta` to its sink.
 *
 * Rules:
 *   - If `prior` is empty, no separator (this is the first byte streamed).
 *   - Otherwise, ensure exactly two trailing newlines on the joined
 *     stream — accounting for any newlines already at the end of `prior`
 *     and at the start of `delta`. Two newlines render as a paragraph
 *     break in a terminal.
 */
export function streamBoundarySeparator(prior: string, delta: string): string {
  if (prior.length === 0) return "";
  let trailing = 0;
  for (let i = prior.length - 1; i >= 0; i--) {
    if (prior[i] === "\n") trailing++;
    else break;
  }
  let leading = 0;
  for (let i = 0; i < delta.length; i++) {
    if (delta[i] === "\n") leading++;
    else break;
  }
  const needed = Math.max(0, 2 - trailing - leading);
  return "\n".repeat(needed);
}

function normalizeTranscriptText(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const normalized = text.trim();
  return normalized.length > 0 ? normalized : null;
}

function transcriptEndsWithBlock(streamed: string, finalTranscript: string): boolean {
  if (!streamed.endsWith(finalTranscript)) return false;
  const startIndex = streamed.length - finalTranscript.length;
  return startIndex === 0 || /\s/.test(streamed[startIndex - 1] ?? "");
}

export function composePersistedTranscript(
  streamedText: string,
  finalText: string | null,
): string | null {
  const streamed = normalizeTranscriptText(streamedText);
  const finalTranscript = normalizeTranscriptText(finalText);

  if (streamed === null) return finalTranscript;
  if (finalTranscript === null) return streamed;
  if (transcriptEndsWithBlock(streamed, finalTranscript)) return streamed;
  return `${streamed}\n\n---\n\n${finalTranscript}`;
}

/**
 * Some backends can finish with a transcript even when they never emitted
 * incremental text deltas. In that case, surface the whole transcript once
 * as a terminal fallback so live timeline consumers don't stay blank until
 * they refetch persisted history.
 */
export function silentTranscriptFallback(
  streamedText: string,
  transcript: string | null,
): string | null {
  if (streamedText.trim().length > 0) {
    return null;
  }
  if (!transcript || transcript.trim().length === 0) {
    return null;
  }
  return transcript;
}
