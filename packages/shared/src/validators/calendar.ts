import { z } from "zod";
import {
  CALENDAR_EVENT_KINDS,
  CALENDAR_EVENT_STATUSES,
  CALENDAR_OWNER_TYPES,
  CALENDAR_SOURCE_MODES,
  CALENDAR_SOURCE_STATUSES,
  CALENDAR_SOURCE_TYPES,
  CALENDAR_VISIBILITIES,
} from "../constants.js";

const nullableUuid = z.string().uuid().optional().nullable();

export const createCalendarSourceSchema = z.object({
  type: z.enum(CALENDAR_SOURCE_TYPES).optional().default("rudder_local"),
  name: z.string().trim().min(1).max(160),
  ownerType: z.enum(CALENDAR_OWNER_TYPES).optional().default("user"),
  ownerUserId: z.string().trim().min(1).optional().nullable(),
  ownerAgentId: nullableUuid,
  externalProvider: z.string().trim().min(1).max(80).optional().nullable(),
  externalCalendarId: z.string().trim().min(1).max(512).optional().nullable(),
  visibilityDefault: z.enum(CALENDAR_VISIBILITIES).optional().default("full"),
  status: z.enum(CALENDAR_SOURCE_STATUSES).optional().default("active"),
  syncCursorJson: z.record(z.unknown()).optional().nullable(),
});

export type CreateCalendarSource = z.infer<typeof createCalendarSourceSchema>;

export const updateCalendarSourceSchema = createCalendarSourceSchema.partial().extend({
  lastSyncedAt: z.coerce.date().optional().nullable(),
});

export type UpdateCalendarSource = z.infer<typeof updateCalendarSourceSchema>;

const calendarEventBaseSchema = z.object({
  sourceId: nullableUuid,
  eventKind: z.enum(CALENDAR_EVENT_KINDS),
  eventStatus: z.enum(CALENDAR_EVENT_STATUSES).optional().default("planned"),
  ownerType: z.enum(CALENDAR_OWNER_TYPES),
  ownerUserId: z.string().trim().min(1).optional().nullable(),
  ownerAgentId: nullableUuid,
  title: z.string().trim().min(1).max(240),
  description: z.string().optional().nullable(),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  timezone: z.string().trim().min(1).max(80).optional().default("UTC"),
  allDay: z.boolean().optional().default(false),
  visibility: z.enum(CALENDAR_VISIBILITIES).optional().default("full"),
  issueId: nullableUuid,
  projectId: nullableUuid,
  goalId: nullableUuid,
  approvalId: nullableUuid,
  heartbeatRunId: nullableUuid,
  activityId: nullableUuid,
  sourceMode: z.enum(CALENDAR_SOURCE_MODES).optional().default("manual"),
  externalProvider: z.string().trim().min(1).max(80).optional().nullable(),
  externalCalendarId: z.string().trim().min(1).max(512).optional().nullable(),
  externalEventId: z.string().trim().min(1).max(512).optional().nullable(),
  externalEtag: z.string().trim().min(1).max(512).optional().nullable(),
  externalUpdatedAt: z.coerce.date().optional().nullable(),
});

export const createCalendarEventSchema = calendarEventBaseSchema.refine(
  (value) => value.endAt.getTime() > value.startAt.getTime(),
  { path: ["endAt"], message: "End time must be after start time" },
);

export type CreateCalendarEvent = z.infer<typeof createCalendarEventSchema>;

export const updateCalendarEventSchema = calendarEventBaseSchema
  .partial()
  .refine(
    (value) =>
      value.startAt === undefined ||
      value.endAt === undefined ||
      value.endAt.getTime() > value.startAt.getTime(),
    { path: ["endAt"], message: "End time must be after start time" },
  );

export type UpdateCalendarEvent = z.infer<typeof updateCalendarEventSchema>;

export const calendarEventListQuerySchema = z.object({
  start: z.coerce.date(),
  end: z.coerce.date(),
  agentIds: z.string().optional(),
  sourceIds: z.string().optional(),
  eventKinds: z.string().optional(),
  statuses: z.string().optional(),
}).refine(
  (value) => value.end.getTime() > value.start.getTime(),
  { path: ["end"], message: "End time must be after start time" },
);

export type CalendarEventListQuery = z.infer<typeof calendarEventListQuerySchema>;

export const googleCalendarSyncSchema = z.object({
  sourceId: z.string().uuid().optional().nullable(),
});

export type GoogleCalendarSync = z.infer<typeof googleCalendarSyncSchema>;
