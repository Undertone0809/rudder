import {
  auth,
  OAuthError,
  OAuthErrorCode,
  type AuthOptions,
  type AuthResult,
  type CallToolResult,
  type OAuthClientProvider,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import type { Db } from "@rudderhq/db";
import {
  activityLog,
  instanceUserRoles,
  mcpConnections,
  mcpOAuthGrants,
  mcpOAuthSessions,
  organizationMemberships,
  organizationSecrets,
  organizationSecretVersions,
} from "@rudderhq/db";
import {
  MCP_OAUTH_SESSION_TTL_MS,
  mcpOAuthCallbackSchema,
  mcpScopeSelectionSchema,
  type McpConnectionSummary,
  type McpExternalScopeOption,
  type McpOAuthCallback,
  type McpOAuthCallbackResult,
  type McpOAuthGrantSummary,
  type McpOAuthStartResponse,
  type McpScopeSelection,
} from "@rudderhq/shared";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  sql,
} from "drizzle-orm";
import {
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { HttpError, notFound, unprocessable } from "../../errors.js";
import { getSecretProvider } from "../../secrets/provider-registry.js";
import { lockManagedMcpOAuthAuthorizer } from "./authorizer-lock.js";
import {
  createManagedMcpClient,
  resolveMcpHttpCredentials,
} from "./managed-client.js";
import {
  PersistentMcpOAuthClientProvider,
  resolveMcpOAuthRedirectUri,
  type ManagedMcpOAuthMaterial,
} from "./oauth-provider.js";
import { createSecureMcpFetch } from "./pinned-fetch.js";
import {
  MCP_PROVIDER_REGISTRY,
  resolveCuratedMcpEndpoint,
} from "./provider-registry.js";
import { resolveMcpHttpTarget, type McpDeploymentAllowlists, type McpDnsLookup } from "./security-policy.js";

type McpConnectionRow = typeof mcpConnections.$inferSelect;
type McpOAuthGrantRow = typeof mcpOAuthGrants.$inferSelect;
type McpOAuthSessionRow = typeof mcpOAuthSessions.$inferSelect;
type McpDbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type OAuthAuth = (
  provider: OAuthClientProvider,
  options: AuthOptions,
) => Promise<AuthResult>;

export interface ManagedMcpOAuthActor {
  userId?: string | null;
  isInstanceAdmin?: boolean;
  localImplicit?: boolean;
}

export interface ManagedMcpProviderScopeResult {
  options: McpExternalScopeOption[];
  selected?: McpExternalScopeOption;
  providerSubject?: string | null;
}

export interface ManagedMcpOAuthServiceOptions {
  deploymentMode: "local_trusted" | "authenticated";
  serverPort: number;
  authPublicBaseUrl?: string | null;
  allowlists: McpDeploymentAllowlists;
  dnsLookup?: McpDnsLookup;
  oauthAuth?: OAuthAuth;
  discoverProviderScope?: (input: {
    provider: "supabase" | "linear" | "notion";
    connection: McpConnectionRow;
    material: ManagedMcpOAuthMaterial;
    endpoint: string;
  }) => Promise<ManagedMcpProviderScopeResult>;
  refreshConnectionTools?: (
    orgId: string,
    connectionId: string,
    actor: { userId?: string | null; agentId?: string | null },
  ) => Promise<unknown>;
}

interface PreparedOAuthSecret {
  id: string;
  name: string;
  externalRef: string | null;
  material: Record<string, unknown>;
  valueSha256: string;
}

function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

class ManagedMcpOAuthRefreshTimeoutError extends Error {
  constructor() {
    super("Managed MCP OAuth refresh timed out");
    this.name = "ManagedMcpOAuthRefreshTimeoutError";
  }
}

async function withHardTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ManagedMcpOAuthRefreshTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForLease(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function publicGrant(row: McpOAuthGrantRow): McpOAuthGrantSummary {
  return {
    id: row.id,
    connectionId: row.connectionId,
    providerSubject: row.providerSubject,
    providerScopes: row.providerScopes,
    externalScopeMetadata: row.externalScopeMetadata,
    status: row.status as McpOAuthGrantSummary["status"],
    hasCredentials: Boolean(row.credentialSecretId),
    expiresAt: row.expiresAt,
    lastRefreshedAt: row.lastRefreshedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function publicConnection(row: McpConnectionRow): McpConnectionSummary {
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
    safeConfig: row.safeConfig,
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

function oauthActivityValues(input: {
  orgId: string;
  connectionId: string;
  action: string;
  actorUserId?: string | null;
  details: Record<string, unknown>;
}) {
  return {
    orgId: input.orgId,
    actorType: input.actorUserId ? "user" as const : "system" as const,
    actorId: input.actorUserId ?? "system",
    action: input.action,
    entityType: "mcp_connection",
    entityId: input.connectionId,
    details: input.details,
  };
}

function tokenExpiry(tokens: StoredOAuthTokens | undefined, now = new Date()): Date | null {
  if (typeof tokens?.expires_in !== "number" || !Number.isFinite(tokens.expires_in)) return null;
  return new Date(now.getTime() + Math.max(0, tokens.expires_in) * 1_000);
}

function tokenScopes(tokens: StoredOAuthTokens | undefined): string[] {
  return typeof tokens?.scope === "string"
    ? Array.from(new Set(tokens.scope.split(/\s+/u).filter(Boolean)))
    : [];
}

function accessToken(material: ManagedMcpOAuthMaterial): string {
  const value = material.tokens?.access_token;
  if (!value) throw unprocessable("Managed MCP OAuth credentials are unavailable");
  return value;
}

function oauthRevocationEndpoint(material: ManagedMcpOAuthMaterial | null): string | null {
  const metadata: unknown = material?.discoveryState?.authorizationServerMetadata;
  return isRecord(metadata) && typeof metadata.revocation_endpoint === "string"
    ? metadata.revocation_endpoint
    : null;
}

const SAFE_SCOPE_METADATA_KEYS = new Set([
  "region",
  "status",
  "workspaceName",
  "workspace_name",
  "organizationName",
  "organization_name",
]);
const MAX_SCOPE_OPTIONS = 500;
const MAX_SCOPE_METADATA_BYTES = 4_096;

function safeScopeMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!SAFE_SCOPE_METADATA_KEYS.has(key)) continue;
    const safeValue = typeof raw === "string"
      ? raw.slice(0, 512)
      : typeof raw === "number" && Number.isFinite(raw)
        ? raw
        : typeof raw === "boolean"
          ? raw
          : undefined;
    if (safeValue === undefined) continue;
    const candidate = { ...output, [key]: safeValue };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_SCOPE_METADATA_BYTES) {
      continue;
    }
    output[key] = safeValue;
  }
  return output;
}

function safeScopeOption(value: McpExternalScopeOption): McpExternalScopeOption {
  return {
    id: value.id.trim().slice(0, 512),
    displayName: value.displayName.trim().slice(0, 240),
    metadata: isRecord(value.metadata) ? safeScopeMetadata(value.metadata) : {},
  };
}

function sanitizeScopeOptions(values: McpExternalScopeOption[]): McpExternalScopeOption[] {
  const output: McpExternalScopeOption[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const safe = safeScopeOption(value);
    if (!safe.id || !safe.displayName || seen.has(safe.id)) continue;
    seen.add(safe.id);
    output.push(safe);
    if (output.length === MAX_SCOPE_OPTIONS) break;
  }
  return output;
}

function parseToolJson(result: CallToolResult): unknown {
  for (const content of result.content ?? []) {
    if (content.type !== "text") continue;
    try {
      return JSON.parse(content.text);
    } catch {
      // Ignore non-JSON provider prose; onboarding never persists it.
    }
  }
  return undefined;
}

function asProviderScope(
  value: unknown,
  keys: { id: string[]; name: string[] },
): McpExternalScopeOption | null {
  if (!isRecord(value)) return null;
  const id = keys.id.map((key) => value[key])
    .find((item): item is string => typeof item === "string" && item.length > 0);
  if (!id) return null;
  const displayName = keys.name.map((key) => value[key])
    .find((item): item is string => typeof item === "string" && item.length > 0) ?? id;
  const metadata = Object.fromEntries(
    ["region", "status", "workspaceName", "workspace_name", "organizationName"]
      .flatMap((key) => value[key] === undefined ? [] : [[key, value[key]]]),
  );
  return safeScopeOption({ id, displayName, metadata });
}

function providerScopeContainer(
  provider: "linear" | "notion",
  value: Record<string, unknown>,
): Record<string, unknown> | null {
  const definition = MCP_PROVIDER_REGISTRY[provider].scopeIdentity;
  const candidates: unknown[] = [
    ...definition.containers.map((key) => value[key]),
  ];
  const user = value.user;
  if (provider === "linear" && isRecord(user)) {
    candidates.push(...definition.containers.map((key) => user[key]));
  }
  const bot = value.bot;
  if (provider === "notion" && isRecord(bot)) {
    candidates.push(...definition.containers.map((key) => bot[key]));
  }
  return candidates.find(isRecord) ?? null;
}

/**
 * Official identity tools return an actor plus an explicit workspace or
 * organization. The actor id is never a valid Rudder connection scope.
 */
export function parseProviderWorkspaceScope(
  provider: "linear" | "notion",
  value: unknown,
): McpExternalScopeOption | null {
  if (!isRecord(value)) return null;
  const container = providerScopeContainer(provider, value);
  if (container) {
    return asProviderScope(container, {
      id: ["workspace_id", "workspaceId", "organization_id", "organizationId", "id"],
      name: [
        "workspace_name",
        "workspaceName",
        "organization_name",
        "organizationName",
        "name",
      ],
    });
  }
  const nested = provider === "notion" && isRecord(value.bot) ? value.bot : value;
  return asProviderScope(nested, {
    id: ["workspace_id", "workspaceId", "organization_id", "organizationId"],
    name: [
      "workspace_name",
      "workspaceName",
      "organization_name",
      "organizationName",
    ],
  });
}

async function defaultDiscoverProviderScope(input: {
  provider: "supabase" | "linear" | "notion";
  connection: McpConnectionRow;
  material: ManagedMcpOAuthMaterial;
  endpoint: string;
  allowlists: McpDeploymentAllowlists;
  dnsLookup?: McpDnsLookup;
}): Promise<ManagedMcpProviderScopeResult> {
  const curatedOrigin = new URL(MCP_PROVIDER_REGISTRY[input.provider].endpoint).origin;
  const client = await createManagedMcpClient({
    transport: "streamable_http",
    url: input.endpoint,
    credentials: resolveMcpHttpCredentials({ bearerToken: accessToken(input.material) }),
    network: {
      allowedOrigins: input.allowlists.httpOrigins,
      curatedOrigin,
      lookup: input.dnsLookup,
    },
    startupTimeoutMs: input.connection.startupTimeoutMs,
    toolTimeoutMs: input.connection.toolTimeoutMs,
  });
  try {
    if (input.provider === "supabase") {
      const parsed = parseToolJson(await client.callTool("list_projects", {}));
      const rawProjects = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.projects)
          ? parsed.projects
          : [];
      const options = rawProjects
        .map((project) => asProviderScope(project, {
          id: ["ref", "id", "project_ref"],
          name: ["name", "display_name", "ref", "id"],
        }))
        .filter((option): option is McpExternalScopeOption => Boolean(option));
      return { options };
    }

    const identity = MCP_PROVIDER_REGISTRY[input.provider].scopeIdentity;
    if (!identity) throw new Error("Provider did not define workspace identity discovery");
    const tools = await client.discoverTools();
    const identityTool = identity.toolNames.find((name) => (
      tools.some((tool) => tool.name === name)
    ));
    if (!identityTool) {
      throw new Error("Provider did not expose a safe workspace identity tool");
    }
    const parsed = parseToolJson(await client.callTool(identityTool, identity.arguments));
    const selected = parseProviderWorkspaceScope(input.provider, parsed);
    if (!selected) throw new Error("Provider workspace identity was invalid");
    return { options: [], selected };
  } finally {
    await client.close();
  }
}

