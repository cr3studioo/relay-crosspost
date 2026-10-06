import type { Settings } from "./types";
const formatters = new Map<string, Intl.DateTimeFormat>();
export function localHour(date: Date, timezone: string): number {
  if (!formatters.has(timezone))
    formatters.set(
      timezone,
      new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        hour: "numeric",
        hourCycle: "h23",
      }),
    );
  return Number(formatters.get(timezone)!.format(date));
}
export function withinWindow(
  date: Date,
  settings: Pick<Settings, "timezone" | "start_hour" | "end_hour">,
): boolean {
  const hour = localHour(date, settings.timezone);
  // The end boundary is exclusive: 21:00 closes the window.
  return hour >= settings.start_hour && hour < settings.end_hour;
}
export function nextWindow(
  date: Date,
  settings: Pick<Settings, "timezone" | "start_hour" | "end_hour">,
): Date {
  const result = new Date(date);
  for (let i = 0; i < 2880; i++) {
    if (withinWindow(result, settings)) return result;
    result.setUTCSeconds(0, 0);
    result.setUTCMinutes(result.getUTCMinutes() + 1);
  }
  throw new Error("No posting window found");
}
export function estimatedSlots(
  settings: Settings,
  count: number,
  now = new Date(),
): Date[] {
  let cursor = new Date(
    Math.max(
      now.getTime(),
      settings.last_publication_at
        ? Date.parse(settings.last_publication_at) + 3600000
        : 0,
    ),
  );
  const result: Date[] = [];
  for (let i = 0; i < count; i++) {
    cursor = nextWindow(cursor, settings);
    result.push(new Date(cursor));
    cursor = new Date(cursor.getTime() + 3600000);
  }
  return result;
}
export function formatTime(date: Date | string, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}
