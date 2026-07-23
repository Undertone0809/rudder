import type { Db } from "@rudderhq/db";
import {
  customIntegrationTools,
  mcpConnections,
  mcpOAuthGrants,
} from "@rudderhq/db";
import {
  createMcpConnectionSchema,
  MCP_PROVIDER_CATALOG,
  mcpConnectionMergedConfigSchema,
  mcpConnectionMutationConfigSchema,
  updateMcpConnectionSchema,
  type CreateMcpConnection,
  type McpConnectionSafeConfig,
  type McpConnectionSecretsMutation,
  type McpConnectionSummary,
  type McpDiscoveredTool,
  type UpdateMcpConnection,
} from "@rudderhq/shared";
import { and, asc, eq, ne } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { conflict, HttpError, notFound, unprocessable } from "../../errors.js";
import { secretService } from "../secrets.js";
import {
  createManagedMcpClient,
  resolveMcpHttpCredentials,
  type ManagedMcpClient,
  type ManagedMcpClientOptions,
} from "./managed-client.js";
import {
  MCP_PROVIDER_REGISTRY,
  resolveCuratedMcpEndpoint,
} from "./provider-registry.js";
import {
  assertSafeMcpCredentialHeaders,
  assertSafeMcpHeaders,
  resolveMcpHttpTarget,
  validateMcpStdioPolicy,
  type McpDeploymentAllowlists,
  type McpDnsLookup,
} from "./security-policy.js";
import {
  normalizeMcpDiscoveredTools,
  reconcileMcpToolCatalog,
} from "./tool-discovery.js";

type McpConnectionRow = typeof mcpConnections.$inferSelect;
type McpToolRow = typeof customIntegrationTools.$inferSelect;

interface ManagedMcpCredentialPayload {
  env?: Record<string, string>;
  headers?: Record<string, string>;
  bearerToken?: string;
}

export interface ManagedMcpConnectionServiceOptions {
  deploymentMode: "local_trusted" | "authenticated";
  allowlists: McpDeploymentAllowlists;
  hostEnv?: Record<string, string | undefined>;
  createClient?: (options: ManagedMcpClientOptions) => Promise<ManagedMcpClient>;
  dnsLookup?: McpDnsLookup;
}

export interface ManagedMcpMutationActor {
  userId?: string | null;
  agentId?: string | null;
}

const EMPTY_ALLOWLISTS: McpDeploymentAllowlists = {
  httpOrigins: [],
  stdioCommands: [],
  stdioWorkingDirectories: [],
  stdioEnvironmentNames: [],
};

const SENSITIVE_STATIC_NAME_RE =
  /(api[-_]?key|access[-_]?token|auth(?:[-_]?token)?|authorization|bearer|secret|passwd|password|credential|cookie|jwt|private[-_]?key|connectionstring|(?:^|[-_])token(?:$|[-_]))/iu;
const RECONNECT_REQUIRED_STATUSES = new Set([
  "disabled",
  "revoked",
  "needs_reauth",
  "error",
]);

export class ManagedMcpConnectionPolicyError extends HttpError {
  readonly code = "managed_mcp_policy_rejected";

