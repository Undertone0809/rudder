import type { Db } from "@rudderhq/db";
import {
  activityLog,
  agentCustomIntegrationBindings,
  customIntegrationToolCalls,
  customIntegrationTools,
  heartbeatRuns,
  mcpConnections,
} from "@rudderhq/db";
import { and, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { forbidden } from "../../errors.js";
import { REDACTED_EVENT_VALUE } from "../../redaction.js";
import {
  ManagedMcpClientError,
  type ManagedMcpClient,
} from "./managed-client.js";

type BindingRow = typeof agentCustomIntegrationBindings.$inferSelect;
type ConnectionRow = typeof mcpConnections.$inferSelect;
type ToolRow = typeof customIntegrationTools.$inferSelect;

export interface ManagedMcpRuntimeIdentity {
  orgId: string;
  agentId: string;
  runId: string;
}

export interface ManagedMcpRuntimeTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface ManagedMcpRuntimeServiceOptions {
  openClient: (orgId: string, connectionId: string) => Promise<ManagedMcpClient>;
  requireUsableGrant: (orgId: string, connectionId: string) => Promise<unknown>;
}

const SECRET_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:[-_]?token)?|authorization|bearer|secret|passwd|password|credential|cookie|jwt|private[-_]?key|connectionstring|(?:^|[-_])token(?:$|[-_]))/iu;
const JWT_RE =
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/u;
const AUTHORIZATION_VALUE_RE =
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]{4,}/iu;
const KNOWN_TOKEN_VALUE_RE =
  /^(?:sk-(?:proj-)?|gh[oprsu]_|github_pat_|xox[baprs]-|pat_|lin_api_|ntn_)[A-Za-z0-9_-]{12,}$/iu;
const TOKEN_QUERY_VALUE_RE =
  /(?:^|[?&])(?:access_token|api_key|apikey|token|auth)=/iu;
const HIGH_ENTROPY_VALUE_RE = /^(?=[A-Za-z0-9+/_=-]{32,}$)(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9+/_=-]+$/u;
const MAX_AUDIT_RECORD_BYTES = 24 * 1024;
const MAX_AUDIT_STRING_CHARS = 2_048;
const MAX_AUDIT_DEPTH = 8;
const MAX_AUDIT_ITEMS = 50;
const MAX_AUDIT_KEYS = 100;
const MAX_AUDIT_NODES = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function redactBoundedValue(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_AUDIT_NODES || depth >= MAX_AUDIT_DEPTH) {
    return "[bounded value omitted]";
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    if (
      JWT_RE.test(value)
      || AUTHORIZATION_VALUE_RE.test(value)
      || KNOWN_TOKEN_VALUE_RE.test(value)
      || TOKEN_QUERY_VALUE_RE.test(value)
      || HIGH_ENTROPY_VALUE_RE.test(value)
    ) {
      return REDACTED_EVENT_VALUE;
    }
    return value.length > MAX_AUDIT_STRING_CHARS
      ? `${value.slice(0, MAX_AUDIT_STRING_CHARS)}…`
      : value;
  }
  if (Array.isArray(value)) {
    const bounded = value.slice(0, MAX_AUDIT_ITEMS)
      .map((item) => redactBoundedValue(item, state, depth + 1));
    if (value.length > MAX_AUDIT_ITEMS) bounded.push("[additional items omitted]");
    return bounded;
  }
  if (!isRecord(value)) return String(value).slice(0, MAX_AUDIT_STRING_CHARS);

  const output: Record<string, unknown> = {};
  const entries = Object.entries(value).slice(0, MAX_AUDIT_KEYS);
  for (const [key, child] of entries) {
    output[key] = SECRET_KEY_RE.test(key)
      ? REDACTED_EVENT_VALUE
      : redactBoundedValue(child, state, depth + 1);
  }
  if (Object.keys(value).length > MAX_AUDIT_KEYS) {
    output.__truncatedKeys = true;
  }
  return output;
}

