import { describe, expect, it } from "vitest";
import {
  isImagePreviewMediaType,
  isPreviewableAttachment,
  normalizeAttachmentMimeType,
} from "./attachments.js";

describe("attachment preview helpers", () => {
  it.each([
    ["text/markdown"],
    ["text/plain"],
    ["image/png"],
    ["image/jpeg"],
    ["image/gif"],
    ["image/webp"],
    ["image/svg+xml"],
  ])("marks %s as previewable", (mimeType) => {
    expect(isPreviewableAttachment({ mimeType })).toBe(true);
  });

  it("normalizes MIME type parameters, casing, and whitespace", () => {
    expect(normalizeAttachmentMimeType(" Text/Markdown; charset=utf-8 ")).toBe("text/markdown");
    expect(isPreviewableAttachment({ mimeType: " Text/Plain; charset=utf-8 " })).toBe(true);
  });

  it("keeps representative non-previewable attachments out of preview", () => {
    expect(isPreviewableAttachment({ mimeType: "application/pdf" })).toBe(false);
  });

  it("identifies image preview media types", () => {
    expect(isImagePreviewMediaType("image/png")).toBe(true);
    expect(isImagePreviewMediaType("text/markdown")).toBe(false);
    expect(isImagePreviewMediaType(null)).toBe(false);
  });
});
