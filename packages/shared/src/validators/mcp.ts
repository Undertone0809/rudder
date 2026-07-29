import { z } from "zod";
import {
  MCP_AGENT_ACCESS_MODES,
  MCP_AGENT_BINDING_STATUSES,
  MCP_CONNECTION_ACCESS_MODES,
  MCP_CONNECTION_CANONICAL_STATES,
  MCP_CONNECTION_PROVIDERS,
  MCP_CONNECTION_SCOPES,
  MCP_CONNECTION_STATUSES,
  MCP_CONNECTION_TRANSPORTS,
  MCP_OAUTH_GRANT_STATUSES,
  MCP_PROVIDER_CATALOG,
  MCP_PROVIDER_ORGANIZATION_STATES,
  MCP_PROVIDER_SCOPE_MODES,
  MCP_TOOL_CAPABILITY_CLASSES,
} from "../constants.js";

const uuidSchema = z.string().uuid();
const timestampSchema = z.string().datetime({ offset: true });
const connectionNameSchema = z.string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/, "Use lowercase letters, numbers, underscores, and hyphens");
const reservedMcpConnectionNames = new Set(["rudder-tools", "rudder-browser"]);
const environmentNameSchema = z.string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use a valid environment variable name");
const externalMcpToolNameSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.-]+$/, "Use an exact MCP tool name");
const externalMcpToolFilterSchema = z.array(externalMcpToolNameSchema).max(500);

export const mcpConnectionProviderSchema = z.enum(MCP_CONNECTION_PROVIDERS);
export const mcpConnectionScopeSchema = z.enum(MCP_CONNECTION_SCOPES);
export const mcpConnectionTransportSchema = z.enum(MCP_CONNECTION_TRANSPORTS);
export const mcpConnectionAccessModeSchema = z.enum(MCP_CONNECTION_ACCESS_MODES);
export const mcpAgentAccessModeSchema = z.enum(MCP_AGENT_ACCESS_MODES);
export const mcpConnectionCanonicalStateSchema = z.enum(MCP_CONNECTION_CANONICAL_STATES);
export const mcpProviderScopeModeSchema = z.enum(MCP_PROVIDER_SCOPE_MODES);
export const mcpProviderOrganizationStateSchema = z.enum(MCP_PROVIDER_ORGANIZATION_STATES);
export const mcpToolCapabilityClassSchema = z.enum(MCP_TOOL_CAPABILITY_CLASSES);
export const mcpProviderMaxAccessSchema = z.enum(["read_only", "read_write", "provider_granted"]);
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
  toolAllowlist: externalMcpToolFilterSchema.optional(),
  toolDenylist: externalMcpToolFilterSchema.optional(),
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
  toolAllowlist: externalMcpToolFilterSchema.optional(),
  toolDenylist: externalMcpToolFilterSchema.optional(),
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

export const mcpCuratedSafeConfigSchema = z.object({
  featureGroups: z.object({
    mode: z.literal("provider_default"),
    excluded: z.array(z.string().min(1).max(120)).max(100),
  }).strict(),
}).strict();

export const mcpConnectionSafeConfigSchema = z.union([
  mcpStdioSafeConfigSchema,
  mcpStreamableHttpSafeConfigSchema,
  mcpLegacyManualSafeConfigSchema,
  mcpCuratedSafeConfigSchema,
]);

