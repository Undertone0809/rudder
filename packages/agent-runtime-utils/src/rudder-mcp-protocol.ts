export const RUDDER_MCP_MODERN_PROTOCOL_VERSION = "2026-07-28" as const;

export const RUDDER_MCP_LEGACY_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;

export const RUDDER_MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  RUDDER_MCP_MODERN_PROTOCOL_VERSION,
  ...RUDDER_MCP_LEGACY_PROTOCOL_VERSIONS,
] as const;

export const RUDDER_MCP_PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
export const RUDDER_MCP_CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
export const RUDDER_MCP_CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
export const RUDDER_MCP_SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

export type RudderMcpProtocolVersion = typeof RUDDER_MCP_SUPPORTED_PROTOCOL_VERSIONS[number];

export function isRudderMcpModernProtocolVersion(value: unknown): value is typeof RUDDER_MCP_MODERN_PROTOCOL_VERSION {
  return value === RUDDER_MCP_MODERN_PROTOCOL_VERSION;
}

export function negotiateRudderMcpProtocolVersion(requested: unknown): RudderMcpProtocolVersion | null {
  if (typeof requested !== "string") return null;
  const normalized = requested.trim();
  return (RUDDER_MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(normalized)
    ? normalized as RudderMcpProtocolVersion
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function protocolVersionFromMcpParams(params: unknown): string | null {
  const record = asRecord(params);
  if (!record) return null;
  const meta = asRecord(record._meta);
  const modernVersion = meta?.[RUDDER_MCP_PROTOCOL_VERSION_META_KEY];
  if (typeof modernVersion === "string" && modernVersion.trim().length > 0) return modernVersion.trim();
  const legacyVersion = record.protocolVersion;
  return typeof legacyVersion === "string" && legacyVersion.trim().length > 0
    ? legacyVersion.trim()
    : null;
}

export function hasConflictingMcpProtocolVersions(params: unknown): boolean {
  const record = asRecord(params);
  const meta = asRecord(record?._meta);
  const modernVersion = meta?.[RUDDER_MCP_PROTOCOL_VERSION_META_KEY];
  const legacyVersion = record?.protocolVersion;
  return typeof modernVersion === "string"
    && typeof legacyVersion === "string"
    && modernVersion.trim().length > 0
    && legacyVersion.trim().length > 0
    && modernVersion.trim() !== legacyVersion.trim();
}

export function hasModernMcpRequestEnvelope(params: unknown): boolean {
  const meta = asRecord(asRecord(params)?._meta);
  return isRudderMcpModernProtocolVersion(meta?.[RUDDER_MCP_PROTOCOL_VERSION_META_KEY])
    && asRecord(meta?.[RUDDER_MCP_CLIENT_CAPABILITIES_META_KEY]) !== null;
}

export function modernMcpResult(
  result: Record<string, unknown>,
  options: {
    cacheable?: boolean;
    cacheScope?: "public" | "private";
    serverInfo?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const cacheable = options.cacheable ?? false;
  const meta = asRecord(result._meta);
  const serverInfo = options.serverInfo;
  const nextMeta = serverInfo && meta?.[RUDDER_MCP_SERVER_INFO_META_KEY] === undefined
    ? { ...(meta ?? {}), [RUDDER_MCP_SERVER_INFO_META_KEY]: serverInfo }
    : meta;
  return {
    ...result,
    resultType: "complete",
    ...(cacheable ? { ttlMs: 300_000, cacheScope: options.cacheScope ?? "public" } : {}),
    ...(nextMeta ? { _meta: nextMeta } : {}),
  };
}
