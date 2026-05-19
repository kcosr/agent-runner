interface RenderedTaskReference {
  path: string;
  selectedText: string;
  view: "rendered-markdown";
}

interface SourceTaskReference {
  endLine: number;
  language: string | null;
  path: string;
  selectedText: string;
  startLine: number;
  view: "source";
}

export type TaskReference = RenderedTaskReference | SourceTaskReference;

const EXTENSION_LANGUAGES = new Map<string, string>([
  ["cjs", "js"],
  ["css", "css"],
  ["html", "html"],
  ["js", "js"],
  ["json", "json"],
  ["jsx", "jsx"],
  ["mjs", "js"],
  ["md", "md"],
  ["mdx", "mdx"],
  ["sh", "sh"],
  ["tsx", "tsx"],
  ["ts", "ts"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
]);

export function languageForPath(path: string): string | null {
  const extension = path.split(".").pop()?.toLowerCase();
  return extension ? (EXTENSION_LANGUAGES.get(extension) ?? null) : null;
}

export function defaultTaskTitle(path: string): string {
  return `Update ${path}`;
}

export function buildTaskBody(reference: TaskReference | null, instruction: string): string {
  const trimmedInstruction = instruction.trim();
  if (!reference) {
    return trimmedInstruction;
  }

  if (reference.view === "rendered-markdown") {
    return [
      `File: \`${reference.path}\``,
      "View: rendered-markdown",
      "",
      "Selected text:",
      "",
      blockquote(reference.selectedText),
      "",
      "Instruction:",
      "",
      trimmedInstruction,
    ].join("\n");
  }

  const range =
    reference.startLine === reference.endLine
      ? `${reference.path}:${reference.startLine}`
      : `${reference.path}:${reference.startLine}-${reference.endLine}`;
  const fenceLanguage = reference.language ?? "";
  return [
    `File: \`${reference.path}\``,
    "View: source",
    `Range: \`${range}\``,
    "",
    "Selected source:",
    "",
    `\`\`\`${fenceLanguage}`,
    reference.selectedText,
    "```",
    "",
    "Instruction:",
    "",
    trimmedInstruction,
  ].join("\n");
}

export function stripSourceGutterNumbersFromTaskBody(body: string): string {
  const lines = body.split("\n");
  const rangeLineIndex = lines.findIndex((line) => line.startsWith("Range: `"));
  if (rangeLineIndex === -1) {
    return body;
  }

  const rangeLine = lines[rangeLineIndex];
  if (rangeLine === undefined) {
    return body;
  }
  const rangeMatch = /:(\d+)(?:-(\d+))?`$/.exec(rangeLine);
  const startLineMatch = rangeMatch?.[1];
  if (!rangeMatch || startLineMatch === undefined) {
    return body;
  }

  const startLine = Number.parseInt(startLineMatch, 10);
  const endLine = rangeMatch[2] ? Number.parseInt(rangeMatch[2], 10) : startLine;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || endLine < startLine) {
    return body;
  }

  const selectedSourceIndex = lines.findIndex(
    (line, index) => index > rangeLineIndex && line === "Selected source:",
  );
  if (selectedSourceIndex === -1) {
    return body;
  }

  const fenceStartIndex = lines.findIndex(
    (line, index) => index > selectedSourceIndex && line.startsWith("```"),
  );
  if (fenceStartIndex === -1) {
    return body;
  }

  const fenceEndIndex = lines.findIndex(
    (line, index) => index > fenceStartIndex && line.startsWith("```"),
  );
  if (fenceEndIndex === -1) {
    return body;
  }

  const rangeNumbers = new Set(
    Array.from({ length: endLine - startLine + 1 }, (_, index) => String(startLine + index)),
  );
  const sourceLines = lines
    .slice(fenceStartIndex + 1, fenceEndIndex)
    .filter((line) => !rangeNumbers.has(line.trim()));
  return [
    ...lines.slice(0, fenceStartIndex + 1),
    ...sourceLines,
    ...lines.slice(fenceEndIndex),
  ].join("\n");
}

function blockquote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}
