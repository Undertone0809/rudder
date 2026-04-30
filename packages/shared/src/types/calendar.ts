import type {
  CalendarEventKind,
  CalendarEventStatus,
  CalendarOwnerType,
  CalendarSourceMode,
  CalendarSourceStatus,
  CalendarSourceType,
  CalendarVisibility,
} from "../constants.js";

export interface CalendarSource {
  id: string;
  orgId: string;
  type: CalendarSourceType;
  name: string;
  ownerType: CalendarOwnerType;
  ownerUserId: string | null;
  ownerAgentId: string | null;
  externalProvider: string | null;
  externalCalendarId: string | null;
  visibilityDefault: CalendarVisibility;
  status: CalendarSourceStatus;
  lastSyncedAt: Date | null;
  syncCursorJson: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CalendarEventLinkedAgent {
  id: string;
  name: string;
  role: string;
  title: string | null;
  urlKey?: string | null;
}

export interface CalendarEventLinkedIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
}

export interface CalendarEvent {
  id: string;
  orgId: string;
  sourceId: string | null;
  eventKind: CalendarEventKind;
  eventStatus: CalendarEventStatus;
  ownerType: CalendarOwnerType;
  ownerUserId: string | null;
  ownerAgentId: string | null;
  title: string;
  description: string | null;
  startAt: Date;
  endAt: Date;
  timezone: string;
  allDay: boolean;
  visibility: CalendarVisibility;
  issueId: string | null;
  projectId: string | null;
  goalId: string | null;
  approvalId: string | null;
  heartbeatRunId: string | null;
  activityId: string | null;
  sourceMode: CalendarSourceMode;
  externalProvider: string | null;
  externalCalendarId: string | null;
  externalEventId: string | null;
  externalEtag: string | null;
  externalUpdatedAt: Date | null;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  source?: Pick<CalendarSource, "id" | "type" | "name" | "visibilityDefault" | "externalProvider"> | null;
  agent?: CalendarEventLinkedAgent | null;
  issue?: CalendarEventLinkedIssue | null;
}

export interface CalendarEventListResponse {
  events: CalendarEvent[];
}

export interface GoogleCalendarConnectResponse {
  status: "configuration_required" | "authorization_required";
  authUrl: string | null;
  source: CalendarSource;
}

export interface GoogleCalendarSyncResponse {
  source: CalendarSource;
  importedCount: number;
}