async function prepareOAuthSecret(
  connectionName: string,
  kind: "session" | "grant",
  material: ManagedMcpOAuthMaterial,
): Promise<PreparedOAuthSecret> {
  const id = randomUUID();
  const prepared = await getSecretProvider("local_encrypted").createVersion({
    value: JSON.stringify(material),
    externalRef: null,
  });
  return {
    id,
    name: `Managed MCP OAuth ${kind} - ${connectionName} - ${id}`,
    externalRef: prepared.externalRef,
    material: prepared.material,
    valueSha256: prepared.valueSha256,
  };
}

async function insertOAuthSecret(
  tx: McpDbTransaction,
  input: {
    orgId: string;
    secret: PreparedOAuthSecret;
    actorUserId?: string | null;
  },
): Promise<void> {
  await tx.insert(organizationSecrets).values({
    id: input.secret.id,
    orgId: input.orgId,
    name: input.secret.name,
    provider: "local_encrypted",
    purpose: "managed_mcp_oauth",
    externalRef: input.secret.externalRef,
    latestVersion: 1,
    description: "Encrypted managed MCP OAuth material",
    createdByUserId: input.actorUserId ?? null,
  });
  await tx.insert(organizationSecretVersions).values({
    secretId: input.secret.id,
    version: 1,
    material: input.secret.material,
    valueSha256: input.secret.valueSha256,
    createdByUserId: input.actorUserId ?? null,
  });
}

function parseOAuthMaterial(value: string): ManagedMcpOAuthMaterial {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) throw new Error("invalid");
    return parsed as ManagedMcpOAuthMaterial;
  } catch {
    throw unprocessable("Managed MCP OAuth credentials are unavailable");
  }
}

