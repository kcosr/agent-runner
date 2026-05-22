import { describe, expect, it } from "vitest";
import { buildTaskBody } from "./task-reference.js";

describe("task references", () => {
  it("renders source references with selected text and instructions", () => {
    expect(
      buildTaskBody(
        {
          view: "source",
          path: "src/app.tsx",
          language: "tsx",
          startLine: 10,
          endLine: 12,
          selectedText: "const value = 1;\nreturn value;",
        },
        "Use this source context.",
      ),
    ).toBe(
      [
        "File: `src/app.tsx`",
        "View: source",
        "Range: `src/app.tsx:10-12`",
        "",
        "Selected source:",
        "",
        "```tsx",
        "const value = 1;",
        "return value;",
        "```",
        "",
        "Instructions:",
        "",
        "Use this source context.",
      ].join("\n"),
    );
  });

  it("renders rendered-markdown references without changing existing shape", () => {
    expect(
      buildTaskBody(
        {
          view: "rendered-markdown",
          path: "docs/guide.md",
          selectedText: "First line\nSecond line",
        },
        "",
      ),
    ).toBe(
      [
        "File: `docs/guide.md`",
        "View: rendered-markdown",
        "",
        "Selected text:",
        "",
        "> First line",
        "> Second line",
      ].join("\n"),
    );
  });

  it("renders diff references with range, side, previous path, selected diff, and instructions", () => {
    expect(
      buildTaskBody(
        {
          view: "diff",
          displayRange: "main...HEAD",
          baseRef: "main",
          headRef: "HEAD",
          comparison: "merge-base",
          path: "src/new-name.ts",
          oldPath: "src/old-name.ts",
          side: "additions",
          startLine: 20,
          endLine: 21,
          selectedText: "export const value = 1;\nexport const next = 2;",
        },
        "Create a follow-up task from this diff.",
      ),
    ).toBe(
      [
        "Diff: `main...HEAD`",
        "File: `src/new-name.ts`",
        "Previous file: `src/old-name.ts`",
        "Side: additions",
        "Range: `src/new-name.ts:20-21`",
        "",
        "Selected diff:",
        "",
        "```ts",
        "export const value = 1;",
        "export const next = 2;",
        "```",
        "",
        "Instructions:",
        "",
        "Create a follow-up task from this diff.",
      ].join("\n"),
    );
  });

  it("renders single-line deletion diff references without instructions", () => {
    expect(
      buildTaskBody(
        {
          view: "diff",
          displayRange: "Working tree",
          baseRef: null,
          headRef: null,
          comparison: null,
          path: "README",
          side: "deletions",
          startLine: 4,
          endLine: 4,
          selectedText: "removed line",
        },
        "   ",
      ),
    ).toBe(
      [
        "Diff: `Working tree`",
        "File: `README`",
        "Side: deletions",
        "Range: `README:4`",
        "",
        "Selected diff:",
        "",
        "```",
        "removed line",
        "```",
      ].join("\n"),
    );
  });
});
