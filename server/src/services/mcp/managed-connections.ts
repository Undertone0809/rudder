import type { Db } from "@rudderhq/db";
import {
  activityLog,
  customIntegrationTools,
  mcpConnections,
  mcpOAuthGrants,
  organizationSecrets,
  organizationSecretVersions,
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
import { and, asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { conflict, HttpError, notFound, unprocessable } from "../../errors.js";
import { getSecretProvider } from "../../secrets/provider-registry.js";
import { secretService } from "../secrets.js";
import {
  createManagedMcpClient,
  resolveMcpHttpCredentials,
  type ManagedMcpClient,
  type ManagedMcpClientOptions,
  type ManagedMcpOAuthCredential,
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

interface PreparedManagedMcpCredential {
  id: string;
  name: string;
  externalRef: string | null;
  material: Record<string, unknown>;
  valueSha256: string;
}

export interface ManagedMcpConnectionServiceOptions {
  deploymentMode: "local_trusted" | "authenticated";
  allowlists: McpDeploymentAllowlists;
  hostEnv?: Record<string, string | undefined>;
  createClient?: (options: ManagedMcpClientOptions) => Promise<ManagedMcpClient>;
  createOAuthCredential?: (
    orgId: string,
    connectionId: string,
  ) => ManagedMcpOAuthCredential;
  dnsLookup?: McpDnsLookup;
}

export interface ManagedMcpMutationActor {
  userId?: string | null;
  agentId?: string | null;
}

export interface ManagedMcpUpdateControl {
  allowCuratedAccessMode?: boolean;
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

export class ManagedMcpDiscoveryStaleError extends HttpError {
  readonly code = "managed_mcp_discovery_stale";

  constructor() {
    super(409, "Managed MCP connection changed while tools were being discovered");
    this.name = "ManagedMcpDiscoveryStaleError";
  }
}

interface ManagedMcpDiscoverySnapshot {
  enabled: boolean;
  lastDiscoveredAt: number | null;
  status: string;
  updatedAt: number;
}

function discoverySnapshot(row: McpConnectionRow): ManagedMcpDiscoverySnapshot {
  return {
    enabled: row.enabled,
    lastDiscoveredAt: row.lastDiscoveredAt?.getTime() ?? null,
    status: row.status,
    updatedAt: row.updatedAt.getTime(),
  };
}

function nextConnectionMutationTime(row: McpConnectionRow): Date {
  return new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1));
}

function assertDiscoverySnapshot(
  row: McpConnectionRow,
  snapshot: ManagedMcpDiscoverySnapshot,
): void {
  if (
    row.enabled !== snapshot.enabled
    || row.status !== snapshot.status
    || row.updatedAt.getTime() !== snapshot.updatedAt
    || (row.lastDiscoveredAt?.getTime() ?? null) !== snapshot.lastDiscoveredAt
  ) {
    throw new ManagedMcpDiscoveryStaleError();
  }
}

function managedMcpActivityValues(input: {
  orgId: string;
  connectionId: string;
  action: string;
  actor: ManagedMcpMutationActor;
  details: Record<string, unknown>;
}) {
  const actorType = input.actor.agentId
    ? "agent" as const
    : input.actor.userId
      ? "user" as const
      : "system" as const;
  const actorId = input.actor.agentId ?? input.actor.userId ?? "system";
  return {
    orgId: input.orgId,
    actorType,
    actorId,
    action: input.action,
    entityType: "mcp_connection",
    entityId: input.connectionId,
    agentId: input.actor.agentId ?? null,
    details: input.details,
  };
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

function discoveryNotReadyError(): ReturnType<typeof unprocessable> {
  return unprocessable(
    "Managed MCP connection is not ready for tool discovery; reconnect or complete authorization first",
  );
}

function canDiscoverTools(row: McpConnectionRow): boolean {
  if (!row.enabled) return false;
  if (row.provider === "custom") {
    return row.status === "draft" || row.status === "active";
  }
  return row.status === "active";
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

  async function prepareCredentialReplacement(
    connectionName: string,
    value: McpConnectionSecretsMutation,
  ): Promise<PreparedManagedMcpCredential> {
    const id = randomUUID();
    const prepared = await getSecretProvider("local_encrypted").createVersion({
      value: JSON.stringify(customSecretPayload(value)),
      externalRef: null,
    });
    return {
      id,
      name: `Managed MCP credentials - ${connectionName} - ${id}`,
      externalRef: prepared.externalRef,
      material: prepared.material,
      valueSha256: prepared.valueSha256,
    };
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
    let oauthCredential: ManagedMcpOAuthCredential | undefined;
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
      if (!grant?.credentialSecretId) {
        throw unprocessable("Managed MCP OAuth authorization is required");
      }
      if (!options.createOAuthCredential) {
        throw unprocessable("Managed MCP OAuth credential factory is not configured");
      }
      oauthCredential = options.createOAuthCredential(row.orgId, row.id);
    }

    const config = asHttpConfig(row.safeConfig);
    return {
      transport: "streamable_http",
      url,
      staticHeaders: row.provider === "custom" ? config.staticHeaders ?? {} : {},
      credentials: resolveMcpHttpCredentials({
        bearerToken: credential.bearerToken,
        secretHeaders: credential.headers,
        oauth: oauthCredential,
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

      const credential = input.secrets
        ? await prepareCredentialReplacement(input.name, input.secrets)
        : null;
      try {
        const row = await db.transaction(async (tx) => {
          if (credential) {
            await tx.insert(organizationSecrets).values({
              id: credential.id,
              orgId,
              name: credential.name,
              provider: "local_encrypted",
              purpose: "managed_mcp_connection",
              externalRef: credential.externalRef,
              latestVersion: 1,
              description: "Encrypted managed MCP credentials",
              createdByAgentId: actor.agentId ?? null,
              createdByUserId: actor.userId ?? null,
            });
            await tx.insert(organizationSecretVersions).values({
              secretId: credential.id,
              version: 1,
              material: credential.material,
              valueSha256: credential.valueSha256,
              createdByAgentId: actor.agentId ?? null,
              createdByUserId: actor.userId ?? null,
            });
          }
          const created = await tx.insert(mcpConnections).values({
            orgId,
            credentialSecretId: credential?.id ?? null,
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
          await tx.insert(activityLog).values(managedMcpActivityValues({
            orgId,
            connectionId: created.id,
            action: "mcp_connection.created",
            actor,
            details: {
              provider: created.provider,
              transport: created.transport,
              status: created.status,
            },
          }));
          return created;
        });
        return publicSummary(row);
      } catch (error) {
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
      control: ManagedMcpUpdateControl = {},
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
      if (
        patch.accessMode !== undefined
        && existing.provider !== "custom"
        && !control.allowCuratedAccessMode
      ) {
        throw unprocessable(
          "Curated MCP access mode must be changed through the dedicated access-mode operation",
        );
      }
      if (
        existing.provider === "linear"
        && existing.accessMode === "read_only"
        && patch.accessMode === "read_write"
        && existing.status === "active"
      ) {
        throw unprocessable(
          "Linear write access requires reauthorization: disconnect the read-only grant, select write access, then reconnect OAuth",
        );
      }

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
      let oldSecretIdToDelete: string | null = null;
      const replacement = patch.secrets
        ? await prepareCredentialReplacement(existing.name, patch.secrets)
        : null;
      if (replacement) {
        oldSecretIdToDelete = credentialSecretId;
        credentialSecretId = replacement.id;
      } else if (declarationChanged && !hasDeclaredSecrets(nextShape) && credentialSecretId) {
        oldSecretIdToDelete = credentialSecretId;
        credentialSecretId = null;
      }

      const row = await db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(mcpConnections)
          .where(and(eq(mcpConnections.orgId, orgId), eq(mcpConnections.id, connectionId)))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!locked) throw notFound("MCP connection not found");
        if (locked.credentialSecretId !== existing.credentialSecretId) {
          throw conflict("Managed MCP credentials changed; retry the connection update");
        }
        if (replacement) {
          await tx.insert(organizationSecrets).values({
            id: replacement.id,
            orgId,
            name: replacement.name,
            provider: "local_encrypted",
            purpose: "managed_mcp_connection",
            externalRef: replacement.externalRef,
            latestVersion: 1,
            description: "Encrypted managed MCP credentials",
            createdByAgentId: actor.agentId ?? null,
            createdByUserId: actor.userId ?? null,
          });
          await tx.insert(organizationSecretVersions).values({
            secretId: replacement.id,
            version: 1,
            material: replacement.material,
            valueSha256: replacement.valueSha256,
            createdByAgentId: actor.agentId ?? null,
            createdByUserId: actor.userId ?? null,
          });
        }
        const updated = await tx
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
            updatedAt: nextConnectionMutationTime(locked),
          })
          .where(and(eq(mcpConnections.orgId, orgId), eq(mcpConnections.id, connectionId)))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) throw notFound("MCP connection not found");
        if (oldSecretIdToDelete) {
          await tx
            .delete(organizationSecrets)
            .where(eq(organizationSecrets.id, oldSecretIdToDelete));
        }
        await tx.insert(activityLog).values(managedMcpActivityValues({
          orgId,
          connectionId,
          action: "mcp_connection.updated",
          actor,
          details: {
            provider: updated.provider,
            status: updated.status,
            accessMode: updated.accessMode,
          },
        }));
        return updated;
      });
      return publicSummary(row);
    },

    reconnect: async (
      orgId: string,
      connectionId: string,
      actor: ManagedMcpMutationActor = {},
    ) => {
      const existing = await findRow(orgId, connectionId);
      assertLegacyMutable(existing);
      const now = nextConnectionMutationTime(existing);
      const row = await db.transaction(async (tx) => {
        const updated = await tx
          .update(mcpConnections)
          .set({
            status: existing.provider === "custom" ? "draft" : "authorizing",
            enabled: true,
            disabledAt: null,
            revokedAt: null,
            updatedAt: now,
          })
          .where(and(eq(mcpConnections.orgId, orgId), eq(mcpConnections.id, connectionId)))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) throw notFound("MCP connection not found");
        if (existing.provider !== "custom") {
          const activeGrant = await tx.select().from(mcpOAuthGrants)
            .where(and(
              eq(mcpOAuthGrants.orgId, orgId),
              eq(mcpOAuthGrants.connectionId, connectionId),
              eq(mcpOAuthGrants.status, "active"),
            ))
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (activeGrant) {
            await tx.update(mcpOAuthGrants).set({
              status: "needs_reauth",
              statusMetadata: { reason: "connection_reconnect" },
              credentialSecretId: null,
              refreshLeaseNonce: null,
              refreshLeaseExpiresAt: null,
              updatedAt: now,
            }).where(eq(mcpOAuthGrants.id, activeGrant.id));
            if (activeGrant.credentialSecretId) {
              await tx.delete(organizationSecrets)
                .where(eq(organizationSecrets.id, activeGrant.credentialSecretId));
            }
          }
        }
        await tx.insert(activityLog).values(managedMcpActivityValues({
          orgId,
          connectionId,
          action: "mcp_connection.reconnect_requested",
          actor,
          details: {
            provider: updated.provider,
            status: updated.status,
          },
        }));
        return updated;
      });
      return publicSummary(row);
    },

    disconnect: async (
      orgId: string,
      connectionId: string,
      actor: ManagedMcpMutationActor = {},
    ) => {
      const existing = await findRow(orgId, connectionId);
      assertLegacyMutable(existing);
      const now = nextConnectionMutationTime(existing);
      const row = await db.transaction(async (tx) => {
        const updated = await tx
          .update(mcpConnections)
          .set({
            status: "disabled",
            enabled: false,
            disabledAt: now,
            updatedAt: now,
          })
          .where(and(eq(mcpConnections.orgId, orgId), eq(mcpConnections.id, connectionId)))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) throw notFound("MCP connection not found");
        await tx.insert(activityLog).values(managedMcpActivityValues({
          orgId,
          connectionId,
          action: "mcp_connection.disconnected",
          actor,
          details: {
            provider: updated.provider,
            status: updated.status,
          },
        }));
        return updated;
      });
      return publicSummary(row);
    },

    listTools,

    refreshTools: async (
      orgId: string,
      connectionId: string,
      actor: ManagedMcpMutationActor = {},
    ) => {
      const existing = await findRow(orgId, connectionId);
      assertLegacyMutable(existing);
      if (existing.provider === "supabase" && !existing.externalScope) {
        throw unprocessable("Supabase MCP connections require a selected project before discovery");
      }
      if (!canDiscoverTools(existing)) {
        throw discoveryNotReadyError();
      }
      const snapshot = discoverySnapshot(existing);
      let client: ManagedMcpClient | null = null;
      try {
        client = await createClient(await buildClientOptions(existing));
        const normalized = normalizeMcpDiscoveredTools(
          existing.name,
          await client.discoverTools(),
        );
        const normalizedByName = new Map(normalized.map((tool) => [tool.externalToolName, tool]));
        await db.transaction(async (tx) => {
          const locked = await tx
            .select()
            .from(mcpConnections)
            .where(and(eq(mcpConnections.orgId, orgId), eq(mcpConnections.id, connectionId)))
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!locked) throw notFound("MCP connection not found");
          assertDiscoverySnapshot(locked, snapshot);
          const now = nextConnectionMutationTime(locked);
          const existingTools = await tx
            .select()
            .from(customIntegrationTools)
            .where(and(
              eq(customIntegrationTools.orgId, orgId),
              eq(customIntegrationTools.connectionId, connectionId),
            ));
          const reconciled = reconcileMcpToolCatalog(existingTools, normalized);
          const existingByName = new Map(
            existingTools.map((tool) => [tool.externalToolName, tool]),
          );
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
              activatedAt: locked.activatedAt ?? now,
              lastDiscoveredAt: now,
              disabledAt: null,
              updatedAt: now,
            })
            .where(and(eq(mcpConnections.orgId, orgId), eq(mcpConnections.id, connectionId)));
          await tx.insert(activityLog).values(managedMcpActivityValues({
            orgId,
            connectionId,
            action: "mcp_connection.tools_refreshed",
            actor,
            details: {
              provider: locked.provider,
              toolCount: normalized.length,
            },
          }));
        });
        return listTools(orgId, connectionId);
      } catch (error) {
        if (error instanceof ManagedMcpDiscoveryStaleError) {
          throw error;
        }
        await db.transaction(async (tx) => {
          const locked = await tx
            .select()
            .from(mcpConnections)
            .where(and(eq(mcpConnections.orgId, orgId), eq(mcpConnections.id, connectionId)))
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!locked) throw notFound("MCP connection not found");
          assertDiscoverySnapshot(locked, snapshot);
          const now = nextConnectionMutationTime(locked);
          await tx
            .update(mcpConnections)
            .set({ status: "error", updatedAt: now })
            .where(and(
              eq(mcpConnections.orgId, orgId),
              eq(mcpConnections.id, connectionId),
            ));
          await tx.insert(activityLog).values(managedMcpActivityValues({
            orgId,
            connectionId,
            action: "mcp_connection.discovery_failed",
            actor,
            details: {
              provider: locked.provider,
              reason: "upstream_discovery_failed",
            },
          }));
        });
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