  constructor(message = "Managed MCP connection policy rejected the configuration") {
    super(422, message);
    this.name = "ManagedMcpConnectionPolicyError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asStdioConfig(config: Record<string, unknown>) {
  return config as {
    command: string;
    args?: string[];
    cwd?: string;
    staticEnv?: Record<string, string>;
    forwardedEnv?: string[];
    secretEnvNames?: string[];
  };
}

function asHttpConfig(config: Record<string, unknown>) {
  return config as {
    url?: string;
    staticHeaders?: Record<string, string>;
    headersFromEnv?: Record<string, string>;
    bearerTokenEnvVar?: string;
    secretHeaderNames?: string[];
    hasBearerToken?: boolean;
  };
}

function declaredSecretShape(
  transport: string,
  safeConfig: Record<string, unknown>,
): {
  env: string[];
  headers: string[];
  bearerToken: boolean;
} {
  if (transport === "stdio") {
    const config = asStdioConfig(safeConfig);
    return {
      env: [...(config.secretEnvNames ?? [])].sort(),
      headers: [],
      bearerToken: false,
    };
  }
  if (transport === "streamable_http") {
    const config = asHttpConfig(safeConfig);
    return {
      env: [],
      headers: [...(config.secretHeaderNames ?? [])]
        .map((name) => name.toLowerCase())
        .sort(),
      bearerToken: config.hasBearerToken === true,
    };
  }
  return { env: [], headers: [], bearerToken: false };
}

function equalSecretShape(
  left: ReturnType<typeof declaredSecretShape>,
  right: ReturnType<typeof declaredSecretShape>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasDeclaredSecrets(shape: ReturnType<typeof declaredSecretShape>): boolean {
  return shape.env.length > 0 || shape.headers.length > 0 || shape.bearerToken;
}

function assertNoSensitiveStaticNames(
  values: Record<string, string> | undefined,
  kind: "environment variable" | "header",
): void {
  const sensitiveName = Object.keys(values ?? {}).find((name) => (
    SENSITIVE_STATIC_NAME_RE.test(name)
  ));
  if (sensitiveName) {
    throw new ManagedMcpConnectionPolicyError(
      `Managed MCP static ${kind} names that look sensitive must use encrypted credentials`,
    );
  }
}

function assertCustomHttpHeaderPolicy(
  config: ReturnType<typeof asHttpConfig>,
  credentials?: ManagedMcpCredentialPayload,
): void {
  try {
    assertSafeMcpHeaders(config.staticHeaders ?? {});
    assertSafeMcpCredentialHeaders(Object.fromEntries(
      Object.keys(config.headersFromEnv ?? {}).map((name) => [name, "environment-reference"]),
    ));
    assertSafeMcpCredentialHeaders(Object.fromEntries(
      (config.secretHeaderNames ?? []).map((name) => [name, "encrypted-reference"]),
    ));
    if (credentials?.headers) {
      assertSafeMcpCredentialHeaders(credentials.headers);
    }
  } catch {
    throw new ManagedMcpConnectionPolicyError(
      "Managed MCP header configuration is rejected by deployment policy",
    );
  }
  assertNoSensitiveStaticNames(config.staticHeaders, "header");
}

function reconnectRequiredError(): ReturnType<typeof unprocessable> {
  return unprocessable(
    "Reconnect the managed MCP connection before enabling or discovering tools",
  );
}

function publicSummary(row: McpConnectionRow): McpConnectionSummary {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    displayName: row.displayName,
    provider: row.provider as McpConnectionSummary["provider"],
    transport: row.transport as McpConnectionSummary["transport"],
    externalScope: row.externalScope,
    accessMode: row.accessMode as McpConnectionSummary["accessMode"],
    status: row.status as McpConnectionSummary["status"],
    safeConfig: row.safeConfig as McpConnectionSafeConfig,
    startupTimeoutMs: row.startupTimeoutMs,
    toolTimeoutMs: row.toolTimeoutMs,
    enabled: row.enabled,
    required: row.required,
    hasCredentials: Boolean(row.credentialSecretId),
    lastDiscoveredAt: row.lastDiscoveredAt,
    activatedAt: row.activatedAt,
    disabledAt: row.disabledAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function publicTool(row: McpToolRow): McpDiscoveredTool {
  if (!row.connectionId) {
    throw new Error("Managed MCP tool is missing its connection");
  }
  return {
    id: row.id,
    connectionId: row.connectionId,
    externalToolName: row.externalToolName,
    rudderToolName: row.rudderToolName,
    description: row.description,
    inputSchema: row.inputSchema,
    outputSchema: row.outputSchema,
    enabled: row.enabled,
    removedAt: row.removedAt,
  };
}

function parseCredentialPayload(value: string): ManagedMcpCredentialPayload {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) throw new Error("invalid");
    return {
      env: isRecord(parsed.env)
        ? Object.fromEntries(Object.entries(parsed.env).filter((entry): entry is [string, string] => (
            typeof entry[1] === "string"
          )))
        : undefined,
      headers: isRecord(parsed.headers)
        ? Object.fromEntries(Object.entries(parsed.headers).filter((entry): entry is [string, string] => (
            typeof entry[1] === "string"
          )))
        : undefined,
      bearerToken: typeof parsed.bearerToken === "string" ? parsed.bearerToken : undefined,
    };
  } catch {
    throw unprocessable("Managed MCP credential material is invalid");
  }
}

function customSecretPayload(input: McpConnectionSecretsMutation): ManagedMcpCredentialPayload {
  return {
    ...(input.env ? { env: input.env } : {}),
    ...(input.headers ? { headers: input.headers } : {}),
    ...(input.bearerToken ? { bearerToken: input.bearerToken } : {}),
  };
}

function assertLegacyMutable(row: McpConnectionRow): void {
  if (row.transport === "legacy_manual") {
    throw unprocessable(
      "Legacy manual MCP definitions are read-only; create and reconnect a new managed connection",
    );
  }
}

function redactedDiscoveryError(): ReturnType<typeof unprocessable> {
  return unprocessable("Managed MCP tool discovery failed");
}

export function managedMcpConnectionService(
  db: Db,
  options: ManagedMcpConnectionServiceOptions,
) {
  const secrets = secretService(db);
  const createClient = options.createClient ?? createManagedMcpClient;
  const hostEnv = options.hostEnv ?? process.env;
  const allowlists = options.allowlists ?? EMPTY_ALLOWLISTS;

  async function findRow(orgId: string, connectionId: string): Promise<McpConnectionRow> {
    const row = await db
      .select()
      .from(mcpConnections)
      .where(and(eq(mcpConnections.orgId, orgId), eq(mcpConnections.id, connectionId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("MCP connection not found");
    return row;
  }

  function assertHttpEnvironmentPolicy(config: ReturnType<typeof asHttpConfig>): void {
    if (options.deploymentMode !== "authenticated") return;
    const allowed = new Set(allowlists.stdioEnvironmentNames);
    const requested = [
      ...Object.values(config.headersFromEnv ?? {}),
      ...(config.bearerTokenEnvVar ? [config.bearerTokenEnvVar] : []),
    ];
    if (requested.some((name) => !allowed.has(name))) {
      throw unprocessable("Managed MCP HTTP environment name is not allowed by deployment policy");
    }
  }

  async function validateBoundary(input: {
    provider: string;
    transport: string;
    accessMode: string;
    externalScope: string | null;
    safeConfig: Record<string, unknown>;
    credentials?: ManagedMcpCredentialPayload;
  }): Promise<void> {
    try {
      if (input.transport === "legacy_manual") return;
      if (input.transport === "stdio") {
        const config = asStdioConfig(input.safeConfig);
        assertNoSensitiveStaticNames(config.staticEnv, "environment variable");
        await validateMcpStdioPolicy({
          command: config.command,
          args: config.args,
          cwd: config.cwd,
          environmentNames: [
            ...Object.keys(config.staticEnv ?? {}),
            ...(config.forwardedEnv ?? []),
            ...(config.secretEnvNames ?? []),
          ],
        }, {
          deploymentMode: options.deploymentMode,
          stdioCommands: allowlists.stdioCommands,
          stdioWorkingDirectories: allowlists.stdioWorkingDirectories,
          stdioEnvironmentNames: allowlists.stdioEnvironmentNames,
        });
        return;
      }

      let url: string;
      let curatedOrigin: string | undefined;
      if (input.provider === "custom") {
        const config = asHttpConfig(input.safeConfig);
        if (!config.url) throw unprocessable("Custom Streamable HTTP connection requires a URL");
        assertCustomHttpHeaderPolicy(config, input.credentials);
        assertHttpEnvironmentPolicy(config);
        url = config.url;
      } else {
        // Supabase is allowed to remain draft before project selection.
        if (input.provider === "supabase" && !input.externalScope) {
          return;
        }
        const endpoint = resolveCuratedMcpEndpoint({
          provider: input.provider as "supabase" | "linear" | "notion",
          accessMode: input.accessMode as "provider_default" | "read_only" | "read_write",
          externalScope: input.externalScope,
        });
        url = endpoint.href;
        curatedOrigin = new URL(MCP_PROVIDER_REGISTRY[
          input.provider as "supabase" | "linear" | "notion"
        ].endpoint).origin;
      }
      await resolveMcpHttpTarget(url, {
        allowedOrigins: allowlists.httpOrigins,
        curatedOrigin,
        lookup: options.dnsLookup,
      });
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      throw new ManagedMcpConnectionPolicyError();
    }
  }

  async function createCredential(
    orgId: string,
    connectionName: string,
    value: McpConnectionSecretsMutation,
    actor: ManagedMcpMutationActor,
  ) {
    return secrets.create(orgId, {
      name: `Managed MCP credentials - ${connectionName} - ${randomUUID()}`,
      provider: "local_encrypted",
      value: JSON.stringify(customSecretPayload(value)),
      description: "Encrypted managed MCP credentials",
    }, actor);
  }

  async function resolveCredentialPayload(row: McpConnectionRow): Promise<ManagedMcpCredentialPayload> {
    if (!row.credentialSecretId) return {};
    return parseCredentialPayload(
      await secrets.resolveSecretValue(row.orgId, row.credentialSecretId, "latest"),
    );
  }

  async function buildClientOptions(row: McpConnectionRow): Promise<ManagedMcpClientOptions> {
    assertLegacyMutable(row);
    await validateBoundary({
      provider: row.provider,
      transport: row.transport,
      accessMode: row.accessMode,
      externalScope: row.externalScope,
      safeConfig: row.safeConfig,
    });

    if (row.transport === "stdio") {
      const config = asStdioConfig(row.safeConfig);
      const credential = await resolveCredentialPayload(row);
      return {
        transport: "stdio",
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        staticEnv: config.staticEnv ?? {},
        forwardedEnv: config.forwardedEnv ?? [],
        secretEnv: credential.env ?? {},
        hostEnv,
        deploymentPolicy: {
          deploymentMode: options.deploymentMode,
          stdioCommands: allowlists.stdioCommands,
          stdioWorkingDirectories: allowlists.stdioWorkingDirectories,
          stdioEnvironmentNames: allowlists.stdioEnvironmentNames,
        },
        startupTimeoutMs: row.startupTimeoutMs,
        toolTimeoutMs: row.toolTimeoutMs,
      };
    }

    let url: string;
    let curatedOrigin: string | undefined;
    let credential: ManagedMcpCredentialPayload = {};
    if (row.provider === "custom") {
      const config = asHttpConfig(row.safeConfig);
      if (!config.url) throw unprocessable("Custom Streamable HTTP connection requires a URL");
      url = config.url;
      credential = await resolveCredentialPayload(row);
      for (const [headerName, environmentName] of Object.entries(config.headersFromEnv ?? {})) {
        const value = hostEnv[environmentName];
        if (value !== undefined) {
          credential.headers = { ...(credential.headers ?? {}), [headerName]: value };
        }
      }
      if (config.bearerTokenEnvVar) {
        credential.bearerToken = hostEnv[config.bearerTokenEnvVar];
      }
      assertCustomHttpHeaderPolicy(config, credential);
    } else {
      const endpoint = resolveCuratedMcpEndpoint({
        provider: row.provider as "supabase" | "linear" | "notion",
        accessMode: row.accessMode as "provider_default" | "read_only" | "read_write",
        externalScope: row.externalScope,
      });
      url = endpoint.href;
      curatedOrigin = new URL(MCP_PROVIDER_REGISTRY[
        row.provider as "supabase" | "linear" | "notion"
      ].endpoint).origin;
      const grant = await db
        .select()
        .from(mcpOAuthGrants)
        .where(and(
          eq(mcpOAuthGrants.orgId, row.orgId),
          eq(mcpOAuthGrants.connectionId, row.id),
          eq(mcpOAuthGrants.status, "active"),
        ))
        .then((rows) => rows[0] ?? null);
      if (!grant) throw unprocessable("Managed MCP OAuth authorization is required");
      const raw = await secrets.resolveSecretValue(row.orgId, grant.credentialSecretId, "latest");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw unprocessable("Managed MCP OAuth credential material is invalid");
      }
      if (!isRecord(parsed)) throw unprocessable("Managed MCP OAuth credential material is invalid");
      const token = [parsed.accessToken, parsed.bearerToken, parsed.token]
        .find((value): value is string => typeof value === "string" && value.length > 0);
      if (!token) throw unprocessable("Managed MCP OAuth credential material is invalid");
      credential = { bearerToken: token };
    }

    const config = asHttpConfig(row.safeConfig);
    return {
      transport: "streamable_http",
      url,
      staticHeaders: row.provider === "custom" ? config.staticHeaders ?? {} : {},
      credentials: resolveMcpHttpCredentials({
        bearerToken: credential.bearerToken,
        secretHeaders: credential.headers,
      }),
      network: {
        allowedOrigins: allowlists.httpOrigins,
        curatedOrigin,
        lookup: options.dnsLookup,
      },
      startupTimeoutMs: row.startupTimeoutMs,
      toolTimeoutMs: row.toolTimeoutMs,
    };
  }

  async function listTools(orgId: string, connectionId: string): Promise<McpDiscoveredTool[]> {
    await findRow(orgId, connectionId);
    return db
      .select()
      .from(customIntegrationTools)
      .where(and(
        eq(customIntegrationTools.orgId, orgId),
        eq(customIntegrationTools.connectionId, connectionId),
      ))
      .orderBy(asc(customIntegrationTools.externalToolName))
      .then((rows) => rows.map(publicTool));
  }

  return {
    catalog: () => MCP_PROVIDER_CATALOG.map((entry) => ({
      ...entry,
      transports: [...entry.transports],
      accessModes: [...entry.accessModes],
    })),

    list: (orgId: string) =>
      db
        .select()
        .from(mcpConnections)
        .where(eq(mcpConnections.orgId, orgId))
        .orderBy(asc(mcpConnections.displayName))
        .then((rows) => rows.map(publicSummary)),

    get: async (orgId: string, connectionId: string) =>
      publicSummary(await findRow(orgId, connectionId)),

    create: async (
      orgId: string,
      rawInput: CreateMcpConnection,
      actor: ManagedMcpMutationActor = {},
    ) => {
      const input = createMcpConnectionSchema.parse(rawInput);
      if (input.transport === "legacy_manual") {
        throw unprocessable("Legacy manual MCP definitions cannot be created as managed connections");
      }
      await validateBoundary({
        provider: input.provider,
        transport: input.transport,
        accessMode: input.accessMode,
        externalScope: input.externalScope ?? null,
        safeConfig: input.safeConfig,
        credentials: input.secrets ? customSecretPayload(input.secrets) : undefined,
      });

      let credentialSecretId: string | null = null;
      if (input.secrets) {
        credentialSecretId = (await createCredential(orgId, input.name, input.secrets, actor)).id;
      }
      try {
        const row = await db
          .insert(mcpConnections)
          .values({
            orgId,
            credentialSecretId,
            name: input.name,
            displayName: input.displayName,
            provider: input.provider,
            transport: input.transport,
            externalScope: input.externalScope ?? null,
            accessMode: input.accessMode,
            status: "draft",
            safeConfig: input.safeConfig,
            startupTimeoutMs: input.startupTimeoutMs,
            toolTimeoutMs: input.toolTimeoutMs,
            enabled: input.enabled,
            required: input.required,
          })
          .returning()
          .then((rows) => rows[0]!);
        return publicSummary(row);
      } catch (error) {
        if (credentialSecretId) await secrets.remove(credentialSecretId).catch(() => undefined);
        if (error instanceof Error && /unique|duplicate/iu.test(error.message)) {
          throw conflict("MCP connection name or provider scope already exists");
        }
        throw error;
      }
    },

    update: async (
      orgId: string,
      connectionId: string,
      rawPatch: UpdateMcpConnection,
      actor: ManagedMcpMutationActor = {},
    ) => {
      const existing = await findRow(orgId, connectionId);
      assertLegacyMutable(existing);
      const patch = updateMcpConnectionSchema.parse(rawPatch);
      if (
        patch.enabled === true
        && RECONNECT_REQUIRED_STATUSES.has(existing.status)
      ) {
        throw reconnectRequiredError();
      }
      const merged = {
        provider: existing.provider,
        transport: existing.transport,
        accessMode: patch.accessMode ?? existing.accessMode,
        safeConfig: patch.safeConfig ?? existing.safeConfig,
        enabled: patch.enabled ?? existing.enabled,
      };
      mcpConnectionMergedConfigSchema.parse(merged);

      const previousShape = declaredSecretShape(existing.transport, existing.safeConfig);
      const nextShape = declaredSecretShape(existing.transport, merged.safeConfig);
      const declarationChanged = !equalSecretShape(previousShape, nextShape);
      if (patch.secrets || declarationChanged) {
        if (hasDeclaredSecrets(nextShape) && !patch.secrets) {
          throw unprocessable(
            "Changed managed MCP secret declarations require exact replacement values",
          );
        }
        mcpConnectionMutationConfigSchema.parse({
          ...merged,
          ...(patch.secrets ? { secrets: patch.secrets } : {}),
        });
      }
      await validateBoundary({
        ...merged,
        externalScope: patch.externalScope === undefined
          ? existing.externalScope
          : patch.externalScope ?? null,
        credentials: patch.secrets ? customSecretPayload(patch.secrets) : undefined,
      });

      let credentialSecretId = existing.credentialSecretId;
      let replacementSecretId: string | null = null;
      let oldSecretIdToDelete: string | null = null;
      if (patch.secrets) {
        const serialized = JSON.stringify(customSecretPayload(patch.secrets));
        if (credentialSecretId && declarationChanged) {
          oldSecretIdToDelete = credentialSecretId;
          const replacement = await createCredential(orgId, existing.name, patch.secrets, actor);
          credentialSecretId = replacement.id;
          replacementSecretId = replacement.id;
        } else if (credentialSecretId) {
          await secrets.rotate(credentialSecretId, { value: serialized }, actor);
        } else {
          const replacement = await createCredential(orgId, existing.name, patch.secrets, actor);
          credentialSecretId = replacement.id;
          replacementSecretId = replacement.id;
        }
      } else if (declarationChanged && !hasDeclaredSecrets(nextShape) && credentialSecretId) {
        oldSecretIdToDelete = credentialSecretId;
        credentialSecretId = null;
      }

      let row: McpConnectionRow | null;
      try {
        row = await db
          .update(mcpConnections)
          .set({
            credentialSecretId,
            ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
            ...(patch.externalScope !== undefined ? { externalScope: patch.externalScope ?? null } : {}),
            ...(patch.accessMode !== undefined ? { accessMode: patch.accessMode } : {}),
            ...(patch.safeConfig !== undefined ? { safeConfig: patch.safeConfig } : {}),
            ...(patch.startupTimeoutMs !== undefined ? { startupTimeoutMs: patch.startupTimeoutMs } : {}),
            ...(patch.toolTimeoutMs !== undefined ? { toolTimeoutMs: patch.toolTimeoutMs } : {}),
            ...(patch.enabled !== undefined ? {
              enabled: patch.enabled,
              disabledAt: patch.enabled ? null : new Date(),
              status: patch.enabled ? existing.status : "disabled",
            } : {}),
            ...(patch.required !== undefined ? { required: patch.required } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(mcpConnections.orgId, orgId), eq(mcpConnections.id, connectionId)))
          .returning()
          .then((rows) => rows[0] ?? null);
      } catch (error) {
        if (replacementSecretId) {
          await secrets.remove(replacementSecretId).catch(() => undefined);
        }
        throw error;
      }
      if (!row) {
        if (replacementSecretId) {
          await secrets.remove(replacementSecretId).catch(() => undefined);
        }
        throw notFound("MCP connection not found");
      }
      if (oldSecretIdToDelete) {
        await secrets.remove(oldSecretIdToDelete).catch(() => undefined);
      }
      return publicSummary(row);
    },

    reconnect: async (orgId: string, connectionId: string) => {
      const existing = await findRow(orgId, connectionId);
      assertLegacyMutable(existing);
      const row = await db
        .update(mcpConnections)
        .set({
          status: existing.provider === "custom" ? "draft" : "authorizing",
          enabled: true,
          disabledAt: null,
          revokedAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(mcpConnections.orgId, orgId), eq(mcpConnections.id, connectionId)))
        .returning()
        .then((rows) => rows[0]!);
      return publicSummary(row);
    },

    disconnect: async (orgId: string, connectionId: string) => {
      const existing = await findRow(orgId, connectionId);
      assertLegacyMutable(existing);
      const now = new Date();
      const row = await db
        .update(mcpConnections)
        .set({
          status: "disabled",
          enabled: false,
          disabledAt: now,
          updatedAt: now,
        })
        .where(and(eq(mcpConnections.orgId, orgId), eq(mcpConnections.id, connectionId)))
        .returning()
        .then((rows) => rows[0]!);
      return publicSummary(row);
    },

    listTools,

    refreshTools: async (orgId: string, connectionId: string) => {
      const existing = await findRow(orgId, connectionId);
      assertLegacyMutable(existing);
      if (
        !existing.enabled
        || RECONNECT_REQUIRED_STATUSES.has(existing.status)
      ) {
        throw reconnectRequiredError();
      }
      if (existing.provider === "supabase" && !existing.externalScope) {
        throw unprocessable("Supabase MCP connections require a selected project before discovery");
      }
      let client: ManagedMcpClient | null = null;
      try {
        client = await createClient(await buildClientOptions(existing));
        const normalized = normalizeMcpDiscoveredTools(
          existing.name,
          await client.discoverTools(),
        );
        const existingTools = await db
          .select()
          .from(customIntegrationTools)
          .where(and(
            eq(customIntegrationTools.orgId, orgId),
            eq(customIntegrationTools.connectionId, connectionId),
          ));
        const reconciled = reconcileMcpToolCatalog(existingTools, normalized);
        const normalizedByName = new Map(normalized.map((tool) => [tool.externalToolName, tool]));
        const existingByName = new Map(existingTools.map((tool) => [tool.externalToolName, tool]));
        const now = new Date();

        await db.transaction(async (tx) => {
          for (const tool of reconciled) {
            const prior = existingByName.get(tool.externalToolName);
            const current = normalizedByName.get(tool.externalToolName);
            if (prior) {
              await tx
                .update(customIntegrationTools)
                .set({
                  ...(current ? {
                    rudderToolName: current.rudderToolName,
                    description: current.description,
                    rawInputSchema: current.rawInputSchema,
                    inputSchema: current.inputSchema,
                    rawOutputSchema: current.rawOutputSchema,
                    outputSchema: current.outputSchema,
                    discoveredAt: now,
                  } : {}),
                  status: tool.status,
                  enabled: tool.enabled,
                  removedAt: tool.status === "removed" ? now : null,
                  updatedAt: now,
                })
                .where(eq(customIntegrationTools.id, prior.id));
            } else if (current) {
              await tx.insert(customIntegrationTools).values({
                orgId,
                connectionId,
                externalToolName: current.externalToolName,
                rudderToolName: current.rudderToolName,
                description: current.description,
                rawInputSchema: current.rawInputSchema,
                inputSchema: current.inputSchema,
                rawOutputSchema: current.rawOutputSchema,
                outputSchema: current.outputSchema,
                status: "active",
                enabled: true,
                discoveredAt: now,
              });
            }
          }
          await tx
            .update(mcpConnections)
            .set({
              status: "active",
              enabled: true,
              activatedAt: existing.activatedAt ?? now,
              lastDiscoveredAt: now,
              disabledAt: null,
              updatedAt: now,
            })
            .where(and(eq(mcpConnections.orgId, orgId), eq(mcpConnections.id, connectionId)));
        });
        return listTools(orgId, connectionId);
      } catch (error) {
        await db
          .update(mcpConnections)
          .set({ status: "error", updatedAt: new Date() })
          .where(and(
            eq(mcpConnections.orgId, orgId),
            eq(mcpConnections.id, connectionId),
            ne(mcpConnections.status, "revoked"),
          ));
        if (error instanceof HttpError) {
          throw error;
        }
        throw redactedDiscoveryError();
      } finally {
        await client?.close().catch(() => undefined);
      }
    },
  };
}
