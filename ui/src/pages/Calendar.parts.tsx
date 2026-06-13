import { AgentIcon } from "@/components/AgentAvatar";
import { compactDenseTimedSegments } from "@/lib/calendar-collision-clusters";
import { timedEventSegmentsForDay, type TimedDaySegment } from "@/lib/calendar-day-segments";
import { buildCalendarDisplayItems, type CalendarDisplayCluster, type CalendarDisplayCollisionCluster, type CalendarDisplayItem } from "@/lib/calendar-display-items";
import { layoutTimedEvents } from "@/lib/calendar-event-layout";
import { Link } from "@/lib/router";
import { cn, formatTime } from "@/lib/utils";
import type { Agent, CalendarEvent, Issue } from "@rudderhq/shared";
import { useMemo, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";

export type CalendarView = "day" | "week" | "month" | "agenda";
export type DraftKind = "human_event" | "agent_work_block";
export type DragMode = "move" | "resize-start" | "resize-end";
export type CreatePreview = { startAt: Date; endAt: Date } | null;
export type SelectedDisplayCluster = CalendarDisplayCluster | CalendarDisplayCollisionCluster;

export const HOUR_HEIGHT = 52;
export const TIME_GUTTER_WIDTH = 56;
export const DAY_MIN_WIDTH = 180;
export const SNAP_MINUTES = 15;
export const MIN_EVENT_MINUTES = 15;
export const DAY_HOURS = Array.from({ length: 24 }, (_, hour) => hour);
export const AGENT_ACCENTS = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-cyan-500",
  "bg-violet-500",
] as const;
export const MONTH_AGENT_DOTS = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-cyan-500",
  "bg-violet-500",
] as const;
export const STATUS_DOTS: Record<CalendarEvent["eventStatus"], string> = {
  planned: "bg-zinc-500",
  in_progress: "bg-amber-500",
  actual: "bg-emerald-500",
  cancelled: "bg-rose-500",
  external: "bg-slate-500",
  projected: "bg-sky-500",
};

export function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

export function endOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

export function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function startOfWeek(date: Date) {
  const day = date.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  return startOfDay(addDays(date, diffToMonday));
}

export function startOfMonthGrid(date: Date) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const day = first.getDay();
  return startOfDay(addDays(first, day === 0 ? -6 : 1 - day));
}

