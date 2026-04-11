import { unescapeStructuralText } from "./escaping.js";

const TASK_ID_MARKER = /^<!--\s*task-id:\s*([A-Za-z0-9._:-]+)\s*-->\s*$/gm;
const NOTES_START_MARKER = /^<!-- notes:start -->\s*$/gm;
const NOTES_END_MARKER = /^<!-- notes:end -->\s*$/gm;
const STATUS_LINE = /^\s*\*\*Status:\*\*\s*(.*?)\s*$/gm;

function clonePattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags);
}

function findLastMatch(
  text: string,
  pattern: RegExp,
): { index: number; match: string; length: number } | null {
  let lastMatch: { index: number; match: string; length: number } | null = null;
  for (const match of text.matchAll(clonePattern(pattern))) {
    if (match.index !== undefined) {
      lastMatch = {
        index: match.index,
        match: match[0],
        length: match[0].length,
      };
    }
  }
  return lastMatch;
}

function findFirstMatch(
  text: string,
  pattern: RegExp,
  fromIndex = 0,
): { index: number; match: string; length: number } | null {
  const sliced = text.slice(fromIndex);
  const match = clonePattern(pattern).exec(sliced);
  if (match?.index === undefined) return null;
  return {
    index: fromIndex + match.index,
    match: match[0],
    length: match[0].length,
  };
}

export interface ParsedSectionUpdate {
  taskId: string;
  status?: string;
  notes?: string;
}

export function parseAssignment(raw: string): ParsedSectionUpdate[] {
  const markers: { id: string; start: number }[] = [];
  const seen = new Set<string>();
  for (const match of raw.matchAll(clonePattern(TASK_ID_MARKER))) {
    if (match.index !== undefined) {
      const id = match[1];
      if (id !== undefined && !seen.has(id)) {
        seen.add(id);
        markers.push({ id, start: match.index });
      }
    }
  }

  const updates: ParsedSectionUpdate[] = [];
  for (let i = 0; i < markers.length; i++) {
    const current = markers[i];
    if (!current) continue;
    const next = markers[i + 1];
    const end = next ? next.start : raw.length;
    const section = raw.slice(current.start, end);
    const update: ParsedSectionUpdate = { taskId: current.id };

    let lastStatus: string | undefined;
    for (const statusMatch of section.matchAll(clonePattern(STATUS_LINE))) {
      if (statusMatch[1] !== undefined) {
        lastStatus = statusMatch[1].trim();
      }
    }
    if (lastStatus !== undefined) {
      update.status = lastStatus;
    }

    const startMatch = findLastMatch(section, NOTES_START_MARKER);
    if (startMatch) {
      const startOffset = startMatch.index + startMatch.length;
      const endMatch = findFirstMatch(section, NOTES_END_MARKER, startOffset);
      if (endMatch) {
        update.notes = unescapeStructuralText(section.slice(startOffset, endMatch.index).trim());
      } else {
        update.notes = unescapeStructuralText(section.slice(startOffset).trim());
      }
    }

    updates.push(update);
  }

  return updates;
}
