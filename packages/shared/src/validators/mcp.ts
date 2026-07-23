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

const stringMapSchema = z.record(z.string().max(8_192));
const environmentValueMapSchema = stringMapSchema.superRefine((values, ctx) => {
  for (const name of Object.keys(values)) {
    if (!environmentNameSchema.safeParse(name).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [name],
        message: `${name} must be a valid environment variable name`,
      });
    }
  }
});
const safeHeaderSchema = stringMapSchema.superRefine((headers, ctx) => {
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
  staticEnv: environmentValueMapSchema.optional(),
  forwardedEnv: z.array(environmentNameSchema).max(100).optional(),
  secretEnvNames: z.array(environmentNameSchema).max(100).optional(),
}).strict().superRefine((value, ctx) => {
  const staticNames = new Set(Object.keys(value.staticEnv ?? {}));
  for (const name of value.secretEnvNames ?? []) {
    if (staticNames.has(name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["staticEnv", name],
        message: `${name} is marked secret and cannot remain in safe config`,
      });
    }
  }
});

export const mcpStreamableHttpSafeConfigSchema = z.object({
  url: z.string().url().max(8_192).optional(),
  staticHeaders: safeHeaderSchema.optional(),
  headersFromEnv: z.record(environmentNameSchema).optional(),
  bearerTokenEnvVar: environmentNameSchema.optional(),
  secretHeaderNames: z.array(z.string().min(1).max(256)).max(100).optional(),
  hasBearerToken: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  const staticNames = new Set(Object.keys(value.staticHeaders ?? {}).map((name) => name.toLowerCase()));
  const mappedNames = new Set(Object.keys(value.headersFromEnv ?? {}).map((name) => name.toLowerCase()));

  for (const name of value.secretHeaderNames ?? []) {
    if (staticNames.has(name.toLowerCase())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["staticHeaders", name],
        message: `${name} is marked secret and cannot remain in safe config`,
      });
    }
  }
  for (const name of mappedNames) {
    if (staticNames.has(name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["headersFromEnv", name],
        message: `${name} cannot have both a static value and an environment mapping`,
      });
    }
  }
});

export const mcpConnectionSecretsMutationSchema = z.object({
  env: environmentValueMapSchema.optional(),
  headers: stringMapSchema.optional(),
  bearerToken: z.string().min(1).max(1_000_000).optional(),
}).strict().refine((value) => (
  Object.keys(value.env ?? {}).length > 0
  || Object.keys(value.headers ?? {}).length > 0
  || Boolean(value.bearerToken)
), {
  message: "At least one secret value is required",
});

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
  accessMode: mcpConnectionAccessModeSchema.optional(),
  safeConfig: mcpConnectionSafeConfigSchema.default({}),
  startupTimeoutMs: z.number().int().min(100).max(300_000).default(10_000),
  toolTimeoutMs: z.number().int().min(100).max(900_000).default(60_000),
  enabled: z.boolean().default(true),
  required: z.boolean().default(false),
  secrets: mcpConnectionSecretsMutationSchema.optional(),
};

const providerAccessModes = {
  supabase: ["read_only", "read_write"],
  linear: ["read_only", "read_write"],
  notion: ["provider_default"],
  custom: ["provider_default", "read_only", "read_write"],
} as const;

function defaultAccessMode(provider: string | undefined) {
  if (provider === "supabase") return "read_only";
  if (provider === "linear") return "read_write";
  return "provider_default";
}

function sameNames(left: string[], right: string[], caseInsensitive = false) {
  const normalize = (name: string) => caseInsensitive ? name.toLowerCase() : name;
  const leftNames = new Set(left.map(normalize));
  const rightNames = new Set(right.map(normalize));
  return leftNames.size === rightNames.size
    && [...leftNames].every((name) => rightNames.has(name));
}

