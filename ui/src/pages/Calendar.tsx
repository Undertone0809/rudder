import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent, CalendarEvent, CalendarEventStatus, CalendarSource, Issue } from "@rudderhq/shared";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Bot,
  CalendarDays,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Trash2,
  User,
  X,
} from "lucide-react";
import { Link } from "@/lib/router";
import { agentsApi } from "@/api/agents";
import { calendarApi } from "@/api/calendar";
import { issuesApi } from "@/api/issues";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { useViewedOrganization } from "@/hooks/useViewedOrganization";
import { agentUrl, cn, formatDateTime, issueUrl } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";

type CalendarView = "day" | "week" | "month" | "agenda";
type DraftKind = "human_event" | "agent_work_block";
type DragMode = "move" | "resize-start" | "resize-end";

const HOUR_HEIGHT = 52;
const TIME_GUTTER_WIDTH = 56;
const DAY_MIN_WIDTH = 180;
const SNAP_MINUTES = 15;
const MIN_EVENT_MINUTES = 15;
const DAY_HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const EVENT_STATUS_OPTIONS: CalendarEventStatus[] = ["planned", "in_progress", "actual", "external", "projected", "cancelled"];
const AGENT_COLORS = [
  "border-blue-400 bg-blue-50 text-blue-950 dark:border-blue-500/60 dark:bg-blue-500/16 dark:text-blue-100",
  "border-emerald-400 bg-emerald-50 text-emerald-950 dark:border-emerald-500/60 dark:bg-emerald-500/16 dark:text-emerald-100",
  "border-amber-400 bg-amber-50 text-amber-950 dark:border-amber-500/60 dark:bg-amber-500/16 dark:text-amber-100",
  "border-rose-400 bg-rose-50 text-rose-950 dark:border-rose-500/60 dark:bg-rose-500/16 dark:text-rose-100",
  "border-cyan-400 bg-cyan-50 text-cyan-950 dark:border-cyan-500/60 dark:bg-cyan-500/16 dark:text-cyan-100",
  "border-violet-400 bg-violet-50 text-violet-950 dark:border-violet-500/60 dark:bg-violet-500/16 dark:text-violet-100",
];
const AGENT_SWATCHES = [
  "border-blue-400 bg-blue-500",
  "border-emerald-400 bg-emerald-500",
  "border-amber-400 bg-amber-500",
  "border-rose-400 bg-rose-500",
  "border-cyan-400 bg-cyan-500",
  "border-violet-400 bg-violet-500",
];

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function endOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfWeek(date: Date) {
  const day = date.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  return startOfDay(addDays(date, diffToMonday));
}

function startOfMonthGrid(date: Date) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const day = first.getDay();
  return startOfDay(addDays(first, day === 0 ? -6 : 1 - day));
}

