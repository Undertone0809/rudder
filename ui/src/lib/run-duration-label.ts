import { formatDateTime, formatRunElapsedDuration } from "./utils";

type RunTiming = {
  status?: string | null;
  startedAt?: Date | string | null;
  finishedAt?: Date | string | null;
  createdAt?: Date | string | null;
};

export function isRunTimingActive(run: RunTiming): boolean {
  return run.status === "queued" || run.status === "running";
}

export function formatRunDurationLabel(run: RunTiming, now = Date.now()): string | null {
  const start = run.startedAt ?? run.createdAt;
  const active = isRunTimingActive(run);
  const elapsed = formatRunElapsedDuration(start, active ? null : run.finishedAt, now);

  if (active) {
    if (run.status === "queued") return elapsed ? `Queued for ${elapsed}` : "Queued";
    return elapsed ? `Live for ${elapsed}` : "Live";
  }

  if (run.finishedAt && elapsed) return `Ran for ${elapsed}`;
  if (run.startedAt && elapsed) return `Ran for ${elapsed}`;
  return null;
}

function parseRunDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function sameLocalDate(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function formatRunClockTime(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function formatRunOccurrenceLabel(run: RunTiming, now = Date.now()): string | null {
  const occurrence = parseRunDate(run.startedAt ?? run.createdAt);
  if (!occurrence) return null;

  const reference = new Date(now);
  if (!Number.isFinite(reference.getTime())) return formatRunClockTime(occurrence);

  const time = formatRunClockTime(occurrence);
  if (sameLocalDate(occurrence, reference)) return time;

  const yesterday = new Date(reference);
  yesterday.setDate(reference.getDate() - 1);
  if (sameLocalDate(occurrence, yesterday)) return `Yesterday ${time}`;

  const dateOptions: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    ...(occurrence.getFullYear() === reference.getFullYear() ? {} : { year: "numeric" }),
  };
  return `${new Intl.DateTimeFormat("en-US", dateOptions).format(occurrence)} ${time}`;
}

export function formatRunTimingTitle(run: RunTiming): string {
  const parts: string[] = [];
  if (run.startedAt) parts.push(`Started ${formatDateTime(run.startedAt)}`);
  if (run.finishedAt) parts.push(`Finished ${formatDateTime(run.finishedAt)}`);
  if (run.createdAt) parts.push(`Created ${formatDateTime(run.createdAt)}`);
  return parts.join(" · ");
}