export function managedMcpOAuthService(
  db: Db,
  options: ManagedMcpOAuthServiceOptions,
) {
  const grantRefreshSingleFlights = new Map<string, Promise<void>>();
  const runAuth = options.oauthAuth ?? auth;
  const secureFetch = createSecureMcpFetch({
    allowedOrigins: options.allowlists.httpOrigins,
    lookup: options.dnsLookup,
  });

  async function resolveLockedOAuthSecret(
    tx: McpDbTransaction,
    orgId: string,
    credentialSecretId: string,
  ): Promise<{
    secret: typeof organizationSecrets.$inferSelect;
    material: ManagedMcpOAuthMaterial;
  } | null> {
    const secret = await tx.select().from(organizationSecrets)
      .where(and(
        eq(organizationSecrets.orgId, orgId),
        eq(organizationSecrets.id, credentialSecretId),
        eq(organizationSecrets.provider, "local_encrypted"),
        eq(organizationSecrets.purpose, "managed_mcp_oauth"),
      ))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!secret) return null;
    const version = await tx.select().from(organizationSecretVersions)
      .where(and(
        eq(organizationSecretVersions.secretId, secret.id),
        eq(organizationSecretVersions.version, secret.latestVersion),
      ))
      .for("share")
      .then((rows) => rows[0] ?? null);
    if (!version) return null;
    return {
      secret,
      material: parseOAuthMaterial(await getSecretProvider("local_encrypted").resolveVersion({
        material: version.material,
        externalRef: secret.externalRef,
      })),
    };
  }

  async function findConnection(orgId: string, connectionId: string): Promise<McpConnectionRow> {
    const row = await db.select().from(mcpConnections)
      .where(and(eq(mcpConnections.orgId, orgId), eq(mcpConnections.id, connectionId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("MCP connection not found");
    return row;
  }

  function assertCurated(row: McpConnectionRow): asserts row is McpConnectionRow & {
    provider: "supabase" | "linear" | "notion";
  } {
    if (row.provider !== "supabase" && row.provider !== "linear" && row.provider !== "notion") {
      throw unprocessable("Custom MCP connections do not use managed OAuth");
    }
  }

  async function isValidAuthorizer(
    orgId: string,
    authorizingUserId: string | null,
  ): Promise<boolean> {
    if (!authorizingUserId) return options.deploymentMode === "local_trusted";
    const [membership, instanceAdmin] = await Promise.all([
      db.select().from(organizationMemberships)
        .where(and(
          eq(organizationMemberships.orgId, orgId),
          eq(organizationMemberships.principalType, "user"),
          eq(organizationMemberships.principalId, authorizingUserId),
          eq(organizationMemberships.status, "active"),
          eq(organizationMemberships.membershipRole, "owner"),
        ))
        .then((rows) => rows[0] ?? null),
      db.select().from(instanceUserRoles)
        .where(and(
          eq(instanceUserRoles.userId, authorizingUserId),
          eq(instanceUserRoles.role, "instance_admin"),
        ))
        .then((rows) => rows[0] ?? null),
    ]);
    return Boolean(membership || instanceAdmin);
  }

  async function isValidAuthorizerInTransaction(
    tx: McpDbTransaction,
    orgId: string,
    authorizingUserId: string | null,
  ): Promise<boolean> {
    if (!authorizingUserId) return options.deploymentMode === "local_trusted";
    const membership = await tx.select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(and(
        eq(organizationMemberships.orgId, orgId),
        eq(organizationMemberships.principalType, "user"),
        eq(organizationMemberships.principalId, authorizingUserId),
        eq(organizationMemberships.status, "active"),
        eq(organizationMemberships.membershipRole, "owner"),
      ))
      .for("share")
      .then((rows) => rows[0] ?? null);
    if (membership) return true;
    return Boolean(await tx.select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(
        eq(instanceUserRoles.userId, authorizingUserId),
        eq(instanceUserRoles.role, "instance_admin"),
      ))
      .for("share")
      .then((rows) => rows[0] ?? null));
  }

  async function requireUsableGrant(
    orgId: string,
    connectionId: string,
  ): Promise<McpOAuthGrantRow> {
    const outcome = await db.transaction(async (tx) => {
      const connection = await tx.select().from(mcpConnections)
        .where(and(
          eq(mcpConnections.orgId, orgId),
          eq(mcpConnections.id, connectionId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      const grant = await tx.select().from(mcpOAuthGrants)
        .where(and(
          eq(mcpOAuthGrants.orgId, orgId),
          eq(mcpOAuthGrants.connectionId, connectionId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (
        !connection
        || !grant
        || grant.status !== "active"
        || !connection.enabled
        || (connection.status !== "active" && connection.status !== "selecting_scope")
      ) {
        return { kind: "unusable" as const };
      }
      if (!await isValidAuthorizerInTransaction(tx, orgId, grant.authorizingUserId)) {
        await transitionGrantToNeedsReauth(tx, grant, "authorizer_no_longer_authorized");
        return { kind: "invalid_authorizer" as const };
      }
      return { kind: "usable" as const, grant };
    });
    if (outcome.kind === "invalid_authorizer") {
      throw unprocessable("Managed MCP OAuth authorization must be reconnected by an owner");
    }
    if (outcome.kind !== "usable") {
      throw unprocessable("Managed MCP OAuth authorization must be reconnected");
    }
    return outcome.grant;
  }

  async function resolveUsableAccessToken(
    orgId: string,
    connectionId: string,
  ): Promise<string> {
    const outcome = await db.transaction(async (tx) => {
      const connection = await tx.select().from(mcpConnections)
        .where(and(
          eq(mcpConnections.orgId, orgId),
          eq(mcpConnections.id, connectionId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      const grant = await tx.select().from(mcpOAuthGrants)
        .where(and(
          eq(mcpOAuthGrants.orgId, orgId),
          eq(mcpOAuthGrants.connectionId, connectionId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (
        !connection
        || !grant
        || grant.status !== "active"
        || !grant.credentialSecretId
        || !connection.enabled
        || (connection.status !== "active" && connection.status !== "selecting_scope")
      ) {
        return { kind: "unusable" as const };
      }
      if (!await isValidAuthorizerInTransaction(tx, orgId, grant.authorizingUserId)) {
        await transitionGrantToNeedsReauth(tx, grant, "authorizer_no_longer_authorized");
        return { kind: "invalid_authorizer" as const };
      }
      const resolved = await resolveLockedOAuthSecret(
        tx,
        orgId,
        grant.credentialSecretId,
      );
      if (!resolved) {
        await transitionGrantToNeedsReauth(tx, grant, "credential_unavailable");
        return { kind: "unusable" as const };
      }
      return { kind: "usable" as const, token: accessToken(resolved.material) };
    });
    if (outcome.kind === "invalid_authorizer") {
      throw unprocessable("Managed MCP OAuth authorization must be reconnected by an owner");
    }
    if (outcome.kind !== "usable") {
      throw unprocessable("Managed MCP OAuth authorization must be reconnected");
    }
    return outcome.token;
  }

  async function discoverScope(input: {
    connection: McpConnectionRow & { provider: "supabase" | "linear" | "notion" };
    material: ManagedMcpOAuthMaterial;
    endpoint: string;
  }): Promise<ManagedMcpProviderScopeResult> {
    if (options.discoverProviderScope) {
      return options.discoverProviderScope({
        provider: input.connection.provider,
        connection: input.connection,
        material: input.material,
        endpoint: input.endpoint,
      });
    }
    return defaultDiscoverProviderScope({
      provider: input.connection.provider,
      connection: input.connection,
      material: input.material,
      endpoint: input.endpoint,
      allowlists: options.allowlists,
      dnsLookup: options.dnsLookup,
    });
  }

  async function bestEffortRevokeMaterial(
    material: ManagedMcpOAuthMaterial | null,
    timeoutMs: number,
  ): Promise<void> {
    const revocationEndpoint = oauthRevocationEndpoint(material);
    const tokens = material?.tokens;
    const token = tokens?.refresh_token ?? tokens?.access_token;
    if (!revocationEndpoint || !token) return;
    const body = new URLSearchParams({
      token,
      token_type_hint: tokens?.refresh_token ? "refresh_token" : "access_token",
    });
    const clientInformation = material?.clientInformation;
    if (clientInformation?.client_id) body.set("client_id", clientInformation.client_id);
    if (clientInformation?.client_secret) body.set("client_secret", clientInformation.client_secret);
    try {
      const response = await secureFetch(revocationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel();
    } catch {
      // RFC 7009 revocation is best effort. Rudder's local state always wins.
    }
  }

  async function cleanupExpiredSessions(
    orgId?: string,
    limit = 100,
  ): Promise<number> {
    const databaseClock = await db.execute(sql<{ value: string }>`
      select clock_timestamp()::text as value
    `) as Array<{ value: string }>;
    const now = new Date(databaseClock[0]!.value);
    const boundedLimit = Math.max(1, Math.min(limit, 1_000));
    const candidates = await db.select({
      id: mcpOAuthSessions.id,
      connectionId: mcpOAuthSessions.connectionId,
      orgId: mcpOAuthSessions.orgId,
    }).from(mcpOAuthSessions).where(and(
      eq(mcpOAuthSessions.status, "authorizing"),
      isNull(mcpOAuthSessions.consumedAt),
      lte(mcpOAuthSessions.expiresAt, now),
      ...(orgId ? [eq(mcpOAuthSessions.orgId, orgId)] : []),
    ))
      .orderBy(asc(mcpOAuthSessions.expiresAt), asc(mcpOAuthSessions.id))
      .limit(boundedLimit);
    const groupedCandidates = new Map<string, {
      connectionId: string;
      orgId: string;
      sessionIds: string[];
    }>();
    for (const candidate of candidates) {
      const key = `${candidate.orgId}:${candidate.connectionId}`;
      const group = groupedCandidates.get(key);
      if (group) {
        group.sessionIds.push(candidate.id);
      } else {
        groupedCandidates.set(key, {
          connectionId: candidate.connectionId,
          orgId: candidate.orgId,
          sessionIds: [candidate.id],
        });
      }
    }
    const keys = Array.from(groupedCandidates.values()).sort((left, right) => (
      left.connectionId.localeCompare(right.connectionId)
    ));
    let cleaned = 0;
    for (const key of keys) {
      cleaned += await db.transaction(async (tx) => {
        const transactionClock = await tx.execute(sql<{ value: string }>`
          select clock_timestamp()::text as value
        `) as Array<{ value: string }>;
        const transactionNow = new Date(transactionClock[0]!.value);
        const connection = await tx.select().from(mcpConnections)
          .where(and(
            eq(mcpConnections.orgId, key.orgId),
            eq(mcpConnections.id, key.connectionId),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!connection) return 0;
        const expired = await tx.select().from(mcpOAuthSessions)
          .where(and(
            eq(mcpOAuthSessions.orgId, key.orgId),
            eq(mcpOAuthSessions.connectionId, key.connectionId),
            inArray(mcpOAuthSessions.id, key.sessionIds),
            eq(mcpOAuthSessions.status, "authorizing"),
            isNull(mcpOAuthSessions.consumedAt),
            lte(mcpOAuthSessions.expiresAt, transactionNow),
          ))
          .for("update");
        if (expired.length === 0) return 0;
        const secretIds = expired
          .map((session) => session.credentialSecretId)
          .filter((id): id is string => Boolean(id));
        await tx.update(mcpOAuthSessions).set({
          status: "expired",
          consumedAt: transactionNow,
          credentialSecretId: null,
          statusMetadata: { reason: "ttl_expired" },
        }).where(inArray(mcpOAuthSessions.id, expired.map((session) => session.id)));
        if (secretIds.length > 0) {
          await tx.delete(organizationSecrets)
            .where(inArray(organizationSecrets.id, secretIds));
        }
        const stillAuthorizing = await tx.select({ id: mcpOAuthSessions.id })
          .from(mcpOAuthSessions)
          .where(and(
            eq(mcpOAuthSessions.orgId, key.orgId),
            eq(mcpOAuthSessions.connectionId, key.connectionId),
            eq(mcpOAuthSessions.status, "authorizing"),
            isNull(mcpOAuthSessions.consumedAt),
            gt(mcpOAuthSessions.expiresAt, transactionNow),
          ))
          .for("share")
          .then((rows) => rows[0] ?? null);
        if (connection.status === "authorizing" && !stillAuthorizing) {
          await tx.update(mcpConnections).set({
            status: "error",
            updatedAt: transactionNow,
          }).where(eq(mcpConnections.id, connection.id));
        }
        await tx.insert(activityLog).values(oauthActivityValues({
          orgId: key.orgId,
          connectionId: key.connectionId,
          action: "mcp_oauth.sessions_expired",
          details: { count: expired.length },
        }));
        return expired.length;
      });
    }
    return cleaned;
  }

  async function start(
    orgId: string,
    connectionId: string,
    actor: ManagedMcpOAuthActor,
  ): Promise<McpOAuthStartResponse> {
    await cleanupExpiredSessions(orgId);
    const connection = await findConnection(orgId, connectionId);
    assertCurated(connection);
    if (
      options.deploymentMode === "authenticated"
      && !actor.userId
    ) {
      throw unprocessable("Managed MCP OAuth requires an authenticated authorizing user");
    }
    let redirectUri: string;
    try {
      redirectUri = resolveMcpOAuthRedirectUri({
        deploymentMode: options.deploymentMode,
        serverPort: options.serverPort,
        authPublicBaseUrl: options.authPublicBaseUrl,
      });
    } catch {
      throw unprocessable("Managed MCP OAuth requires a canonical HTTPS auth public base URL");
    }
    const rawState = randomBytes(32).toString("hex");
    let material: ManagedMcpOAuthMaterial = {};
    const provider = new PersistentMcpOAuthClientProvider({
      redirectUri,
      state: rawState,
      material,
      save: async (next) => {
        material = structuredClone(next);
      },
    });
    const endpoint = MCP_PROVIDER_REGISTRY[connection.provider].endpoint;
    const result = await runAuth(provider, {
      serverUrl: endpoint,
      scope: connection.provider === "linear" && connection.accessMode === "read_only"
        ? "read"
        : undefined,
      fetchFn: secureFetch,
    });
    if (result !== "REDIRECT" || !provider.authorizationUrl) {
      throw unprocessable("Managed MCP OAuth did not produce an authorization redirect");
    }
    try {
      await resolveMcpHttpTarget(provider.authorizationUrl.href, {
        allowedOrigins: options.allowlists.httpOrigins,
        lookup: options.dnsLookup,
      });
    } catch {
      throw unprocessable("Managed MCP OAuth authorization endpoint is not allowed");
    }

    const sessionSecret = await prepareOAuthSecret(connection.name, "session", material);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + MCP_OAUTH_SESSION_TTL_MS);
    await db.transaction(async (tx) => {
      const locked = await tx.select().from(mcpConnections)
        .where(and(eq(mcpConnections.orgId, orgId), eq(mcpConnections.id, connectionId)))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!locked) throw notFound("MCP connection not found");
      assertCurated(locked);
      const priorGrant = await tx.select().from(mcpOAuthGrants)
        .where(and(
          eq(mcpOAuthGrants.orgId, orgId),
          eq(mcpOAuthGrants.connectionId, connectionId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (priorGrant?.status === "active") {
        await tx.update(mcpOAuthGrants).set({
          status: "needs_reauth",
          statusMetadata: { reason: "authorization_restarted" },
          credentialSecretId: null,
          refreshLeaseNonce: null,
          refreshLeaseExpiresAt: null,
          updatedAt: now,
        }).where(eq(mcpOAuthGrants.id, priorGrant.id));
        if (priorGrant.credentialSecretId) {
          await tx.delete(organizationSecrets)
            .where(eq(organizationSecrets.id, priorGrant.credentialSecretId));
        }
      }
      const replacedSessions = await tx.select({
        id: mcpOAuthSessions.id,
        credentialSecretId: mcpOAuthSessions.credentialSecretId,
      }).from(mcpOAuthSessions).where(and(
        eq(mcpOAuthSessions.orgId, orgId),
        eq(mcpOAuthSessions.connectionId, connectionId),
        eq(mcpOAuthSessions.status, "authorizing"),
        isNull(mcpOAuthSessions.consumedAt),
      )).for("update");
      if (replacedSessions.length > 0) {
        await tx.update(mcpOAuthSessions).set({
          status: "expired",
          consumedAt: now,
          credentialSecretId: null,
          statusMetadata: { reason: "replaced" },
        }).where(inArray(
          mcpOAuthSessions.id,
          replacedSessions.map((item) => item.id),
        ));
      }
      const replacedSecretIds = replacedSessions
        .map((item) => item.credentialSecretId)
        .filter((id): id is string => Boolean(id));
      if (replacedSecretIds.length > 0) {
        await tx.delete(organizationSecrets)
          .where(inArray(organizationSecrets.id, replacedSecretIds));
      }
      await insertOAuthSecret(tx, {
        orgId,
        secret: sessionSecret,
        actorUserId: actor.userId,
      });
      await tx.insert(mcpOAuthSessions).values({
        orgId,
        connectionId,
        authorizingUserId: actor.localImplicit ? null : actor.userId ?? null,
        stateHash: hashState(rawState),
        credentialSecretId: sessionSecret.id,
        redirectUri,
        status: "authorizing",
        expiresAt,
      });
      await tx.update(mcpConnections).set({
        status: "authorizing",
        enabled: true,
        disabledAt: null,
        revokedAt: null,
        updatedAt: now,
      }).where(and(eq(mcpConnections.orgId, orgId), eq(mcpConnections.id, connectionId)));
      await tx.insert(activityLog).values(oauthActivityValues({
        orgId,
        connectionId,
        action: "mcp_oauth.authorization_started",
        actorUserId: actor.userId,
        details: { provider: connection.provider },
      }));
    });
    return {
      connectionId,
      authorizationUrl: provider.authorizationUrl.href,
      expiresAt,
    };
  }

  async function callback(rawInput: McpOAuthCallback): Promise<McpOAuthCallbackResult> {
    const input = mcpOAuthCallbackSchema.parse(rawInput);
    const stateHash = hashState(input.state);
    const session = await db.select().from(mcpOAuthSessions)
      .where(eq(mcpOAuthSessions.stateHash, stateHash))
      .then((rows) => rows[0] ?? null);
    if (!session) {
      throw unprocessable("Managed MCP OAuth session is invalid or expired");
    }
    const consumed = await db.transaction(async (tx) => {
      const now = new Date();
      const connection = await tx.select().from(mcpConnections)
        .where(and(
          eq(mcpConnections.orgId, session.orgId),
          eq(mcpConnections.id, session.connectionId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!connection) return null;
      assertCurated(connection);
      if (connection.status !== "authorizing") return null;
      const lockedSession = await tx.select().from(mcpOAuthSessions)
        .where(and(
          eq(mcpOAuthSessions.id, session.id),
          eq(mcpOAuthSessions.stateHash, stateHash),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!lockedSession || lockedSession.status !== "authorizing" || lockedSession.consumedAt) {
        return null;
      }
      if (lockedSession.expiresAt <= now) {
        await tx.update(mcpOAuthSessions).set({
          consumedAt: now,
          status: "expired",
          credentialSecretId: null,
          statusMetadata: { reason: "ttl_expired" },
        }).where(eq(mcpOAuthSessions.id, lockedSession.id));
        if (lockedSession.credentialSecretId) {
          await tx.delete(organizationSecrets)
            .where(eq(organizationSecrets.id, lockedSession.credentialSecretId));
        }
        if (connection.status === "authorizing") {
          await tx.update(mcpConnections).set({
            status: "error",
            updatedAt: now,
          }).where(eq(mcpConnections.id, connection.id));
        }
        return null;
      }
      if (!lockedSession.credentialSecretId) return null;
      const resolvedSessionSecret = await resolveLockedOAuthSecret(
        tx,
        lockedSession.orgId,
        lockedSession.credentialSecretId,
      );
      if (!resolvedSessionSecret) return null;
      const consumedRow = await tx.update(mcpOAuthSessions).set({
        consumedAt: now,
        status: input.error ? "error" : "consumed",
        credentialSecretId: null,
        statusMetadata: input.error ? { reason: "provider_denied" } : {},
      }).where(and(
        eq(mcpOAuthSessions.id, lockedSession.id),
        eq(mcpOAuthSessions.status, "authorizing"),
      )).returning().then((rows) => rows[0] ?? null);
      if (!consumedRow) return null;
      await tx.delete(organizationSecrets)
        .where(eq(organizationSecrets.id, lockedSession.credentialSecretId));
      await tx.insert(activityLog).values(oauthActivityValues({
        orgId: consumedRow.orgId,
        connectionId: connection.id,
        action: "mcp_oauth.callback_consumed",
        actorUserId: consumedRow.authorizingUserId,
        details: { provider: connection.provider, providerError: Boolean(input.error) },
      }));
      return {
        session: consumedRow,
        sessionMaterial: resolvedSessionSecret.material,
        connection,
        connectionUpdatedAt: connection.updatedAt.getTime(),
      };
    });
    if (!consumed) {
      throw unprocessable("Managed MCP OAuth session is invalid or expired");
    }
    const callbackContext = consumed;

    async function finishFailure(inputFailure: {
      status: "error" | "needs_reauth";
      action: string;
      reason: string;
    }): Promise<void> {
      await db.transaction(async (tx) => {
        const locked = await tx.select().from(mcpConnections)
          .where(and(
            eq(mcpConnections.orgId, callbackContext.session.orgId),
            eq(mcpConnections.id, callbackContext.connection.id),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !locked
          || locked.status !== "authorizing"
          || locked.updatedAt.getTime() !== callbackContext.connectionUpdatedAt
        ) {
          return;
        }
        const now = new Date();
        await tx.update(mcpConnections).set({
          status: inputFailure.status,
          ...(inputFailure.status === "needs_reauth"
            ? { enabled: false, disabledAt: now }
            : {}),
          updatedAt: now,
        }).where(eq(mcpConnections.id, locked.id));
        await tx.insert(activityLog).values(oauthActivityValues({
          orgId: callbackContext.session.orgId,
          connectionId: locked.id,
          action: inputFailure.action,
          actorUserId: callbackContext.session.authorizingUserId,
          details: { reason: inputFailure.reason },
        }));
      });
    }

    if (!await isValidAuthorizer(
      consumed.session.orgId,
      consumed.session.authorizingUserId,
    )) {
      await finishFailure({
        status: "needs_reauth",
        action: "mcp_oauth.authorization_rejected",
        reason: "authorizer_no_longer_authorized",
      });
      throw unprocessable("Managed MCP OAuth must be reauthorized by an owner");
    }

    if (input.error) {
      await finishFailure({
        status: "error",
        action: "mcp_oauth.authorization_failed",
        reason: "provider_denied",
      });
      throw unprocessable("Managed MCP OAuth authorization was not completed");
    }

    let grantMaterial: ManagedMcpOAuthMaterial;
    try {
      grantMaterial = structuredClone(consumed.sessionMaterial);
    } catch {
      await finishFailure({
        status: "error",
        action: "mcp_oauth.authorization_failed",
        reason: "session_credential_unavailable",
      });
      throw unprocessable("Managed MCP OAuth authorization could not be completed");
    }
    let scope: ManagedMcpProviderScopeResult;
    try {
      const provider = new PersistentMcpOAuthClientProvider({
        redirectUri: consumed.session.redirectUri,
        state: "consumed",
        material: grantMaterial,
        save: async (next) => {
          grantMaterial = structuredClone(next);
        },
      });
      const authResult = await runAuth(provider, {
        serverUrl: MCP_PROVIDER_REGISTRY[consumed.connection.provider].endpoint,
        authorizationCode: input.code,
        iss: input.iss,
        scope: consumed.connection.provider === "linear"
          && consumed.connection.accessMode === "read_only"
          ? "read"
          : undefined,
        fetchFn: secureFetch,
      });
      if (authResult !== "AUTHORIZED" || !grantMaterial.tokens?.access_token) {
        throw unprocessable("Managed MCP OAuth token exchange failed");
      }
      const onboardingEndpoint = consumed.connection.provider === "supabase"
        ? MCP_PROVIDER_REGISTRY.supabase.endpoint
        : resolveCuratedMcpEndpoint({
            provider: consumed.connection.provider,
            accessMode: consumed.connection.accessMode as
              "provider_default" | "read_only" | "read_write",
            externalScope: consumed.connection.externalScope,
          }).href;
      scope = await discoverScope({
        connection: consumed.connection,
        material: grantMaterial,
        endpoint: onboardingEndpoint,
      });
    } catch (error) {
      await finishFailure({
        status: isInvalidGrantOAuthError(error) ? "needs_reauth" : "error",
        action: "mcp_oauth.authorization_failed",
        reason: isInvalidGrantOAuthError(error)
          ? "invalid_grant"
          : "token_or_scope_exchange_failed",
      });
      if (error instanceof HttpError) throw error;
      throw unprocessable("Managed MCP OAuth authorization could not be completed");
    }

    const safeOptions = sanitizeScopeOptions(scope.options);
    const selected = scope.selected ? safeScopeOption(scope.selected) : undefined;
    if (consumed.connection.provider === "supabase" && safeOptions.length === 0) {
      await finishFailure({
        status: "error",
        action: "mcp_oauth.authorization_failed",
        reason: "no_selectable_projects",
      });
      throw unprocessable("Supabase OAuth did not return any selectable projects");
    }
    if (consumed.connection.provider !== "supabase" && !selected) {
      await finishFailure({
        status: "error",
        action: "mcp_oauth.authorization_failed",
        reason: "workspace_identity_unavailable",
      });
      throw unprocessable("Managed MCP OAuth did not identify a provider workspace");
    }

    const grantSecret = await prepareOAuthSecret(
      consumed.connection.name,
      "grant",
      grantMaterial,
    );
    const outcome = await db.transaction(async (tx) => {
      const now = new Date();
      await lockManagedMcpOAuthAuthorizer(
        tx,
        consumed.session.authorizingUserId,
      );
      const connection = await tx.select().from(mcpConnections)
        .where(and(
          eq(mcpConnections.orgId, consumed.session.orgId),
          eq(mcpConnections.id, consumed.connection.id),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (
        !connection
        || connection.status !== "authorizing"
        || connection.updatedAt.getTime() !== consumed.connectionUpdatedAt
      ) {
        return null;
      }
      const stillAuthorized = options.deploymentMode === "local_trusted"
        && !consumed.session.authorizingUserId
        ? true
        : Boolean(
            await tx.select({ id: organizationMemberships.id })
              .from(organizationMemberships)
              .where(and(
                eq(organizationMemberships.orgId, consumed.session.orgId),
                eq(organizationMemberships.principalType, "user"),
                eq(organizationMemberships.principalId, consumed.session.authorizingUserId ?? ""),
                eq(organizationMemberships.status, "active"),
                eq(organizationMemberships.membershipRole, "owner"),
              ))
              .for("share")
              .then((rows) => rows[0] ?? null)
            ?? await tx.select({ id: instanceUserRoles.id })
              .from(instanceUserRoles)
              .where(and(
                eq(instanceUserRoles.userId, consumed.session.authorizingUserId ?? ""),
                eq(instanceUserRoles.role, "instance_admin"),
              ))
              .for("share")
              .then((rows) => rows[0] ?? null),
          );
      if (!stillAuthorized) {
        await tx.update(mcpConnections).set({
          status: "needs_reauth",
          enabled: false,
          disabledAt: now,
          updatedAt: now,
        }).where(eq(mcpConnections.id, connection.id));
        await tx.insert(activityLog).values(oauthActivityValues({
          orgId: consumed.session.orgId,
          connectionId: connection.id,
          action: "mcp_oauth.authorization_rejected",
          actorUserId: consumed.session.authorizingUserId,
          details: { reason: "authorizer_no_longer_authorized" },
        }));
        return { kind: "reauth" as const };
      }
      await insertOAuthSecret(tx, {
        orgId: consumed.session.orgId,
        secret: grantSecret,
        actorUserId: consumed.session.authorizingUserId,
      });
      const existingGrant = await tx.select().from(mcpOAuthGrants)
        .where(and(
          eq(mcpOAuthGrants.orgId, consumed.session.orgId),
          eq(mcpOAuthGrants.connectionId, connection.id),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      const grantValues = {
        authorizingUserId: consumed.session.authorizingUserId,
        providerSubject: scope.providerSubject ?? selected?.id ?? null,
        providerScopes: tokenScopes(grantMaterial.tokens),
        externalScopeMetadata: selected?.metadata ?? {},
        credentialSecretId: grantSecret.id,
        status: "active",
        statusMetadata: connection.provider === "supabase"
          ? { scopeOptions: safeOptions }
          : {},
        expiresAt: tokenExpiry(grantMaterial.tokens, now),
        lastRefreshedAt: now,
        refreshLeaseNonce: null,
        refreshLeaseExpiresAt: null,
        revokedAt: null,
        updatedAt: now,
      } as const;
      if (existingGrant) {
        await tx.update(mcpOAuthGrants).set(grantValues)
          .where(eq(mcpOAuthGrants.id, existingGrant.id));
      } else {
        await tx.insert(mcpOAuthGrants).values({
          orgId: consumed.session.orgId,
          connectionId: connection.id,
          ...grantValues,
        });
      }
      if (existingGrant?.credentialSecretId) {
        await tx.delete(organizationSecrets)
          .where(eq(organizationSecrets.id, existingGrant.credentialSecretId));
      }
      const status: "selecting_scope" | "active" =
        connection.provider === "supabase" ? "selecting_scope" : "active";
      await tx.update(mcpConnections).set({
        status,
        externalScope: selected?.id ?? null,
        safeConfig: connection.provider === "supabase"
          ? {}
          : connection.safeConfig,
        enabled: true,
        activatedAt: status === "active" ? connection.activatedAt ?? now : null,
        updatedAt: now,
      }).where(eq(mcpConnections.id, connection.id));
      await tx.insert(activityLog).values(oauthActivityValues({
        orgId: consumed.session.orgId,
        connectionId: connection.id,
        action: "mcp_oauth.authorization_completed",
        actorUserId: consumed.session.authorizingUserId,
        details: {
          provider: connection.provider,
          status,
          hasExternalScope: Boolean(selected),
        },
      }));
      return {
        kind: "completed" as const,
        connectionId: connection.id,
        orgId: consumed.session.orgId,
        authorizingUserId: consumed.session.authorizingUserId,
        status,
      };
    });
    if (!outcome) {
      await bestEffortRevokeMaterial(
        grantMaterial,
        Math.min(consumed.connection.toolTimeoutMs, 10_000),
      );
      throw unprocessable("Managed MCP OAuth connection changed; start authorization again");
    }
    if (outcome.kind === "reauth") {
      await bestEffortRevokeMaterial(
        grantMaterial,
        Math.min(consumed.connection.toolTimeoutMs, 10_000),
      );
      throw unprocessable("Managed MCP OAuth must be reauthorized by an owner");
    }
    if (outcome.status === "active" && options.refreshConnectionTools) {
      await options.refreshConnectionTools(
        outcome.orgId,
        outcome.connectionId,
        { userId: outcome.authorizingUserId, agentId: null },
      );
    }
    return { connectionId: outcome.connectionId, status: outcome.status };
  }

  async function getGrantSummary(
    orgId: string,
    connectionId: string,
  ): Promise<McpOAuthGrantSummary> {
    return publicGrant(await requireUsableGrant(orgId, connectionId));
  }

  async function listScopeOptions(
    orgId: string,
    connectionId: string,
  ): Promise<McpExternalScopeOption[]> {
    const connection = await findConnection(orgId, connectionId);
    if (connection.provider !== "supabase" || connection.status !== "selecting_scope") {
      throw unprocessable("Managed MCP connection does not have pending scope selection");
    }
    const grant = await requireUsableGrant(orgId, connectionId);
    const optionsValue = grant.statusMetadata.scopeOptions;
    if (!Array.isArray(optionsValue)) return [];
    return optionsValue
      .filter((value): value is McpExternalScopeOption => (
        isRecord(value)
        && typeof value.id === "string"
        && typeof value.displayName === "string"
        && isRecord(value.metadata)
      ))
      .slice(0, MAX_SCOPE_OPTIONS)
      .map(safeScopeOption);
  }

  async function selectScope(
    orgId: string,
    connectionId: string,
    rawSelection: McpScopeSelection,
    actor: ManagedMcpOAuthActor,
  ): Promise<McpConnectionSummary> {
    const selection = mcpScopeSelectionSchema.parse(rawSelection);
    if (selection.connectionId !== connectionId) {
      throw unprocessable("Managed MCP scope selection does not match its connection");
    }
    if (selection.accessMode !== "read_only" && selection.accessMode !== "read_write") {
      throw unprocessable("Supabase scope requires read_only or read_write access");
    }
    const now = new Date();
    const result = await db.transaction(async (tx) => {
      const connection = await tx.select().from(mcpConnections)
        .where(and(eq(mcpConnections.orgId, orgId), eq(mcpConnections.id, connectionId)))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!connection || connection.provider !== "supabase" || connection.status !== "selecting_scope") {
        throw unprocessable("Managed MCP connection does not have pending scope selection");
      }
      const grant = await tx.select().from(mcpOAuthGrants)
        .where(and(
          eq(mcpOAuthGrants.orgId, orgId),
          eq(mcpOAuthGrants.connectionId, connectionId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!grant || grant.status !== "active" || !grant.credentialSecretId) {
        throw unprocessable("Managed MCP OAuth authorization must be reconnected");
      }
      const authorizerValid = options.deploymentMode === "local_trusted"
        && !grant.authorizingUserId
        ? true
        : Boolean(
            await tx.select({ id: organizationMemberships.id })
              .from(organizationMemberships)
              .where(and(
                eq(organizationMemberships.orgId, orgId),
                eq(organizationMemberships.principalType, "user"),
                eq(organizationMemberships.principalId, grant.authorizingUserId ?? ""),
                eq(organizationMemberships.status, "active"),
                eq(organizationMemberships.membershipRole, "owner"),
              ))
              .for("share")
              .then((rows) => rows[0] ?? null)
            ?? await tx.select({ id: instanceUserRoles.id })
              .from(instanceUserRoles)
              .where(and(
                eq(instanceUserRoles.userId, grant.authorizingUserId ?? ""),
                eq(instanceUserRoles.role, "instance_admin"),
              ))
              .for("share")
              .then((rows) => rows[0] ?? null),
          );
      if (!authorizerValid) {
        await transitionGrantToNeedsReauth(
          tx,
          grant,
          "authorizer_no_longer_authorized",
        );
        return { kind: "reauth" as const };
      }
      const optionsValue = grant.statusMetadata.scopeOptions;
      const optionsList = Array.isArray(optionsValue)
        ? optionsValue
            .filter((value): value is McpExternalScopeOption => (
              isRecord(value)
              && typeof value.id === "string"
              && typeof value.displayName === "string"
              && isRecord(value.metadata)
            ))
            .slice(0, MAX_SCOPE_OPTIONS)
            .map(safeScopeOption)
        : [];
      const selected = optionsList.find((option) => option.id === selection.externalScope);
      if (!selected) throw unprocessable("Selected Supabase project was not discovered");
      const row = await tx.update(mcpConnections).set({
        externalScope: selected.id,
        accessMode: selection.accessMode,
        safeConfig: {
          featureGroups: MCP_PROVIDER_REGISTRY.supabase.featureGroups,
        },
        status: "active",
        enabled: true,
        activatedAt: connection.activatedAt ?? now,
        updatedAt: now,
      }).where(and(
        eq(mcpConnections.orgId, orgId),
        eq(mcpConnections.id, connectionId),
      )).returning().then((rows) => rows[0]!);
      const updatedGrant = await tx.update(mcpOAuthGrants).set({
        externalScopeMetadata: selected.metadata,
        statusMetadata: {},
        updatedAt: now,
      }).where(and(
        eq(mcpOAuthGrants.orgId, orgId),
        eq(mcpOAuthGrants.connectionId, connectionId),
        eq(mcpOAuthGrants.status, "active"),
      )).returning({ id: mcpOAuthGrants.id });
      if (updatedGrant.length !== 1) {
        throw unprocessable("Managed MCP OAuth authorization changed during scope selection");
      }
      await tx.insert(activityLog).values(oauthActivityValues({
        orgId,
        connectionId,
        action: "mcp_oauth.scope_selected",
        actorUserId: actor.userId,
        details: {
          provider: "supabase",
          accessMode: selection.accessMode,
          projectSelected: true,
        },
      }));
      return { kind: "selected" as const, row };
    });
    if (result.kind === "reauth") {
      throw unprocessable("Managed MCP OAuth authorization must be reconnected by an owner");
    }
    const updated = result.row;
    if (options.refreshConnectionTools) {
      await options.refreshConnectionTools(orgId, connectionId, {
        userId: actor.userId,
        agentId: null,
      });
    }
    return publicConnection(updated);
  }

  async function revoke(
    orgId: string,
    connectionId: string,
    actor: ManagedMcpOAuthActor,
    reason = "connection_disconnect",
  ): Promise<McpConnectionSummary> {
    const existing = await findConnection(orgId, connectionId);
    assertCurated(existing);

    const outcome = await db.transaction(async (tx) => {
      const now = new Date();
      const connection = await tx.select().from(mcpConnections)
        .where(and(
          eq(mcpConnections.orgId, orgId),
          eq(mcpConnections.id, connectionId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      const grant = await tx.select().from(mcpOAuthGrants)
        .where(and(
          eq(mcpOAuthGrants.orgId, orgId),
          eq(mcpOAuthGrants.connectionId, connectionId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!connection) throw notFound("MCP connection not found");
      assertCurated(connection);
      const pendingSessions = await tx.select().from(mcpOAuthSessions)
        .where(and(
          eq(mcpOAuthSessions.orgId, orgId),
          eq(mcpOAuthSessions.connectionId, connectionId),
          eq(mcpOAuthSessions.status, "authorizing"),
          isNull(mcpOAuthSessions.consumedAt),
        ))
        .for("update");
      let material: ManagedMcpOAuthMaterial | null = null;
      if (grant?.credentialSecretId) {
        try {
          material = (await resolveLockedOAuthSecret(
            tx,
            orgId,
            grant.credentialSecretId,
          ))?.material ?? null;
        } catch {
          // Local revocation and credential deletion must not depend on readable provider material.
        }
      }
      if (grant) {
        await tx.update(mcpOAuthGrants).set({
          status: "revoked",
          statusMetadata: { reason },
          credentialSecretId: null,
          refreshLeaseNonce: null,
          refreshLeaseExpiresAt: null,
          revokedAt: now,
          updatedAt: now,
        }).where(eq(mcpOAuthGrants.id, grant.id));
        if (grant.credentialSecretId) {
          await tx.delete(organizationSecrets)
            .where(eq(organizationSecrets.id, grant.credentialSecretId));
        }
      }
      if (pendingSessions.length > 0) {
        await tx.update(mcpOAuthSessions).set({
          status: "expired",
          statusMetadata: { reason },
          credentialSecretId: null,
          consumedAt: now,
        }).where(inArray(
          mcpOAuthSessions.id,
          pendingSessions.map((session) => session.id),
        ));
        const pendingSecretIds = pendingSessions
          .map((session) => session.credentialSecretId)
          .filter((id): id is string => Boolean(id));
        if (pendingSecretIds.length > 0) {
          await tx.delete(organizationSecrets).where(and(
            eq(organizationSecrets.orgId, orgId),
            inArray(organizationSecrets.id, pendingSecretIds),
          ));
        }
      }
      const updated = await tx.update(mcpConnections).set({
        status: "revoked",
        enabled: false,
        disabledAt: now,
        revokedAt: now,
        updatedAt: now,
      }).where(and(
        eq(mcpConnections.orgId, orgId),
        eq(mcpConnections.id, connectionId),
      )).returning().then((rows) => rows[0]!);
      await tx.insert(activityLog).values(oauthActivityValues({
        orgId,
        connectionId,
        action: "mcp_oauth.revoked",
        actorUserId: actor.userId,
        details: {
          provider: connection.provider,
          reason,
          upstreamRevocationAvailable: Boolean(oauthRevocationEndpoint(material)),
        },
      }));
      return {
        connection: updated,
        material,
      };
    });

    await bestEffortRevokeMaterial(
      outcome.material,
      Math.min(existing.toolTimeoutMs, 10_000),
    );
    return publicConnection(outcome.connection);
  }

  async function transitionGrantToNeedsReauth(
    tx: McpDbTransaction,
    grant: McpOAuthGrantRow,
    reason: string,
  ): Promise<void> {
    const now = new Date();
    await tx.update(mcpOAuthGrants).set({
      status: "needs_reauth",
      statusMetadata: { reason },
      credentialSecretId: null,
      refreshLeaseNonce: null,
      refreshLeaseExpiresAt: null,
      updatedAt: now,
    }).where(and(
      eq(mcpOAuthGrants.id, grant.id),
      eq(mcpOAuthGrants.status, "active"),
    ));
    await tx.update(mcpConnections).set({
      status: "needs_reauth",
      enabled: false,
      disabledAt: now,
      updatedAt: now,
    }).where(and(
      eq(mcpConnections.orgId, grant.orgId),
      eq(mcpConnections.id, grant.connectionId),
    ));
    if (grant.credentialSecretId) {
      await tx.delete(organizationSecrets)
        .where(eq(organizationSecrets.id, grant.credentialSecretId));
    }
    await tx.insert(activityLog).values(oauthActivityValues({
      orgId: grant.orgId,
      connectionId: grant.connectionId,
      action: "mcp_oauth.reauthorization_required",
      actorUserId: grant.authorizingUserId,
      details: { reason },
    }));
  }

  async function performGrantRefresh(
    orgId: string,
    connectionId: string,
  ): Promise<void> {
    const baseline = await db.select({
      credentialSecretId: mcpOAuthGrants.credentialSecretId,
      latestVersion: organizationSecrets.latestVersion,
    }).from(mcpOAuthGrants)
      .innerJoin(
        organizationSecrets,
        eq(organizationSecrets.id, mcpOAuthGrants.credentialSecretId),
      )
      .where(and(
        eq(mcpOAuthGrants.orgId, orgId),
        eq(mcpOAuthGrants.connectionId, connectionId),
        eq(mcpOAuthGrants.status, "active"),
        eq(organizationSecrets.orgId, orgId),
        eq(organizationSecrets.purpose, "managed_mcp_oauth"),
      ))
      .then((rows) => rows[0] ?? null);
    if (!baseline?.credentialSecretId) {
      throw unprocessable("Managed MCP OAuth authorization must be reconnected");
    }
    const acquisitionStartedAt = Date.now();
    let claimed: {
      nonce: string;
      timeoutMs: number;
      connection: McpConnectionRow & { provider: "supabase" | "linear" | "notion" };
      grant: McpOAuthGrantRow & { credentialSecretId: string };
      secret: typeof organizationSecrets.$inferSelect;
      material: ManagedMcpOAuthMaterial;
    } | null = null;
    while (!claimed) {
      const result = await db.transaction(async (tx) => {
        const databaseClock = await tx.execute(sql<{ value: string }>`
          select clock_timestamp()::text as value
        `) as Array<{ value: string }>;
        const now = new Date(databaseClock[0]!.value);
        const connection = await tx.select().from(mcpConnections)
          .where(and(
            eq(mcpConnections.orgId, orgId),
            eq(mcpConnections.id, connectionId),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null);
        const grant = await tx.select().from(mcpOAuthGrants)
          .where(and(
            eq(mcpOAuthGrants.orgId, orgId),
            eq(mcpOAuthGrants.connectionId, connectionId),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !connection
          || !grant
          || grant.status !== "active"
          || !grant.credentialSecretId
          || connection.status !== "active"
          || !connection.enabled
        ) {
          return { kind: "needs_reauth" as const };
        }
        assertCurated(connection);
        if (!await isValidAuthorizerInTransaction(tx, orgId, grant.authorizingUserId)) {
          await transitionGrantToNeedsReauth(
            tx,
            grant,
            "authorizer_no_longer_authorized",
          );
          return { kind: "needs_reauth" as const };
        }
        const resolved = await resolveLockedOAuthSecret(
          tx,
          orgId,
          grant.credentialSecretId,
        );
        if (!resolved) {
          await transitionGrantToNeedsReauth(tx, grant, "credential_unavailable");
          return { kind: "needs_reauth" as const };
        }
        if (
          grant.credentialSecretId !== baseline.credentialSecretId
          || resolved.secret.latestVersion !== baseline.latestVersion
        ) {
          return { kind: "refreshed" as const };
        }
        if (
          grant.refreshLeaseNonce
          && grant.refreshLeaseExpiresAt
          && grant.refreshLeaseExpiresAt > now
        ) {
          return {
            kind: "leased" as const,
            waitMs: Math.min(
              50,
              Math.max(5, grant.refreshLeaseExpiresAt.getTime() - now.getTime()),
            ),
            timeoutMs: Math.min(connection.toolTimeoutMs, 10_000),
          };
        }
        const timeoutMs = Math.min(connection.toolTimeoutMs, 10_000);
        const nonce = randomUUID();
        const leaseExpiresAt = new Date(now.getTime() + timeoutMs + 1_000);
        await tx.update(mcpOAuthGrants).set({
          refreshLeaseNonce: nonce,
          refreshLeaseExpiresAt: leaseExpiresAt,
          updatedAt: now,
        }).where(eq(mcpOAuthGrants.id, grant.id));
        return {
          kind: "claimed" as const,
          nonce,
          timeoutMs,
          connection,
          grant: { ...grant, credentialSecretId: grant.credentialSecretId },
          secret: resolved.secret,
          material: resolved.material,
        };
      });
      if (result.kind === "needs_reauth") {
        throw unprocessable("Managed MCP OAuth authorization must be reconnected");
      }
      if (result.kind === "refreshed") return;
      if (result.kind === "leased") {
        if (Date.now() - acquisitionStartedAt > result.timeoutMs + 2_000) {
          throw unprocessable("Managed MCP OAuth token refresh timed out");
        }
        await waitForLease(result.waitMs);
        continue;
      }
      claimed = result;
    }

    let material = claimed.material;
    const provider = new PersistentMcpOAuthClientProvider({
      redirectUri: resolveMcpOAuthRedirectUri({
        deploymentMode: options.deploymentMode,
        serverPort: options.serverPort,
        authPublicBaseUrl: options.authPublicBaseUrl,
      }),
      state: "refresh",
      material,
      save: async (next) => {
        material = structuredClone(next);
      },
    });
    let authResult: AuthResult | null = null;
    let refreshError: unknown;
    const refreshAbortController = new AbortController();
    const refreshAbortTimer = setTimeout(() => {
      refreshAbortController.abort(new ManagedMcpOAuthRefreshTimeoutError());
    }, claimed.timeoutMs);
    try {
      authResult = await withHardTimeout(runAuth(provider, {
        serverUrl: MCP_PROVIDER_REGISTRY[claimed.connection.provider].endpoint,
        scope: claimed.connection.provider === "linear"
          && claimed.connection.accessMode === "read_only"
          ? "read"
          : undefined,
        fetchFn: (input, init) => secureFetch(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, refreshAbortController.signal])
            : refreshAbortController.signal,
        }),
      }), claimed.timeoutMs);
    } catch (error) {
      refreshError = error;
    } finally {
      clearTimeout(refreshAbortTimer);
    }
    const invalidGrant = (
      isInvalidGrantOAuthError(refreshError)
      || (refreshError === undefined
        && (authResult !== "AUTHORIZED" || !material.tokens?.access_token))
    );
    const prepared = !refreshError && !invalidGrant
      ? await getSecretProvider("local_encrypted").createVersion({
          value: JSON.stringify(material),
          externalRef: claimed.secret.externalRef,
        })
      : null;

    const outcome = await db.transaction(async (tx) => {
      const connection = await tx.select().from(mcpConnections)
        .where(and(
          eq(mcpConnections.orgId, orgId),
          eq(mcpConnections.id, connectionId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      const grant = await tx.select().from(mcpOAuthGrants)
        .where(and(
          eq(mcpOAuthGrants.orgId, orgId),
          eq(mcpOAuthGrants.connectionId, connectionId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (
        !connection
        || !grant
        || grant.status !== "active"
        || !grant.credentialSecretId
        || grant.id !== claimed!.grant.id
        || grant.credentialSecretId !== claimed!.secret.id
        || grant.refreshLeaseNonce !== claimed!.nonce
      ) {
        return { kind: "stale" as const };
      }
      const resolved = await resolveLockedOAuthSecret(
        tx,
        orgId,
        grant.credentialSecretId,
      );
      if (!resolved || resolved.secret.latestVersion !== claimed!.secret.latestVersion) {
        await tx.update(mcpOAuthGrants).set({
          refreshLeaseNonce: null,
          refreshLeaseExpiresAt: null,
          updatedAt: new Date(),
        }).where(and(
          eq(mcpOAuthGrants.id, grant.id),
          eq(mcpOAuthGrants.refreshLeaseNonce, claimed!.nonce),
        ));
        return { kind: "stale" as const };
      }
      if (invalidGrant) {
        await transitionGrantToNeedsReauth(tx, grant, "invalid_grant");
        return { kind: "needs_reauth" as const };
      }
      if (refreshError || !prepared) {
        await tx.update(mcpOAuthGrants).set({
          refreshLeaseNonce: null,
          refreshLeaseExpiresAt: null,
          updatedAt: new Date(),
        }).where(and(
          eq(mcpOAuthGrants.id, grant.id),
          eq(mcpOAuthGrants.refreshLeaseNonce, claimed!.nonce),
        ));
        return { kind: "failed" as const };
      }
      const nextVersion = resolved.secret.latestVersion + 1;
      await tx.insert(organizationSecretVersions).values({
        secretId: resolved.secret.id,
        version: nextVersion,
        material: prepared.material,
        valueSha256: prepared.valueSha256,
        createdByUserId: grant.authorizingUserId,
      });
      const secretUpdated = await tx.update(organizationSecrets).set({
        latestVersion: nextVersion,
        externalRef: prepared.externalRef,
        updatedAt: new Date(),
      }).where(and(
        eq(organizationSecrets.id, resolved.secret.id),
        eq(organizationSecrets.latestVersion, resolved.secret.latestVersion),
      )).returning({ id: organizationSecrets.id });
      if (secretUpdated.length !== 1) {
        throw new Error("Managed MCP OAuth secret version changed during refresh");
      }
      const now = new Date();
      await tx.update(mcpOAuthGrants).set({
        providerScopes: tokenScopes(material.tokens),
        expiresAt: tokenExpiry(material.tokens, now),
        lastRefreshedAt: now,
        refreshLeaseNonce: null,
        refreshLeaseExpiresAt: null,
        statusMetadata: {},
        updatedAt: now,
      }).where(and(
        eq(mcpOAuthGrants.id, grant.id),
        eq(mcpOAuthGrants.status, "active"),
        eq(mcpOAuthGrants.refreshLeaseNonce, claimed!.nonce),
      ));
      await tx.insert(activityLog).values(oauthActivityValues({
        orgId,
        connectionId,
        action: "mcp_oauth.token_refreshed",
        actorUserId: grant.authorizingUserId,
        details: { rotated: true },
      }));
      return { kind: "refreshed" as const };
    });
    if (outcome.kind === "refreshed") return;
    if (outcome.kind === "needs_reauth") {
      throw unprocessable("Managed MCP OAuth authorization must be reconnected");
    }
    if (outcome.kind === "failed") {
      throw unprocessable("Managed MCP OAuth token refresh failed");
    }
    throw unprocessable("Managed MCP OAuth authorization changed during token refresh");
  }

  function createCredential(orgId: string, connectionId: string) {
    return {
      async token(): Promise<string> {
        return resolveUsableAccessToken(orgId, connectionId);
      },
      async refresh(): Promise<void> {
        const key = `${orgId}:${connectionId}`;
        const existing = grantRefreshSingleFlights.get(key);
        if (existing) return existing;
        let refreshPromise!: Promise<void>;
        refreshPromise = (async () => {
          await performGrantRefresh(orgId, connectionId);
        })().finally(() => {
            if (grantRefreshSingleFlights.get(key) === refreshPromise) {
              grantRefreshSingleFlights.delete(key);
            }
          });
        grantRefreshSingleFlights.set(key, refreshPromise);
        return refreshPromise;
      },
      async markNeedsReauth(): Promise<void> {
        await db.transaction(async (tx) => {
          const connection = await tx.select({ id: mcpConnections.id }).from(mcpConnections)
            .where(and(
              eq(mcpConnections.orgId, orgId),
              eq(mcpConnections.id, connectionId),
            ))
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!connection) return;
          const locked = await tx.select().from(mcpOAuthGrants)
            .where(and(
              eq(mcpOAuthGrants.orgId, orgId),
              eq(mcpOAuthGrants.connectionId, connectionId),
            ))
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (locked?.status === "active") {
            await transitionGrantToNeedsReauth(tx, locked, "upstream_unauthorized");
          }
        });
      },
    };
  }

  function resolveProviderEndpoint(row: McpConnectionRow): string {
    assertCurated(row);
    return resolveCuratedMcpEndpoint({
      provider: row.provider,
      accessMode: row.accessMode as "provider_default" | "read_only" | "read_write",
      externalScope: row.externalScope,
    }).href;
  }

  return {
    start,
    callback,
    getGrantSummary,
    listScopeOptions,
    selectScope,
    revoke,
    createCredential,
    requireUsableGrant,
    resolveProviderEndpoint,
    cleanupExpiredSessions,
  };
}

export function isInvalidGrantOAuthError(error: unknown): boolean {
  return error instanceof OAuthError && error.code === OAuthErrorCode.InvalidGrant;
}