function dateKey(date: Date | string) {
  const value = new Date(date);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function sameDay(a: Date | string, b: Date | string) {
  return dateKey(a) === dateKey(b);
}

function toInputDateTime(date: Date | string) {
  const value = new Date(date);
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatDayLabel(date: Date) {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(date);
}

function formatWeekday(date: Date) {
  return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
}

function formatMonthDay(date: Date) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
}

function formatRangeTitle(view: CalendarView, cursor: Date) {
  if (view === "day") return formatDayLabel(cursor);
  if (view === "month") {
    return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(cursor);
  }
  const start = startOfWeek(cursor);
  const end = addDays(start, 6);
  return `${formatDayLabel(start)} - ${formatDayLabel(end)}`;
}

function rangeForView(view: CalendarView, cursor: Date) {
  if (view === "day") return { start: startOfDay(cursor), end: endOfDay(cursor) };
  if (view === "month") {
    const start = startOfMonthGrid(cursor);
    return { start, end: endOfDay(addDays(start, 41)) };
  }
  const start = startOfWeek(cursor);
  return { start, end: endOfDay(addDays(start, 6)) };
}

function moveCursor(view: CalendarView, cursor: Date, direction: -1 | 1) {
  if (view === "day") return addDays(cursor, direction);
  if (view === "month") return new Date(cursor.getFullYear(), cursor.getMonth() + direction, 1);
  return addDays(cursor, direction * 7);
}

function minuteOfDay(date: Date | string) {
  const value = new Date(date);
  return value.getHours() * 60 + value.getMinutes();
}

function durationMinutes(event: Pick<CalendarEvent, "startAt" | "endAt">) {
  return Math.max(MIN_EVENT_MINUTES, Math.round((new Date(event.endAt).getTime() - new Date(event.startAt).getTime()) / 60_000));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function snapMinute(value: number) {
  return clamp(Math.round(value / SNAP_MINUTES) * SNAP_MINUTES, 0, 24 * 60);
}

function dateAtMinutes(day: Date, minutes: number) {
  const next = startOfDay(day);
  next.setMinutes(minutes, 0, 0);
  return next;
}

function statusLabel(status: string) {
  if (status === "in_progress") return "in progress";
  return status;
}

function eventTone(event: CalendarEvent, agents: Agent[]) {
  if (event.eventStatus === "projected") {
    return "border-sky-300 bg-sky-50/70 text-sky-950 dark:border-sky-400/50 dark:bg-sky-400/12 dark:text-sky-100";
  }
  if (event.eventKind === "external_event") {
    return "border-slate-300 bg-slate-50 text-slate-800 dark:border-slate-500/50 dark:bg-slate-500/14 dark:text-slate-100";
  }
  if (event.eventKind === "human_event") {
    return "border-zinc-300 bg-zinc-50 text-zinc-950 dark:border-zinc-500/60 dark:bg-zinc-500/14 dark:text-zinc-100";
  }
  const index = agents.findIndex((agent) => agent.id === event.ownerAgentId);
  return AGENT_COLORS[Math.max(0, index) % AGENT_COLORS.length]!;
}

function isWritableEvent(event: CalendarEvent | null) {
  return !!event && event.eventKind === "human_event" && event.sourceMode === "manual";
}

function visibleEventTitle(event: CalendarEvent) {
  if (event.visibility === "private") return "Private";
  if (event.visibility === "busy_only" && event.eventKind === "external_event") return "Busy";
  return event.title;
}

function defaultDraftStart() {
  const now = new Date();
  now.setMinutes(now.getMinutes() < 30 ? 30 : 60, 0, 0);
  return now;
}

function newDraft(kind: DraftKind = "human_event") {
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

function buildEventPayload(draft: ReturnType<typeof newDraft>, agents: Agent[], issues: Issue[]) {
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

function sourceStatusTone(status: CalendarSource["status"] | "missing") {
  if (status === "active") return "text-emerald-600 dark:text-emerald-400";
  if (status === "error") return "text-destructive";
  return "text-muted-foreground";
}

function EventBlock({
  event,
  agents,
  onSelect,
  onPointerStart,
  onPointerMove,
  onPointerEnd,
  compact = false,
}: {
  event: CalendarEvent;
  agents: Agent[];
  onSelect: (event: CalendarEvent) => void;
  onPointerStart?: (event: ReactPointerEvent<HTMLDivElement>, mode: DragMode) => void;
  onPointerMove?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerEnd?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  compact?: boolean;
}) {
  const writable = isWritableEvent(event);
  return (
    <div
      role="button"
      tabIndex={0}
      data-calendar-event="true"
      data-testid={`calendar-event-${event.id}`}
      onClick={() => onSelect(event)}
      onPointerDown={writable && onPointerStart ? (pointerEvent) => onPointerStart(pointerEvent, "move") : undefined}
      onPointerMove={writable ? onPointerMove : undefined}
      onPointerUp={writable ? onPointerEnd : undefined}
      onPointerCancel={writable ? onPointerEnd : undefined}
      onKeyDown={(keyboardEvent) => {
        if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
          keyboardEvent.preventDefault();
          onSelect(event);
        }
      }}
      className={cn(
        "group relative h-full w-full min-w-0 select-none overflow-hidden rounded-[calc(var(--radius-sm)-1px)] border px-2 py-1 text-left shadow-[0_10px_18px_-18px_rgba(15,23,42,0.45)] transition hover:brightness-[0.98]",
        eventTone(event, agents),
        event.eventStatus === "projected" && "border-dashed",
        writable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
        compact ? "text-[11px]" : "text-xs",
      )}
    >
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
      <div className="truncate font-medium">{visibleEventTitle(event)}</div>
      <div className="mt-0.5 truncate text-[10px] opacity-78">
        {statusLabel(event.eventStatus)} · {new Date(event.startAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
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

function CalendarGridView({
  view,
  days,
  events,
  agents,
  currentTime,
  onSelect,
  onCreateSelection,
  onUpdateEventTime,
}: {
  view: "day" | "week";
  days: Date[];
  events: CalendarEvent[];
  agents: Agent[];
  currentTime: Date;
  onSelect: (event: CalendarEvent) => void;
  onCreateSelection: (startAt: Date, endAt: Date, anchor: { x: number; y: number }) => void;
  onUpdateEventTime: (event: CalendarEvent, startAt: Date, endAt: Date) => void;
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

  function selectEvent(event: CalendarEvent) {
    if (suppressClickEventId.current === event.id) {
      suppressClickEventId.current = null;
      return;
    }
    onSelect(event);
  }

  const displayEvents = eventDrag
    ? events.map((event) => event.id === eventDrag.event.id
      ? { ...event, startAt: eventDrag.previewStartAt, endAt: eventDrag.previewEndAt }
      : event)
    : events;

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
                  {hour === 0 ? "12 AM" : hour < 12 ? `${hour} AM` : hour === 12 ? "12 PM" : `${hour - 12} PM`}
                </div>
              ))}
            </div>
            {days.map((day) => {
              const dayEvents = displayEvents.filter((event) => sameDay(event.startAt, day));
              const today = sameDay(day, currentTime);
              const todayLineTop = (minuteOfDay(currentTime) / 60) * HOUR_HEIGHT;
              const activeSelection = selection?.dayKey === dateKey(day) ? selection : null;
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
                      className="pointer-events-none absolute left-2 right-2 z-20 rounded-[var(--radius-sm)] border border-primary/60 bg-primary/12"
                      style={{ top: selectionTop, height: selectionHeight }}
                    />
                  ) : null}
                  {dayEvents.map((event, index) => {
                    const top = Math.max(0, (minuteOfDay(event.startAt) / 60) * HOUR_HEIGHT);
                    const height = Math.max(28, (durationMinutes(event) / 60) * HOUR_HEIGHT);
                    return (
                      <div
                        key={event.id}
                        className="absolute px-1.5"
                        style={{
                          top,
                          height,
                          left: `${2 + (index % 2) * 5}%`,
                          right: `${2 + ((index + 1) % 2) * 5}%`,
                        }}
                      >
                        <EventBlock
                          event={event}
                          agents={agents}
                          onSelect={selectEvent}
                          compact={view === "week"}
                          onPointerStart={(pointerEvent, mode) => beginEventDrag(pointerEvent, event, mode)}
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
          {eventDrag.previewStartAt.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}
          {" - "}
          {eventDrag.previewEndAt.toLocaleString([], { hour: "2-digit", minute: "2-digit" })}
        </div>
      ) : null}
    </div>
  );
}

function MonthView({
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
    <div className="grid min-h-0 flex-1 grid-cols-7 overflow-hidden rounded-[var(--radius-sm)] border border-border bg-card">
      {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => (
        <div key={label} className="border-b border-r border-border bg-muted/30 px-2 py-2 text-xs font-medium last:border-r-0">
          {label}
        </div>
      ))}
      {days.map((day) => {
        const dayEvents = events.filter((event) => sameDay(event.startAt, day)).slice(0, 4);
        const outside = day.getMonth() !== cursor.getMonth();
        const today = sameDay(day, currentTime);
        return (
          <div
            key={day.toISOString()}
            className={cn(
              "min-h-[118px] border-b border-r border-border p-2 last:border-r-0",
              outside && "bg-muted/20 text-muted-foreground",
              today && "bg-primary/6",
            )}
          >
            <div className={cn("flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold", today && "bg-primary text-primary-foreground")}>
              {day.getDate()}
            </div>
            <div className="mt-2 space-y-1">
              {dayEvents.map((event) => (
                <EventBlock key={event.id} event={event} agents={agents} onSelect={onSelect} compact />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AgendaView({
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
                  {new Date(event.startAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
                <span className="truncate font-medium">{visibleEventTitle(event)}</span>
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

export function Calendar() {
  const { viewedOrganizationId } = useViewedOrganization();
  const { setBreadcrumbs, setHeaderActions } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [view, setView] = useState<CalendarView>("week");
  const [cursor, setCursor] = useState(() => new Date());
  const [currentTime, setCurrentTime] = useState(() => new Date());
  const [filtersVisible, setFiltersVisible] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem("rudder.calendar.filtersVisible") !== "false";
  });
  const [hiddenAgentIds, setHiddenAgentIds] = useState<Set<string>>(() => new Set());
  const [hiddenSourceIds, setHiddenSourceIds] = useState<Set<string>>(() => new Set());
  const [myCalendarVisible, setMyCalendarVisible] = useState(true);
  const [visibleStatuses, setVisibleStatuses] = useState<Set<string>>(() => new Set(EVENT_STATUS_OPTIONS));
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [quickCreate, setQuickCreate] = useState<null | { x: number; y: number }>(null);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [draft, setDraft] = useState(() => newDraft());

  const clampQuickCreatePosition = useCallback((anchor?: { x: number; y: number }) => {
    if (typeof window === "undefined") return { x: 420, y: 96 };
    const x = anchor?.x ?? window.innerWidth - 380;
    const y = anchor?.y ?? 84;
    return {
      x: clamp(x, 16, Math.max(16, window.innerWidth - 380)),
      y: clamp(y, 64, Math.max(64, window.innerHeight - 360)),
    };
  }, []);

  const openQuickCreate = useCallback((kind: DraftKind = "human_event", startAt?: Date, endAt?: Date, anchor?: { x: number; y: number }) => {
    const start = startAt ?? defaultDraftStart();
    const end = endAt ?? new Date(start.getTime() + 60 * 60_000);
    setEditingEvent(null);
    setDraft({
      ...newDraft(kind),
      kind,
      startAt: toInputDateTime(start),
      endAt: toInputDateTime(end),
    });
    setDialogOpen(false);
    setQuickCreate(clampQuickCreatePosition(anchor));
  }, [clampQuickCreatePosition]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Calendar" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("rudder.calendar.filtersVisible", String(filtersVisible));
    }
  }, [filtersVisible]);

  useEffect(() => {
    setHeaderActions(
      <Button type="button" size="sm" onClick={() => openQuickCreate("human_event")}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        Create
      </Button>,
    );
    return () => setHeaderActions(null);
  }, [openQuickCreate, setHeaderActions]);

  const range = useMemo(() => rangeForView(view, cursor), [view, cursor]);
  const rangeStart = range.start.toISOString();
  const rangeEnd = range.end.toISOString();

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(viewedOrganizationId ?? "__none__"),
    queryFn: () => agentsApi.list(viewedOrganizationId!),
    enabled: !!viewedOrganizationId,
  });
  const issuesQuery = useQuery({
    queryKey: queryKeys.issues.list(viewedOrganizationId ?? "__none__"),
    queryFn: () => issuesApi.list(viewedOrganizationId!),
    enabled: !!viewedOrganizationId,
  });
  const sourcesQuery = useQuery({
    queryKey: queryKeys.calendar.sources(viewedOrganizationId ?? "__none__"),
    queryFn: () => calendarApi.sources(viewedOrganizationId!),
    enabled: !!viewedOrganizationId,
  });
  const eventsQuery = useQuery({
    queryKey: queryKeys.calendar.events(viewedOrganizationId ?? "__none__", rangeStart, rangeEnd),
    queryFn: () => calendarApi.events(viewedOrganizationId!, { start: rangeStart, end: rangeEnd }),
    enabled: !!viewedOrganizationId,
    refetchInterval: 20_000,
  });

  const agents = useMemo(
    () => (agentsQuery.data ?? []).filter((agent) => agent.status !== "terminated"),
    [agentsQuery.data],
  );
  const issues = issuesQuery.data ?? [];
  const sources = sourcesQuery.data ?? [];

  const visibleEvents = useMemo(() => {
    return (eventsQuery.data?.events ?? []).filter((event) => {
      if (!visibleStatuses.has(event.eventStatus)) return false;
      if (event.eventKind === "human_event") return myCalendarVisible;
      if (event.eventKind === "agent_work_block") {
        return !event.ownerAgentId || !hiddenAgentIds.has(event.ownerAgentId);
      }
      if (event.eventKind === "external_event") {
        return !!event.sourceId && !hiddenSourceIds.has(event.sourceId);
      }
      return true;
    });
  }, [eventsQuery.data?.events, hiddenAgentIds, hiddenSourceIds, myCalendarVisible, visibleStatuses]);

  const invalidateCalendar = async () => {
    if (!viewedOrganizationId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.calendar.sources(viewedOrganizationId) }),
      queryClient.invalidateQueries({ queryKey: ["calendar", viewedOrganizationId] }),
      queryClient.invalidateQueries({ queryKey: queryKeys.activity(viewedOrganizationId) }),
    ]);
  };

  const createEventMutation = useMutation({
    mutationFn: () => calendarApi.createEvent(viewedOrganizationId!, buildEventPayload(draft, agents, issues)),
    onSuccess: async (event) => {
      setQuickCreate(null);
      setDialogOpen(false);
      setSelectedEvent(event);
      await invalidateCalendar();
      pushToast({ title: "Calendar block created", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Failed to create calendar block", body: error instanceof Error ? error.message : undefined, tone: "error" }),
  });
  const updateEventMutation = useMutation({
    mutationFn: () => calendarApi.updateEvent(viewedOrganizationId!, editingEvent!.id, buildEventPayload(draft, agents, issues)),
    onSuccess: async (event) => {
      setDialogOpen(false);
      setSelectedEvent(event);
      setEditingEvent(null);
      await invalidateCalendar();
      pushToast({ title: "Calendar block updated", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Failed to update calendar block", body: error instanceof Error ? error.message : undefined, tone: "error" }),
  });
  const moveEventMutation = useMutation({
    mutationFn: ({ event, startAt, endAt }: { event: CalendarEvent; startAt: Date; endAt: Date }) =>
      calendarApi.updateEvent(viewedOrganizationId!, event.id, {
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      }),
    onSuccess: async (event) => {
      setSelectedEvent((current) => current?.id === event.id ? event : current);
      await invalidateCalendar();
      pushToast({ title: "Calendar event moved", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Failed to move calendar event", body: error instanceof Error ? error.message : undefined, tone: "error" }),
  });
  const deleteEventMutation = useMutation({
    mutationFn: (event: CalendarEvent) => calendarApi.deleteEvent(viewedOrganizationId!, event.id),
    onSuccess: async () => {
      setSelectedEvent(null);
      await invalidateCalendar();
      pushToast({ title: "Calendar block deleted", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Failed to delete calendar block", body: error instanceof Error ? error.message : undefined, tone: "error" }),
  });
  const updateSourceMutation = useMutation({
    mutationFn: ({ sourceId, visibilityDefault }: { sourceId: string; visibilityDefault: CalendarSource["visibilityDefault"] }) =>
      calendarApi.updateSource(viewedOrganizationId!, sourceId, { visibilityDefault }),
    onSuccess: async () => {
      await invalidateCalendar();
      pushToast({ title: "Calendar source updated", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Failed to update calendar source", body: error instanceof Error ? error.message : undefined, tone: "error" }),
  });
  const connectGoogleMutation = useMutation({
    mutationFn: () => calendarApi.connectGoogle(viewedOrganizationId!),
    onSuccess: async (result) => {
      await invalidateCalendar();
      if (result.authUrl) {
        window.location.href = result.authUrl;
        return;
      }
      pushToast({
        title: "Google Calendar needs OAuth credentials",
        body: "Set Google OAuth credentials on the server to enable read-only import.",
        tone: "error",
      });
    },
    onError: (error) => pushToast({ title: "Google Calendar connection failed", body: error instanceof Error ? error.message : undefined, tone: "error" }),
  });
  const syncGoogleMutation = useMutation({
    mutationFn: (sourceId?: string | null) => calendarApi.syncGoogle(viewedOrganizationId!, sourceId),
    onSuccess: async (result) => {
      await invalidateCalendar();
      pushToast({ title: "Google Calendar synced", body: `${result.importedCount} new busy block${result.importedCount === 1 ? "" : "s"} imported.`, tone: "success" });
    },
    onError: (error) => pushToast({ title: "Google Calendar sync failed", body: error instanceof Error ? error.message : undefined, tone: "error" }),
  });

  function openEdit(event: CalendarEvent) {
    if (!isWritableEvent(event)) return;
    setEditingEvent(event);
    setDraft({
      kind: "human_event",
      title: event.title,
      description: event.description ?? "",
      agentId: "",
      issueId: "",
      startAt: toInputDateTime(event.startAt),
      endAt: toInputDateTime(event.endAt),
    });
    setDialogOpen(true);
  }

  function submitDraft() {
    if (draft.kind === "agent_work_block" && !draft.agentId) {
      pushToast({ title: "Choose an agent for this work block", tone: "error" });
      return;
    }
    if (new Date(draft.endAt).getTime() <= new Date(draft.startAt).getTime()) {
      pushToast({ title: "End time must be after start time", tone: "error" });
      return;
    }
    if (editingEvent) updateEventMutation.mutate();
    else createEventMutation.mutate();
  }

  if (!viewedOrganizationId) {
    return <EmptyState icon={CalendarDays} message="Create or select an organization to use Calendar." />;
  }

  if (agentsQuery.isLoading || sourcesQuery.isLoading || eventsQuery.isLoading) {
    return <PageSkeleton />;
  }

  const days = view === "day"
    ? [startOfDay(cursor)]
    : Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(cursor), index));
  const googleSources = sources.filter((source) => source.type === "google_calendar");
  const googleSource = googleSources[0] ?? null;
  const googleStatus: CalendarSource["status"] | "missing" = googleSource ? googleSource.status : "missing";
  const sourceEventsCount = (sourceId: string) =>
    (eventsQuery.data?.events ?? []).filter((event) => event.sourceId === sourceId).length;

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {filtersVisible ? (
        <aside
          data-testid="calendar-layers-sidebar"
          className="hidden w-72 shrink-0 flex-col overflow-y-auto border-r border-border bg-card/80 p-4 lg:flex"
        >
          <div className="mb-4 flex items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold">Calendar</div>
              <div className="text-xs text-muted-foreground">Layers and sync</div>
            </div>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Hide calendar sidebar" onClick={() => setFiltersVisible(false)}>
              <PanelLeftClose className="h-4 w-4" />
            </Button>
          </div>

          <div className="mb-4">
            <Label htmlFor="calendar-month" className="text-xs text-muted-foreground">Month</Label>
            <Input
              id="calendar-month"
              type="month"
              value={`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`}
              onChange={(event) => {
                const [year, month] = event.target.value.split("-").map(Number);
                if (year && month) setCursor(new Date(year, month - 1, 1));
              }}
              className="mt-1 h-9"
            />
          </div>

          <section className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">Calendars</div>
            <label className="flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-sm hover:bg-muted/40">
              <Checkbox checked={myCalendarVisible} onCheckedChange={(checked) => setMyCalendarVisible(checked === true)} />
              <User className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">My Calendar</span>
            </label>
          </section>

          <section className="mt-4 space-y-3 rounded-[var(--radius-sm)] border border-border bg-muted/20 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
                  Google Calendar
                </div>
                <div className="mt-1 text-xs leading-5 text-muted-foreground">
                  Read-only import. Events default to busy blocks and never enter agent context.
                </div>
              </div>
              <div className={cn("mt-0.5 flex items-center gap-1 text-xs", sourceStatusTone(googleStatus))}>
                {googleStatus === "active" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
                {googleStatus === "missing" ? "not connected" : googleStatus}
              </div>
            </div>
            {googleSource ? (
              <div className="space-y-2">
                <label className="flex items-center gap-2 rounded-[var(--radius-sm)] px-1 py-1.5 text-sm">
                  <Checkbox
                    checked={!hiddenSourceIds.has(googleSource.id)}
                    onCheckedChange={(checked) => {
                      setHiddenSourceIds((current) => {
                        const next = new Set(current);
                        if (checked === true) next.delete(googleSource.id);
                        else next.add(googleSource.id);
                        return next;
                      });
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate">{googleSource.name}</span>
                  <span className="text-xs text-muted-foreground">{sourceEventsCount(googleSource.id)}</span>
                </label>
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span>Visibility</span>
                  <select
                    value={googleSource.visibilityDefault}
                    onChange={(event) => updateSourceMutation.mutate({
                      sourceId: googleSource.id,
                      visibilityDefault: event.target.value as CalendarSource["visibilityDefault"],
                    })}
                    className="h-8 w-full rounded-[var(--radius-sm)] border border-input bg-background px-2 text-xs text-foreground"
                  >
                    <option value="busy_only">Busy only</option>
                    <option value="full">Show titles</option>
                    <option value="private">Private</option>
                  </select>
                </label>
                <div className="text-[11px] text-muted-foreground">
                  Last synced {googleSource.lastSyncedAt ? formatDateTime(googleSource.lastSyncedAt) : "never"}
                </div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">Connect Google to show external busy blocks beside agent work.</div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => connectGoogleMutation.mutate()}
                disabled={connectGoogleMutation.isPending}
              >
                {connectGoogleMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="mr-1.5 h-3.5 w-3.5" />}
                Connect
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => syncGoogleMutation.mutate(googleSource?.id)}
                disabled={syncGoogleMutation.isPending || !googleSource}
              >
                {syncGoogleMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
                Sync
              </Button>
            </div>
          </section>

          <section className="mt-4 space-y-2">
            <div className="text-xs font-medium text-muted-foreground">Agents</div>
            {agents.map((agent, index) => (
              <label key={agent.id} className="flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-sm hover:bg-muted/40">
                <Checkbox
                  checked={!hiddenAgentIds.has(agent.id)}
                  onCheckedChange={(checked) => {
                    setHiddenAgentIds((current) => {
                      const next = new Set(current);
                      if (checked === true) next.delete(agent.id);
                      else next.add(agent.id);
                      return next;
                    });
                  }}
                />
                <span className={cn("h-2.5 w-2.5 shrink-0 rounded-sm border", AGENT_SWATCHES[index % AGENT_SWATCHES.length])} />
                <span className="min-w-0 flex-1 truncate">{agent.name}</span>
              </label>
            ))}
          </section>

          <section className="mt-4 space-y-2">
            <div className="text-xs font-medium text-muted-foreground">Status</div>
            {EVENT_STATUS_OPTIONS.map((status) => (
              <label key={status} className="flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-sm hover:bg-muted/40">
                <Checkbox
                  checked={visibleStatuses.has(status)}
                  onCheckedChange={(checked) => {
                    setVisibleStatuses((current) => {
                      const next = new Set(current);
                      if (checked === true) next.add(status);
                      else next.delete(status);
                      return next;
                    });
                  }}
                />
                <span>{statusLabel(status)}</span>
              </label>
            ))}
          </section>
        </aside>
      ) : null}

      <main className="flex min-w-0 flex-1 flex-col gap-3 p-4 md:p-5">
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-border bg-card px-3 py-2">
          {!filtersVisible ? (
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Show calendar sidebar" onClick={() => setFiltersVisible(true)}>
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => setCursor(new Date())}>Today</Button>
          <Button variant="ghost" size="icon-sm" aria-label="Previous range" onClick={() => setCursor((value) => moveCursor(view, value, -1))}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next range" onClick={() => setCursor((value) => moveCursor(view, value, 1))}>
            <ArrowRight className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1 truncate px-1 text-sm font-medium">{formatRangeTitle(view, cursor)}</div>
          <Button type="button" size="sm" variant="outline" className="lg:hidden" onClick={() => setFiltersVisible((value) => !value)}>
            Layers
          </Button>
          <div className="grid grid-cols-4 rounded-[var(--radius-sm)] border border-border p-0.5">
            {(["day", "week", "month", "agenda"] as CalendarView[]).map((item) => (
              <button
                key={item}
                type="button"
                className={cn(
                  "rounded-[calc(var(--radius-sm)-2px)] px-2.5 py-1.5 text-xs font-medium capitalize transition",
                  view === item ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
                onClick={() => setView(item)}
              >
                {item}
              </button>
            ))}
          </div>
        </div>

        {view === "day" || view === "week" ? (
          <CalendarGridView
            view={view}
            days={days}
            events={visibleEvents}
            agents={agents}
            currentTime={currentTime}
            onSelect={setSelectedEvent}
            onCreateSelection={(startAt, endAt, anchor) => openQuickCreate("human_event", startAt, endAt, anchor)}
            onUpdateEventTime={(event, startAt, endAt) => moveEventMutation.mutate({ event, startAt, endAt })}
          />
        ) : view === "month" ? (
          <MonthView cursor={cursor} events={visibleEvents} agents={agents} currentTime={currentTime} onSelect={setSelectedEvent} />
        ) : (
          <AgendaView events={visibleEvents} agents={agents} onSelect={setSelectedEvent} />
        )}
      </main>

      {quickCreate ? (
        <div
          data-testid="calendar-quick-create"
          className="fixed z-50 w-[360px] rounded-[var(--radius-sm)] border border-border bg-popover p-3 text-popover-foreground shadow-xl"
          style={{ left: quickCreate.x, top: quickCreate.y }}
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="text-sm font-semibold">Create</div>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Close create popover" onClick={() => setQuickCreate(null)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="space-y-3">
            <Input
              autoFocus
              value={draft.title}
              onChange={(event) => setDraft((value) => ({ ...value, title: event.target.value }))}
              placeholder={draft.kind === "agent_work_block" ? "CEO · Plan roadmap" : "Add title"}
            />
            <div className="grid grid-cols-2 rounded-[var(--radius-sm)] border border-border p-0.5">
              {([
                ["human_event", "Event"],
                ["agent_work_block", "Agent block"],
              ] as const).map(([kind, label]) => (
                <button
                  key={kind}
                  type="button"
                  className={cn(
                    "rounded-[calc(var(--radius-sm)-2px)] px-2 py-1.5 text-xs font-medium",
                    draft.kind === kind ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/60",
                  )}
                  onClick={() => setDraft((value) => ({
                    ...value,
                    kind,
                    agentId: kind === "human_event" ? "" : value.agentId,
                    issueId: kind === "human_event" ? "" : value.issueId,
                  }))}
                >
                  {label}
                </button>
              ))}
            </div>
            {draft.kind === "agent_work_block" ? (
              <div className="grid gap-2">
                <select
                  aria-label="Agent"
                  value={draft.agentId}
                  onChange={(event) => setDraft((value) => ({ ...value, agentId: event.target.value }))}
                  className="h-9 w-full rounded-[var(--radius-sm)] border border-input bg-background px-3 text-sm"
                >
                  <option value="">Choose agent</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>{agent.name}</option>
                  ))}
                </select>
                <select
                  aria-label="Linked issue"
                  value={draft.issueId}
                  onChange={(event) => setDraft((value) => ({ ...value, issueId: event.target.value }))}
                  className="h-9 w-full rounded-[var(--radius-sm)] border border-input bg-background px-3 text-sm"
                >
                  <option value="">No issue linked</option>
                  {issues.map((issue) => (
                    <option key={issue.id} value={issue.id}>
                      {issue.identifier ? `${issue.identifier} · ` : ""}{issue.title}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-2">
              <Input
                aria-label="Start"
                type="datetime-local"
                value={draft.startAt}
                onChange={(event) => setDraft((value) => ({ ...value, startAt: event.target.value }))}
              />
              <Input
                aria-label="End"
                type="datetime-local"
                value={draft.endAt}
                onChange={(event) => setDraft((value) => ({ ...value, endAt: event.target.value }))}
              />
            </div>
            {draft.kind === "agent_work_block" ? (
              <div className="rounded-[var(--radius-sm)] border border-border bg-muted/30 p-2 text-[11px] leading-5 text-muted-foreground">
                Calendar annotation only. It does not run, assign, or reprioritize the agent.
              </div>
            ) : null}
            <div className="flex justify-between gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => {
                setQuickCreate(null);
                setDialogOpen(true);
              }}>
                More options
              </Button>
              <Button type="button" size="sm" onClick={submitDraft} disabled={createEventMutation.isPending}>
                {createEventMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                Save
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <Sheet open={!!selectedEvent} onOpenChange={(open) => !open && setSelectedEvent(null)}>
        <SheetContent className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{selectedEvent ? visibleEventTitle(selectedEvent) : "Calendar block"}</SheetTitle>
          </SheetHeader>
          {selectedEvent ? (
            <div className="space-y-5 overflow-y-auto px-4 pb-4 text-sm">
              <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-y-2">
                <span className="text-muted-foreground">Status</span>
                <span>{statusLabel(selectedEvent.eventStatus)}</span>
                <span className="text-muted-foreground">Source</span>
                <span>
                  {selectedEvent.eventStatus === "projected"
                    ? "projected heartbeat"
                    : selectedEvent.sourceMode === "derived"
                      ? "run history"
                      : selectedEvent.source?.name ?? "manual"}
                </span>
                <span className="text-muted-foreground">Time</span>
                <span>{formatDateTime(selectedEvent.startAt)} - {formatDateTime(selectedEvent.endAt)}</span>
                <span className="text-muted-foreground">Agent</span>
                <span>{selectedEvent.agent?.name ?? "None"}</span>
                <span className="text-muted-foreground">Issue</span>
                <span>{selectedEvent.issue?.identifier ?? selectedEvent.issue?.title ?? "None"}</span>
              </div>
              {selectedEvent.description ? (
                <p className="rounded-[var(--radius-sm)] border border-border bg-muted/30 p-3 text-sm leading-6">
                  {selectedEvent.description}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {selectedEvent.issue ? (
                  <Button asChild variant="outline" size="sm">
                    <Link to={issueUrl(selectedEvent.issue)}>Open issue</Link>
                  </Button>
                ) : null}
                {selectedEvent.agent ? (
                  <Button asChild variant="outline" size="sm">
                    <Link to={agentUrl(selectedEvent.agent)}>Open agent</Link>
                  </Button>
                ) : null}
                {selectedEvent.heartbeatRunId && selectedEvent.agent ? (
                  <Button asChild variant="outline" size="sm">
                    <Link to={`${agentUrl(selectedEvent.agent)}/runs/${selectedEvent.heartbeatRunId}`}>Open run</Link>
                  </Button>
                ) : null}
              </div>
              {isWritableEvent(selectedEvent) ? (
                <div className="flex gap-2 border-t border-border pt-4">
                  <Button type="button" size="sm" onClick={() => openEdit(selectedEvent)}>
                    Edit calendar event
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    onClick={() => deleteEventMutation.mutate(selectedEvent)}
                    disabled={deleteEventMutation.isPending}
                  >
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    Delete
                  </Button>
                </div>
              ) : (
                <div className="rounded-[var(--radius-sm)] border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
                  Only My Calendar events can be edited. Agent schedules, run history, projected heartbeats, and Google Calendar blocks are read-only here.
                </div>
              )}
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingEvent ? "Edit calendar event" : "New calendar block"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-1">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">Type</span>
                <select
                  value={draft.kind}
                  disabled={!!editingEvent}
                  onChange={(event) => setDraft((value) => ({ ...value, kind: event.target.value as DraftKind }))}
                  className="h-9 w-full rounded-[var(--radius-sm)] border border-input bg-background px-3 text-sm disabled:opacity-60"
                >
                  <option value="human_event">My event</option>
                  <option value="agent_work_block">Agent work block</option>
                </select>
              </label>
              {draft.kind === "agent_work_block" ? (
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Agent</span>
                  <select
                    aria-label="Agent"
                    value={draft.agentId}
                    onChange={(event) => setDraft((value) => ({ ...value, agentId: event.target.value }))}
                    className="h-9 w-full rounded-[var(--radius-sm)] border border-input bg-background px-3 text-sm"
                  >
                    <option value="">Choose agent</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>{agent.name}</option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            <label className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Title</span>
              <Input
                value={draft.title}
                onChange={(event) => setDraft((value) => ({ ...value, title: event.target.value }))}
                placeholder={draft.kind === "agent_work_block" ? "CEO · Plan launch issues" : "Review output"}
              />
            </label>
            {draft.kind === "agent_work_block" ? (
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">Linked issue</span>
                <select
                  aria-label="Linked issue"
                  value={draft.issueId}
                  onChange={(event) => setDraft((value) => ({ ...value, issueId: event.target.value }))}
                  className="h-9 w-full rounded-[var(--radius-sm)] border border-input bg-background px-3 text-sm"
                >
                  <option value="">No issue linked</option>
                  {issues.map((issue) => (
                    <option key={issue.id} value={issue.id}>
                      {issue.identifier ? `${issue.identifier} · ` : ""}{issue.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">Start</span>
                <Input
                  type="datetime-local"
                  value={draft.startAt}
                  onChange={(event) => setDraft((value) => ({ ...value, startAt: event.target.value }))}
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">End</span>
                <Input
                  type="datetime-local"
                  value={draft.endAt}
                  onChange={(event) => setDraft((value) => ({ ...value, endAt: event.target.value }))}
                />
              </label>
            </div>
            <label className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Description</span>
              <Textarea
                value={draft.description}
                onChange={(event) => setDraft((value) => ({ ...value, description: event.target.value }))}
                rows={4}
              />
            </label>
            {draft.kind === "agent_work_block" ? (
              <div className="rounded-[var(--radius-sm)] border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
                This creates a planned calendar block only. It does not assign the issue, check it out, run a heartbeat, or change agent priority.
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={submitDraft} disabled={createEventMutation.isPending || updateEventMutation.isPending}>
              {(createEventMutation.isPending || updateEventMutation.isPending) ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {editingEvent ? "Save changes" : "Create block"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
