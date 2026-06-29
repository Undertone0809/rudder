import { z } from "zod";
import {
  CUSTOM_INTEGRATION_BINDING_STATUSES,
  CUSTOM_INTEGRATION_KINDS,
  CUSTOM_INTEGRATION_SCOPES,
  CUSTOM_INTEGRATION_STATUSES,
  CUSTOM_INTEGRATION_TOOL_CALL_STATUSES,
  CUSTOM_INTEGRATION_TOOL_STATUSES,
} from "../constants.js";

const customIntegrationSlugSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "Use lowercase letters, numbers, and hyphens");

export const customIntegrationKindSchema = z.enum(CUSTOM_INTEGRATION_KINDS);
export const customIntegrationScopeSchema = z.enum(CUSTOM_INTEGRATION_SCOPES);
export const customIntegrationStatusSchema = z.enum(CUSTOM_INTEGRATION_STATUSES);
export const customIntegrationToolStatusSchema = z.enum(CUSTOM_INTEGRATION_TOOL_STATUSES);
export const customIntegrationBindingStatusSchema = z.enum(CUSTOM_INTEGRATION_BINDING_STATUSES);
export const customIntegrationToolCallStatusSchema = z.enum(CUSTOM_INTEGRATION_TOOL_CALL_STATUSES);

export const customIntegrationToolInputSchema = z.object({
  externalToolName: z.string().min(1).max(120),
  rudderToolName: z.string().min(1).max(160).optional(),
  description: z.string().max(1000).optional().nullable(),
  inputSchema: z.record(z.unknown()).optional(),
  config: z.record(z.unknown()).optional(),
});

export const createCustomIntegrationSchema = z.object({
  scope: customIntegrationScopeSchema,
  kind: customIntegrationKindSchema,
  slug: customIntegrationSlugSchema.optional(),
  displayName: z.string().min(1).max(120),
  description: z.string().max(1000).optional().nullable(),
  config: z.record(z.unknown()).optional(),
  credential: z.object({
    name: z.string().min(1).max(160).optional(),
    value: z.string().min(1),
  }).optional(),
  credentialSecretId: z.string().uuid().optional().nullable(),
  tools: z.array(customIntegrationToolInputSchema).min(1).max(25),
  enabledToolNames: z.array(z.string().min(1)).optional(),
});

export type CreateCustomIntegration = z.infer<typeof createCustomIntegrationSchema>;

export const updateCustomIntegrationBindingSchema = z.object({
  enabledToolIds: z.array(z.string().uuid()).max(100),
});

export type UpdateCustomIntegrationBinding = z.infer<typeof updateCustomIntegrationBindingSchema>;

export const createCustomIntegrationToolCallSchema = z.object({
  toolId: z.string().uuid(),
  input: z.record(z.unknown()).optional(),
  runId: z.string().uuid().optional().nullable(),
  conversationId: z.string().uuid().optional().nullable(),
  issueId: z.string().uuid().optional().nullable(),
});

export type CreateCustomIntegrationToolCall = z.infer<typeof createCustomIntegrationToolCallSchema>;
