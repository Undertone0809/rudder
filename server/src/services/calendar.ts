import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@rudderhq/db";
import {
  activityLog,
  agents,
  approvals,
  calendarEvents,
  calendarSources,
  goals,
  heartbeatRuns,
  issues,
  projects,
} from "@rudderhq/db";
import type {
  CalendarEvent,
  CalendarEventKind,
  CalendarEventStatus,
  CalendarSource,
  CalendarSourceStatus,
  CalendarVisibility,
  CreateCalendarEvent,
  CreateCalendarSource,
  UpdateCalendarEvent,
  UpdateCalendarSource,
} from "@rudderhq/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";

type Actor = { userId?: string | null };

export interface CalendarEventFilters {
  start: Date;
  end: Date;
  agentIds?: string[];
  sourceIds?: string[];
  eventKinds?: string[];
  statuses?: string[];
}

function sanitizeSource(row: typeof calendarSources.$inferSelect): CalendarSource {
  const rawCursor = row.syncCursorJson ?? null;
  const cursor = rawCursor && typeof rawCursor === "object"
    ? {
      ...rawCursor,
      accessToken: typeof rawCursor.accessToken === "string" ? "[redacted]" : undefined,
      refreshToken: typeof rawCursor.refreshToken === "string" ? "[redacted]" : undefined,
    }
    : null;
  return {
    ...row,
    type: row.type as CalendarSource["type"],
    ownerType: row.ownerType as CalendarSource["ownerType"],
    visibilityDefault: row.visibilityDefault as CalendarSource["visibilityDefault"],
    status: row.status as CalendarSource["status"],
    syncCursorJson: cursor,
  };
}

function csvIncludes(filters: string[] | undefined, value: string) {
  return !filters || filters.length === 0 || filters.includes(value);
}

function parseSyncCursor(value: Record<string, unknown> | null | undefined) {
  if (!value) return {};
  return value;
}