export function boundedRedactedMcpAuditRecord(
  value: unknown,
): Record<string, unknown> {
  const sanitized = redactBoundedValue(value, { nodes: 0 });
  const record = isRecord(sanitized) ? sanitized : { value: sanitized };
  let serialized: string;
  try {
    serialized = JSON.stringify(record);
  } catch {
    return { omitted: true, reason: "not_json_serializable" };
  }
  if (Buffer.byteLength(serialized, "utf8") <= MAX_AUDIT_RECORD_BYTES) {
    return record;
  }
  let lower = 0;
  let upper = serialized.length;
  while (lower < upper) {
    const midpoint = Math.ceil((lower + upper) / 2);
    const candidate = {
      truncated: true,
      preview: serialized.slice(0, midpoint),
    };
    if (
      Buffer.byteLength(JSON.stringify(candidate), "utf8")
      <= MAX_AUDIT_RECORD_BYTES
    ) {
      lower = midpoint;
    } else {
      upper = midpoint - 1;
    }
  }
  let preview = serialized.slice(0, lower);
  const trailingCodeUnit = preview.charCodeAt(preview.length - 1);
  if (trailingCodeUnit >= 0xD800 && trailingCodeUnit <= 0xDBFF) {
    preview = preview.slice(0, -1);
  }
  return { truncated: true, preview };
}

function safeError(error: unknown): ManagedMcpClientError {
  if (error instanceof ManagedMcpClientError) {
    return new ManagedMcpClientError(error.code, safeErrorMessage(error.code));
  }
  return new ManagedMcpClientError(
    "mcp_tool_failed",
    "Managed MCP tool call failed",
  );
}

function safeErrorMessage(code: string): string {
  switch (code) {
    case "mcp_tool_timeout":
      return "Managed MCP tool call timed out";
    case "mcp_upstream_unauthorized":
      return "Managed MCP authorization was rejected";
    case "mcp_upstream_rate_limited":
      return "Managed MCP upstream rate limit was reached";
    case "mcp_result_too_large":
      return "Managed MCP tool result exceeds the output limit";
    default:
      return "Managed MCP tool call failed";
  }
}

