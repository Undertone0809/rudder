import type { CalendarEvent } from "@rudderhq/shared";
import type { TimedDaySegment } from "./calendar-day-segments";
import { layoutTimedEvents } from "./calendar-event-layout";
import {
  calendarAgentNameFor,
  calendarDisplayItemEvents,
  calendarStatusCounts,
  type CalendarDisplayCollisionCluster,
  type CalendarDisplayItem,
} from "./calendar-display-items";

type CompactDenseTimedSegmentsOptions = {
  enabled?: boolean;
  minColumns?: number;
  minEvents?: number;
  unreadableMinColumns?: number;
  unreadableMinEvents?: number;
};

function eventStart(segment: TimedDaySegment<CalendarDisplayItem>) {
  return segment.startAt.getTime();
}

function eventEnd(segment: TimedDaySegment<CalendarDisplayItem>) {
  return segment.endAt.getTime();
}

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function uniqueBy<T>(items: T[], keyFor: (item: T) => string | null | undefined) {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyFor(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function uniqueAgentIds(events: CalendarEvent[]) {
  return uniqueBy(events, (event) => event.ownerAgentId).map((event) => event.ownerAgentId!);
}

function uniqueAgentNames(events: CalendarEvent[]) {
  return uniqueBy(events.filter((event) => event.ownerAgentId), (event) => event.ownerAgentId)
    .map(calendarAgentNameFor);
}

function denseClusterFor(group: TimedDaySegment<CalendarDisplayItem>[]): TimedDaySegment<CalendarDisplayItem> {
  const startAt = new Date(Math.min(...group.map((segment) => segment.startAt.getTime())));
  const endAt = new Date(Math.max(...group.map((segment) => segment.endAt.getTime())));
  const items = group.map((segment) => segment.event);
  const events = items.flatMap(calendarDisplayItemEvents).sort((a, b) => {
    const startDelta = new Date(a.startAt).getTime() - new Date(b.startAt).getTime();
    if (startDelta !== 0) return startDelta;
    return a.id.localeCompare(b.id);
  });
  const cluster: CalendarDisplayCollisionCluster = {
    kind: "collision_cluster",
    id: `collision:${localDateKey(startAt)}:${startAt.toISOString()}:${group.map((segment) => segment.id).join("|")}`,
    startAt,
    endAt,
    items,
    events,
    agentIds: uniqueAgentIds(events),
    agentNames: uniqueAgentNames(events),
    statusCounts: calendarStatusCounts(events),
  };

  return {
    id: `${cluster.id}:${localDateKey(startAt)}`,
    event: cluster,
    startAt,
    endAt,
    startsBeforeDay: group.some((segment) => segment.startsBeforeDay),
    endsAfterDay: group.some((segment) => segment.endsAfterDay),
  };
}

function shouldCompactGroup(
  group: TimedDaySegment<CalendarDisplayItem>[],
  minColumns: number,
  minEvents: number,
  unreadableMinColumns: number,
  unreadableMinEvents: number,
) {
  const events = group.flatMap((segment) => calendarDisplayItemEvents(segment.event));
  const allDirectlyWritableHuman = events.every((event) => event.eventKind === "human_event" && event.sourceMode === "manual");
  const layout = layoutTimedEvents(group);
  const maxColumns = Math.max(1, ...layout.map((item) => item.columns));
  if (!allDirectlyWritableHuman && events.length >= unreadableMinEvents && maxColumns >= unreadableMinColumns) return true;
  if (events.length < minEvents) return false;
  return maxColumns >= minColumns;
}

export function compactDenseTimedSegments(
  segments: TimedDaySegment<CalendarDisplayItem>[],
  options: CompactDenseTimedSegmentsOptions = {},
): TimedDaySegment<CalendarDisplayItem>[] {
  const enabled = options.enabled ?? true;
  if (!enabled || segments.length === 0) return segments;

  const minColumns = options.minColumns ?? 4;
  const minEvents = options.minEvents ?? 4;
  const unreadableMinColumns = options.unreadableMinColumns ?? 3;
  const unreadableMinEvents = options.unreadableMinEvents ?? 3;
  const sorted = [...segments].sort((a, b) => {
    const startDelta = eventStart(a) - eventStart(b);
    if (startDelta !== 0) return startDelta;
    const endDelta = eventEnd(a) - eventEnd(b);
    if (endDelta !== 0) return endDelta;
    return a.id.localeCompare(b.id);
  });

  const compacted: TimedDaySegment<CalendarDisplayItem>[] = [];
  let group: TimedDaySegment<CalendarDisplayItem>[] = [];
  let groupEnd = Number.NEGATIVE_INFINITY;

  function flushGroup() {
    if (group.length === 0) return;
    if (shouldCompactGroup(group, minColumns, minEvents, unreadableMinColumns, unreadableMinEvents)) {
      compacted.push(denseClusterFor(group));
    } else {
      compacted.push(...group);
    }
    group = [];
    groupEnd = Number.NEGATIVE_INFINITY;
  }

  for (const segment of sorted) {
    const start = eventStart(segment);
    const end = eventEnd(segment);
    if (group.length > 0 && start >= groupEnd) {
      flushGroup();
    }
    group.push(segment);
    groupEnd = Math.max(groupEnd, end);
  }
  flushGroup();

  return compacted.sort((a, b) => {
    const startDelta = eventStart(a) - eventStart(b);
    if (startDelta !== 0) return startDelta;
    const endDelta = eventEnd(a) - eventEnd(b);
    if (endDelta !== 0) return endDelta;
    return a.id.localeCompare(b.id);
  });
}
