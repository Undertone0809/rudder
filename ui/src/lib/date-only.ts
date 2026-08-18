const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function padDatePart(value: number) {
  return String(value).padStart(2, "0");
}

export function isDateOnly(value: string): boolean {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

export function formatLocalDateOnly(value: Date): string {
  if (Number.isNaN(value.getTime())) return "";
  return [
    value.getFullYear(),
    padDatePart(value.getMonth() + 1),
    padDatePart(value.getDate()),
  ].join("-");
}

export function toDateOnlyValue(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    if (isDateOnly(value)) return value;
    const datePrefix = /^(\d{4}-\d{2}-\d{2})T/.exec(value)?.[1];
    if (datePrefix && isDateOnly(datePrefix)) return datePrefix;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
  }
  return formatLocalDateOnly(value);
}

export function parseDateOnlyValue(value: Date | string | null | undefined): Date | null {
  const dateOnly = toDateOnlyValue(value);
  if (!isDateOnly(dateOnly)) return null;
  const [year, month, day] = dateOnly.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

export function formatDateOnly(value: Date | string): string {
  const date = parseDateOnlyValue(value);
  if (!date) return "";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}
