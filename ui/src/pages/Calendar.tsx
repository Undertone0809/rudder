import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent, CalendarEvent, CalendarSource, GoogleCalendarConnectResponse, GoogleCalendarOAuthConfig, Issue } from "@rudderhq/shared";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
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
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { AgentIcon, AgentIdentity } from "@/components/AgentAvatar";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCalendarWorkspace } from "@/context/CalendarWorkspaceContext";
import { useToast } from "@/context/ToastContext";
import { useViewedOrganization } from "@/hooks/useViewedOrganization";
import { agentUrl, cn, formatDateTime, formatTime, issueUrl } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";
import { layoutTimedEvents } from "@/lib/calendar-event-layout";
import { timedEventSegmentsForDay, type TimedDaySegment } from "@/lib/calendar-day-segments";
import { compactDenseTimedSegments } from "@/lib/calendar-collision-clusters";
import { buildCalendarDisplayItems, type CalendarDisplayCluster, type CalendarDisplayCollisionCluster, type CalendarDisplayItem } from "@/lib/calendar-display-items";
import { formatSidebarAgentLabel } from "@/lib/agent-labels";
import {
  calendarEventRunHref,
  calendarEventSourceLabel,
  formatCalendarDetailTimeRange,
} from "@/lib/calendar-detail";
import { CalendarView, DraftKind, DragMode, CreatePreview, SelectedDisplayCluster, HOUR_HEIGHT, TIME_GUTTER_WIDTH, DAY_MIN_WIDTH, SNAP_MINUTES, MIN_EVENT_MINUTES, DAY_HOURS, AGENT_ACCENTS, MONTH_AGENT_DOTS, STATUS_DOTS, startOfDay, endOfDay, addDays, startOfWeek, startOfMonthGrid, dateKey, sameDay, toInputDateTime, formatDayLabel, formatWeekday, formatMonthDay, formatRangeTitle, rangeForView, moveCursor, minuteOfDay, durationMinutes, clamp, snapMinute, dateAtMinutes, statusLabel, agentAccent, eventAccent, agentById, eventAgent, displayItemAccent, primaryEvent, statusSummary, clusterActivityLabel, collisionParticipantLabel, clusterTitle, clusterParticipantText, formatShortTime, formatTimeRange, displayItemTitle, displayItemSubtitle, monthEventDot, CalendarAgentMarker, CalendarAgentStack, CalendarEventMarker, eventIntersectsDay, formatMonthEventTime, isWritableEvent, visibleEventTitle, defaultDraftStart, newDraft, CalendarDetailLink, CalendarDetailRow, buildEventPayload, EventBlock, CalendarGridView, MonthView, AgendaView } from "./Calendar.parts";

