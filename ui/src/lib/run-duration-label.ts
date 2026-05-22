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

export function formatRunTimingTitle(run: RunTiming): string {
  const parts: string[] = [];
  if (run.startedAt) parts.push(`Started ${formatDateTime(run.startedAt)}`);
  if (run.finishedAt) parts.push(`Finished ${formatDateTime(run.finishedAt)}`);
  if (parts.length === 0 && run.createdAt) parts.push(`Created ${formatDateTime(run.createdAt)}`);
  return parts.join(" · ");
}
