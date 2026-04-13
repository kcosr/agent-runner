export function formatTimestamp(value: string | null): string {
  if (!value) {
    return "Not available";
  }

  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatRelativeTimestamp(value: string | null): string {
  if (!value) {
    return "";
  }

  const deltaMs = new Date(value).getTime() - Date.now();
  const deltaMinutes = Math.round(deltaMs / 60_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  if (Math.abs(deltaMinutes) < 60) {
    return formatter.format(deltaMinutes, "minute");
  }

  const deltaHours = Math.round(deltaMinutes / 60);
  if (Math.abs(deltaHours) < 48) {
    return formatter.format(deltaHours, "hour");
  }

  return formatter.format(Math.round(deltaHours / 24), "day");
}

export function truncateMiddle(value: string, start = 20, end = 18): string {
  if (value.length <= start + end + 3) {
    return value;
  }
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}
