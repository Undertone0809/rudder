import type { CalendarEvent } from "@rudderhq/shared";
import { agentUrl } from "@/lib/utils";

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

export function formatCalendarDetailDateTime(date: Date | string) {
  const value = new Date(date);
  return [
    value.getFullYear(),
    pad2(value.getMonth() + 1),
    pad2(value.getDate()),
  ].join("-")
    + " "
    + [
      pad2(value.getHours()),
      pad2(value.getMinutes()),
      pad2(value.getSeconds()),
    ].join(":");
}

export function formatCalendarDetailTime(date: Date | string) {
  const value = new Date(date);
  return [
    pad2(value.getHours()),
    pad2(value.getMinutes()),
    pad2(value.getSeconds()),
  ].join(":");
}

export function formatCalendarDetailTimeRange(startAt: Date | string, endAt: Date | string) {
  const start = new Date(startAt);
  const end = new Date(endAt);
  const sameLocalDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();

  if (sameLocalDay) {
    return `${formatCalendarDetailDateTime(start)} - ${formatCalendarDetailTime(end)}`;
  }

  return `${formatCalendarDetailDateTime(start)} - ${formatCalendarDetailDateTime(end)}`;
}

export function calendarEventSourceLabel(event: CalendarEvent) {
  if (event.eventStatus === "projected") return "projected heartbeat";
  if (event.sourceMode === "derived") return "run history";
  return event.source?.name ?? "manual";
}

export function calendarEventRunHref(event: CalendarEvent) {
  if (!event.heartbeatRunId || !event.agent) return null;
  return `${agentUrl(event.agent)}/runs/${event.heartbeatRunId}`;
}
