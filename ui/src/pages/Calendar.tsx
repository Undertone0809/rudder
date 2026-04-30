import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent, CalendarEvent, CalendarEventStatus, Issue } from "@rudderhq/shared";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  CalendarDays,
  Clock3,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  User,
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

const HOUR_HEIGHT = 52;
const DAY_HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const EVENT_STATUS_OPTIONS: CalendarEventStatus[] = ["planned", "in_progress", "actual", "external", "cancelled"];
const AGENT_COLORS = [
  "border-blue-400 bg-blue-50 text-blue-950 dark:border-blue-500/60 dark:bg-blue-500/16 dark:text-blue-100",
  "border-emerald-400 bg-emerald-50 text-emerald-950 dark:border-emerald-500/60 dark:bg-emerald-500/16 dark:text-emerald-100",
  "border-amber-400 bg-amber-50 text-amber-950 dark:border-amber-500/60 dark:bg-amber-500/16 dark:text-amber-100",
  "border-rose-400 bg-rose-50 text-rose-950 dark:border-rose-500/60 dark:bg-rose-500/16 dark:text-rose-100",
  "border-cyan-400 bg-cyan-50 text-cyan-950 dark:border-cyan-500/60 dark:bg-cyan-500/16 dark:text-cyan-100",
  "border-violet-400 bg-violet-50 text-violet-950 dark:border-violet-500/60 dark:bg-violet-500/16 dark:text-violet-100",
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

function durationMinutes(event: CalendarEvent) {
  return Math.max(15, Math.round((new Date(event.endAt).getTime() - new Date(event.startAt).getTime()) / 60_000));
}

function statusLabel(status: string) {
  if (status === "in_progress") return "in progress";
  return status;
}

function eventTone(event: CalendarEvent, agents: Agent[]) {
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
  return !!event && event.sourceMode === "manual";
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

function newDraft(kind: DraftKind = "agent_work_block") {
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
    issueId: draft.issueId || null,
    sourceMode: "manual",
  };
}

function EventBlock({
  event,
  agents,
  onSelect,
  compact = false,
}: {
  event: CalendarEvent;
  agents: Agent[];
  onSelect: (event: CalendarEvent) => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={`calendar-event-${event.id}`}
      onClick={() => onSelect(event)}
      className={cn(
        "w-full min-w-0 rounded-[calc(var(--radius-sm)-1px)] border px-2 py-1 text-left shadow-[0_10px_18px_-18px_rgba(15,23,42,0.45)] transition hover:brightness-[0.98]",
        eventTone(event, agents),
        compact ? "text-[11px]" : "text-xs",
      )}
    >
      <div className="truncate font-medium">{visibleEventTitle(event)}</div>
      <div className="mt-0.5 truncate text-[10px] opacity-78">
        {statusLabel(event.eventStatus)} · {new Date(event.startAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </div>
    </button>
  );
}

function CalendarGridView({
  view,
  days,
  events,
  agents,
  onSelect,
}: {
  view: "day" | "week";
  days: Date[];
  events: CalendarEvent[];
  agents: Agent[];
  onSelect: (event: CalendarEvent) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-sm)] border border-border bg-card">
      <div className="grid border-b border-border bg-muted/30" style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` }}>
        <div className="border-r border-border" />
        {days.map((day) => (
          <div key={day.toISOString()} className="border-r border-border px-3 py-2 last:border-r-0">
            <div className="text-xs font-medium">{formatDayLabel(day)}</div>
            <div className={cn("mt-0.5 h-1 w-8 rounded-sm", sameDay(day, new Date()) ? "bg-primary" : "bg-transparent")} />
          </div>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="grid" style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(180px, 1fr))`, minHeight: HOUR_HEIGHT * 24 }}>
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
            const dayEvents = events.filter((event) => sameDay(event.startAt, day));
            return (
              <div key={day.toISOString()} className="relative border-r border-border last:border-r-0">
                {DAY_HOURS.map((hour) => (
                  <div
                    key={hour}
                    className="absolute left-0 right-0 border-t border-border/60"
                    style={{ top: hour * HOUR_HEIGHT }}
                  />
                ))}
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
                      <EventBlock event={event} agents={agents} onSelect={onSelect} compact={view === "week"} />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MonthView({
  cursor,
  events,
  agents,
  onSelect,
}: {
  cursor: Date;
  events: CalendarEvent[];
  agents: Agent[];
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
        return (
          <div key={day.toISOString()} className={cn("min-h-[118px] border-b border-r border-border p-2 last:border-r-0", outside && "bg-muted/20 text-muted-foreground")}>
            <div className="text-xs font-medium">{day.getDate()}</div>
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
  const [hiddenAgentIds, setHiddenAgentIds] = useState<Set<string>>(() => new Set());
  const [hiddenSourceIds, setHiddenSourceIds] = useState<Set<string>>(() => new Set());
  const [myCalendarVisible, setMyCalendarVisible] = useState(true);
  const [visibleStatuses, setVisibleStatuses] = useState<Set<string>>(() => new Set(EVENT_STATUS_OPTIONS));
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [draft, setDraft] = useState(() => newDraft());

  useEffect(() => {
    setBreadcrumbs([{ label: "Calendar" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    setHeaderActions(
      <Button type="button" size="sm" onClick={() => {
        setEditingEvent(null);
        setDraft(newDraft("agent_work_block"));
        setDialogOpen(true);
      }}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        New block
      </Button>,
    );
    return () => setHeaderActions(null);
  }, [setHeaderActions]);

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
  const deleteEventMutation = useMutation({
    mutationFn: (event: CalendarEvent) => calendarApi.deleteEvent(viewedOrganizationId!, event.id),
    onSuccess: async () => {
      setSelectedEvent(null);
      await invalidateCalendar();
      pushToast({ title: "Calendar block deleted", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Failed to delete calendar block", body: error instanceof Error ? error.message : undefined, tone: "error" }),
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
        title: "Google Calendar is not configured",
        body: "Set Google OAuth credentials on the server to enable read-only import.",
        tone: "error",
      });
    },
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
    setEditingEvent(event);
    setDraft({
      kind: event.eventKind === "agent_work_block" ? "agent_work_block" : "human_event",
      title: event.title,
      description: event.description ?? "",
      agentId: event.ownerAgentId ?? "",
      issueId: event.issueId ?? "",
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
  const sourceEventsCount = (sourceId: string) =>
    (eventsQuery.data?.events ?? []).filter((event) => event.sourceId === sourceId).length;

  return (
    <div className="flex h-full min-h-0 gap-4 p-4 md:p-5">
      <aside className="hidden w-72 shrink-0 flex-col gap-4 overflow-y-auto rounded-[var(--radius-sm)] border border-border bg-card p-4 lg:flex">
        <div>
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
          <div className="flex items-center justify-between gap-2 px-2 pt-1">
            <span className="text-xs text-muted-foreground">Google Calendar</span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title="Connect Google Calendar"
                onClick={() => connectGoogleMutation.mutate()}
              >
                {connectGoogleMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title="Sync Google Calendar"
                onClick={() => syncGoogleMutation.mutate(googleSources[0]?.id)}
              >
                {syncGoogleMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>
          {googleSources.length === 0 ? (
            <div className="px-2 text-xs text-muted-foreground">No Google source connected.</div>
          ) : googleSources.map((source) => (
            <label key={source.id} className="flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-sm hover:bg-muted/40">
              <Checkbox
                checked={!hiddenSourceIds.has(source.id)}
                onCheckedChange={(checked) => {
                  setHiddenSourceIds((current) => {
                    const next = new Set(current);
                    if (checked === true) next.delete(source.id);
                    else next.add(source.id);
                    return next;
                  });
                }}
              />
              <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{source.name}</span>
              <span className="text-xs text-muted-foreground">{sourceEventsCount(source.id)}</span>
            </label>
          ))}
        </section>

        <section className="space-y-2">
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
              <span className={cn("h-2.5 w-2.5 shrink-0 rounded-sm border", AGENT_COLORS[index % AGENT_COLORS.length]?.split(" ").slice(0, 2).join(" "))} />
              <span className="min-w-0 flex-1 truncate">{agent.name}</span>
            </label>
          ))}
        </section>

        <section className="space-y-2">
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

      <main className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-border bg-card px-3 py-2">
          <Button variant="outline" size="sm" onClick={() => setCursor(new Date())}>Today</Button>
          <Button variant="ghost" size="icon-sm" aria-label="Previous range" onClick={() => setCursor((value) => moveCursor(view, value, -1))}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next range" onClick={() => setCursor((value) => moveCursor(view, value, 1))}>
            <ArrowRight className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1 truncate px-1 text-sm font-medium">{formatRangeTitle(view, cursor)}</div>
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
          <CalendarGridView view={view} days={days} events={visibleEvents} agents={agents} onSelect={setSelectedEvent} />
        ) : view === "month" ? (
          <MonthView cursor={cursor} events={visibleEvents} agents={agents} onSelect={setSelectedEvent} />
        ) : (
          <AgendaView events={visibleEvents} agents={agents} onSelect={setSelectedEvent} />
        )}
      </main>

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
                <span>{selectedEvent.sourceMode === "derived" ? "run history" : selectedEvent.source?.name ?? "manual"}</span>
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
                    Edit calendar block
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
                  This block is read-only because it comes from run history or an external calendar.
                </div>
              )}
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingEvent ? "Edit calendar block" : "New calendar block"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-1">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">Type</span>
                <select
                  value={draft.kind}
                  onChange={(event) => setDraft((value) => ({ ...value, kind: event.target.value as DraftKind }))}
                  className="h-9 w-full rounded-[var(--radius-sm)] border border-input bg-background px-3 text-sm"
                >
                  <option value="agent_work_block">Agent work block</option>
                  <option value="human_event">My event</option>
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
