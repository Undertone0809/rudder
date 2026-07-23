import { z } from "zod";
import {
  MCP_AGENT_BINDING_STATUSES,
  MCP_CONNECTION_ACCESS_MODES,
  MCP_CONNECTION_PROVIDERS,
  MCP_CONNECTION_STATUSES,
  MCP_CONNECTION_TRANSPORTS,
  MCP_OAUTH_GRANT_STATUSES,
  MCP_PROVIDER_CATALOG,
} from "../constants.js";

const uuidSchema = z.string().uuid();
const timestampSchema = z.string().datetime({ offset: true });
const connectionNameSchema = z.string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/, "Use lowercase letters, numbers, underscores, and hyphens");
const environmentNameSchema = z.string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use a valid environment variable name");

export const mcpConnectionProviderSchema = z.enum(MCP_CONNECTION_PROVIDERS);
export const mcpConnectionTransportSchema = z.enum(MCP_CONNECTION_TRANSPORTS);
export const mcpConnectionAccessModeSchema = z.enum(MCP_CONNECTION_ACCESS_MODES);
export const mcpConnectionStatusSchema = z.enum(MCP_CONNECTION_STATUSES);
export const mcpOAuthGrantStatusSchema = z.enum(MCP_OAUTH_GRANT_STATUSES);
export const mcpAgentBindingStatusSchema = z.enum(MCP_AGENT_BINDING_STATUSES);

const safeHeaderSchema = z.record(z.string().max(8_192)).superRefine((headers, ctx) => {
  const forbidden = new Set(["authorization", "cookie", "proxy-authorization", "x-api-key"]);
  for (const name of Object.keys(headers)) {
    if (forbidden.has(name.toLowerCase())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [name],
        message: `${name} must be stored as encrypted credential material`,
      });
    }
  }
});

export const mcpStdioSafeConfigSchema = z.object({
  command: z.string().min(1).max(2_048),
  args: z.array(z.string().max(8_192)).max(200).optional(),
  cwd: z.string().min(1).max(4_096).optional(),
  env: z.record(z.string().max(8_192)).optional(),
  forwardedEnv: z.array(environmentNameSchema).max(100).optional(),
  credentialEnvNames: z.array(environmentNameSchema).max(100).optional(),
}).strict();

export const mcpStreamableHttpSafeConfigSchema = z.object({
  url: z.string().url().max(8_192).optional(),
  headers: safeHeaderSchema.optional(),
  bearerEnvVar: environmentNameSchema.optional(),
  credentialHeaderNames: z.array(z.string().min(1).max(256)).max(100).optional(),
}).strict();

export const mcpLegacyManualSafeConfigSchema = z.object({
  legacyConfigRetained: z.literal(true),
}).strict();

export const mcpConnectionSafeConfigSchema = z.union([
  mcpStdioSafeConfigSchema,
  mcpStreamableHttpSafeConfigSchema,
  mcpLegacyManualSafeConfigSchema,
]);

const mcpConnectionInputFields = {
  name: connectionNameSchema,
  displayName: z.string().trim().min(1).max(120),
  provider: mcpConnectionProviderSchema,
  transport: mcpConnectionTransportSchema,
  externalScope: z.string().trim().min(1).max(512).optional().nullable(),
  accessMode: mcpConnectionAccessModeSchema.default("provider_default"),
  safeConfig: mcpConnectionSafeConfigSchema.default({}),
  connectTimeoutMs: z.number().int().min(100).max(300_000).default(10_000),
  toolTimeoutMs: z.number().int().min(100).max(900_000).default(60_000),
  enabled: z.boolean().default(true),
  required: z.boolean().default(false),
  credential: z.object({
    name: z.string().trim().min(1).max(160).optional(),
    value: z.string().min(1).max(1_000_000),
  }).strict().optional(),
};

function validateTransportConfig(
  value: {
    provider?: string;
    transport?: string;
    safeConfig?: unknown;
    enabled?: boolean;
  },
  ctx: z.RefinementCtx,
) {
  if (value.transport === "stdio") {
    if (value.provider !== "custom") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provider"],
        message: "STDIO connections must use the custom provider",
      });
    }
    if (!mcpStdioSafeConfigSchema.safeParse(value.safeConfig).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["safeConfig"],
        message: "STDIO connections require command-based safe config",
      });
    }
  }

  if (value.transport === "streamable_http") {
    const parsed = mcpStreamableHttpSafeConfigSchema.safeParse(value.safeConfig);
    if (!parsed.success || (value.provider === "custom" && !parsed.data.url)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["safeConfig", "url"],
        message: "Custom Streamable HTTP connections require a URL",
      });
    }
  }

  if (value.transport === "legacy_manual") {
    if (value.provider !== "custom") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provider"],
        message: "Legacy manual connections must use the custom provider",
      });
    }
    if (value.enabled !== false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["enabled"],
        message: "Legacy manual connections cannot be executable",
      });
    }
  }
}

export const createMcpConnectionSchema = z.object(mcpConnectionInputFields)
  .strict()
  .superRefine(validateTransportConfig);

export const updateMcpConnectionSchema = z.object({
  displayName: mcpConnectionInputFields.displayName.optional(),
  externalScope: mcpConnectionInputFields.externalScope.optional(),
  accessMode: mcpConnectionInputFields.accessMode.optional(),
  safeConfig: mcpConnectionInputFields.safeConfig.optional(),
  connectTimeoutMs: mcpConnectionInputFields.connectTimeoutMs.optional(),
  toolTimeoutMs: mcpConnectionInputFields.toolTimeoutMs.optional(),
  enabled: mcpConnectionInputFields.enabled.optional(),
  required: mcpConnectionInputFields.required.optional(),
  credential: mcpConnectionInputFields.credential,
}).strict();

