import { strict as assert } from "node:assert";
import { test } from "node:test";
import { streamBoundarySeparator } from "../dist/backends/codex.js";

test("streamBoundarySeparator: empty prior returns no separator", () => {
  assert.equal(streamBoundarySeparator("", "Hello"), "");
});

test("streamBoundarySeparator: glued prior + delta gets two newlines", () => {
  // "...sentence one." + "Sentence two..." → "\n\n"
  assert.equal(streamBoundarySeparator("Hello world.", "Goodbye world."), "\n\n");
});

test("streamBoundarySeparator: prior with one trailing newline gets one more", () => {
  assert.equal(streamBoundarySeparator("Hello world.\n", "Next message"), "\n");
});

test("streamBoundarySeparator: prior with two trailing newlines needs no padding", () => {
  assert.equal(streamBoundarySeparator("Hello world.\n\n", "Next message"), "");
});

test("streamBoundarySeparator: prior with three trailing newlines also needs none", () => {
  assert.equal(streamBoundarySeparator("Hello world.\n\n\n", "Next message"), "");
});

test("streamBoundarySeparator: leading newline on delta counts toward total", () => {
  // prior has 0 trailing, delta has 1 leading → need 1 more
  assert.equal(streamBoundarySeparator("Hello world.", "\nNext message"), "\n");
});

test("streamBoundarySeparator: two leading newlines on delta needs no padding", () => {
  assert.equal(streamBoundarySeparator("Hello world.", "\n\nNext message"), "");
});

test("streamBoundarySeparator: one trailing + one leading is enough", () => {
  assert.equal(streamBoundarySeparator("Hello world.\n", "\nNext message"), "");
});
