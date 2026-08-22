import { getUiLocale } from "./utils";

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return startOfLocalDay(a).getTime() === startOfLocalDay(b).getTime();
}

function isYesterday(date: Date, now: Date): boolean {
  const yesterday = startOfLocalDay(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return startOfLocalDay(date).getTime() === yesterday.getTime();
}

function formatLocalTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function formatIssueCardDate(date: Date | string, now: Date = new Date()): string {
  const value = new Date(date);
  const locale = getUiLocale();

  if (Number.isNaN(value.getTime())) return "-";

  if (isSameLocalDay(value, now)) {
    return formatLocalTime(value);
  }

  if (isYesterday(value, now)) {
    const time = formatLocalTime(value);
    return locale === "zh-CN" ? `昨天 ${time}` : `Yesterday, ${time}`;
  }

  const resolvedLocale = locale === "zh-CN" ? "zh-CN" : "en-US";
  return new Intl.DateTimeFormat(resolvedLocale, locale === "zh-CN"
    ? {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        ...(value.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
      }
    : {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        ...(value.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
      }).format(value);
}