export function managedMcpRuntimeService(
  db: Db,
  options: ManagedMcpRuntimeServiceOptions,
) {
  async function requireRuntimeBinding(
    identity: ManagedMcpRuntimeIdentity,
    bindingId: string,
  ): Promise<{ binding: BindingRow; connection: ConnectionRow }> {
    const run = await db.select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, identity.runId),
        eq(heartbeatRuns.orgId, identity.orgId),
        eq(heartbeatRuns.agentId, identity.agentId),
        eq(heartbeatRuns.status, "running"),
      ))
      .then((rows) => rows[0] ?? null);
    if (!run) throw forbidden("Managed MCP runtime context is not active");

    const row = await db.select({
      binding: agentCustomIntegrationBindings,
      connection: mcpConnections,
    })
      .from(agentCustomIntegrationBindings)
      .innerJoin(
        mcpConnections,
        eq(agentCustomIntegrationBindings.connectionId, mcpConnections.id),
      )
      .where(and(
        eq(agentCustomIntegrationBindings.id, bindingId),
        eq(agentCustomIntegrationBindings.orgId, identity.orgId),
        eq(agentCustomIntegrationBindings.agentId, identity.agentId),
        eq(agentCustomIntegrationBindings.status, "active"),
        eq(mcpConnections.orgId, identity.orgId),
        eq(mcpConnections.enabled, true),
        eq(mcpConnections.status, "active"),
      ))
      .then((rows) => rows[0] ?? null);
    if (!row || row.connection.transport === "legacy_manual") {
      throw forbidden("Managed MCP binding is unavailable");
    }
    if (row.connection.provider !== "custom") {
      try {
        await options.requireUsableGrant(identity.orgId, row.connection.id);
      } catch {
        throw forbidden("Managed MCP binding is unavailable");
      }
    }
    return row;
  }

  async function currentTools(
    identity: ManagedMcpRuntimeIdentity,
    bindingId: string,
  ): Promise<{
    binding: BindingRow;
    connection: ConnectionRow;
    tools: ToolRow[];
  }> {
    const context = await requireRuntimeBinding(identity, bindingId);
    const enabledIds = context.binding.enabledToolIds;
    const tools = enabledIds.length === 0
      ? []
      : await db.select().from(customIntegrationTools)
        .where(and(
          eq(customIntegrationTools.orgId, identity.orgId),
          eq(customIntegrationTools.connectionId, context.connection.id),
          eq(customIntegrationTools.status, "active"),
          eq(customIntegrationTools.enabled, true),
          inArray(customIntegrationTools.id, enabledIds),
        ));
    return {
      ...context,
      tools: tools.filter((tool) => !tool.removedAt),
    };
  }

  async function listTools(
    identity: ManagedMcpRuntimeIdentity,
    bindingId: string,
  ): Promise<ManagedMcpRuntimeTool[]> {
    const { tools } = await currentTools(identity, bindingId);
    return tools
      .map((tool) => ({
        name: tool.rudderToolName,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async function callTool(
    identity: ManagedMcpRuntimeIdentity,
    bindingId: string,
    exposedToolName: string,
    args: Record<string, unknown>,
  ) {
    const context = await requireRuntimeBinding(identity, bindingId);
    const tool = await db.select().from(customIntegrationTools)
      .where(and(
        eq(customIntegrationTools.orgId, identity.orgId),
        eq(customIntegrationTools.connectionId, context.connection.id),
        eq(customIntegrationTools.rudderToolName, exposedToolName),
      ))
      .then((rows) => rows[0] ?? null);
    const enabled = Boolean(
      tool
      && context.binding.enabledToolIds.includes(tool.id)
      && tool.status === "active"
      && tool.enabled
      && !tool.removedAt,
    );
    if (!enabled) {
      if (tool) {
        await db.insert(customIntegrationToolCalls).values({
          orgId: identity.orgId,
          connectionId: context.connection.id,
          toolId: tool.id,
          agentId: identity.agentId,
          runId: identity.runId,
          status: "blocked",
          sanitizedInput: boundedRedactedMcpAuditRecord(args),
          redactedDispatchOutcome: {
            status: "blocked",
            errorCode: "mcp_tool_not_allowed",
          },
          errorCode: "mcp_tool_not_allowed",
          errorMessage: "Managed MCP tool is not enabled for this run",
          completedAt: new Date(),
        });
      } else {
        await db.insert(activityLog).values({
          orgId: identity.orgId,
          actorType: "agent",
          actorId: identity.agentId,
          action: "mcp_tool_call.blocked_unknown",
          entityType: "mcp_agent_binding",
          entityId: context.binding.id,
          agentId: identity.agentId,
          runId: identity.runId,
          details: {
            reason: "unknown_tool",
            requestedToolSha256: createHash("sha256")
              .update(exposedToolName)
              .digest("hex"),
          },
        });
      }
      throw forbidden("Managed MCP tool is not enabled for this run");
    }

    const audit = await db.insert(customIntegrationToolCalls).values({
      orgId: identity.orgId,
      connectionId: context.connection.id,
      toolId: tool!.id,
      agentId: identity.agentId,
      runId: identity.runId,
      status: "blocked",
      sanitizedInput: boundedRedactedMcpAuditRecord(args),
      redactedDispatchOutcome: { status: "started" },
    }).returning({ id: customIntegrationToolCalls.id })
      .then((rows) => rows[0]!);

    let client: ManagedMcpClient | null = null;
    try {
      client = await options.openClient(identity.orgId, context.connection.id);
      const result = await client.callTool(tool!.externalToolName, args);
      await db.update(customIntegrationToolCalls).set({
        status: "success",
        sanitizedResult: boundedRedactedMcpAuditRecord(result),
        redactedDispatchOutcome: { status: "success" },
        errorCode: null,
        errorMessage: null,
        completedAt: new Date(),
      }).where(eq(customIntegrationToolCalls.id, audit.id));
      return result;
    } catch (error) {
      const safe = safeError(error);
      await db.update(customIntegrationToolCalls).set({
        status: "error",
        sanitizedResult: null,
        redactedDispatchOutcome: {
          status: "error",
          errorCode: safe.code,
        },
        errorCode: safe.code,
        errorMessage: safeErrorMessage(safe.code),
        completedAt: new Date(),
      }).where(eq(customIntegrationToolCalls.id, audit.id));
      throw safe;
    } finally {
      await client?.close().catch(() => undefined);
    }
  }

  return {
    requireBindingAccess: requireRuntimeBinding,
    listTools,
    callTool,
  };
}
