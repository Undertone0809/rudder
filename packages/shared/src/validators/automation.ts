import { z } from "zod";
import {
  ISSUE_PRIORITIES,
  AUTOMATION_CATCH_UP_POLICIES,
  AUTOMATION_CONCURRENCY_POLICIES,
  AUTOMATION_STATUSES,
  AUTOMATION_TRIGGER_SIGNING_MODES,
} from "../constants.js";

export const createAutomationSchema = z.object({
  projectId: z.string().uuid(),
  goalId: z.string().uuid().optional().nullable(),
  parentIssueId: z.string().uuid().optional().nullable(),
  title: z.string().trim().min(1).max(200),
  description: z.string().optional().nullable(),
  assigneeAgentId: z.string().uuid(),
  priority: z.enum(ISSUE_PRIORITIES).optional().default("medium"),
  status: z.enum(AUTOMATION_STATUSES).optional().default("active"),
  concurrencyPolicy: z.enum(AUTOMATION_CONCURRENCY_POLICIES).optional().default("coalesce_if_active"),
  catchUpPolicy: z.enum(AUTOMATION_CATCH_UP_POLICIES).optional().default("skip_missed"),
});

export type CreateAutomation = z.infer<typeof createAutomationSchema>;

export const updateAutomationSchema = createAutomationSchema.partial();
export type UpdateAutomation = z.infer<typeof updateAutomationSchema>;

const baseTriggerSchema = z.object({
  label: z.string().trim().max(120).optional().nullable(),
  enabled: z.boolean().optional().default(true),
});

export const createAutomationTriggerSchema = z.discriminatedUnion("kind", [
  baseTriggerSchema.extend({
    kind: z.literal("schedule"),
    cronExpression: z.string().trim().min(1),
    timezone: z.string().trim().min(1).default("UTC"),
  }),
  baseTriggerSchema.extend({
    kind: z.literal("webhook"),
    signingMode: z.enum(AUTOMATION_TRIGGER_SIGNING_MODES).optional().default("bearer"),
    replayWindowSec: z.number().int().min(30).max(86_400).optional().default(300),
  }),
  baseTriggerSchema.extend({
    kind: z.literal("api"),
  }),
]);

export type CreateAutomationTrigger = z.infer<typeof createAutomationTriggerSchema>;

export const updateAutomationTriggerSchema = z.object({
  label: z.string().trim().max(120).optional().nullable(),
  enabled: z.boolean().optional(),
  cronExpression: z.string().trim().min(1).optional().nullable(),
  timezone: z.string().trim().min(1).optional().nullable(),
  signingMode: z.enum(AUTOMATION_TRIGGER_SIGNING_MODES).optional().nullable(),
  replayWindowSec: z.number().int().min(30).max(86_400).optional().nullable(),
});

export type UpdateAutomationTrigger = z.infer<typeof updateAutomationTriggerSchema>;

export const runAutomationSchema = z.object({
  triggerId: z.string().uuid().optional().nullable(),
  payload: z.record(z.unknown()).optional().nullable(),
  idempotencyKey: z.string().trim().max(255).optional().nullable(),
  source: z.enum(["manual", "api"]).optional().default("manual"),
});

export type RunAutomation = z.infer<typeof runAutomationSchema>;

export const rotateAutomationTriggerSecretSchema = z.object({});
export type RotateAutomationTriggerSecret = z.infer<typeof rotateAutomationTriggerSecretSchema>;