export function dateKey(date: Date | string) {
  const value = new Date(date);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

export function sameDay(a: Date | string, b: Date | string) {
  return dateKey(a) === dateKey(b);
}

export function toInputDateTime(date: Date | string) {
  const value = new Date(date);
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function formatDayLabel(date: Date) {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(date);
}

export function formatWeekday(date: Date) {
  return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
}

export function formatMonthDay(date: Date) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
}

export function formatRangeTitle(view: CalendarView, cursor: Date) {
  if (view === "day") return formatDayLabel(cursor);
  if (view === "month") {
    return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(cursor);
  }
  const start = startOfWeek(cursor);
  const end = addDays(start, 6);
  return `${formatDayLabel(start)} - ${formatDayLabel(end)}`;
}

export function rangeForView(view: CalendarView, cursor: Date) {
  if (view === "day") return { start: startOfDay(cursor), end: endOfDay(cursor) };
  if (view === "month") {
    const start = startOfMonthGrid(cursor);
    return { start, end: endOfDay(addDays(start, 41)) };
  }
  const start = startOfWeek(cursor);
  return { start, end: endOfDay(addDays(start, 6)) };
}

export function moveCursor(view: CalendarView, cursor: Date, direction: -1 | 1) {
  if (view === "day") return addDays(cursor, direction);
  if (view === "month") return new Date(cursor.getFullYear(), cursor.getMonth() + direction, 1);
  return addDays(cursor, direction * 7);
}

export function minuteOfDay(date: Date | string) {
  const value = new Date(date);
  return value.getHours() * 60 + value.getMinutes();
}

export function durationMinutes(event: { startAt: Date | string; endAt: Date | string }) {
  return Math.max(MIN_EVENT_MINUTES, Math.round((new Date(event.endAt).getTime() - new Date(event.startAt).getTime()) / 60_000));
}

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function snapMinute(value: number) {
  return clamp(Math.round(value / SNAP_MINUTES) * SNAP_MINUTES, 0, 24 * 60);
}

export function dateAtMinutes(day: Date, minutes: number) {
  const next = startOfDay(day);
  next.setMinutes(minutes, 0, 0);
  return next;
}

export function statusLabel(status: string) {
  if (status === "in_progress") return "in progress";
  return status;
}

export function agentAccent(agentId: string | null | undefined, agents: Agent[]) {
  const index = agents.findIndex((agent) => agent.id === agentId);
  return AGENT_ACCENTS[Math.max(0, index) % AGENT_ACCENTS.length]!;
}

export function eventAccent(event: CalendarEvent, agents: Agent[]) {
  if (event.eventStatus === "projected") return "bg-sky-500";
  if (event.eventKind === "external_event") return "bg-slate-500";
  if (event.eventKind === "human_event") return "bg-zinc-500";
  return agentAccent(event.ownerAgentId, agents);
}

export function agentById(agentId: string | null | undefined, agents: Agent[]) {
  if (!agentId) return null;
  return agents.find((agent) => agent.id === agentId) ?? null;
}

export function eventAgent(event: CalendarEvent, agents: Agent[]) {
  return agentById(event.ownerAgentId, agents);
}

export function displayItemAccent(item: CalendarDisplayItem, agents: Agent[]) {
  if (item.kind === "cluster") return agentAccent(item.agentId, agents);
  if (item.kind === "collision_cluster") return "bg-slate-500";
  return eventAccent(item.event, agents);
}

export function primaryEvent(item: CalendarDisplayItem) {
  return item.kind === "single" ? item.event : item.events[0]!;
}

export function statusSummary(statusCounts: SelectedDisplayCluster["statusCounts"]) {
  return statusCounts.map(({ status, count }) => `${count} ${statusLabel(status)}`).join(" · ");
}

export function clusterActivityLabel(cluster: SelectedDisplayCluster) {
  return statusSummary(cluster.statusCounts) || `${cluster.events.length} events`;
}

export function collisionParticipantLabel(cluster: CalendarDisplayCollisionCluster) {
  if (cluster.agentIds.length === 0) return "calendar";
  if (cluster.agentIds.length === 1) return cluster.agentNames[0] ?? "1 agent";
  return `${cluster.agentIds.length} agents`;
}

export function clusterTitle(cluster: SelectedDisplayCluster) {
  if (cluster.kind === "collision_cluster") {
    return `${cluster.events.length} events · ${collisionParticipantLabel(cluster)}`;
  }
  return `${cluster.agentName} · ${clusterActivityLabel(cluster)}`;
}

export function clusterParticipantText(cluster: SelectedDisplayCluster) {
  if (cluster.kind === "cluster") return cluster.agentName;
  if (cluster.agentNames.length === 0) return "Calendar";
  const visibleNames = cluster.agentNames.slice(0, 4);
  const hiddenCount = Math.max(0, cluster.agentNames.length - visibleNames.length);
  return hiddenCount > 0 ? `${visibleNames.join(", ")} +${hiddenCount}` : visibleNames.join(", ");
}

export function formatShortTime(date: Date | string) {
  return formatTime(date);
}

export function formatTimeRange(startAt: Date | string, endAt: Date | string) {
  return `${formatShortTime(startAt)} - ${formatShortTime(endAt)}`;
}

export function displayItemTitle(item: CalendarDisplayItem) {
  return item.kind === "single" ? visibleEventTitle(item.event) : clusterTitle(item);
}

export function displayItemSubtitle(item: CalendarDisplayItem, displayStartAt?: Date | string) {
  if (item.kind === "cluster") {
    return item.statusCounts.length === 1 ? formatTimeRange(item.startAt, item.endAt) : statusSummary(item.statusCounts);
  }
  if (item.kind === "collision_cluster") {
    const summary = statusSummary(item.statusCounts);
    return summary ? `${formatTimeRange(item.startAt, item.endAt)} · ${summary}` : formatTimeRange(item.startAt, item.endAt);
  }
  return `${statusLabel(item.event.eventStatus)} · ${formatShortTime(displayStartAt ?? item.event.startAt)}`;
}

export function monthEventDot(event: CalendarEvent, agents: Agent[]) {
  if (event.eventStatus === "projected") return "bg-sky-500";
  if (event.eventKind === "external_event") return "bg-slate-500";
  if (event.eventKind === "human_event") return "bg-zinc-500";
  const index = agents.findIndex((agent) => agent.id === event.ownerAgentId);
  return MONTH_AGENT_DOTS[Math.max(0, index) % MONTH_AGENT_DOTS.length]!;
}

export function CalendarAgentMarker({
  agent,
  fallbackClassName,
  compact = false,
  className,
}: {
  agent: Agent | null;
  fallbackClassName?: string;
  compact?: boolean;
  className?: string;
}) {
  if (!agent) {
    return (
      <span
        className={cn(
          compact ? "h-1.5 w-1.5" : "h-2 w-2",
          "shrink-0 rounded-full",
          fallbackClassName ?? "bg-slate-500",
          className,
        )}
      />
    );
  }

  return (
    <span
      data-testid={`calendar-agent-marker-${agent.id}`}
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted ring-1 ring-border/80",
        compact ? "h-3.5 w-3.5" : "h-4 w-4",
        className,
      )}
      title={agent.name}
    >
      <AgentIcon icon={agent.icon} role={agent.role} className="h-full w-full" />
    </span>
  );
}

