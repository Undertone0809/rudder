import {
  type CallToolResult,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { mcpConnections } from "@rudderhq/db";
import type {
  McpExternalScopeOption,
} from "@rudderhq/shared";
import { createHash } from "node:crypto";
import { unprocessable } from "../../errors.js";
import {
  createManagedMcpClient,
  resolveMcpHttpCredentials,
} from "./managed-client.js";
import type { ManagedMcpOAuthMaterial } from "./oauth-provider.js";
import {
  MCP_PROVIDER_REGISTRY,
} from "./provider-registry.js";
import {
  type McpDeploymentAllowlists,
  type McpDnsLookup,
} from "./security-policy.js";

type McpConnectionRow = typeof mcpConnections.$inferSelect;

export interface ManagedMcpProviderScopeResult {
  options: McpExternalScopeOption[];
  selected?: McpExternalScopeOption;
  providerSubject?: string | null;
}

export function oauthActivityValues(input: {
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

export function tokenExpiry(tokens: StoredOAuthTokens | undefined, now = new Date()): Date | null {
  if (typeof tokens?.expires_in !== "number" || !Number.isFinite(tokens.expires_in)) return null;
  return new Date(now.getTime() + Math.max(0, tokens.expires_in) * 1_000);
}

export function tokenScopes(tokens: StoredOAuthTokens | undefined): string[] {
  return typeof tokens?.scope === "string"
    ? Array.from(new Set(tokens.scope.split(/\s+/u).filter(Boolean)))
    : [];
}

export function accessToken(material: ManagedMcpOAuthMaterial): string {
  const value = material.tokens?.access_token;
  if (!value) throw unprocessable("Managed MCP OAuth credentials are unavailable");
  return value;
}

export function oauthRevocationEndpoint(material: ManagedMcpOAuthMaterial | null): string | null {
  const metadata: unknown = material?.discoveryState?.authorizationServerMetadata;
  return isRecord(metadata) && typeof metadata.revocation_endpoint === "string"
    ? metadata.revocation_endpoint
    : null;
}

const SAFE_SCOPE_METADATA_KEYS = new Set([
  "region",
  "scopeKind",
  "status",
  "workspaceName",
  "workspace_name",
  "organizationName",
  "organization_name",
]);
export const MAX_SCOPE_OPTIONS = 500;
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

export function safeScopeOption(value: McpExternalScopeOption): McpExternalScopeOption {
  return {
    id: value.id.trim().slice(0, 512),
    displayName: value.displayName.trim().slice(0, 240),
    metadata: isRecord(value.metadata) ? safeScopeMetadata(value.metadata) : {},
  };
}

export function sanitizeScopeOptions(values: McpExternalScopeOption[]): McpExternalScopeOption[] {
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
  const self = value.self;
  if (provider === "notion" && isRecord(self)) {
    candidates.push(...definition.containers.map((key) => self[key]));
  }
  return candidates.find(isRecord) ?? null;
}

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
  if (
    provider === "linear"
    && typeof value.id === "string"
    && value.id.length > 0
    && Array.isArray(value.teams)
    && value.teams.some((team) => isRecord(team) && typeof team.id === "string")
  ) {
    const authorizationName = typeof value.name === "string" && value.name.length > 0
      ? `${value.name}'s Linear authorization`
      : "Linear authorization";
    const opaqueSubjectId = createHash("sha256")
      .update(`linear-authorization-subject:${value.id}`)
      .digest("hex")
      .slice(0, 24);
    return safeScopeOption({
      id: `linear-authorization-subject-${opaqueSubjectId}`,
      displayName: authorizationName,
      metadata: {
        scopeKind: "authorization_subject",
      },
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

export async function defaultDiscoverProviderScope(input: {
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

export async function defaultValidateProviderTools(input: {
  provider: "supabase" | "linear" | "notion" | "github";
  connection: McpConnectionRow;
  material: ManagedMcpOAuthMaterial;
  endpoint: string;
  allowlists: McpDeploymentAllowlists;
  dnsLookup?: McpDnsLookup;
}): Promise<void> {
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
    await client.discoverTools();
  } finally {
    await client.close();
  }
}

export function parseOAuthMaterial(value: string): ManagedMcpOAuthMaterial {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) throw new Error("invalid");
    return parsed as ManagedMcpOAuthMaterial;
  } catch {
    throw unprocessable("Managed MCP OAuth credentials are unavailable");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
