import { z } from "zod";
import {
  AGENT_RUNTIME_TYPES,
  ORGANIZATION_INTELLIGENCE_PROFILE_PURPOSES,
  ORGANIZATION_INTELLIGENCE_PROFILE_STATUSES,
} from "../constants.js";
import { validateModelFallbacksConfig } from "./model-fallbacks.js";
import { envConfigSchema } from "./secret.js";

export const organizationIntelligenceProfilePurposeSchema = z.enum(
  ORGANIZATION_INTELLIGENCE_PROFILE_PURPOSES,
);

export const organizationIntelligenceProfileStatusSchema = z.enum(
  ORGANIZATION_INTELLIGENCE_PROFILE_STATUSES,
);

export const organizationIntelligenceProfileConfigSchema = z.record(z.unknown()).superRefine((value, ctx) => {
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

  validateModelFallbacksConfig(value, ctx, []);
});

export const upsertOrganizationIntelligenceProfileSchema = z.object({
  agentRuntimeType: z.enum(AGENT_RUNTIME_TYPES),
  agentRuntimeConfig: organizationIntelligenceProfileConfigSchema.default({}),
  status: organizationIntelligenceProfileStatusSchema.optional().default("configured"),
});

export type OrganizationIntelligenceProfilePurposeInput = z.infer<typeof organizationIntelligenceProfilePurposeSchema>;
export type UpsertOrganizationIntelligenceProfileInput = z.infer<typeof upsertOrganizationIntelligenceProfileSchema>;
