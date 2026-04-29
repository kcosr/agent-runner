import assert from "node:assert/strict";
import test from "node:test";
import {
  composePersistedTranscript,
  silentTranscriptFallback,
} from "../packages/core/dist/backends/shared.js";

test("composePersistedTranscript returns the streamed transcript when only streamed text exists", () => {
  assert.equal(composePersistedTranscript("  Live output  ", null), "Live output");
});

test("composePersistedTranscript returns the final transcript when only final text exists", () => {
  assert.equal(composePersistedTranscript("", "  Final answer  "), "Final answer");
});

test("composePersistedTranscript deduplicates identical streamed and final text after trim", () => {
  assert.equal(composePersistedTranscript("  Final answer  ", "Final answer"), "Final answer");
});

test("composePersistedTranscript deduplicates final text that matches the streamed tail", () => {
  assert.equal(
    composePersistedTranscript(
      "First provisional update.\n\nThe run is complete.",
      "The run is complete.",
    ),
    "First provisional update.\n\nThe run is complete.",
  );
});

test("composePersistedTranscript joins differing streamed and final text with a markdown divider", () => {
  assert.equal(
    composePersistedTranscript("  Live output  ", "  Final answer  "),
    "Live output\n\n---\n\nFinal answer",
  );
});

test("composePersistedTranscript keeps distinct final text when it only matches inside a word", () => {
  assert.equal(composePersistedTranscript("setup", "up"), "setup\n\n---\n\nup");
});

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
