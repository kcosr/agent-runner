const TASK_ID_MARKER = /^<!--\s*task-id:\s*[A-Za-z0-9._:-]+\s*-->\s*$/;
const STATUS_LINE = /^\s*\*\*Status:\*\*.*$/;
const NOTES_LABEL = /^\s*\*\*Notes:\*\*\s*$/;
const NOTES_START_MARKER = /^<!-- notes:start -->$/;
const NOTES_END_MARKER = /^<!-- notes:end -->$/;

function isStructuralLine(line: string): boolean {
  return (
    TASK_ID_MARKER.test(line) ||
    STATUS_LINE.test(line) ||
    NOTES_LABEL.test(line) ||
    NOTES_START_MARKER.test(line) ||
    NOTES_END_MARKER.test(line)
  );
}

export function escapeStructuralText(text: string): string {
  return text
    .split("\n")
    .map((line) => (isStructuralLine(line) ? `\\${line}` : line))
    .join("\n");
}

export function unescapeStructuralText(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (!line.startsWith("\\")) return line;
      const candidate = line.slice(1);
      return isStructuralLine(candidate) ? candidate : line;
    })
    .join("\n");
}
