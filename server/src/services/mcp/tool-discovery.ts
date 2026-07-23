import Ajv from "ajv";
import { createHash } from "node:crypto";

export const MCP_TOOL_DISCOVERY_LIMITS = {
  maxTools: 500,
  maxToolNameCharacters: 128,
  maxDescriptionCharacters: 4_000,
  maxSchemaBytes: 256 * 1024,
  maxSchemaDepth: 32,
} as const;

export interface RawMcpDiscoveredTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface NormalizedMcpDiscoveredTool {
  externalToolName: string;
  rudderToolName: string;
  description: string | null;
  rawInputSchema: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  rawOutputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
}

const AjvCtor = (Ajv as any).default ?? Ajv;
const ajv = new AjvCtor({
  allErrors: false,
  strict: false,
  validateSchema: true,
});

const unsafeObjectKeys = new Set(["__proto__", "constructor", "prototype"]);

function cloneJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Managed MCP tool JSON Schema must be JSON serializable");
  }
  const parsed = JSON.parse(serialized) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Managed MCP tool JSON Schema must be an object");
  }
  return parsed as Record<string, unknown>;
}

function jsonDepth(value: unknown, seen = new Set<object>()): number {
  if (!value || typeof value !== "object") return 0;
  if (seen.has(value)) {
    throw new Error("Managed MCP tool JSON Schema must not be circular");
  }
  seen.add(value);
  const childValues = Array.isArray(value)
    ? value
    : Object.entries(value)
      .filter(([key]) => !unsafeObjectKeys.has(key))
      .map(([, child]) => child);
  const depth = childValues.length === 0
    ? 1
    : 1 + Math.max(...childValues.map((child) => jsonDepth(child, seen)));
  seen.delete(value);
  return depth;
}

function sanitizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (!value || typeof value !== "object") return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (unsafeObjectKeys.has(key)) continue;
    sanitized[key] = sanitizeJsonValue(child);
  }
  return sanitized;
}

function normalizeSchema(
  schema: Record<string, unknown>,
  fieldName: "input" | "output",
): {
  raw: Record<string, unknown>;
  sanitized: Record<string, unknown>;
} {
  let serialized: string;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    throw new Error(`Managed MCP ${fieldName} JSON Schema must be JSON serializable`);
  }
  if (Buffer.byteLength(serialized, "utf8") > MCP_TOOL_DISCOVERY_LIMITS.maxSchemaBytes) {
    throw new Error(`Managed MCP ${fieldName} schema size exceeds the limit`);
  }
  if (jsonDepth(schema) > MCP_TOOL_DISCOVERY_LIMITS.maxSchemaDepth) {
    throw new Error(`Managed MCP ${fieldName} schema depth exceeds the limit`);
  }

  const raw = cloneJsonRecord(schema);
  const sanitized = sanitizeJsonValue(raw) as Record<string, unknown>;
  try {
    ajv.compile(sanitized);
  } catch {
    throw new Error(`Managed MCP ${fieldName} JSON Schema is invalid`);
  }
  return { raw, sanitized };
}

function toolSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    || "tool";
}

function collisionSuffix(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function boundedSegment(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const suffix = collisionSuffix(value);
  return `${value.slice(0, maxLength - suffix.length - 1)}-${suffix}`;
}

function boundedNamespacedToolName(
  prefix: string,
  toolName: string,
  forceHash: boolean,
  hashKey = toolName,
): string {
  const maxLength = 128;
  const needsHash = forceHash || `${prefix}.${toolName}`.length > maxLength;
  if (!needsHash) return `${prefix}.${toolName}`;

  const suffix = collisionSuffix(hashKey);
  const available = maxLength - prefix.length - 1 - suffix.length - 1;
  if (available < 1) {
    throw new Error("Managed MCP connection name leaves no room for a namespaced tool");
  }
  return `${prefix}.${toolName.slice(0, available)}-${suffix}`;
}

export function normalizeMcpDiscoveredTools(
  connectionName: string,
  tools: RawMcpDiscoveredTool[],
): NormalizedMcpDiscoveredTool[] {
  if (tools.length > MCP_TOOL_DISCOVERY_LIMITS.maxTools) {
    throw new Error("Managed MCP tool count exceeds the discovery limit");
  }

  const names = new Set<string>();
  for (const tool of tools) {
    if (
      !tool.name
      || tool.name.length > MCP_TOOL_DISCOVERY_LIMITS.maxToolNameCharacters
      || !/^[A-Za-z0-9_.-]+$/u.test(tool.name)
    ) {
      throw new Error("Managed MCP tool name is invalid or exceeds the limit");
    }
    if (names.has(tool.name)) {
      throw new Error("Managed MCP discovery returned a duplicate tool name");
    }
    names.add(tool.name);
  }

  const connectionPrefix = `external.${boundedSegment(toolSlug(connectionName), 56)}`;
  const slugCounts = new Map<string, number>();
  for (const tool of tools) {
    const slug = toolSlug(tool.name);
    slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
  }

  return tools.map((tool) => {
    const input = normalizeSchema(tool.inputSchema ?? { type: "object" }, "input");
    const output = tool.outputSchema
      ? normalizeSchema(tool.outputSchema, "output")
      : null;
    const slug = toolSlug(tool.name);
    const rudderToolName = boundedNamespacedToolName(
      connectionPrefix,
      slug,
      slugCounts.get(slug) !== 1,
      tool.name,
    );

    const description = tool.description?.trim() || null;
    return {
      externalToolName: tool.name,
      rudderToolName,
      description: description?.slice(
        0,
        MCP_TOOL_DISCOVERY_LIMITS.maxDescriptionCharacters,
      ) ?? null,
      rawInputSchema: input.raw,
      inputSchema: input.sanitized,
      rawOutputSchema: output?.raw ?? null,
      outputSchema: output?.sanitized ?? null,
    };
  });
}

export interface ExistingMcpToolCatalogEntry {
  externalToolName: string;
  enabled: boolean;
}

export interface ReconciledMcpToolCatalogEntry {
  externalToolName: string;
  enabled: boolean;
  status: "active" | "removed";
  isNew: boolean;
}

export function reconcileMcpToolCatalog(
  existing: ExistingMcpToolCatalogEntry[],
  current: Array<{ externalToolName: string }>,
): ReconciledMcpToolCatalogEntry[] {
  const existingByName = new Map(
    existing.map((tool) => [tool.externalToolName, tool]),
  );
  const currentNames = new Set(current.map((tool) => tool.externalToolName));

  return [
    ...current.map((tool) => {
      const prior = existingByName.get(tool.externalToolName);
      return {
        externalToolName: tool.externalToolName,
        enabled: prior?.enabled ?? true,
        status: "active" as const,
        isNew: !prior,
      };
    }),
    ...existing
      .filter((tool) => !currentNames.has(tool.externalToolName))
      .map((tool) => ({
        externalToolName: tool.externalToolName,
        enabled: false,
        status: "removed" as const,
        isNew: false,
      })),
  ];
}

export function reconcileMcpBindingToolNames(input: {
  initialBinding: boolean;
  previouslyKnownToolNames: string[];
  previouslyEnabledToolNames: string[];
  currentToolNames: string[];
}): string[] {
  if (input.initialBinding) return [...input.currentToolNames];

  const previouslyKnown = new Set(input.previouslyKnownToolNames);
  const previouslyEnabled = new Set(input.previouslyEnabledToolNames);
  return input.currentToolNames.filter(
    (name) => previouslyKnown.has(name) && previouslyEnabled.has(name),
  );
}