export const mcpConnectionSummarySchema = z.object({
  id: uuidSchema,
  orgId: uuidSchema,
  name: connectionNameSchema,
  displayName: z.string().min(1).max(120),
  provider: mcpConnectionProviderSchema,
  transport: mcpConnectionTransportSchema,
  externalScope: z.string().max(512).nullable(),
  accessMode: mcpConnectionAccessModeSchema,
  status: mcpConnectionStatusSchema,
  safeConfig: mcpConnectionSafeConfigSchema,
  connectTimeoutMs: z.number().int().positive(),
  toolTimeoutMs: z.number().int().positive(),
  enabled: z.boolean(),
  required: z.boolean(),
  hasCredentials: z.boolean(),
  lastDiscoveredAt: timestampSchema.nullable(),
  activatedAt: timestampSchema.nullable(),
  disabledAt: timestampSchema.nullable(),
  revokedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export const mcpProviderCatalogEntrySchema = z.object({
  id: mcpConnectionProviderSchema,
  label: z.string().min(1),
  curated: z.boolean(),
  requiresOAuth: z.boolean(),
  requiresScopeSelection: z.boolean(),
  scopeLabel: z.string().min(1),
  transports: z.array(mcpConnectionTransportSchema).min(1),
  accessModes: z.array(mcpConnectionAccessModeSchema).min(1),
}).strict();

export const mcpProviderCatalogSchema = z.array(mcpProviderCatalogEntrySchema);
mcpProviderCatalogSchema.parse(MCP_PROVIDER_CATALOG);

export const mcpOAuthStartSchema = z.object({
  connectionId: uuidSchema,
  redirectUri: z.string().url().max(8_192),
}).strict();

export const mcpOAuthStartResponseSchema = z.object({
  connectionId: uuidSchema,
  authorizationUrl: z.string().url().max(16_384),
  expiresAt: timestampSchema,
}).strict();

export const mcpOAuthCallbackSchema = z.object({
  state: z.string().min(16).max(8_192),
  code: z.string().min(1).max(16_384).optional(),
  error: z.string().min(1).max(512).optional(),
  errorDescription: z.string().max(4_096).optional(),
}).strict().superRefine((value, ctx) => {
  if (Boolean(value.code) === Boolean(value.error)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "OAuth callback must include exactly one of code or error",
    });
  }
});

export const mcpScopeSelectionSchema = z.object({
  connectionId: uuidSchema,
  externalScope: z.string().trim().min(1).max(512),
  accessMode: mcpConnectionAccessModeSchema,
}).strict();

export const mcpExternalScopeOptionSchema = z.object({
  id: z.string().min(1).max(512),
  displayName: z.string().min(1).max(240),
  metadata: z.record(z.unknown()).default({}),
}).strict();

export const mcpOAuthGrantSummarySchema = z.object({
  id: uuidSchema,
  connectionId: uuidSchema,
  providerSubject: z.string().max(1_024).nullable(),
  providerScopes: z.array(z.string().max(512)),
  externalScopeMetadata: z.record(z.unknown()),
  status: mcpOAuthGrantStatusSchema,
  hasCredentials: z.boolean(),
  expiresAt: timestampSchema.nullable(),
  lastRefreshedAt: timestampSchema.nullable(),
  revokedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export const mcpDiscoveredToolSchema = z.object({
  id: uuidSchema,
  connectionId: uuidSchema,
  externalToolName: z.string().min(1).max(240),
  rudderToolName: z.string().min(1).max(320),
  description: z.string().max(4_000).nullable(),
  inputSchema: z.record(z.unknown()),
  outputSchema: z.record(z.unknown()).nullable(),
  enabled: z.boolean(),
  removedAt: timestampSchema.nullable(),
}).strict();

export const mcpAgentBindingSchema = z.object({
  id: uuidSchema,
  connectionId: uuidSchema,
  agentId: uuidSchema,
  status: mcpAgentBindingStatusSchema,
  enabledToolIds: z.array(uuidSchema).max(500),
}).strict();

export const updateMcpAgentBindingSchema = z.object({
  status: mcpAgentBindingStatusSchema.optional(),
  enabledToolIds: z.array(uuidSchema).max(500).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "At least one binding field is required",
});

export const managedExternalMcpBindingSchema = z.object({
  connectionId: uuidSchema,
  serverName: connectionNameSchema,
  proxyUrl: z.string().url().max(8_192),
  authorizationEnvVar: environmentNameSchema,
  enabledToolNames: z.array(z.string().min(1).max(240)).max(500),
  required: z.boolean(),
  connectTimeoutMs: z.number().int().positive(),
  toolTimeoutMs: z.number().int().positive(),
}).strict();

export const managedExternalMcpBindingsSchema = z.array(managedExternalMcpBindingSchema).max(100);

export type CreateMcpConnection = z.infer<typeof createMcpConnectionSchema>;
export type UpdateMcpConnection = z.infer<typeof updateMcpConnectionSchema>;
export type McpOAuthStart = z.infer<typeof mcpOAuthStartSchema>;
export type McpOAuthCallback = z.infer<typeof mcpOAuthCallbackSchema>;
export type McpScopeSelection = z.infer<typeof mcpScopeSelectionSchema>;
export type UpdateMcpAgentBinding = z.infer<typeof updateMcpAgentBindingSchema>;