export function CalendarAgentStack({
  agentIds,
  agents,
  max = 5,
  compact = false,
}: {
  agentIds: string[];
  agents: Agent[];
  max?: number;
  compact?: boolean;
}) {
  const visibleAgents = agentIds
    .slice(0, max)
    .map((agentId) => agentById(agentId, agents));

  if (visibleAgents.length === 0) {
    return <CalendarAgentMarker agent={null} fallbackClassName="bg-slate-500" compact={compact} />;
  }

  return (
    <span className={cn("flex shrink-0 items-center", compact ? "-space-x-1" : "-space-x-1.5")}>
      {visibleAgents.map((agent, index) => (
        <CalendarAgentMarker
          key={agent?.id ?? `${agentIds[index]}-${index}`}
          agent={agent}
          fallbackClassName={agent ? undefined : agentAccent(agentIds[index], agents)}
          compact={compact}
          className="ring-background"
        />
      ))}
    </span>
  );
}

export function CalendarEventMarker({
  event,
  agents,
  compact = false,
}: {
  event: CalendarEvent;
  agents: Agent[];
  compact?: boolean;
}) {
  const agent = eventAgent(event, agents);
  if (agent) {
    return <CalendarAgentMarker agent={agent} compact={compact} />;
  }
  return <CalendarAgentMarker agent={null} fallbackClassName={monthEventDot(event, agents)} compact={compact} />;
}

export function eventIntersectsDay(event: CalendarEvent, day: Date) {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = addDays(startOfDay(day), 1).getTime();
  const eventStart = new Date(event.startAt).getTime();
  const eventEnd = new Date(event.endAt).getTime();
  return eventStart < dayEnd && eventEnd > dayStart;
}

export function formatMonthEventTime(event: CalendarEvent, day: Date) {
  const eventStart = new Date(event.startAt);
  if (event.allDay) return "All day";
  if (eventStart < startOfDay(day)) return "00:00";
  return formatTime(eventStart);
}

export function isWritableEvent(event: CalendarEvent | null) {
  return !!event && event.eventKind === "human_event" && event.sourceMode === "manual";
}

export function visibleEventTitle(event: CalendarEvent) {
  if (event.eventKind === "external_event" && event.visibility !== "full") return "Busy";
  if (event.visibility === "private") return "Private";
  return event.title;
}

export function defaultDraftStart() {
  const now = new Date();
  now.setMinutes(now.getMinutes() < 30 ? 30 : 60, 0, 0);
  return now;
}

export function newDraft(kind: DraftKind = "human_event") {
  const start = defaultDraftStart();
  const end = new Date(start.getTime() + 60 * 60_000);
  return {
    kind,
    title: "",
    description: "",
    agentId: "",
    issueId: "",
    startAt: toInputDateTime(start),
    endAt: toInputDateTime(end),
  };
}

export function CalendarDetailLink({
  to,
  children,
  ariaLabel,
}: {
  to: string;
  children: ReactNode;
  ariaLabel: string;
}) {
  return (
    <Link
      to={to}
      aria-label={ariaLabel}
      className="inline-flex max-w-full items-center rounded-[calc(var(--radius-sm)-2px)] font-medium leading-5 text-blue-700 underline-offset-2 hover:text-blue-800 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring dark:text-blue-300 dark:hover:text-blue-200"
    >
      <span className="min-w-0 truncate">{children}</span>
    </Link>
  );
}

export function CalendarDetailRow({
  label,
  children,
  valueClassName,
}: {
  label: string;
  children: ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] items-baseline gap-x-3 sm:grid-cols-[112px_minmax(0,1fr)]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 leading-5", valueClassName)}>{children}</dd>
    </div>
  );
}

export function buildEventPayload(draft: ReturnType<typeof newDraft>, agents: Agent[], issues: Issue[]) {
  const linkedAgent = agents.find((agent) => agent.id === draft.agentId);
  const linkedIssue = issues.find((issue) => issue.id === draft.issueId);
  const title = draft.title.trim()
    || (draft.kind === "agent_work_block" && linkedAgent && linkedIssue
      ? `${linkedAgent.name} · ${linkedIssue.title}`
      : draft.kind === "agent_work_block" && linkedAgent
        ? `${linkedAgent.name} · Planned work`
        : "Untitled event");
  return {
    eventKind: draft.kind,
    eventStatus: "planned",
    ownerType: draft.kind === "agent_work_block" ? "agent" : "user",
    ownerAgentId: draft.kind === "agent_work_block" ? draft.agentId || null : null,
    title,
    description: draft.description.trim() || null,
    startAt: new Date(draft.startAt).toISOString(),
    endAt: new Date(draft.endAt).toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    allDay: false,
    visibility: "full",
    issueId: draft.kind === "agent_work_block" ? draft.issueId || null : null,
    sourceMode: "manual",
  };
}