export function Calendar() {
  const { viewedOrganizationId } = useViewedOrganization();
  const { setBreadcrumbs, setHeaderActions } = useBreadcrumbs();
  const {
    cursor,
    setCursor,
    hiddenAgentIds,
    hiddenSourceIds,
    myCalendarVisible,
    visibleStatuses,
    googleCalendarModalOpen,
    setGoogleCalendarModalOpen,
  } = useCalendarWorkspace();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [view, setView] = useState<CalendarView>("week");
  const [currentTime, setCurrentTime] = useState(() => new Date());
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [selectedCluster, setSelectedCluster] = useState<SelectedDisplayCluster | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [quickCreate, setQuickCreate] = useState<null | { x: number; y: number }>(null);
  const [createPreview, setCreatePreview] = useState<CreatePreview>(null);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [draft, setDraft] = useState(() => newDraft());
  const [googleConnectResult, setGoogleConnectResult] = useState<GoogleCalendarConnectResponse | null>(null);
  const [googleConfigForm, setGoogleConfigForm] = useState({ clientId: "", clientSecret: "" });
  const [googleConfigFormDirty, setGoogleConfigFormDirty] = useState(false);

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
    setCreatePreview(startAt && endAt ? { startAt, endAt } : null);
    setQuickCreate(clampQuickCreatePosition(anchor));
  }, [clampQuickCreatePosition]);

  const closeCreateFlow = useCallback(() => {
    setQuickCreate(null);
    setDialogOpen(false);
    setCreatePreview(null);
  }, []);

  useEffect(() => {
    setBreadcrumbs([{ label: "Calendar" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

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
  const googleConfigQuery = useQuery({
    queryKey: queryKeys.calendar.googleConfig(viewedOrganizationId ?? "__none__"),
    queryFn: () => calendarApi.googleConfig(viewedOrganizationId!),
    enabled: !!viewedOrganizationId && googleCalendarModalOpen,
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
  const sourceById = useMemo(
    () => new Map(sources.map((source) => [source.id, source])),
    [sources],
  );
  const googleConfig = googleConfigQuery.data ?? googleConnectResult?.config ?? null;

  useEffect(() => {
    if (!googleCalendarModalOpen) {
      setGoogleConfigFormDirty(false);
      return;
    }
    if (!googleConfig || googleConfigFormDirty) return;
    setGoogleConfigForm({ clientId: googleConfig.clientId, clientSecret: "" });
  }, [googleCalendarModalOpen, googleConfig, googleConfigFormDirty]);

  const visibleEvents = useMemo(() => {
    return (eventsQuery.data?.events ?? []).filter((event) => {
      if (!visibleStatuses.has(event.eventStatus)) return false;
      if (event.eventKind === "human_event") return myCalendarVisible;
      if (event.eventKind === "agent_work_block") {
        return !event.ownerAgentId || !hiddenAgentIds.has(event.ownerAgentId);
      }
      if (event.eventKind === "external_event") {
        if (!event.sourceId || hiddenSourceIds.has(event.sourceId)) return false;
        return sourceById.get(event.sourceId)?.status === "active";
      }
      return true;
    });
  }, [eventsQuery.data?.events, hiddenAgentIds, hiddenSourceIds, myCalendarVisible, sourceById, visibleStatuses]);

  const visibleCreatePreview = useMemo<CreatePreview>(() => {
    if (!createPreview || editingEvent || (!quickCreate && !dialogOpen)) return null;
    const startAt = new Date(draft.startAt);
    const endAt = new Date(draft.endAt);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt.getTime() <= startAt.getTime()) {
      return createPreview;
    }
    return { startAt, endAt };
  }, [createPreview, dialogOpen, draft.endAt, draft.startAt, editingEvent, quickCreate]);

  const invalidateCalendar = async () => {
    if (!viewedOrganizationId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.calendar.sources(viewedOrganizationId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.calendar.googleConfig(viewedOrganizationId) }),
      queryClient.invalidateQueries({ queryKey: ["calendar", viewedOrganizationId] }),
      queryClient.invalidateQueries({ queryKey: queryKeys.activity(viewedOrganizationId) }),
    ]);
  };

  const createEventMutation = useMutation({
    mutationFn: () => calendarApi.createEvent(viewedOrganizationId!, buildEventPayload(draft, agents, issues)),
    onSuccess: async (event) => {
      setQuickCreate(null);
      setDialogOpen(false);
      setCreatePreview(null);
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
    mutationFn: async ({
      sourceId,
      visibilityDefault,
      status,
      syncAfter,
    }: {
      sourceId: string;
      visibilityDefault?: CalendarSource["visibilityDefault"];
      status?: CalendarSource["status"];
      syncAfter?: boolean;
    }) => {
      const source = await calendarApi.updateSource(viewedOrganizationId!, sourceId, {
        ...(visibilityDefault ? { visibilityDefault } : {}),
        ...(status ? { status } : {}),
      });
      if (syncAfter && source.status === "active") {
        await calendarApi.syncGoogle(viewedOrganizationId!, sourceId);
      }
      return source;
    },
    onSuccess: async () => {
      await invalidateCalendar();
      pushToast({ title: "Calendar source updated", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Failed to update calendar source", body: error instanceof Error ? error.message : undefined, tone: "error" }),
  });
  const setGoogleConfigCache = (config: GoogleCalendarOAuthConfig) => {
    if (!viewedOrganizationId) return;
    queryClient.setQueryData(queryKeys.calendar.googleConfig(viewedOrganizationId), config);
  };
  const saveGoogleConfigMutation = useMutation({
    mutationFn: () => calendarApi.updateGoogleConfig(viewedOrganizationId!, {
      clientId: googleConfigForm.clientId.trim(),
      ...(googleConfigForm.clientSecret.trim() ? { clientSecret: googleConfigForm.clientSecret.trim() } : {}),
    }),
    onSuccess: async (config) => {
      setGoogleConfigCache(config);
      setGoogleConfigForm({ clientId: config.clientId, clientSecret: "" });
      setGoogleConfigFormDirty(false);
      await invalidateCalendar();
      pushToast({ title: "Google Calendar OAuth settings saved", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Failed to save Google Calendar settings", body: error instanceof Error ? error.message : undefined, tone: "error" }),
  });
  const clearGoogleConfigMutation = useMutation({
    mutationFn: () => calendarApi.updateGoogleConfig(viewedOrganizationId!, { clear: true }),
    onSuccess: async (config) => {
      setGoogleConfigCache(config);
      setGoogleConfigForm({ clientId: "", clientSecret: "" });
      setGoogleConfigFormDirty(false);
      await invalidateCalendar();
      pushToast({ title: "Google Calendar OAuth settings cleared", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Failed to clear Google Calendar settings", body: error instanceof Error ? error.message : undefined, tone: "error" }),
  });
  const connectGoogleMutation = useMutation({
    mutationFn: () => calendarApi.connectGoogle(viewedOrganizationId!),
    onSuccess: async (result) => {
      setGoogleConnectResult(result);
      await invalidateCalendar();
      if (result.authUrl) {
        window.location.href = result.authUrl;
        return;
      }
      setGoogleCalendarModalOpen(true);
    },
    onError: (error) => {
      setGoogleCalendarModalOpen(true);
      pushToast({ title: "Google Calendar connection failed", body: error instanceof Error ? error.message : undefined, tone: "error" });
    },
  });
  const saveAndConnectGoogleMutation = useMutation({
    mutationFn: async () => {
      const config = await calendarApi.updateGoogleConfig(viewedOrganizationId!, {
        clientId: googleConfigForm.clientId.trim(),
        ...(googleConfigForm.clientSecret.trim() ? { clientSecret: googleConfigForm.clientSecret.trim() } : {}),
      });
      setGoogleConfigCache(config);
      setGoogleConfigForm({ clientId: config.clientId, clientSecret: "" });
      setGoogleConfigFormDirty(false);
      return calendarApi.connectGoogle(viewedOrganizationId!);
    },
    onSuccess: async (result) => {
      setGoogleConnectResult(result);
      await invalidateCalendar();
      if (result.authUrl) {
        window.location.href = result.authUrl;
        return;
      }
      setGoogleCalendarModalOpen(true);
    },
    onError: (error) => {
      setGoogleCalendarModalOpen(true);
      pushToast({ title: "Google Calendar connection failed", body: error instanceof Error ? error.message : undefined, tone: "error" });
    },
  });
  const syncGoogleMutation = useMutation({
    mutationFn: (sourceId?: string | null) => calendarApi.syncGoogle(viewedOrganizationId!, sourceId),
    onSuccess: async (result) => {
      await invalidateCalendar();
      pushToast({ title: "Google Calendar synced", body: `${result.importedCount} new event${result.importedCount === 1 ? "" : "s"} imported.`, tone: "success" });
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

  function selectCalendarGridItem(item: CalendarDisplayItem) {
    if (item.kind !== "single") {
      setSelectedEvent(null);
      setSelectedCluster(item);
      return;
    }
    setSelectedCluster(null);
    setSelectedEvent(item.event);
  }

  function openClusterEvent(event: CalendarEvent) {
    setSelectedCluster(null);
    setSelectedEvent(event);
  }

  function openClusterDay(cluster: SelectedDisplayCluster) {
    setCursor(startOfDay(cluster.startAt));
    setView("day");
    setSelectedCluster(null);
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
  const googleSources = sources
    .filter((source) => source.type === "google_calendar")
    .sort((a, b) => {
      const primaryDelta = (a.externalCalendarId === "primary" ? 0 : 1) - (b.externalCalendarId === "primary" ? 0 : 1);
      return primaryDelta !== 0 ? primaryDelta : a.name.localeCompare(b.name);
    });
  const googleSource = googleSources.find((source) => source.externalCalendarId === "primary") ?? googleSources[0] ?? null;
  const googleEnabledCount = googleSources.filter((source) => source.status === "active").length;
  const googleLastSyncedAt = googleSources
    .map((source) => source.lastSyncedAt)
    .filter((value): value is NonNullable<CalendarSource["lastSyncedAt"]> => !!value)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null;
  const redirectUri = typeof window === "undefined"
    ? `/api/orgs/${encodeURIComponent(viewedOrganizationId)}/calendar/google/callback`
    : `${window.location.origin}/api/orgs/${encodeURIComponent(viewedOrganizationId)}/calendar/google/callback`;
  const activeGoogleRedirectUri = googleConfig?.redirectUri ?? googleConnectResult?.redirectUri ?? redirectUri;
  const googleManagedByEnv = googleConfig?.managedByEnv ?? false;
  const googleOauthConfigured = !!googleConfig?.clientSecretConfigured || googleManagedByEnv;
  const googleConfigRequired =
    googleConnectResult?.status === "configuration_required" ||
    (googleSource?.status === "error" && !googleSource.lastSyncedAt && !googleOauthConfigured);
  const requiredGoogleEnv = googleConfig?.requiredEnv ?? googleConnectResult?.requiredEnv ?? [
    "GOOGLE_CALENDAR_CLIENT_ID",
    "GOOGLE_CALENDAR_CLIENT_SECRET",
  ];
  const acceptedGoogleAliases = googleConfig?.acceptedAliases ?? googleConnectResult?.acceptedAliases ?? [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
  ];
  const googleConfigCanSave =
    !googleManagedByEnv &&
    googleConfigForm.clientId.trim().length > 0 &&
    (googleConfigForm.clientSecret.trim().length > 0 || !!googleConfig?.clientSecretConfigured);
  const googleConfigDirty =
    !googleManagedByEnv &&
    (googleConfigForm.clientId.trim() !== (googleConfig?.clientId ?? "") ||
      googleConfigForm.clientSecret.trim().length > 0);
  const googleConfigActionPending =
    saveGoogleConfigMutation.isPending ||
    clearGoogleConfigMutation.isPending ||
    saveAndConnectGoogleMutation.isPending;
  const selectedClusterAgent = selectedCluster?.kind === "collision_cluster" && selectedCluster.agentIds.length !== 1
    ? null
    : selectedCluster?.events.find((event) => event.agent)?.agent ?? null;
  const selectedEventRunHref = selectedEvent ? calendarEventRunHref(selectedEvent) : null;

  return (
    <div className="flex h-full min-h-[720px] min-w-0 flex-col gap-3">
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
        <CalendarGridView
          view={view}
          days={days}
          events={visibleEvents}
          agents={agents}
          currentTime={currentTime}
          onSelect={selectCalendarGridItem}
          onCreateSelection={(startAt, endAt, anchor) => openQuickCreate("human_event", startAt, endAt, anchor)}
          onUpdateEventTime={(event, startAt, endAt) => moveEventMutation.mutate({ event, startAt, endAt })}
          createPreview={visibleCreatePreview}
        />
      ) : view === "month" ? (
        <MonthView cursor={cursor} events={visibleEvents} agents={agents} currentTime={currentTime} onSelect={setSelectedEvent} />
      ) : (
        <AgendaView events={visibleEvents} agents={agents} onSelect={setSelectedEvent} />
      )}

      {quickCreate ? (
        <div
          data-testid="calendar-quick-create"
          className="fixed z-50 w-[360px] rounded-[var(--radius-sm)] border border-border bg-popover p-3 text-popover-foreground shadow-xl animate-in fade-in-0 zoom-in-95 slide-in-from-top-1 duration-150"
          style={{ left: quickCreate.x, top: quickCreate.y }}
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="text-sm font-semibold">Create</div>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Close create popover" onClick={closeCreateFlow}>
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
            <Textarea
              aria-label="Description"
              value={draft.description}
              onChange={(event) => setDraft((value) => ({ ...value, description: event.target.value }))}
              placeholder="Add description"
              rows={2}
              className="resize-none"
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
                    <option key={agent.id} value={agent.id}>{formatSidebarAgentLabel(agent)}</option>
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

      <Dialog open={googleCalendarModalOpen} onOpenChange={setGoogleCalendarModalOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Google Calendar</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-1 text-sm">
            <div className="rounded-[var(--radius-sm)] border border-border bg-muted/25 p-3 text-xs leading-5 text-muted-foreground">
              Read-only import for the operator calendar. Imported event titles are visible in Rudder when enabled; private Google events stay Busy, descriptions are not imported, and calendar data never enters agent context.
            </div>

            {googleSource?.status === "active" ? (
              <div className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-emerald-500/20 bg-emerald-500/10 p-3 text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-4 w-4" />
                <span className="font-medium">Connected</span>
              </div>
            ) : googleConfigRequired ? (
              <div className="space-y-3 rounded-[var(--radius-sm)] border border-amber-500/25 bg-amber-500/10 p-3">
                <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
                  <AlertCircle className="h-4 w-4" />
                  <span className="font-medium">OAuth configuration required</span>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  Enter a Google OAuth client ID and client secret below, then connect this organization calendar.
                </p>
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-border bg-muted/25 p-3 text-muted-foreground">
                <AlertCircle className="h-4 w-4" />
                <span className="font-medium">Disconnected</span>
              </div>
            )}

            <div className="space-y-3 rounded-[var(--radius-sm)] border border-border bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-medium text-foreground">OAuth settings</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {googleManagedByEnv
                      ? "Managed by server environment variables"
                      : googleConfig?.clientSecretConfigured
                        ? "Stored for this organization"
                        : "Not configured"}
                  </div>
                </div>
                {googleConfigQuery.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
              </div>

              {googleManagedByEnv ? (
                <div className="space-y-2 text-xs leading-5 text-muted-foreground">
                  <div className="rounded-[calc(var(--radius-sm)-1px)] border border-border bg-background p-2">
                    Server environment variables are active. UI edits are disabled until those variables are removed.
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <div className="mb-1 text-[11px] font-medium text-muted-foreground">Required env</div>
                      <div className="rounded-[calc(var(--radius-sm)-1px)] border border-border bg-background p-2 font-mono text-[11px] text-foreground">
                        {requiredGoogleEnv.map((name) => <div key={name}>{name}</div>)}
                      </div>
                    </div>
                    <div>
                      <div className="mb-1 text-[11px] font-medium text-muted-foreground">Accepted aliases</div>
                      <div className="rounded-[calc(var(--radius-sm)-1px)] border border-border bg-background p-2 font-mono text-[11px] text-foreground">
                        {acceptedGoogleAliases.map((name) => <div key={name}>{name}</div>)}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="grid gap-3">
                  <label className="space-y-1.5 text-xs text-muted-foreground">
                    <span>Client ID</span>
                    <Input
                      value={googleConfigForm.clientId}
                      onChange={(event) => {
                        setGoogleConfigFormDirty(true);
                        setGoogleConfigForm((current) => ({ ...current, clientId: event.target.value }));
                      }}
                      placeholder="Google OAuth client ID"
                      disabled={googleConfigActionPending}
                    />
                  </label>
                  <label className="space-y-1.5 text-xs text-muted-foreground">
                    <span>Client secret</span>
                    <Input
                      type="password"
                      value={googleConfigForm.clientSecret}
                      onChange={(event) => {
                        setGoogleConfigFormDirty(true);
                        setGoogleConfigForm((current) => ({ ...current, clientSecret: event.target.value }));
                      }}
                      placeholder={googleConfig?.clientSecretConfigured ? "Stored. Enter a new value to rotate." : "Google OAuth client secret"}
                      disabled={googleConfigActionPending}
                    />
                  </label>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[11px] text-muted-foreground">
                      {googleConfig?.clientSecretConfigured ? "Client secret is stored and never shown again." : "Client secret is required before connecting."}
                    </div>
                    <div className="flex gap-2">
                      {googleConfig?.clientSecretConfigured ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() => clearGoogleConfigMutation.mutate()}
                          disabled={googleConfigActionPending}
                        >
                          Clear
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={() => saveGoogleConfigMutation.mutate()}
                        disabled={!googleConfigCanSave || !googleConfigDirty || googleConfigActionPending}
                      >
                        {saveGoogleConfigMutation.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                        Save settings
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-1.5 text-xs text-muted-foreground">
                <span>Redirect URI</span>
                <div className="flex gap-2">
                  <div className="min-w-0 flex-1 break-all rounded-[calc(var(--radius-sm)-1px)] border border-border bg-background p-2 font-mono text-[11px] text-foreground">
                    {activeGoogleRedirectUri}
                  </div>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="outline"
                    aria-label="Copy Google Calendar redirect URI"
                    onClick={() => navigator.clipboard?.writeText(activeGoogleRedirectUri)}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>

            {googleSource ? (
              <div className="grid gap-4">
                <label className="space-y-1.5 text-xs text-muted-foreground">
                  <span>Imported visibility</span>
                  <select
                    value={googleSource.visibilityDefault}
                    onChange={(event) => updateSourceMutation.mutate({
                      sourceId: googleSource.id,
                      visibilityDefault: event.target.value as CalendarSource["visibilityDefault"],
                      syncAfter: googleSource.type === "google_calendar",
                    })}
                    className="h-9 w-full rounded-[var(--radius-sm)] border border-input bg-background px-3 text-sm text-foreground"
                  >
                    <option value="busy_only">Busy only</option>
                    <option value="full">Show titles</option>
                    <option value="private">Private</option>
                  </select>
                </label>

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-xs font-medium text-foreground">Calendars</div>
                      <div className="text-[11px] text-muted-foreground">
                        {googleEnabledCount} of {googleSources.length} enabled
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => syncGoogleMutation.mutate(null)}
                      disabled={syncGoogleMutation.isPending || googleSource.status === "error"}
                    >
                      {syncGoogleMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                      Refresh
                    </Button>
                  </div>
                  <div className="max-h-56 overflow-y-auto rounded-[var(--radius-sm)] border border-border">
                    {googleSources.map((source, index) => (
                      <label
                        key={source.id}
                        className="flex min-h-10 items-center gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0 hover:bg-muted/35"
                      >
                        <Checkbox
                          checked={source.status === "active"}
                          disabled={updateSourceMutation.isPending}
                          onCheckedChange={(checked) => updateSourceMutation.mutate({
                            sourceId: source.id,
                            status: checked === true ? "active" : "paused",
                            syncAfter: checked === true,
                          })}
                          aria-label={`Enable ${source.name}`}
                        />
                        <span
                          className={cn(
                            "h-2.5 w-2.5 shrink-0 rounded-sm border",
                            [
                              "border-blue-400 bg-blue-500",
                              "border-emerald-400 bg-emerald-500",
                              "border-amber-400 bg-amber-500",
                              "border-rose-400 bg-rose-500",
                              "border-cyan-400 bg-cyan-500",
                              "border-violet-400 bg-violet-500",
                            ][index % 6],
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate">{source.name}</span>
                        {source.status !== "active" ? (
                          <span className="shrink-0 rounded-[calc(var(--radius-sm)-2px)] border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            Off
                          </span>
                        ) : null}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  Last synced {googleLastSyncedAt ? formatDateTime(googleLastSyncedAt) : "never"}
                </div>
              </div>
            ) : null}
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button type="button" variant="ghost" onClick={() => setGoogleCalendarModalOpen(false)}>
              Close
            </Button>
            <div className="flex gap-2">
              {googleSource ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => syncGoogleMutation.mutate(null)}
                  disabled={syncGoogleMutation.isPending || googleSource.status === "error"}
                >
                  {syncGoogleMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
                  Sync now
                </Button>
              ) : null}
              <Button
                type="button"
                onClick={() => {
                  if (!googleOauthConfigured && !googleManagedByEnv) {
                    saveAndConnectGoogleMutation.mutate();
                    return;
                  }
                  connectGoogleMutation.mutate();
                }}
                disabled={
                  connectGoogleMutation.isPending ||
                  saveAndConnectGoogleMutation.isPending ||
                  (!googleOauthConfigured && !googleConfigCanSave)
                }
              >
                {connectGoogleMutation.isPending || saveAndConnectGoogleMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="mr-1.5 h-3.5 w-3.5" />}
                {!googleOauthConfigured && !googleManagedByEnv ? "Save and connect" : "Connect"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Sheet open={!!selectedCluster} onOpenChange={(open) => !open && setSelectedCluster(null)}>
        <SheetContent className="w-full sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{selectedCluster ? clusterTitle(selectedCluster) : "Agent activity"}</SheetTitle>
          </SheetHeader>
          {selectedCluster ? (
            <div className="space-y-5 overflow-y-auto px-4 pb-4 text-sm">
              <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-y-2">
                <span className="text-muted-foreground">{selectedCluster.kind === "cluster" ? "Agent" : "Participants"}</span>
                <span className="flex min-w-0 items-center gap-2">
                  {selectedCluster.kind === "cluster" ? (
                    <CalendarAgentMarker agent={agentById(selectedCluster.agentId, agents)} />
                  ) : (
                    <CalendarAgentStack agentIds={selectedCluster.agentIds} agents={agents} max={4} />
                  )}
                  <span className="min-w-0 truncate">{clusterParticipantText(selectedCluster)}</span>
                </span>
                <span className="text-muted-foreground">Window</span>
                <span>{formatDateTime(selectedCluster.startAt)} - {formatShortTime(selectedCluster.endAt)}</span>
                <span className="text-muted-foreground">Activity</span>
                <span>{selectedCluster.events.length} underlying events</span>
                <span className="text-muted-foreground">Status</span>
                <span>{statusSummary(selectedCluster.statusCounts)}</span>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">Underlying events</div>
                <div className="overflow-hidden rounded-[var(--radius-sm)] border border-border">
                  {selectedCluster.events.map((event) => (
                    <button
                      key={event.id}
                      type="button"
                      className="grid w-full grid-cols-[108px_minmax(0,1fr)_96px] items-center gap-3 border-b border-border px-3 py-2 text-left text-xs last:border-b-0 hover:bg-muted/35"
                      onClick={() => openClusterEvent(event)}
                    >
                      <span className="tabular-nums text-muted-foreground">{formatTimeRange(event.startAt, event.endAt)}</span>
                      <span className="flex min-w-0 items-center gap-2">
                        <CalendarEventMarker event={event} agents={agents} />
                        <span className="min-w-0 flex-1 truncate font-medium">{visibleEventTitle(event)}</span>
                      </span>
                      <span className="flex items-center justify-end gap-1.5 text-muted-foreground">
                        <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOTS[event.eventStatus])} />
                        {statusLabel(event.eventStatus)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {selectedClusterAgent ? (
                <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                  <Button asChild variant="outline" size="sm">
                    <Link to={agentUrl(selectedClusterAgent)}>Open agent</Link>
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => openClusterDay(selectedCluster)}>
                    Open day view
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                  <Button type="button" variant="outline" size="sm" onClick={() => openClusterDay(selectedCluster)}>
                    Open day view
                  </Button>
                </div>
              )}
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      <Sheet open={!!selectedEvent} onOpenChange={(open) => !open && setSelectedEvent(null)}>
        <SheetContent className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{selectedEvent ? visibleEventTitle(selectedEvent) : "Calendar block"}</SheetTitle>
          </SheetHeader>
          {selectedEvent ? (
            <div className="space-y-5 overflow-y-auto px-4 pb-4 text-sm">
              <dl className="space-y-2 text-sm leading-5">
                <CalendarDetailRow label="Status">
                  {statusLabel(selectedEvent.eventStatus)}
                </CalendarDetailRow>
                <CalendarDetailRow label="Source">
                  {selectedEventRunHref ? (
                    <CalendarDetailLink to={selectedEventRunHref} ariaLabel={`Open source run ${selectedEvent.heartbeatRunId}`}>
                      {calendarEventSourceLabel(selectedEvent)}
                    </CalendarDetailLink>
                  ) : (
                    calendarEventSourceLabel(selectedEvent)
                  )}
                </CalendarDetailRow>
                <CalendarDetailRow label="Time" valueClassName="overflow-x-auto whitespace-nowrap font-mono tabular-nums">
                  {formatCalendarDetailTimeRange(selectedEvent.startAt, selectedEvent.endAt)}
                </CalendarDetailRow>
                <CalendarDetailRow label="Agent">
                  {selectedEvent.agent ? (
                    <CalendarDetailLink to={agentUrl(selectedEvent.agent)} ariaLabel={`Open agent ${selectedEvent.agent.name}`}>
                      <AgentIdentity
                        name={selectedEvent.agent.name}
                        icon={eventAgent(selectedEvent, agents)?.icon}
                        role={eventAgent(selectedEvent, agents)?.role ?? null}
                        size="xs"
                        className="min-w-0"
                      />
                    </CalendarDetailLink>
                  ) : (
                    "None"
                  )}
                </CalendarDetailRow>
                <CalendarDetailRow label="Issue">
                  {selectedEvent.issue ? (
                    <CalendarDetailLink
                      to={issueUrl(selectedEvent.issue)}
                      ariaLabel={`Open issue ${selectedEvent.issue.identifier ?? selectedEvent.issue.title}`}
                    >
                      {selectedEvent.issue.identifier ?? selectedEvent.issue.title}
                    </CalendarDetailLink>
                  ) : (
                    "None"
                  )}
                </CalendarDetailRow>
              </dl>
              {isWritableEvent(selectedEvent) && selectedEvent.description ? (
                <p className="rounded-[var(--radius-sm)] border border-border bg-muted/30 p-3 text-sm leading-6">
                  {selectedEvent.description}
                </p>
              ) : null}
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
              ) : null}
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      <Dialog open={dialogOpen} onOpenChange={(open) => {
        setDialogOpen(open);
        if (!open && !quickCreate) setCreatePreview(null);
      }}>
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
