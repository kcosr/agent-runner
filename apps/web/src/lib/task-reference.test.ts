import { describe, expect, it } from "vitest";
import { stripSourceGutterNumbersFromTaskBody } from "./task-reference.js";

describe("task-reference", () => {
  it("strips source gutter line numbers from generated task bodies", () => {
    expect(
      stripSourceGutterNumbersFromTaskBody(
        [
          "File: `biome.json`",
          "View: source",
          "Range: `biome.json:2-4`",
          "",
          "Selected source:",
          "",
          "```json",
          '"$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",',
          "3",
          '"organizeImports": {',
          "4",
          '"enabled": true',
          "```",
          "",
          "Instruction:",
          "",
          "Test.",
        ].join("\n"),
      ),
    ).toBe(
      [
        "File: `biome.json`",
        "View: source",
        "Range: `biome.json:2-4`",
        "",
        "Selected source:",
        "",
        "```json",
        '"$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",',
        '"organizeImports": {',
        '"enabled": true',
        "```",
        "",
        "Instruction:",
        "",
        "Test.",
      ].join("\n"),
    );
  });
});