const mcpConnectionInputFields = {
  name: connectionNameSchema,
  displayName: z.string().trim().min(1).max(120),
  provider: mcpConnectionProviderSchema,
  scope: mcpConnectionScopeSchema,
  ownerAgentId: uuidSchema.optional().nullable(),
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
  if (provider === "supabase") return "read_write";
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

function validateSafeConnectionConfig(
  value: {
    provider?: string;
    transport?: string;
    accessMode?: string;
    safeConfig?: unknown;
    enabled?: boolean;
    secrets?: z.infer<typeof mcpConnectionSecretsMutationSchema>;
  },
  ctx: z.RefinementCtx,
  options: { allowManagedCuratedSafeConfig?: boolean } = {},
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
    const hasManagedCuratedConfig = (
      options.allowManagedCuratedSafeConfig === true
      && mcpCuratedSafeConfigSchema.safeParse(value.safeConfig).success
    );
    if (
      typeof value.safeConfig !== "object"
      || value.safeConfig === null
      || Array.isArray(value.safeConfig)
      || (Object.keys(value.safeConfig).length > 0 && !hasManagedCuratedConfig)
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
  }

  if (value.transport === "streamable_http") {
    const parsed = mcpStreamableHttpSafeConfigSchema.safeParse(value.safeConfig);
    if (parsed.success) {
      const declaredHeaderNames = parsed.data.secretHeaderNames ?? [];
      const suppliedHeaderNames = Object.keys(value.secrets?.headers ?? {});
      const declaredBearer = parsed.data.hasBearerToken === true;
      const suppliedBearer = Boolean(value.secrets?.bearerToken);

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

function validateConnectionSecretMutation(
  value: {
    provider?: string;
    transport?: string;
    safeConfig?: unknown;
    secrets?: z.infer<typeof mcpConnectionSecretsMutationSchema>;
  },
  ctx: z.RefinementCtx,
) {
  if (value.provider !== "custom") return;

  if (value.transport === "stdio") {
    const parsed = mcpStdioSafeConfigSchema.safeParse(value.safeConfig);
    if (parsed.success) {
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

  if (value.transport === "legacy_manual" && value.secrets) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["secrets"],
      message: "Legacy manual connections cannot accept new secret values",
    });
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
    }
  }
}

export const createMcpConnectionSchema = z.object(mcpConnectionInputFields)
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === "organization" && value.ownerAgentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ownerAgentId"],
        message: "Organization MCP connections cannot have an owner agent",
      });
    }
    if (value.scope === "agent" && !value.ownerAgentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ownerAgentId"],
        message: "Agent MCP connections require an owner agent",
      });
    }
  })
  .superRefine((value, ctx) => {
    if (reservedMcpConnectionNames.has(value.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["name"],
        message: `${value.name} is reserved for an internal Rudder runtime`,
      });
    }
  })
  .superRefine(validateSafeConnectionConfig)
  .superRefine(validateConnectionSecretMutation)
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
 * Persisted-safe validation target after an immutable provider/transport
 * record has been merged with a public update payload. Existing encrypted
 * secret material is intentionally not required.
 */
const mcpConnectionMergedConfigFields = {
  provider: mcpConnectionProviderSchema,
  transport: mcpConnectionTransportSchema,
  accessMode: mcpConnectionAccessModeSchema,
  safeConfig: mcpConnectionSafeConfigSchema,
  enabled: z.boolean(),
};

export const mcpConnectionMergedConfigSchema = z.object(
  mcpConnectionMergedConfigFields,
).strict().superRefine((value, ctx) => {
  validateSafeConnectionConfig(value, ctx, { allowManagedCuratedSafeConfig: true });
});

/**
 * Mutation-aware validation target for create, secret rotation, or a safe
 * config change that alters secret declarations.
 */
export const mcpConnectionMutationConfigSchema = z.object({
  ...mcpConnectionMergedConfigFields,
  secrets: mcpConnectionSecretsMutationSchema.optional(),
}).strict()
  .superRefine((value, ctx) => {
    validateSafeConnectionConfig(value, ctx, { allowManagedCuratedSafeConfig: true });
  })
  .superRefine(validateConnectionSecretMutation);

export const mcpConnectionSummarySchema = z.object({
  id: uuidSchema,
  orgId: uuidSchema,
  scope: mcpConnectionScopeSchema,
  ownerAgentId: uuidSchema.nullable(),
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
  defaultAccessMode: mcpConnectionAccessModeSchema,
}).strict().superRefine((value, ctx) => {
  if (!value.accessModes.includes(value.defaultAccessMode)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["defaultAccessMode"],
      message: "Default access mode must be included in accessModes",
    });
  }
});

export const mcpProviderCatalogSchema = z.array(mcpProviderCatalogEntrySchema);
mcpProviderCatalogSchema.parse(MCP_PROVIDER_CATALOG);

export const mcpOAuthStartSchema = z.object({}).strict();

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
  iss: z.string().url().max(8_192).optional(),
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
  capabilityClass: mcpToolCapabilityClassSchema,
  policyRevision: z.number().int().positive(),
  catalogRevision: z.number().int().positive(),
  enabled: z.boolean(),
  removedAt: timestampSchema.nullable(),
}).strict();

export const mcpAgentBindingSchema = z.object({
  id: uuidSchema,
  connectionId: uuidSchema,
  agentId: uuidSchema,
  status: mcpAgentBindingStatusSchema,
  accessMode: mcpAgentAccessModeSchema,
  policyRevision: z.number().int().positive(),
  enabledToolIds: z.array(uuidSchema).max(500),
}).strict();

export const mcpAgentConnectionSummarySchema = z.object({
  connection: mcpConnectionSummarySchema,
  binding: mcpAgentBindingSchema.nullable(),
  tools: z.array(mcpDiscoveredToolSchema).max(500),
  reviewRequired: z.boolean(),
}).strict();