function googleCredentials() {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID?.trim() || process.env.GOOGLE_CLIENT_ID?.trim() || "";
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET?.trim() || process.env.GOOGLE_CLIENT_SECRET?.trim() || "";
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function eventSummary(event: Pick<typeof calendarEvents.$inferSelect, "title" | "eventKind" | "eventStatus" | "startAt" | "endAt" | "ownerAgentId" | "issueId">) {
  return {
    title: event.title,
    eventKind: event.eventKind,
    eventStatus: event.eventStatus,
    startAt: event.startAt.toISOString(),
    endAt: event.endAt.toISOString(),
    ownerAgentId: event.ownerAgentId,
    issueId: event.issueId,
  };
}

function createEventValues(orgId: string, input: CreateCalendarEvent, actor?: Actor): typeof calendarEvents.$inferInsert {
  return {
    orgId,
    sourceId: input.sourceId ?? null,
    eventKind: input.eventKind,
    eventStatus: input.eventStatus,
    ownerType: input.ownerType,
    ownerUserId: input.ownerUserId ?? null,
    ownerAgentId: input.ownerAgentId ?? null,
    title: input.title,
    description: input.description ?? null,
    startAt: input.startAt,
    endAt: input.endAt,
    timezone: input.timezone,
    allDay: input.allDay,
    visibility: input.visibility,
    issueId: input.issueId ?? null,
    projectId: input.projectId ?? null,
    goalId: input.goalId ?? null,
    approvalId: input.approvalId ?? null,
    heartbeatRunId: input.heartbeatRunId ?? null,
    activityId: input.activityId ?? null,
    sourceMode: input.sourceMode,
    externalProvider: input.externalProvider ?? null,
    externalCalendarId: input.externalCalendarId ?? null,
    externalEventId: input.externalEventId ?? null,
    externalEtag: input.externalEtag ?? null,
    externalUpdatedAt: input.externalUpdatedAt ?? null,
    createdByUserId: actor?.userId ?? null,
    updatedByUserId: actor?.userId ?? null,
  };
}

function updateEventValues(input: UpdateCalendarEvent, actor?: Actor): Partial<typeof calendarEvents.$inferInsert> {
  const values: Partial<typeof calendarEvents.$inferInsert> = {
    updatedByUserId: actor?.userId ?? null,
  };
  if (input.sourceId !== undefined) values.sourceId = input.sourceId ?? null;
  if (input.eventKind !== undefined) values.eventKind = input.eventKind;
  if (input.eventStatus !== undefined) values.eventStatus = input.eventStatus;
  if (input.ownerType !== undefined) values.ownerType = input.ownerType;
  if (input.ownerUserId !== undefined) values.ownerUserId = input.ownerUserId ?? null;
  if (input.ownerAgentId !== undefined) values.ownerAgentId = input.ownerAgentId ?? null;
  if (input.title !== undefined) values.title = input.title;
  if (input.description !== undefined) values.description = input.description ?? null;
  if (input.startAt !== undefined) values.startAt = input.startAt;
  if (input.endAt !== undefined) values.endAt = input.endAt;
  if (input.timezone !== undefined) values.timezone = input.timezone;
  if (input.allDay !== undefined) values.allDay = input.allDay;
  if (input.visibility !== undefined) values.visibility = input.visibility;
  if (input.issueId !== undefined) values.issueId = input.issueId ?? null;
  if (input.projectId !== undefined) values.projectId = input.projectId ?? null;
  if (input.goalId !== undefined) values.goalId = input.goalId ?? null;
  if (input.approvalId !== undefined) values.approvalId = input.approvalId ?? null;
  if (input.heartbeatRunId !== undefined) values.heartbeatRunId = input.heartbeatRunId ?? null;
  if (input.activityId !== undefined) values.activityId = input.activityId ?? null;
  if (input.sourceMode !== undefined) values.sourceMode = input.sourceMode;
  if (input.externalProvider !== undefined) values.externalProvider = input.externalProvider ?? null;
  if (input.externalCalendarId !== undefined) values.externalCalendarId = input.externalCalendarId ?? null;
  if (input.externalEventId !== undefined) values.externalEventId = input.externalEventId ?? null;
  if (input.externalEtag !== undefined) values.externalEtag = input.externalEtag ?? null;
  if (input.externalUpdatedAt !== undefined) values.externalUpdatedAt = input.externalUpdatedAt ?? null;
  return values;
}

function mergeEventInput(
  existing: typeof calendarEvents.$inferSelect,
  input: UpdateCalendarEvent,
): CreateCalendarEvent {
  return {
    sourceId: input.sourceId === undefined ? existing.sourceId : input.sourceId,
    eventKind: (input.eventKind ?? existing.eventKind) as CreateCalendarEvent["eventKind"],
    eventStatus: (input.eventStatus ?? existing.eventStatus) as CreateCalendarEvent["eventStatus"],
    ownerType: (input.ownerType ?? existing.ownerType) as CreateCalendarEvent["ownerType"],
    ownerUserId: input.ownerUserId === undefined ? existing.ownerUserId : input.ownerUserId,
    ownerAgentId: input.ownerAgentId === undefined ? existing.ownerAgentId : input.ownerAgentId,
    title: input.title ?? existing.title,
    description: input.description === undefined ? existing.description : input.description,
    startAt: input.startAt ?? existing.startAt,
    endAt: input.endAt ?? existing.endAt,
    timezone: input.timezone ?? existing.timezone,
    allDay: input.allDay ?? existing.allDay,
    visibility: (input.visibility ?? existing.visibility) as CreateCalendarEvent["visibility"],
    issueId: input.issueId === undefined ? existing.issueId : input.issueId,
    projectId: input.projectId === undefined ? existing.projectId : input.projectId,
    goalId: input.goalId === undefined ? existing.goalId : input.goalId,
    approvalId: input.approvalId === undefined ? existing.approvalId : input.approvalId,
    heartbeatRunId: input.heartbeatRunId === undefined ? existing.heartbeatRunId : input.heartbeatRunId,
    activityId: input.activityId === undefined ? existing.activityId : input.activityId,
    sourceMode: (input.sourceMode ?? existing.sourceMode) as CreateCalendarEvent["sourceMode"],
    externalProvider: input.externalProvider === undefined ? existing.externalProvider : input.externalProvider,
    externalCalendarId: input.externalCalendarId === undefined ? existing.externalCalendarId : input.externalCalendarId,
    externalEventId: input.externalEventId === undefined ? existing.externalEventId : input.externalEventId,
    externalEtag: input.externalEtag === undefined ? existing.externalEtag : input.externalEtag,
    externalUpdatedAt: input.externalUpdatedAt === undefined ? existing.externalUpdatedAt : input.externalUpdatedAt,
  };
}

export function calendarService(db: Db) {
  const issueIdAsText = sql<string>`${issues.id}::text`;
  const contextIssueId = sql<string>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;

  async function assertSourceOrg(orgId: string, sourceId: string | null | undefined) {
    if (!sourceId) return null;
    const source = await db
      .select()
      .from(calendarSources)
      .where(and(eq(calendarSources.id, sourceId), eq(calendarSources.orgId, orgId)))
      .then((rows) => rows[0] ?? null);
    if (!source) throw notFound("Calendar source not found");
    return source;
  }

  async function assertAgentOrg(orgId: string, agentId: string | null | undefined) {
    if (!agentId) return null;
    const agent = await db
      .select({ id: agents.id, orgId: agents.orgId, status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");
    if (agent.orgId !== orgId) throw unprocessable("Agent must belong to same organization");
    if (agent.status === "terminated") throw conflict("Cannot create calendar blocks for terminated agents");
    return agent;
  }

  async function assertIssueOrg(orgId: string, issueId: string | null | undefined) {
    if (!issueId) return null;
    const issue = await db
      .select({ id: issues.id, orgId: issues.orgId, hiddenAt: issues.hiddenAt })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue || issue.hiddenAt) throw notFound("Issue not found");
    if (issue.orgId !== orgId) throw unprocessable("Issue must belong to same organization");
    return issue;
  }

  async function assertProjectOrg(orgId: string, projectId: string | null | undefined) {
    if (!projectId) return null;
    const project = await db
      .select({ id: projects.id, orgId: projects.orgId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .then((rows) => rows[0] ?? null);
    if (!project) throw notFound("Project not found");
    if (project.orgId !== orgId) throw unprocessable("Project must belong to same organization");
    return project;
  }

  async function assertGoalOrg(orgId: string, goalId: string | null | undefined) {
    if (!goalId) return null;
    const goal = await db
      .select({ id: goals.id, orgId: goals.orgId })
      .from(goals)
      .where(eq(goals.id, goalId))
      .then((rows) => rows[0] ?? null);
    if (!goal) throw notFound("Goal not found");
    if (goal.orgId !== orgId) throw unprocessable("Goal must belong to same organization");
    return goal;
  }

  async function assertApprovalOrg(orgId: string, approvalId: string | null | undefined) {
    if (!approvalId) return null;
    const approval = await db
      .select({ id: approvals.id, orgId: approvals.orgId })
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .then((rows) => rows[0] ?? null);
    if (!approval) throw notFound("Approval not found");
    if (approval.orgId !== orgId) throw unprocessable("Approval must belong to same organization");
    return approval;
  }

  async function assertRunOrg(orgId: string, runId: string | null | undefined) {
    if (!runId) return null;
    const run = await db
      .select({ id: heartbeatRuns.id, orgId: heartbeatRuns.orgId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run) throw notFound("Heartbeat run not found");
    if (run.orgId !== orgId) throw unprocessable("Heartbeat run must belong to same organization");
    return run;
  }

  async function assertActivityOrg(orgId: string, activityId: string | null | undefined) {
    if (!activityId) return null;
    const activity = await db
      .select({ id: activityLog.id, orgId: activityLog.orgId })
      .from(activityLog)
      .where(eq(activityLog.id, activityId))
      .then((rows) => rows[0] ?? null);
    if (!activity) throw notFound("Activity event not found");
    if (activity.orgId !== orgId) throw unprocessable("Activity event must belong to same organization");
    return activity;
  }

  async function assertCalendarEventShape(orgId: string, input: CreateCalendarEvent | UpdateCalendarEvent) {
    if (input.eventKind === "agent_work_block") {
      if (input.ownerAgentId === null) throw unprocessable("Agent work blocks require an agent");
      if (input.ownerType && input.ownerType !== "agent") throw unprocessable("Agent work blocks must be owned by an agent");
    }
    if (input.eventKind === "human_event" && input.ownerType && input.ownerType !== "user") {
      throw unprocessable("Human calendar events must be owned by a user");
    }
    if (input.sourceMode && input.sourceMode !== "manual" && input.sourceMode !== "imported") {
      throw forbidden("Derived calendar events are read-only");
    }
    await Promise.all([
      assertSourceOrg(orgId, input.sourceId),
      assertAgentOrg(orgId, input.ownerAgentId),
      assertIssueOrg(orgId, input.issueId),
      assertProjectOrg(orgId, input.projectId),
      assertGoalOrg(orgId, input.goalId),
      assertApprovalOrg(orgId, input.approvalId),
      assertRunOrg(orgId, input.heartbeatRunId),
      assertActivityOrg(orgId, input.activityId),
    ]);
  }

  function mapPersistedEvent(row: {
    event: typeof calendarEvents.$inferSelect;
    sourceId: string | null;
    sourceType: string | null;
    sourceName: string | null;
    sourceVisibilityDefault: string | null;
    sourceExternalProvider: string | null;
    agentName: string | null;
    agentRole: string | null;
    agentTitle: string | null;
    agentUrlKey: string | null;
    issueIdentifier: string | null;
    issueTitle: string | null;
    issueStatus: string | null;
    issuePriority: string | null;
  }): CalendarEvent {
    return {
      ...row.event,
      eventKind: row.event.eventKind as CalendarEventKind,
      eventStatus: row.event.eventStatus as CalendarEventStatus,
      ownerType: row.event.ownerType as CalendarEvent["ownerType"],
      visibility: row.event.visibility as CalendarVisibility,
      sourceMode: row.event.sourceMode as CalendarEvent["sourceMode"],
      source: row.sourceId
        ? {
          id: row.sourceId,
          type: row.sourceType as CalendarSource["type"],
          name: row.sourceName ?? "Calendar",
          visibilityDefault: (row.sourceVisibilityDefault ?? "full") as CalendarVisibility,
          externalProvider: row.sourceExternalProvider,
        }
        : null,
      agent: row.event.ownerAgentId && row.agentName
        ? {
          id: row.event.ownerAgentId,
          name: row.agentName,
          role: row.agentRole ?? "general",
          title: row.agentTitle,
          urlKey: row.agentUrlKey,
        }
        : null,
      issue: row.event.issueId && row.issueTitle
        ? {
          id: row.event.issueId,
          identifier: row.issueIdentifier,
          title: row.issueTitle,
          status: row.issueStatus ?? "todo",
          priority: row.issuePriority ?? "medium",
        }
        : null,
    };
  }

  async function listPersistedEvents(orgId: string, filters: CalendarEventFilters) {
    const conditions = [
      eq(calendarEvents.orgId, orgId),
      isNull(calendarEvents.deletedAt),
      lt(calendarEvents.startAt, filters.end),
      gt(calendarEvents.endAt, filters.start),
    ];
    if (filters.agentIds?.length) {
      conditions.push(inArray(calendarEvents.ownerAgentId, filters.agentIds));
    }
    if (filters.sourceIds?.length) {
      conditions.push(inArray(calendarEvents.sourceId, filters.sourceIds));
    }
    if (filters.eventKinds?.length) {
      conditions.push(inArray(calendarEvents.eventKind, filters.eventKinds));
    }
    if (filters.statuses?.length) {
      conditions.push(inArray(calendarEvents.eventStatus, filters.statuses));
    }

    const rows = await db
      .select({
        event: calendarEvents,
        sourceId: calendarSources.id,
        sourceType: calendarSources.type,
        sourceName: calendarSources.name,
        sourceVisibilityDefault: calendarSources.visibilityDefault,
        sourceExternalProvider: calendarSources.externalProvider,
        agentName: agents.name,
        agentRole: agents.role,
        agentTitle: agents.title,
        agentUrlKey: agents.workspaceKey,
        issueIdentifier: issues.identifier,
        issueTitle: issues.title,
        issueStatus: issues.status,
        issuePriority: issues.priority,
      })
      .from(calendarEvents)
      .leftJoin(calendarSources, eq(calendarEvents.sourceId, calendarSources.id))
      .leftJoin(agents, eq(calendarEvents.ownerAgentId, agents.id))
      .leftJoin(issues, eq(calendarEvents.issueId, issues.id))
      .where(and(...conditions))
      .orderBy(asc(calendarEvents.startAt), asc(calendarEvents.title));

    return rows.map(mapPersistedEvent);
  }

  async function listRunIssueFallbacks(orgId: string, runIds: string[]) {
    if (runIds.length === 0) return new Map<string, {
      activityId: string;
      issue: NonNullable<CalendarEvent["issue"]>;
    }>();
    const rows = await db
      .selectDistinctOn([activityLog.runId], {
        runId: activityLog.runId,
        activityId: activityLog.id,
        issueId: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
      })
      .from(activityLog)
      .innerJoin(issues, eq(activityLog.entityId, issueIdAsText))
      .where(
        and(
          eq(activityLog.orgId, orgId),
          inArray(activityLog.runId, runIds),
          eq(activityLog.entityType, "issue"),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(activityLog.runId, desc(activityLog.createdAt));
    return new Map(
      rows
        .filter((row) => row.runId)
        .map((row) => [
          row.runId!,
          {
            activityId: row.activityId,
            issue: {
              id: row.issueId,
              identifier: row.identifier,
              title: row.title,
              status: row.status,
              priority: row.priority,
            },
          },
        ]),
    );
  }

  async function listDerivedRunEvents(orgId: string, filters: CalendarEventFilters & { runId?: string }) {
    if (filters.sourceIds?.length) return [];
    if (!csvIncludes(filters.eventKinds, "agent_work_block")) return [];

    const conditions = [
      eq(heartbeatRuns.orgId, orgId),
      sql`coalesce(${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) < ${filters.end.toISOString()}::timestamptz`,
      sql`coalesce(${heartbeatRuns.finishedAt}, now()) > ${filters.start.toISOString()}::timestamptz`,
    ];
    if (filters.agentIds?.length) {
      conditions.push(inArray(heartbeatRuns.agentId, filters.agentIds));
    }
    if (filters.runId) {
      conditions.push(eq(heartbeatRuns.id, filters.runId));
    }

    const runRows = await db
      .select({
        id: heartbeatRuns.id,
        orgId: heartbeatRuns.orgId,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
        updatedAt: heartbeatRuns.updatedAt,
        invocationSource: heartbeatRuns.invocationSource,
        triggerDetail: heartbeatRuns.triggerDetail,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        agentName: agents.name,
        agentRole: agents.role,
        agentTitle: agents.title,
        agentUrlKey: agents.workspaceKey,
        issueId: issues.id,
        issueIdentifier: issues.identifier,
        issueTitle: issues.title,
        issueStatus: issues.status,
        issuePriority: issues.priority,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .leftJoin(
        issues,
        and(
          eq(issueIdAsText, contextIssueId),
          isNull(issues.hiddenAt),
        ),
      )
      .where(and(...conditions))
      .orderBy(asc(sql`coalesce(${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt})`));

    const fallbackByRunId = await listRunIssueFallbacks(orgId, runRows.map((row) => row.id));
    const now = new Date();

    return runRows.flatMap((row): CalendarEvent[] => {
      const startAt = row.startedAt ?? row.createdAt;
      const endAt = row.finishedAt ?? now;
      const eventStatus: CalendarEventStatus = row.status === "queued" || row.status === "running"
        ? "in_progress"
        : "actual";
      if (!csvIncludes(filters.statuses, eventStatus)) return [];
      const fallback = fallbackByRunId.get(row.id);
      const issue = row.issueId
        ? {
          id: row.issueId,
          identifier: row.issueIdentifier,
          title: row.issueTitle ?? "Untitled issue",
          status: row.issueStatus ?? "todo",
          priority: row.issuePriority ?? "medium",
        }
        : fallback?.issue ?? null;
      const title = issue ? `${row.agentName} · ${issue.title}` : `${row.agentName} · Heartbeat run`;
      return [{
        id: `run:${row.id}`,
        orgId: row.orgId,
        sourceId: null,
        eventKind: "agent_work_block",
        eventStatus,
        ownerType: "agent",
        ownerUserId: null,
        ownerAgentId: row.agentId,
        title,
        description: row.triggerDetail ? `Run trigger: ${row.triggerDetail}` : null,
        startAt,
        endAt,
        timezone: "UTC",
        allDay: false,
        visibility: "full",
        issueId: issue?.id ?? null,
        projectId: null,
        goalId: null,
        approvalId: null,
        heartbeatRunId: row.id,
        activityId: fallback?.activityId ?? null,
        sourceMode: "derived",
        externalProvider: null,
        externalCalendarId: null,
        externalEventId: null,
        externalEtag: null,
        externalUpdatedAt: null,
        createdByUserId: null,
        updatedByUserId: null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        deletedAt: null,
        source: {
          id: "derived:agent-work",
          type: "agent_work",
          name: "Agent work history",
          visibilityDefault: "full",
          externalProvider: null,
        },
        agent: {
          id: row.agentId,
          name: row.agentName,
          role: row.agentRole,
          title: row.agentTitle,
          urlKey: row.agentUrlKey,
        },
        issue,
      }];
    });
  }

  async function getPersistedEvent(orgId: string, id: string) {
    const rows = await db
      .select({
        event: calendarEvents,
        sourceId: calendarSources.id,
        sourceType: calendarSources.type,
        sourceName: calendarSources.name,
        sourceVisibilityDefault: calendarSources.visibilityDefault,
        sourceExternalProvider: calendarSources.externalProvider,
        agentName: agents.name,
        agentRole: agents.role,
        agentTitle: agents.title,
        agentUrlKey: agents.workspaceKey,
        issueIdentifier: issues.identifier,
        issueTitle: issues.title,
        issueStatus: issues.status,
        issuePriority: issues.priority,
      })
      .from(calendarEvents)
      .leftJoin(calendarSources, eq(calendarEvents.sourceId, calendarSources.id))
      .leftJoin(agents, eq(calendarEvents.ownerAgentId, agents.id))
      .leftJoin(issues, eq(calendarEvents.issueId, issues.id))
      .where(and(eq(calendarEvents.id, id), eq(calendarEvents.orgId, orgId), isNull(calendarEvents.deletedAt)));
    return rows[0] ? mapPersistedEvent(rows[0]) : null;
  }

  async function writableEvent(orgId: string, id: string) {
    const event = await db
      .select()
      .from(calendarEvents)
      .where(and(eq(calendarEvents.id, id), eq(calendarEvents.orgId, orgId), isNull(calendarEvents.deletedAt)))
      .then((rows) => rows[0] ?? null);
    if (!event) throw notFound("Calendar event not found");
    if (event.sourceMode !== "manual") {
      throw conflict("Imported and derived calendar events are read-only");
    }
    return event;
  }

  async function getOrCreateGoogleSource(orgId: string, actor?: Actor, status: CalendarSourceStatus = "disconnected") {
    const existing = await db
      .select()
      .from(calendarSources)
      .where(
        and(
          eq(calendarSources.orgId, orgId),
          eq(calendarSources.type, "google_calendar"),
          eq(calendarSources.externalProvider, "google_calendar"),
          eq(calendarSources.externalCalendarId, "primary"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;
    const [created] = await db
      .insert(calendarSources)
      .values({
        orgId,
        type: "google_calendar",
        name: "Google Calendar",
        ownerType: "user",
        ownerUserId: actor?.userId ?? "board",
        externalProvider: "google_calendar",
        externalCalendarId: "primary",
        visibilityDefault: "busy_only",
        status,
      })
      .returning();
    return created!;
  }

  async function upsertImportedGoogleEvent(params: {
    orgId: string;
    sourceId: string;
    calendarId: string;
    title: string;
    startAt: Date;
    endAt: Date;
    timezone: string;
    allDay: boolean;
    visibility: CalendarVisibility;
    externalEventId: string;
    externalEtag: string | null;
    externalUpdatedAt: Date | null;
  }) {
    const existing = await db
      .select({ id: calendarEvents.id })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.orgId, params.orgId),
          eq(calendarEvents.externalProvider, "google_calendar"),
          eq(calendarEvents.externalCalendarId, params.calendarId),
          eq(calendarEvents.externalEventId, params.externalEventId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    const values = {
      orgId: params.orgId,
      sourceId: params.sourceId,
      eventKind: "external_event",
      eventStatus: "external",
      ownerType: "user",
      title: params.title,
      startAt: params.startAt,
      endAt: params.endAt,
      timezone: params.timezone,
      allDay: params.allDay,
      visibility: params.visibility,
      sourceMode: "imported",
      externalProvider: "google_calendar",
      externalCalendarId: params.calendarId,
      externalEventId: params.externalEventId,
      externalEtag: params.externalEtag,
      externalUpdatedAt: params.externalUpdatedAt,
      updatedAt: new Date(),
      deletedAt: null,
    } satisfies Partial<typeof calendarEvents.$inferInsert>;
    if (existing) {
      await db.update(calendarEvents).set(values).where(eq(calendarEvents.id, existing.id));
      return false;
    }
    await db.insert(calendarEvents).values(values as typeof calendarEvents.$inferInsert);
    return true;
  }

  return {
    eventSummary,

    async listSources(orgId: string) {
      const rows = await db
        .select()
        .from(calendarSources)
        .where(eq(calendarSources.orgId, orgId))
        .orderBy(asc(calendarSources.type), asc(calendarSources.name));
      return rows.map(sanitizeSource);
    },

    async createSource(orgId: string, input: CreateCalendarSource, actor?: Actor) {
      await assertAgentOrg(orgId, input.ownerAgentId);
      const [created] = await db
        .insert(calendarSources)
        .values({
          orgId,
          ...input,
          ownerUserId: input.ownerUserId ?? actor?.userId ?? null,
          ownerAgentId: input.ownerAgentId ?? null,
          externalProvider: input.externalProvider ?? null,
          externalCalendarId: input.externalCalendarId ?? null,
          syncCursorJson: input.syncCursorJson ?? null,
        })
        .returning();
      return sanitizeSource(created!);
    },

    async updateSource(orgId: string, sourceId: string, input: UpdateCalendarSource, actor?: Actor) {
      const existing = await assertSourceOrg(orgId, sourceId);
      await assertAgentOrg(orgId, input.ownerAgentId);
      const [updated] = await db
        .update(calendarSources)
        .set({
          ...input,
          ownerUserId: input.ownerUserId ?? existing?.ownerUserId ?? actor?.userId ?? null,
          ownerAgentId: input.ownerAgentId === undefined ? existing?.ownerAgentId ?? null : input.ownerAgentId,
          externalProvider: input.externalProvider === undefined ? existing?.externalProvider ?? null : input.externalProvider,
          externalCalendarId: input.externalCalendarId === undefined ? existing?.externalCalendarId ?? null : input.externalCalendarId,
          syncCursorJson: input.syncCursorJson === undefined ? existing?.syncCursorJson ?? null : input.syncCursorJson,
          updatedAt: new Date(),
        })
        .where(eq(calendarSources.id, sourceId))
        .returning();
      return sanitizeSource(updated!);
    },

    async deleteSource(orgId: string, sourceId: string) {
      await assertSourceOrg(orgId, sourceId);
      await db.delete(calendarSources).where(and(eq(calendarSources.id, sourceId), eq(calendarSources.orgId, orgId)));
      return { ok: true as const };
    },

    async listEvents(orgId: string, filters: CalendarEventFilters) {
      const [persisted, derived] = await Promise.all([
        listPersistedEvents(orgId, filters),
        listDerivedRunEvents(orgId, filters),
      ]);
      return [...persisted, ...derived].sort((a, b) => {
        const time = new Date(a.startAt).getTime() - new Date(b.startAt).getTime();
        return time !== 0 ? time : a.title.localeCompare(b.title);
      });
    },

    async getEvent(orgId: string, eventId: string) {
      if (eventId.startsWith("run:")) {
        const runId = eventId.slice("run:".length);
        const derived = await listDerivedRunEvents(orgId, {
          start: new Date(0),
          end: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          runId,
        });
        return derived[0] ?? null;
      }
      return getPersistedEvent(orgId, eventId);
    },

    async createEvent(orgId: string, input: CreateCalendarEvent, actor?: Actor) {
      await assertCalendarEventShape(orgId, input);
      const [created] = await db
        .insert(calendarEvents)
        .values(createEventValues(orgId, input, actor))
        .returning();
      return getPersistedEvent(orgId, created!.id);
    },

    async updateEvent(orgId: string, eventId: string, input: UpdateCalendarEvent, actor?: Actor) {
      const existing = await writableEvent(orgId, eventId);
      const merged = mergeEventInput(existing, input);
      await assertCalendarEventShape(orgId, merged);
      if (merged.endAt.getTime() <= merged.startAt.getTime()) {
        throw unprocessable("End time must be after start time");
      }
      const [updated] = await db
        .update(calendarEvents)
        .set({
          ...updateEventValues(input, actor),
          updatedAt: new Date(),
        })
        .where(eq(calendarEvents.id, eventId))
        .returning();
      return { previous: existing, event: await getPersistedEvent(orgId, updated!.id) };
    },

    async deleteEvent(orgId: string, eventId: string, actor?: Actor) {
      const existing = await writableEvent(orgId, eventId);
      await db
        .update(calendarEvents)
        .set({
          deletedAt: new Date(),
          updatedAt: new Date(),
          updatedByUserId: actor?.userId ?? null,
          eventStatus: "cancelled",
        })
        .where(eq(calendarEvents.id, eventId));
      return existing;
    },

    async connectGoogle(orgId: string, redirectUri: string, actor?: Actor) {
      const source = await getOrCreateGoogleSource(orgId, actor, googleCredentials() ? "disconnected" : "error");
      const credentials = googleCredentials();
      if (!credentials) {
        return {
          status: "configuration_required" as const,
          authUrl: null,
          source: sanitizeSource(source),
        };
      }
      const state = Buffer.from(JSON.stringify({ orgId, sourceId: source.id })).toString("base64url");
      const params = new URLSearchParams({
        client_id: credentials.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "https://www.googleapis.com/auth/calendar.readonly",
        access_type: "offline",
        include_granted_scopes: "true",
        prompt: "consent",
        state,
      });
      return {
        status: "authorization_required" as const,
        authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
        source: sanitizeSource(source),
      };
    },

    async completeGoogleCallback(orgId: string, input: { code: string; state?: string | null; redirectUri: string }, actor?: Actor) {
      const credentials = googleCredentials();
      if (!credentials) throw unprocessable("Google Calendar OAuth is not configured");
      let sourceId: string | null = null;
      if (input.state) {
        try {
          const parsed = JSON.parse(Buffer.from(input.state, "base64url").toString("utf8")) as { sourceId?: string; orgId?: string };
          if (parsed.orgId === orgId && typeof parsed.sourceId === "string") {
            sourceId = parsed.sourceId;
          }
        } catch {
          sourceId = null;
        }
      }
      const source = sourceId
        ? await assertSourceOrg(orgId, sourceId)
        : await getOrCreateGoogleSource(orgId, actor);
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: input.code,
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          redirect_uri: input.redirectUri,
          grant_type: "authorization_code",
        }),
      });
      if (!response.ok) {
        throw unprocessable(`Google Calendar authorization failed: ${response.status}`);
      }
      const token = await response.json() as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        token_type?: string;
        scope?: string;
      };
      const cursor = parseSyncCursor(source?.syncCursorJson);
      const [updated] = await db
        .update(calendarSources)
        .set({
          status: "active",
          syncCursorJson: {
            ...cursor,
            accessToken: token.access_token,
            refreshToken: token.refresh_token ?? cursor.refreshToken,
            tokenType: token.token_type,
            scope: token.scope,
            expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null,
          },
          updatedAt: new Date(),
        })
        .where(eq(calendarSources.id, source!.id))
        .returning();
      return sanitizeSource(updated!);
    },

    async syncGoogle(orgId: string, sourceId?: string | null) {
      const source = sourceId
        ? await assertSourceOrg(orgId, sourceId)
        : await getOrCreateGoogleSource(orgId);
      if (!source || source.type !== "google_calendar") {
        throw unprocessable("Calendar source is not a Google Calendar source");
      }
      const cursor = parseSyncCursor(source.syncCursorJson);
      const accessToken = typeof cursor.accessToken === "string" ? cursor.accessToken : null;
      if (!accessToken) {
        return { source: sanitizeSource(source), importedCount: 0 };
      }

      const timeMin = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const timeMax = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
      const params = new URLSearchParams({
        singleEvents: "true",
        orderBy: "startTime",
        timeMin,
        timeMax,
      });
      const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(source.externalCalendarId ?? "primary")}/events?${params.toString()}`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        const [updated] = await db
          .update(calendarSources)
          .set({ status: "error", updatedAt: new Date() })
          .where(eq(calendarSources.id, source.id))
          .returning();
        return { source: sanitizeSource(updated!), importedCount: 0 };
      }
      const body = await response.json() as {
        items?: Array<{
          id?: string;
          summary?: string;
          transparency?: string;
          visibility?: string;
          status?: string;
          etag?: string;
          updated?: string;
          start?: { dateTime?: string; date?: string; timeZone?: string };
          end?: { dateTime?: string; date?: string; timeZone?: string };
        }>;
      };
      let importedCount = 0;
      for (const item of body.items ?? []) {
        if (!item.id || item.status === "cancelled") continue;
        const startRaw = item.start?.dateTime ?? item.start?.date;
        const endRaw = item.end?.dateTime ?? item.end?.date;
        if (!startRaw || !endRaw) continue;
        const allDay = !item.start?.dateTime;
        const visibility: CalendarVisibility = source.visibilityDefault as CalendarVisibility;
        const title = visibility === "busy_only" || item.visibility === "private"
          ? "Busy"
          : item.summary?.trim() || "Busy";
        const created = await upsertImportedGoogleEvent({
          orgId,
          sourceId: source.id,
          calendarId: source.externalCalendarId ?? "primary",
          title,
          startAt: new Date(startRaw),
          endAt: new Date(endRaw),
          timezone: item.start?.timeZone ?? "UTC",
          allDay,
          visibility,
          externalEventId: item.id,
          externalEtag: item.etag ?? null,
          externalUpdatedAt: item.updated ? new Date(item.updated) : null,
        });
        if (created) importedCount += 1;
      }
      const [updated] = await db
        .update(calendarSources)
        .set({
          status: "active",
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(calendarSources.id, source.id))
        .returning();
      return { source: sanitizeSource(updated!), importedCount };
    },
  };
}
