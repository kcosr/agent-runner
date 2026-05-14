import { afterEach, describe, expect, it, vi } from "vitest";
import { writeToClipboard } from "./clipboard.js";

function stubNavigatorClipboard(writeText?: (value: string) => Promise<void>) {
  const stubbedNavigator = Object.create(navigator) as Navigator;
  Object.defineProperty(stubbedNavigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
  vi.stubGlobal("navigator", stubbedNavigator);
}

function stubDocumentCopy(copy: () => boolean) {
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: vi.fn(copy),
  });
}

describe("writeToClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.querySelectorAll("textarea").forEach((textarea) => textarea.remove());
  });

  it("uses the Clipboard API when available", async () => {
    const writeText = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    stubNavigatorClipboard(writeText);
    stubDocumentCopy(() => {
      throw new Error("fallback should not run");
    });

    await expect(writeToClipboard("copy me")).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith("copy me");
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it("falls back to document copy when the Clipboard API fails", async () => {
    const writeText = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("denied"));
    stubNavigatorClipboard(writeText);
    stubDocumentCopy(() => true);

    await expect(writeToClipboard("fallback text")).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith("fallback text");
    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back to document copy when Clipboard API access is unavailable", async () => {
    stubNavigatorClipboard();
    stubDocumentCopy(() => true);

    await expect(writeToClipboard("legacy text")).resolves.toBe(true);

    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("returns false when document copy fails", async () => {
    stubNavigatorClipboard();
    stubDocumentCopy(() => {
      throw new Error("copy unavailable");
    });

    await expect(writeToClipboard("uncopied text")).resolves.toBe(false);

    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });
});