export const upsertMcpAgentBindingSchema = z.object({
  status: mcpAgentBindingStatusSchema.optional(),
  accessMode: mcpAgentAccessModeSchema.optional(),
  expectedRevision: z.number().int().positive().optional(),
  enabledToolIds: z.array(uuidSchema).max(500).optional(),
}).strict();

export const updateMcpAgentBindingSchema = z.object({
  status: mcpAgentBindingStatusSchema.optional(),
  accessMode: mcpAgentAccessModeSchema.optional(),
  expectedRevision: z.number().int().positive().optional(),
  enabledToolIds: z.array(uuidSchema).max(500).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "At least one binding field is required",
});

export const managedExternalMcpBindingSchema = z.object({
  bindingId: uuidSchema,
  serverName: connectionNameSchema,
  accessMode: mcpAgentAccessModeSchema,
  toolPolicy: z.object({
    mode: z.literal("allowlist"),
    allowedToolNames: z.array(z.string().min(1).max(320)).max(500),
  }).strict(),
  required: z.boolean(),
  startupTimeoutMs: z.number().int().positive(),
  toolTimeoutMs: z.number().int().positive(),
}).strict();

export const managedExternalMcpBindingsSchema = z.array(managedExternalMcpBindingSchema).max(100);

export const mcpProviderAvailabilitySchema = z.object({
  provider: z.enum(["supabase", "linear", "notion"]),
  organization: z.object({
    state: mcpProviderOrganizationStateSchema,
    connectionId: uuidSchema.nullable(),
    maxAccess: mcpProviderMaxAccessSchema.nullable(),
    scopeMode: mcpProviderScopeModeSchema.nullable(),
    revision: z.number().int().positive().nullable(),
    affectedAgentCount: z.number().int().nonnegative().optional(),
    agentConnectionCount: z.number().int().nonnegative().optional(),
    historicalGrantConnectionIds: z.array(uuidSchema).max(100).optional(),
  }).strict(),
  agent: z.object({
    access: mcpAgentAccessModeSchema,
    activeRunUsesOlderPolicy: z.boolean(),
    connection: z.object({
      state: mcpProviderOrganizationStateSchema,
      connectionId: uuidSchema,
      maxAccess: mcpProviderMaxAccessSchema,
      revision: z.number().int().positive(),
    }).strict().nullable().default(null),
    effectiveSource: z.enum(["agent", "organization", "none"]).default("none"),
    effectiveConnectionId: uuidSchema.nullable().default(null),
    explicitlyDisabled: z.boolean().default(false),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  const connectedState = value.organization.state === "connected";
  if (connectedState && (
    value.organization.connectionId === null
    || value.organization.maxAccess === null
    || value.organization.scopeMode === null
    || value.organization.revision === null
  )) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["organization"],
      message: "Connected providers require a connection, access, scope, and revision",
    });
  }

  const maxAccess = value.organization.maxAccess;
  if (
    value.provider === "notion"
    && maxAccess !== null
    && maxAccess !== "provider_granted"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["organization", "maxAccess"],
      message: "Notion exposes provider-granted access",
    });
  }
  if (
    value.provider !== "notion"
    && maxAccess !== null
    && maxAccess === "provider_granted"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["organization", "maxAccess"],
      message: `${value.provider} requires explicit read-only or read-write access`,
    });
  }

  const scopeMode = value.organization.scopeMode;
  const validScope = scopeMode === null
    || (value.provider === "supabase"
      ? scopeMode === "account" || scopeMode === "legacy_project"
      : scopeMode === "workspace");
  if (!validScope) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["organization", "scopeMode"],
      message: `${value.provider} does not support ${scopeMode}`,
    });
  }

  const agentAccess = value.agent?.access;
  if (agentAccess !== undefined) {
    const validAgentAccess = agentAccess === "none"
      || (value.provider === "notion"
        ? agentAccess === "provider_granted"
        : agentAccess === "read_only"
          || (
            agentAccess === "read_write"
            && value.organization.maxAccess === "read_write"
          ));
    if (!validAgentAccess) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agent", "access"],
        message: `${value.provider} agent access exceeds or conflicts with organization access`,
      });
    }
  }
});

export type CreateMcpConnection = z.infer<typeof createMcpConnectionSchema>;
export type UpdateMcpConnection = z.infer<typeof updateMcpConnectionSchema>;
export type McpOAuthStart = z.infer<typeof mcpOAuthStartSchema>;
export type McpOAuthCallback = z.infer<typeof mcpOAuthCallbackSchema>;
export type McpScopeSelection = z.infer<typeof mcpScopeSelectionSchema>;
export type UpsertMcpAgentBinding = z.infer<typeof upsertMcpAgentBindingSchema>;
export type UpdateMcpAgentBinding = z.infer<typeof updateMcpAgentBindingSchema>;
