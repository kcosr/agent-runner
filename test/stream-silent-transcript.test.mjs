import assert from "node:assert/strict";
import test from "node:test";
import { silentTranscriptFallback } from "../packages/core/dist/backends/shared.js";

test("silentTranscriptFallback returns the transcript when nothing streamed live", () => {
  assert.equal(silentTranscriptFallback("", "Final answer"), "Final answer");
});

test("silentTranscriptFallback ignores empty final transcripts", () => {
  assert.equal(silentTranscriptFallback("", ""), null);
  assert.equal(silentTranscriptFallback("", "   "), null);
  assert.equal(silentTranscriptFallback("", null), null);
});

test("silentTranscriptFallback does not duplicate already-streamed output", () => {
  assert.equal(silentTranscriptFallback("Live output", "Final answer"), null);
  assert.equal(silentTranscriptFallback("  Live output  ", "Final answer"), null);
});