export function EventBlock({
  item,
  agents,
  onSelect,
  onPointerStart,
  onPointerMove,
  onPointerEnd,
  displayStartAt,
  continuation,
  testId,
  compact = false,
}: {
  item: CalendarDisplayItem;
  agents: Agent[];
  onSelect: (item: CalendarDisplayItem) => void;
  onPointerStart?: (event: ReactPointerEvent<HTMLDivElement>, mode: DragMode) => void;
  onPointerMove?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerEnd?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  displayStartAt?: Date | string;
  continuation?: Pick<TimedDaySegment<CalendarDisplayItem>, "startsBeforeDay" | "endsAfterDay">;
  testId?: string;
  compact?: boolean;
}) {
  const event = primaryEvent(item);
  const writable = item.kind === "single" && isWritableEvent(event);
  return (
    <div
      role="button"
      tabIndex={0}
      data-calendar-event="true"
      data-testid={testId ?? (
        item.kind === "collision_cluster"
          ? `calendar-collision-cluster-${item.id}`
          : item.kind === "cluster"
            ? `calendar-cluster-${item.id}`
            : `calendar-event-${event.id}`
      )}
      aria-label={displayItemTitle(item)}
      onClick={() => onSelect(item)}
      onPointerDown={writable && onPointerStart ? (pointerEvent) => onPointerStart(pointerEvent, "move") : undefined}
      onPointerMove={writable ? onPointerMove : undefined}
      onPointerUp={writable ? onPointerEnd : undefined}
      onPointerCancel={writable ? onPointerEnd : undefined}
      onKeyDown={(keyboardEvent) => {
        if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
          keyboardEvent.preventDefault();
          onSelect(item);
        }
      }}
      className={cn(
        "group relative h-full w-full min-w-0 select-none overflow-hidden rounded-[calc(var(--radius-sm)-1px)] border border-border/80 bg-background px-2 py-1 pl-3 text-left text-foreground shadow-[0_10px_18px_-18px_rgba(15,23,42,0.45)] transition hover:bg-muted/35",
        item.kind !== "single" && "border-border bg-card hover:bg-card",
        item.kind === "single" && event.eventStatus === "projected" && "border-dashed",
        continuation?.startsBeforeDay && "rounded-t-none border-t-0",
        continuation?.endsAfterDay && "rounded-b-none border-b-0",
        writable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
        compact ? "text-[11px]" : "text-xs",
      )}
    >
      {item.kind === "collision_cluster" ? (
        <span className="absolute inset-y-0 left-0 flex w-1 flex-col overflow-hidden rounded-l-[calc(var(--radius-sm)-1px)]">
          {(item.agentIds.length ? item.agentIds.slice(0, 5) : [null]).map((agentId, index) => (
            <span
              key={agentId ?? `calendar-${index}`}
              className={cn("min-h-1 flex-1", agentId ? agentAccent(agentId, agents) : "bg-slate-500")}
            />
          ))}
        </span>
      ) : (
        <span className={cn("absolute inset-y-0 left-0 w-1", displayItemAccent(item, agents))} />
      )}
      {writable && onPointerStart ? (
        <div
          data-testid={`calendar-event-resize-start-${event.id}`}
          className="absolute inset-x-2 top-0 z-10 h-2 cursor-ns-resize rounded-full opacity-0 transition group-hover:opacity-100"
          onPointerDown={(pointerEvent) => {
            pointerEvent.stopPropagation();
            onPointerStart(pointerEvent, "resize-start");
          }}
        />
      ) : null}
      <div className="flex min-w-0 items-center gap-1.5 truncate font-medium">
        {item.kind === "collision_cluster" ? (
          <CalendarAgentStack agentIds={item.agentIds} agents={agents} compact={compact} />
        ) : item.kind === "cluster" ? (
          <CalendarAgentMarker agent={agentById(item.agentId, agents)} compact={compact} />
        ) : (
          <CalendarEventMarker event={event} agents={agents} compact={compact} />
        )}
        <span className="min-w-0 flex-1 truncate">{displayItemTitle(item)}</span>
      </div>
      <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
        {displayItemSubtitle(item, displayStartAt)}
      </div>
      {writable && onPointerStart ? (
        <div
          data-testid={`calendar-event-resize-end-${event.id}`}
          className="absolute inset-x-2 bottom-0 z-10 h-2 cursor-ns-resize rounded-full opacity-0 transition group-hover:opacity-100"
          onPointerDown={(pointerEvent) => {
            pointerEvent.stopPropagation();
            onPointerStart(pointerEvent, "resize-end");
          }}
        />
      ) : null}
    </div>
  );
}

