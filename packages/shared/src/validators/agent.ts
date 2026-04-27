import { z } from "zod";
import {
  AGENT_RUNTIME_TYPES,
  AGENT_ICON_NAMES,
  AGENT_ROLES,
  AGENT_STATUSES,
} from "../constants.js";
import { envConfigSchema } from "./secret.js";

const MAX_AGENT_MODEL_FALLBACKS = 2;

export const agentPermissionsSchema = z.object({
  canCreateAgents: z.boolean().optional().default(false),
});

export const agentInstructionsBundleModeSchema = z.enum(["managed", "external"]);

export const updateAgentInstructionsBundleSchema = z.object({
  mode: agentInstructionsBundleModeSchema.optional(),
  rootPath: z.string().trim().min(1).nullable().optional(),
  entryFile: z.string().trim().min(1).optional(),
  clearLegacyPromptTemplate: z.boolean().optional().default(false),
});

export type UpdateAgentInstructionsBundle = z.infer<typeof updateAgentInstructionsBundleSchema>;

export const upsertAgentInstructionsFileSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
  clearLegacyPromptTemplate: z.boolean().optional().default(false),
});

export type UpsertAgentInstructionsFile = z.infer<typeof upsertAgentInstructionsFileSchema>;

const agentRuntimeConfigSchema = z.record(z.unknown()).superRefine((value, ctx) => {
  const envValue = value.env;
  if (envValue !== undefined) {
    const parsed = envConfigSchema.safeParse(envValue);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "agentRuntimeConfig.env must be a map of valid env bindings",
        path: ["env"],
      });
    }
  }

  const fallbackModels = value.modelFallbacks;
  if (fallbackModels !== undefined) {
    if (!Array.isArray(fallbackModels)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "agentRuntimeConfig.modelFallbacks must be an array",
        path: ["modelFallbacks"],
      });
      return;
    }
    if (fallbackModels.length > MAX_AGENT_MODEL_FALLBACKS) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: MAX_AGENT_MODEL_FALLBACKS,
        type: "array",
        inclusive: true,
        message: `agentRuntimeConfig.modelFallbacks can include at most ${MAX_AGENT_MODEL_FALLBACKS} models`,
        path: ["modelFallbacks"],
      });
    }
    fallbackModels.forEach((model, index) => {
      if (typeof model !== "string" || model.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "agentRuntimeConfig.modelFallbacks entries must be non-empty strings",
          path: ["modelFallbacks", index],
        });
      }
    });
  }
});

const optionalAgentNameSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  },
  z.string().trim().min(1).optional(),
);

export const uploadedAgentIconSchema = z.string().regex(
  /^asset:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  "Invalid uploaded avatar reference",
);

export const customAgentIconSchema = z.string()
  .trim()
  .min(1)
  .max(24)
  .refine((value) => !value.toLowerCase().startsWith("asset:"), "Invalid uploaded avatar reference")
  .refine((value) => !/[<>\u0000-\u001f\u007f]/u.test(value), "Icon cannot contain markup or control characters");

export const agentIconSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  },
  z.union([
    z.enum(AGENT_ICON_NAMES),
    uploadedAgentIconSchema,
    customAgentIconSchema,
  ]).nullable(),
);

export const createAgentSchema = z.object({
  name: optionalAgentNameSchema,
  role: z.enum(AGENT_ROLES).optional().default("general"),
  title: z.string().optional().nullable(),
  icon: agentIconSchema.optional(),
  reportsTo: z.string().uuid().optional().nullable(),
  capabilities: z.string().optional().nullable(),
  desiredSkills: z.array(z.string().min(1)).optional(),
  agentRuntimeType: z.enum(AGENT_RUNTIME_TYPES).optional().default("process"),
  agentRuntimeConfig: agentRuntimeConfigSchema.optional().default({}),
  runtimeConfig: z.record(z.unknown()).optional().default({}),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  permissions: agentPermissionsSchema.optional(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

export type CreateAgent = z.infer<typeof createAgentSchema>;

export const createAgentHireSchema = createAgentSchema.extend({
  sourceIssueId: z.string().uuid().optional().nullable(),
  sourceIssueIds: z.array(z.string().uuid()).optional(),
});

export type CreateAgentHire = z.infer<typeof createAgentHireSchema>;

export const updateAgentSchema = createAgentSchema
  .omit({ permissions: true })
  .partial()
  .extend({
    permissions: z.never().optional(),
    replaceAgentRuntimeConfig: z.boolean().optional(),
    status: z.enum(AGENT_STATUSES).optional(),
    spentMonthlyCents: z.number().int().nonnegative().optional(),
  });

export type UpdateAgent = z.infer<typeof updateAgentSchema>;

export const updateAgentInstructionsPathSchema = z.object({
  path: z.string().trim().min(1).nullable(),
  agentRuntimeConfigKey: z.string().trim().min(1).optional(),
});

export type UpdateAgentInstructionsPath = z.infer<typeof updateAgentInstructionsPathSchema>;

export const createAgentKeySchema = z.object({
  name: z.string().min(1).default("default"),
});

export type CreateAgentKey = z.infer<typeof createAgentKeySchema>;

export const wakeAgentSchema = z.object({
  source: z.enum(["timer", "assignment", "on_demand", "automation"]).optional().default("on_demand"),
  triggerDetail: z.enum(["manual", "ping", "callback", "system"]).optional(),
  reason: z.string().optional().nullable(),
  payload: z.record(z.unknown()).optional().nullable(),
  idempotencyKey: z.string().optional().nullable(),
  forceFreshSession: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.boolean().optional().default(false),
  ),
});

export type WakeAgent = z.infer<typeof wakeAgentSchema>;

export const resetAgentSessionSchema = z.object({
  taskKey: z.string().min(1).optional().nullable(),
});

export type ResetAgentSession = z.infer<typeof resetAgentSessionSchema>;

export const testAgentRuntimeEnvironmentSchema = z.object({
  agentRuntimeConfig: agentRuntimeConfigSchema.optional().default({}),
});

export type TestAgentRuntimeEnvironment = z.infer<typeof testAgentRuntimeEnvironmentSchema>;

export const updateAgentPermissionsSchema = z.object({
  canCreateAgents: z.boolean(),
  canAssignTasks: z.boolean(),
});

export type UpdateAgentPermissions = z.infer<typeof updateAgentPermissionsSchema>;
