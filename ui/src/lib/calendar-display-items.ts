import type { CalendarEvent, CalendarEventStatus } from "@rudderhq/shared";

export type CalendarDisplaySingle = {
  kind: "single";
  id: string;
  event: CalendarEvent;
  startAt: Date;
  endAt: Date;
};

export type CalendarDisplayCluster = {
  kind: "cluster";
  id: string;
  agentId: string;
  agentName: string;
  startAt: Date;
  endAt: Date;
  events: CalendarEvent[];
  statusCounts: Array<{ status: CalendarEventStatus; count: number }>;
};

export type CalendarDisplayItem = CalendarDisplaySingle | CalendarDisplayCluster;

type BuildCalendarDisplayItemsOptions = {
  groupAgentActivity?: boolean;
  bucketMinutes?: number;
  minClusterSize?: number;
  maxClusterEventDurationMinutes?: number;
};

const STATUS_ORDER: CalendarEventStatus[] = [
  "in_progress",
  "actual",
  "projected",
  "planned",
  "external",
  "cancelled",
];

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function bucketStartFor(date: Date, bucketMinutes: number) {
  const start = new Date(date);
  start.setSeconds(0, 0);
  const minuteOfDay = start.getHours() * 60 + start.getMinutes();
  const bucketMinute = Math.floor(minuteOfDay / bucketMinutes) * bucketMinutes;
  start.setHours(0, bucketMinute, 0, 0);
  return start;
}

function durationMinutes(event: Pick<CalendarEvent, "startAt" | "endAt">) {
  return (new Date(event.endAt).getTime() - new Date(event.startAt).getTime()) / 60_000;
}

function agentNameFor(event: CalendarEvent) {
  const titleAgent = event.title.split(" · ")[0]?.trim();
  return event.agent?.name ?? titleAgent ?? "Agent";
}

function canCluster(event: CalendarEvent, maxClusterEventDurationMinutes: number) {
  return event.eventKind === "agent_work_block" &&
    event.sourceMode === "derived" &&
    !!event.ownerAgentId &&
    !event.allDay &&
    durationMinutes(event) > 0 &&
    durationMinutes(event) <= maxClusterEventDurationMinutes;
}

function toSingle(event: CalendarEvent): CalendarDisplaySingle {
  return {
    kind: "single",
    id: event.id,
    event,
    startAt: new Date(event.startAt),
    endAt: new Date(event.endAt),
  };
}

function statusCounts(events: CalendarEvent[]) {
  const counts = new Map<CalendarEventStatus, number>();
  for (const event of events) {
    counts.set(event.eventStatus, (counts.get(event.eventStatus) ?? 0) + 1);
  }
  return STATUS_ORDER.flatMap((status) => {
    const count = counts.get(status) ?? 0;
    return count > 0 ? [{ status, count }] : [];
  });
}

function compareDisplayItems(a: CalendarDisplayItem, b: CalendarDisplayItem) {
  const startDelta = a.startAt.getTime() - b.startAt.getTime();
  if (startDelta !== 0) return startDelta;
  const endDelta = a.endAt.getTime() - b.endAt.getTime();
  if (endDelta !== 0) return endDelta;
  return a.id.localeCompare(b.id);
}

export function buildCalendarDisplayItems(
  events: CalendarEvent[],
  options: BuildCalendarDisplayItemsOptions = {},
): CalendarDisplayItem[] {
  const groupAgentActivity = options.groupAgentActivity ?? false;
  const bucketMinutes = options.bucketMinutes ?? 60;
  const minClusterSize = options.minClusterSize ?? 2;
  const maxClusterEventDurationMinutes = options.maxClusterEventDurationMinutes ?? 45;

  if (!groupAgentActivity) {
    return events.map(toSingle).sort(compareDisplayItems);
  }

  const groups = new Map<string, { bucketStart: Date; bucketEnd: Date; events: CalendarEvent[] }>();
  const singles: CalendarDisplaySingle[] = [];

  for (const event of events) {
    if (!canCluster(event, maxClusterEventDurationMinutes)) {
      singles.push(toSingle(event));
      continue;
    }

    const startAt = new Date(event.startAt);
    const endAt = new Date(event.endAt);
    const bucketStart = bucketStartFor(startAt, bucketMinutes);
    const bucketEnd = new Date(bucketStart.getTime() + bucketMinutes * 60_000);
    if (endAt.getTime() > bucketEnd.getTime()) {
      singles.push(toSingle(event));
      continue;
    }

    const key = `${event.ownerAgentId}:${localDateKey(bucketStart)}:${bucketStart.getHours()}:${bucketStart.getMinutes()}`;
    const group = groups.get(key) ?? { bucketStart, bucketEnd, events: [] };
    group.events.push(event);
    groups.set(key, group);
  }

  const displayItems: CalendarDisplayItem[] = [...singles];
  for (const group of groups.values()) {
    const sortedEvents = [...group.events].sort((a, b) => {
      const startDelta = new Date(a.startAt).getTime() - new Date(b.startAt).getTime();
      if (startDelta !== 0) return startDelta;
      return a.id.localeCompare(b.id);
    });

    if (sortedEvents.length < minClusterSize) {
      displayItems.push(...sortedEvents.map(toSingle));
      continue;
    }

    const firstEvent = sortedEvents[0]!;
    const minStart = Math.min(...sortedEvents.map((event) => new Date(event.startAt).getTime()));
    const maxEnd = Math.max(...sortedEvents.map((event) => new Date(event.endAt).getTime()));
    displayItems.push({
      kind: "cluster",
      id: `cluster:${firstEvent.ownerAgentId}:${group.bucketStart.toISOString()}`,
      agentId: firstEvent.ownerAgentId!,
      agentName: agentNameFor(firstEvent),
      startAt: new Date(Math.max(group.bucketStart.getTime(), minStart)),
      endAt: new Date(Math.min(group.bucketEnd.getTime(), maxEnd)),
      events: sortedEvents,
      statusCounts: statusCounts(sortedEvents),
    });
  }

  return displayItems.sort(compareDisplayItems);
}
