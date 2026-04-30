import type {
  CalendarEvent,
  CalendarEventListResponse,
  CalendarSource,
  GoogleCalendarConnectResponse,
  GoogleCalendarSyncResponse,
} from "@rudderhq/shared";
import { api } from "./client";

export interface CalendarEventFilters {
  start: string;
  end: string;
  agentIds?: string[];
  sourceIds?: string[];
  eventKinds?: string[];
  statuses?: string[];
}

function eventQuery(filters: CalendarEventFilters) {
  const params = new URLSearchParams({
    start: filters.start,
    end: filters.end,
  });
  if (filters.agentIds?.length) params.set("agentIds", filters.agentIds.join(","));
  if (filters.sourceIds?.length) params.set("sourceIds", filters.sourceIds.join(","));
  if (filters.eventKinds?.length) params.set("eventKinds", filters.eventKinds.join(","));
  if (filters.statuses?.length) params.set("statuses", filters.statuses.join(","));
  return params.toString();
}

export const calendarApi = {
  sources: (orgId: string) =>
    api.get<CalendarSource[]>(`/orgs/${encodeURIComponent(orgId)}/calendar/sources`),
  createSource: (orgId: string, data: Record<string, unknown>) =>
    api.post<CalendarSource>(`/orgs/${encodeURIComponent(orgId)}/calendar/sources`, data),
  updateSource: (orgId: string, sourceId: string, data: Record<string, unknown>) =>
    api.patch<CalendarSource>(
      `/orgs/${encodeURIComponent(orgId)}/calendar/sources/${encodeURIComponent(sourceId)}`,
      data,
    ),
  deleteSource: (orgId: string, sourceId: string) =>
    api.delete<{ ok: true }>(`/orgs/${encodeURIComponent(orgId)}/calendar/sources/${encodeURIComponent(sourceId)}`),
  events: (orgId: string, filters: CalendarEventFilters) =>
    api.get<CalendarEventListResponse>(
      `/orgs/${encodeURIComponent(orgId)}/calendar/events?${eventQuery(filters)}`,
    ),
  getEvent: (orgId: string, eventId: string) =>
    api.get<CalendarEvent>(
      `/orgs/${encodeURIComponent(orgId)}/calendar/events/${encodeURIComponent(eventId)}`,
    ),
  createEvent: (orgId: string, data: Record<string, unknown>) =>
    api.post<CalendarEvent>(`/orgs/${encodeURIComponent(orgId)}/calendar/events`, data),
  updateEvent: (orgId: string, eventId: string, data: Record<string, unknown>) =>
    api.patch<CalendarEvent>(
      `/orgs/${encodeURIComponent(orgId)}/calendar/events/${encodeURIComponent(eventId)}`,
      data,
    ),
  deleteEvent: (orgId: string, eventId: string) =>
    api.delete<{ ok: true }>(`/orgs/${encodeURIComponent(orgId)}/calendar/events/${encodeURIComponent(eventId)}`),
  connectGoogle: (orgId: string) =>
    api.post<GoogleCalendarConnectResponse>(
      `/orgs/${encodeURIComponent(orgId)}/calendar/google/connect`,
      {},
    ),
  syncGoogle: (orgId: string, sourceId?: string | null) =>
    api.post<GoogleCalendarSyncResponse>(
      `/orgs/${encodeURIComponent(orgId)}/calendar/google/sync`,
      { sourceId: sourceId ?? null },
    ),
};
