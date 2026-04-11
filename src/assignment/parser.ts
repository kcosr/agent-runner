const TASK_ID_MARKER = /<!--\s*task-id:\s*([A-Za-z0-9._:-]+)\s*-->/g;
const NOTES_START_MARKER = /<!--\s*notes:start\s*-->/;
const NOTES_END_MARKER = /<!--\s*notes:end\s*-->/;
const STATUS_LINE = /^\s*\*\*Status:\*\*\s*(.*?)\s*$/m;

export interface ParsedSectionUpdate {
  taskId: string;
  status?: string;
  notes?: string;
}

export function parseAssignment(raw: string): ParsedSectionUpdate[] {
  const markers: { id: string; start: number }[] = [];
  for (const match of raw.matchAll(TASK_ID_MARKER)) {
    if (match.index !== undefined) {
      const id = match[1];
      if (id !== undefined) {
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

    const statusMatch = section.match(STATUS_LINE);
    if (statusMatch?.[1] !== undefined) {
      update.status = statusMatch[1].trim();
    }

    const startMatch = section.match(NOTES_START_MARKER);
    if (startMatch?.index !== undefined) {
      const startOffset = startMatch.index + startMatch[0].length;
      const tail = section.slice(startOffset);
      const endMatch = tail.match(NOTES_END_MARKER);
      if (endMatch?.index !== undefined) {
        update.notes = tail.slice(0, endMatch.index).trim();
      } else {
        update.notes = tail.trim();
      }
    }

    updates.push(update);
  }

  return updates;
}
