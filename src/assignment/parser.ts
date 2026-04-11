const TASK_ID_MARKER = /^<!--\s*task-id:\s*([A-Za-z0-9._:-]+)\s*-->\s*$/gm;
const NOTES_START_MARKER = "<!-- notes:start -->";
const NOTES_END_MARKER = "<!-- notes:end -->";
const STATUS_LINE = /^\s*\*\*Status:\*\*\s*(.*?)\s*$/gm;

function clonePattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags);
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

    const startIndex = section.lastIndexOf(NOTES_START_MARKER);
    if (startIndex >= 0) {
      const startOffset = startIndex + NOTES_START_MARKER.length;
      const tail = section.slice(startOffset);
      const endIndex = tail.indexOf(NOTES_END_MARKER);
      if (endIndex >= 0) {
        update.notes = tail.slice(0, endIndex).trim();
      } else {
        update.notes = tail.trim();
      }
    }

    updates.push(update);
  }

  return updates;
}