export function CalendarGridView({
  view,
  days,
  events,
  agents,
  currentTime,
  onSelect,
  onCreateSelection,
  onUpdateEventTime,
  createPreview,
}: {
  view: "day" | "week";
  days: Date[];
  events: CalendarEvent[];
  agents: Agent[];
  currentTime: Date;
  onSelect: (item: CalendarDisplayItem) => void;
  onCreateSelection: (startAt: Date, endAt: Date, anchor: { x: number; y: number }) => void;
  onUpdateEventTime: (event: CalendarEvent, startAt: Date, endAt: Date) => void;
  createPreview?: CreatePreview;
}) {
  const gridTemplate = `${TIME_GUTTER_WIDTH}px repeat(${days.length}, minmax(${DAY_MIN_WIDTH}px, 1fr))`;
  const minGridWidth = TIME_GUTTER_WIDTH + days.length * DAY_MIN_WIDTH;
  const [selection, setSelection] = useState<null | {
    dayKey: string;
    startMinute: number;
    endMinute: number;
    startY: number;
    moved: boolean;
  }>(null);
  const [eventDrag, setEventDrag] = useState<null | {
    event: CalendarEvent;
    mode: DragMode;
    startClientX: number;
    startClientY: number;
    pointerOffsetMinutes: number;
    duration: number;
    originalDayIndex: number;
    previewStartAt: Date;
    previewEndAt: Date;
    moved: boolean;
  }>(null);
  const suppressClickEventId = useRef<string | null>(null);

  function pointToMinute(grid: HTMLElement, clientY: number) {
    const rect = grid.getBoundingClientRect();
    return snapMinute(((clientY - rect.top) / HOUR_HEIGHT) * 60);
  }

  function pointToDayIndex(grid: HTMLElement, clientX: number) {
    const rect = grid.getBoundingClientRect();
    const dayWidth = (rect.width - TIME_GUTTER_WIDTH) / days.length;
    return clamp(Math.floor((clientX - rect.left - TIME_GUTTER_WIDTH) / dayWidth), 0, days.length - 1);
  }

  function beginSelection(pointerEvent: ReactPointerEvent<HTMLDivElement>, day: Date) {
    if (pointerEvent.button !== 0) return;
    if ((pointerEvent.target as HTMLElement).closest("[data-calendar-event]")) return;
    const column = pointerEvent.currentTarget;
    column.setPointerCapture(pointerEvent.pointerId);
    const rect = column.getBoundingClientRect();
    const minute = snapMinute(((pointerEvent.clientY - rect.top) / HOUR_HEIGHT) * 60);
    setSelection({
      dayKey: dateKey(day),
      startMinute: minute,
      endMinute: Math.min(24 * 60, minute + MIN_EVENT_MINUTES),
      startY: pointerEvent.clientY,
      moved: false,
    });
  }

  function moveSelection(pointerEvent: ReactPointerEvent<HTMLDivElement>, day: Date) {
    if (!selection || selection.dayKey !== dateKey(day)) return;
    const rect = pointerEvent.currentTarget.getBoundingClientRect();
    const minute = snapMinute(((pointerEvent.clientY - rect.top) / HOUR_HEIGHT) * 60);
    setSelection((current) => current
      ? {
        ...current,
        endMinute: minute,
        moved: current.moved || Math.abs(pointerEvent.clientY - current.startY) > 8,
      }
      : current);
  }

  function endSelection(pointerEvent: ReactPointerEvent<HTMLDivElement>, day: Date) {
    if (!selection || selection.dayKey !== dateKey(day)) return;
    pointerEvent.currentTarget.releasePointerCapture(pointerEvent.pointerId);
    const startMinute = Math.min(selection.startMinute, selection.endMinute);
    let endMinute = Math.max(selection.startMinute, selection.endMinute);
    if (endMinute - startMinute < MIN_EVENT_MINUTES) endMinute = startMinute + MIN_EVENT_MINUTES;
    if (selection.moved) {
      onCreateSelection(
        dateAtMinutes(day, startMinute),
        dateAtMinutes(day, Math.min(24 * 60, endMinute)),
        { x: pointerEvent.clientX, y: pointerEvent.clientY },
      );
    }
    setSelection(null);
  }

  function beginEventDrag(pointerEvent: ReactPointerEvent<HTMLDivElement>, event: CalendarEvent, mode: DragMode) {
    if (!isWritableEvent(event) || pointerEvent.button !== 0) return;
    pointerEvent.preventDefault();
    pointerEvent.stopPropagation();
    const root = (pointerEvent.currentTarget as HTMLElement).closest("[data-calendar-event]") as HTMLElement | null;
    root?.setPointerCapture(pointerEvent.pointerId);
    const grid = root?.closest("[data-calendar-grid-body]") as HTMLElement | null;
    const originalDayIndex = days.findIndex((day) => sameDay(day, event.startAt));
    const pointerMinute = grid ? pointToMinute(grid, pointerEvent.clientY) : minuteOfDay(event.startAt);
    setEventDrag({
      event,
      mode,
      startClientX: pointerEvent.clientX,
      startClientY: pointerEvent.clientY,
      pointerOffsetMinutes: minuteOfDay(event.startAt) - pointerMinute,
      duration: durationMinutes(event),
      originalDayIndex: Math.max(0, originalDayIndex),
      previewStartAt: new Date(event.startAt),
      previewEndAt: new Date(event.endAt),
      moved: false,
    });
  }

  function moveEventDrag(pointerEvent: ReactPointerEvent<HTMLDivElement>) {
    if (!eventDrag) return;
    const grid = (pointerEvent.currentTarget.closest("[data-calendar-grid-body]") as HTMLElement | null);
    if (!grid) return;
    const distance = Math.hypot(pointerEvent.clientX - eventDrag.startClientX, pointerEvent.clientY - eventDrag.startClientY);
    const dayIndex = eventDrag.mode === "move" ? pointToDayIndex(grid, pointerEvent.clientX) : eventDrag.originalDayIndex;
    const pointerMinute = pointToMinute(grid, pointerEvent.clientY);
    const originalStartMinute = minuteOfDay(eventDrag.event.startAt);
    const originalEndMinute = Math.min(24 * 60, originalStartMinute + eventDrag.duration);
    let startMinute = originalStartMinute;
    let endMinute = originalEndMinute;

    if (eventDrag.mode === "move") {
      startMinute = clamp(snapMinute(pointerMinute + eventDrag.pointerOffsetMinutes), 0, 24 * 60 - eventDrag.duration);
      endMinute = startMinute + eventDrag.duration;
    } else if (eventDrag.mode === "resize-start") {
      startMinute = clamp(pointerMinute, 0, originalEndMinute - MIN_EVENT_MINUTES);
      endMinute = originalEndMinute;
    } else {
      startMinute = originalStartMinute;
      endMinute = clamp(pointerMinute, originalStartMinute + MIN_EVENT_MINUTES, 24 * 60);
    }

    const previewStartAt = dateAtMinutes(days[dayIndex]!, startMinute);
    const previewEndAt = dateAtMinutes(days[dayIndex]!, endMinute);
    setEventDrag((current) => current
      ? {
        ...current,
        previewStartAt,
        previewEndAt,
        moved: current.moved || distance > 4,
      }
      : current);
  }

  function endEventDrag(pointerEvent: ReactPointerEvent<HTMLDivElement>) {
    if (!eventDrag) return;
    const root = (pointerEvent.currentTarget as HTMLElement).closest("[data-calendar-event]") as HTMLElement | null;
    if (root?.hasPointerCapture(pointerEvent.pointerId)) root.releasePointerCapture(pointerEvent.pointerId);
    const didMove = eventDrag.moved || Math.hypot(pointerEvent.clientX - eventDrag.startClientX, pointerEvent.clientY - eventDrag.startClientY) > 4;
    if (didMove) {
      suppressClickEventId.current = eventDrag.event.id;
      onUpdateEventTime(eventDrag.event, eventDrag.previewStartAt, eventDrag.previewEndAt);
    }
    setEventDrag(null);
  }

  function selectDisplayItem(item: CalendarDisplayItem) {
    if (item.kind === "single" && suppressClickEventId.current === item.event.id) {
      suppressClickEventId.current = null;
      return;
    }
    onSelect(item);
  }

  const displayEvents = eventDrag
    ? events.map((event) => event.id === eventDrag.event.id
      ? { ...event, startAt: eventDrag.previewStartAt, endAt: eventDrag.previewEndAt }
      : event)
    : events;
  const displayItems = useMemo(
    () => buildCalendarDisplayItems(displayEvents, { groupAgentActivity: view === "week" }),
    [displayEvents, view],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-sm)] border border-border bg-card">
      <div className="min-h-0 flex-1 overflow-auto" data-testid="calendar-grid-scroll">
        <div className="min-w-full" style={{ minWidth: minGridWidth }}>
          <div className="sticky top-0 z-20 grid border-b border-border bg-card/95 backdrop-blur" style={{ gridTemplateColumns: gridTemplate }}>
            <div className="border-r border-border bg-muted/20" />
            {days.map((day) => {
              const today = sameDay(day, currentTime);
              return (
                <div
                  key={day.toISOString()}
                  data-testid={`calendar-day-header-${dateKey(day)}`}
                  className={cn("border-r border-border px-3 py-2 last:border-r-0", today && "bg-primary/6")}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-medium uppercase text-muted-foreground">{formatWeekday(day)}</span>
                    <span
                      className={cn(
                        "flex h-7 min-w-7 items-center justify-center rounded-full px-2 text-sm font-semibold",
                        today ? "bg-primary text-primary-foreground shadow-sm" : "text-foreground",
                      )}
                    >
                      {day.getDate()}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">{formatMonthDay(day)}</div>
                </div>
              );
            })}
          </div>
          <div
            data-calendar-grid-body="true"
            data-testid="calendar-grid-body"
            className="grid"
            style={{ gridTemplateColumns: gridTemplate, minHeight: HOUR_HEIGHT * 24 }}
          >
            <div className="relative border-r border-border bg-muted/20">
              {DAY_HOURS.map((hour) => (
                <div
                  key={hour}
                  className="absolute left-0 right-0 border-t border-border/70 px-2 pt-0.5 text-[10px] text-muted-foreground"
                  style={{ top: hour * HOUR_HEIGHT }}
                >
                  {`${String(hour).padStart(2, "0")}:00`}
                </div>
              ))}
            </div>
            {days.map((day) => {
              const daySegments = timedEventSegmentsForDay(displayItems, day);
              const compactedSegments = compactDenseTimedSegments(daySegments, { enabled: view === "week" });
              const laidOutEvents = layoutTimedEvents(compactedSegments);
              const today = sameDay(day, currentTime);
              const todayLineTop = (minuteOfDay(currentTime) / 60) * HOUR_HEIGHT;
              const previewSelection = createPreview && sameDay(createPreview.startAt, day)
                ? {
                  dayKey: dateKey(day),
                  startMinute: minuteOfDay(createPreview.startAt),
                  endMinute: minuteOfDay(createPreview.endAt),
                  startY: 0,
                  moved: true,
                }
                : null;
              const activeSelection = selection?.dayKey === dateKey(day) ? selection : previewSelection;
              const selectionTop = activeSelection
                ? (Math.min(activeSelection.startMinute, activeSelection.endMinute) / 60) * HOUR_HEIGHT
                : 0;
              const selectionHeight = activeSelection
                ? Math.max(18, (Math.abs(activeSelection.endMinute - activeSelection.startMinute) / 60) * HOUR_HEIGHT)
                : 0;
              return (
                <div
                  key={day.toISOString()}
                  data-testid={`calendar-day-column-${dateKey(day)}`}
                  className="relative border-r border-border last:border-r-0"
                  onPointerDown={(pointerEvent) => beginSelection(pointerEvent, day)}
                  onPointerMove={(pointerEvent) => moveSelection(pointerEvent, day)}
                  onPointerUp={(pointerEvent) => endSelection(pointerEvent, day)}
                  onPointerCancel={() => setSelection(null)}
                >
                  {DAY_HOURS.map((hour) => (
                    <div
                      key={hour}
                      className="absolute left-0 right-0 border-t border-border/60"
                      style={{ top: hour * HOUR_HEIGHT }}
                    />
                  ))}
                  {today ? (
                    <div className="pointer-events-none absolute left-0 right-0 z-10 flex items-center" style={{ top: todayLineTop }}>
                      <span className="-ml-1 h-2 w-2 rounded-full bg-primary" />
                      <span className="h-px flex-1 bg-primary" />
                    </div>
                  ) : null}
                  {activeSelection ? (
                    <div
                      data-testid={`calendar-create-preview-${dateKey(day)}`}
                      className="pointer-events-none absolute left-2 right-2 z-20 rounded-[var(--radius-sm)] border border-primary/60 bg-primary/12"
                      style={{ top: selectionTop, height: selectionHeight }}
                    />
                  ) : null}
                  {laidOutEvents.map(({ event: segment, leftPct, widthPct }) => {
                    const item = segment.event;
                    const event = primaryEvent(item);
                    const top = Math.max(0, (minuteOfDay(segment.startAt) / 60) * HOUR_HEIGHT);
                    const height = Math.max(28, (durationMinutes(segment) / 60) * HOUR_HEIGHT);
                    return (
                      <div
                        key={segment.id}
                        className="absolute px-0.5"
                        style={{
                          top,
                          height,
                          left: `calc(${leftPct}% + 4px)`,
                          width: `calc(${widthPct}% - 8px)`,
                        }}
                      >
                        <EventBlock
                          item={item}
                          agents={agents}
                          onSelect={selectDisplayItem}
                          displayStartAt={segment.startAt}
                          continuation={segment}
                          testId={segment.startsBeforeDay ? (
                            item.kind === "collision_cluster"
                              ? `calendar-collision-cluster-${segment.id}`
                              : item.kind === "cluster"
                                ? `calendar-cluster-${segment.id}`
                                : `calendar-event-${segment.id}`
                          ) : undefined}
                          compact={view === "week"}
                          onPointerStart={item.kind === "single" ? (pointerEvent, mode) => beginEventDrag(pointerEvent, event, mode) : undefined}
                          onPointerMove={moveEventDrag}
                          onPointerEnd={endEventDrag}
                        />
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {eventDrag ? (
        <div className="border-t border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {eventDrag.previewStartAt.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}
          {" - "}
          {eventDrag.previewEndAt.toLocaleString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}
        </div>
      ) : null}
    </div>
  );
}

export function MonthView({
  cursor,
  events,
  agents,
  currentTime,
  onSelect,
}: {
  cursor: Date;
  events: CalendarEvent[];
  agents: Agent[];
  currentTime: Date;
  onSelect: (event: CalendarEvent) => void;
}) {
  const start = startOfMonthGrid(cursor);
  const days = Array.from({ length: 42 }, (_, index) => addDays(start, index));
  return (
    <div
      className="grid min-h-0 flex-1 grid-cols-7 overflow-hidden rounded-[var(--radius-sm)] border border-border bg-card"
      style={{ gridTemplateRows: "32px repeat(6, minmax(0, 1fr))" }}
    >
      {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => (
        <div key={label} className="border-b border-r border-border bg-muted/30 px-2 py-2 text-xs font-medium last:border-r-0">
          {label}
        </div>
      ))}
      {days.map((day) => {
        const dayEvents = events
          .filter((event) => eventIntersectsDay(event, day))
          .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
        const visibleEvents = dayEvents.slice(0, 5);
        const hiddenCount = Math.max(0, dayEvents.length - visibleEvents.length);
        const outside = day.getMonth() !== cursor.getMonth();
        const today = sameDay(day, currentTime);
        return (
          <div
            key={day.toISOString()}
            className={cn(
              "min-h-0 overflow-hidden border-b border-r border-border p-1.5 last:border-r-0",
              outside && "bg-muted/20 text-muted-foreground",
              today && "bg-primary/6",
            )}
          >
            <div className={cn("mb-1 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold", today && "bg-primary text-primary-foreground")}>
              {day.getDate()}
            </div>
            <div className="space-y-0.5">
              {visibleEvents.map((event) => (
                <button
                  key={`${day.toISOString()}-${event.id}`}
                  type="button"
                  className={cn(
                    "flex h-5 w-full min-w-0 items-center gap-1 rounded-[calc(var(--radius-sm)-2px)] px-1 text-left text-[11px] leading-none text-foreground/88 hover:bg-muted/45",
                    event.eventStatus === "projected" && "border border-dashed border-sky-300/70 text-muted-foreground",
                  )}
                  onClick={() => onSelect(event)}
                >
                  <CalendarEventMarker event={event} agents={agents} compact />
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                    {formatMonthEventTime(event, day)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{visibleEventTitle(event)}</span>
                </button>
              ))}
              {hiddenCount > 0 ? (
                <div className="flex h-5 w-full items-center rounded-[calc(var(--radius-sm)-2px)] px-1 text-[11px] font-medium text-muted-foreground">
                  {hiddenCount} more
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function AgendaView({
  events,
  agents,
  onSelect,
}: {
  events: CalendarEvent[];
  agents: Agent[];
  onSelect: (event: CalendarEvent) => void;
}) {
  const grouped = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const key = dateKey(event.startAt);
    grouped.set(key, [...(grouped.get(key) ?? []), event]);
  }
  const entries = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-[var(--radius-sm)] border border-border bg-card">
      {entries.length === 0 ? (
        <div className="p-8 text-sm text-muted-foreground">No calendar blocks in this range.</div>
      ) : entries.map(([key, items]) => (
        <section key={key} className="border-b border-border last:border-b-0">
          <div className="bg-muted/30 px-4 py-2 text-xs font-medium">{formatDayLabel(new Date(`${key}T00:00:00`))}</div>
          <div className="divide-y divide-border">
            {items.map((event) => (
              <button
                key={event.id}
                type="button"
                className="grid w-full grid-cols-[112px_minmax(0,1fr)_120px] items-center gap-3 px-4 py-3 text-left text-sm hover:bg-muted/30"
                onClick={() => onSelect(event)}
              >
                <span className="text-xs text-muted-foreground">
                  {formatTime(event.startAt)}
                </span>
                <span className="flex min-w-0 items-center gap-2">
                  <CalendarEventMarker event={event} agents={agents} />
                  <span className="min-w-0 flex-1 truncate font-medium">{visibleEventTitle(event)}</span>
                </span>
                <span className="justify-self-end rounded-[calc(var(--radius-sm)-2px)] border border-border px-2 py-1 text-xs text-muted-foreground">
                  {statusLabel(event.eventStatus)}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