function validateConnectionConfig(
  value: {
    provider?: string;
    transport?: string;
    accessMode?: string;
    safeConfig?: unknown;
    enabled?: boolean;
    secrets?: z.infer<typeof mcpConnectionSecretsMutationSchema>;
  },
  ctx: z.RefinementCtx,
) {
  const accessMode = value.accessMode ?? defaultAccessMode(value.provider);
  const allowedAccessModes = value.provider
    ? providerAccessModes[value.provider as keyof typeof providerAccessModes]
    : undefined;
  if (!allowedAccessModes?.some((allowed) => allowed === accessMode)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["accessMode"],
      message: `${value.provider ?? "Unknown"} does not support ${accessMode}`,
    });
  }

  if (value.provider !== "custom") {
    if (value.transport !== "streamable_http") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transport"],
        message: "Curated providers use Rudder-managed Streamable HTTP",
      });
    }
    if (
      typeof value.safeConfig !== "object"
      || value.safeConfig === null
      || Array.isArray(value.safeConfig)
      || Object.keys(value.safeConfig).length > 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["safeConfig"],
        message: "Curated provider URL, headers, and transport config are Rudder-managed",
      });
    }
    if (value.secrets) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["secrets"],
        message: "Curated provider credentials must come from its OAuth grant",
      });
    }
    return;
  }

  if (value.transport === "stdio") {
    const parsed = mcpStdioSafeConfigSchema.safeParse(value.safeConfig);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["safeConfig"],
        message: "STDIO connections require command-based safe config",
      });
    } else {
      const declaredEnvNames = parsed.data.secretEnvNames ?? [];
      const suppliedEnvNames = Object.keys(value.secrets?.env ?? {});
      if (
        !sameNames(declaredEnvNames, suppliedEnvNames)
        || Object.keys(value.secrets?.headers ?? {}).length > 0
        || Boolean(value.secrets?.bearerToken)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["secrets"],
          message: "STDIO secret values must exactly match declared secret environment names",
        });
      }
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
    if (!mcpLegacyManualSafeConfigSchema.safeParse(value.safeConfig).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["safeConfig"],
        message: "Legacy manual connections require compatibility config",
      });
    }
    if (value.enabled !== false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["enabled"],
        message: "Legacy manual connections cannot be executable",
      });
    }
    if (value.secrets) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["secrets"],
        message: "Legacy manual connections cannot accept new secret values",
      });
    }
  }

  if (value.transport === "streamable_http") {
    const parsed = mcpStreamableHttpSafeConfigSchema.safeParse(value.safeConfig);
    if (parsed.success) {
      const suppliedEnvNames = Object.keys(value.secrets?.env ?? {});
      const declaredHeaderNames = parsed.data.secretHeaderNames ?? [];
      const suppliedHeaderNames = Object.keys(value.secrets?.headers ?? {});
      const declaredBearer = parsed.data.hasBearerToken === true;
      const suppliedBearer = Boolean(value.secrets?.bearerToken);
      if (
        suppliedEnvNames.length > 0
        || !sameNames(declaredHeaderNames, suppliedHeaderNames, true)
        || declaredBearer !== suppliedBearer
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["secrets"],
          message: "HTTP mutations accept only exactly declared encrypted headers and direct Bearer values",
        });
      }

      const authorizationFromEnv = Object.keys(parsed.data.headersFromEnv ?? {})
        .some((name) => name.toLowerCase() === "authorization");
      const encryptedAuthorizationHeader = (
        declaredHeaderNames.some((name) => name.toLowerCase() === "authorization")
        || suppliedHeaderNames.some((name) => name.toLowerCase() === "authorization")
      );
      const bearerEnvironment = Boolean(parsed.data.bearerTokenEnvVar);
      const directBearer = declaredBearer || suppliedBearer;
      if ([
        authorizationFromEnv,
        encryptedAuthorizationHeader,
        bearerEnvironment,
        directBearer,
      ].filter(Boolean).length > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["safeConfig"],
          message: "Configure only one manual Authorization or Bearer source",
        });
      }
    }
  }
}

export const createMcpConnectionSchema = z.object(mcpConnectionInputFields)
  .strict()
  .superRefine(validateConnectionConfig)
  .transform((value) => ({
    ...value,
    accessMode: value.accessMode ?? defaultAccessMode(value.provider),
  }));

export const updateMcpConnectionSchema = z.object({
  displayName: mcpConnectionInputFields.displayName.optional(),
  externalScope: mcpConnectionInputFields.externalScope.optional(),
  accessMode: mcpConnectionAccessModeSchema.optional(),
  safeConfig: mcpConnectionSafeConfigSchema.optional(),
  startupTimeoutMs: z.number().int().min(100).max(300_000).optional(),
  toolTimeoutMs: z.number().int().min(100).max(900_000).optional(),
  enabled: z.boolean().optional(),
  required: z.boolean().optional(),
  secrets: mcpConnectionSecretsMutationSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "At least one connection field is required",
});

/**
 * Service-side validation target after an immutable provider/transport record
 * has been merged with a public update payload.
 */
export const mcpConnectionMergedConfigSchema = z.object({
  provider: mcpConnectionProviderSchema,
  transport: mcpConnectionTransportSchema,
  accessMode: mcpConnectionAccessModeSchema,
  safeConfig: mcpConnectionSafeConfigSchema,
  enabled: z.boolean(),
  secrets: mcpConnectionSecretsMutationSchema.optional(),
}).strict().superRefine(validateConnectionConfig);

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
  startupTimeoutMs: z.number().int().positive(),
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
  bindingId: uuidSchema,
  serverName: connectionNameSchema,
  toolPolicy: z.object({
    mode: z.literal("allowlist"),
    allowedToolNames: z.array(z.string().min(1).max(240)).max(500),
  }).strict(),
  required: z.boolean(),
  startupTimeoutMs: z.number().int().positive(),
  toolTimeoutMs: z.number().int().positive(),
}).strict();

export const managedExternalMcpBindingsSchema = z.array(managedExternalMcpBindingSchema).max(100);

export type CreateMcpConnection = z.infer<typeof createMcpConnectionSchema>;
export type UpdateMcpConnection = z.infer<typeof updateMcpConnectionSchema>;
export type McpOAuthStart = z.infer<typeof mcpOAuthStartSchema>;
export type McpOAuthCallback = z.infer<typeof mcpOAuthCallbackSchema>;
export type McpScopeSelection = z.infer<typeof mcpScopeSelectionSchema>;
export type UpdateMcpAgentBinding = z.infer<typeof updateMcpAgentBindingSchema>;
