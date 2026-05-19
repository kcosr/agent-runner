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
    return withOptionalInstruction(
      [
        `File: \`${reference.path}\``,
        "View: rendered-markdown",
        "",
        "Selected text:",
        "",
        blockquote(reference.selectedText),
      ].join("\n"),
      trimmedInstruction,
    );
  }

  const range =
    reference.startLine === reference.endLine
      ? `${reference.path}:${reference.startLine}`
      : `${reference.path}:${reference.startLine}-${reference.endLine}`;
  const fenceLanguage = reference.language ?? "";
  return withOptionalInstruction(
    [
      `File: \`${reference.path}\``,
      "View: source",
      `Range: \`${range}\``,
      "",
      "Selected source:",
      "",
      `\`\`\`${fenceLanguage}`,
      reference.selectedText,
      "```",
    ].join("\n"),
    trimmedInstruction,
  );
}

function withOptionalInstruction(referenceBody: string, instruction: string): string {
  if (!instruction) {
    return referenceBody;
  }
  return [referenceBody, "", "Instructions:", "", instruction].join("\n");
}

function blockquote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}
