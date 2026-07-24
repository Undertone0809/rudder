import type { Db } from "@rudderhq/db";
import {
  activityLog,
  agentCustomIntegrationBindings,
  agents,
  customIntegrationTools,
  mcpConnections,
  mcpOAuthGrants,
} from "@rudderhq/db";
import {
  upsertMcpAgentBindingSchema,
  type ManagedExternalMcpBinding,
  type McpAgentBinding,
  type McpAgentConnectionSummary,
  type McpConnectionSummary,
  type McpDiscoveredTool,
  type UpsertMcpAgentBinding,
} from "@rudderhq/shared";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { notFound, unprocessable } from "../../errors.js";
import { managedMcpRuntimeServerName } from "./tool-discovery.js";

type ConnectionRow = typeof mcpConnections.$inferSelect;
type BindingRow = typeof agentCustomIntegrationBindings.$inferSelect;
type ToolRow = typeof customIntegrationTools.$inferSelect;

export interface ManagedMcpBindingActor {
  userId?: string | null;
  agentId?: string | null;
}

function publicConnection(row: ConnectionRow): McpConnectionSummary {
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
    safeConfig: row.safeConfig as McpConnectionSummary["safeConfig"],
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

function publicBinding(row: BindingRow): McpAgentBinding {
  if (!row.connectionId) {
    throw new Error("Managed MCP binding is missing its connection");
  }
  return {
    id: row.id,
    connectionId: row.connectionId,
    agentId: row.agentId,
    status: row.status as McpAgentBinding["status"],
    enabledToolIds: row.enabledToolIds,
  };
}

function publicTool(row: ToolRow): McpDiscoveredTool {
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

function activityValues(input: {
  orgId: string;
  agentId: string;
  connectionId: string;
  bindingId: string;
  action: string;
  actor: ManagedMcpBindingActor;
  details: Record<string, unknown>;
}) {
  return {
    orgId: input.orgId,
    actorType: input.actor.agentId
      ? "agent" as const
      : input.actor.userId
        ? "user" as const
        : "system" as const,
    actorId: input.actor.agentId ?? input.actor.userId ?? "system",
    action: input.action,
    entityType: "mcp_agent_binding",
    entityId: input.bindingId,
    agentId: input.agentId,
    details: {
      connectionId: input.connectionId,
      ...input.details,
    },
  };
}

export class RequiredManagedMcpConnectionUnavailableError extends Error {
  constructor(readonly serverName: string) {
    super(`Required managed MCP connection ${serverName} is unavailable`);
    this.name = "RequiredManagedMcpConnectionUnavailableError";
  }
}

export function managedMcpBindingService(db: Db) {
  async function assertAgentInOrg(orgId: string, agentId: string): Promise<void> {
    const agent = await db.select({ id: agents.id, orgId: agents.orgId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");
    if (agent.orgId !== orgId) {
      throw unprocessable("Agent must belong to same organization");
    }
  }

  async function summarize(
    connection: ConnectionRow,
    binding: BindingRow | null,
  ): Promise<McpAgentConnectionSummary> {
    const tools = await db.select().from(customIntegrationTools)
      .where(and(
        eq(customIntegrationTools.orgId, connection.orgId),
        eq(customIntegrationTools.connectionId, connection.id),
      ))
      .orderBy(asc(customIntegrationTools.rudderToolName));
    return {
      connection: publicConnection(connection),
      binding: binding ? publicBinding(binding) : null,
      tools: tools.map(publicTool),
    };
  }

  async function listForAgent(
    orgId: string,
    agentId: string,
  ): Promise<McpAgentConnectionSummary[]> {
    await assertAgentInOrg(orgId, agentId);
    const [connections, bindings, tools] = await Promise.all([
      db.select().from(mcpConnections)
        .where(and(
          eq(mcpConnections.orgId, orgId),
          eq(mcpConnections.status, "active"),
          eq(mcpConnections.enabled, true),
          ne(mcpConnections.transport, "legacy_manual"),
        ))
        .orderBy(asc(mcpConnections.displayName), asc(mcpConnections.name)),
      db.select().from(agentCustomIntegrationBindings)
        .where(and(
          eq(agentCustomIntegrationBindings.orgId, orgId),
          eq(agentCustomIntegrationBindings.agentId, agentId),
        )),
      db.select().from(customIntegrationTools)
        .where(eq(customIntegrationTools.orgId, orgId))
        .orderBy(asc(customIntegrationTools.rudderToolName)),
    ]);
    const bindingByConnection = new Map(
      bindings
        .filter((binding) => binding.connectionId)
        .map((binding) => [binding.connectionId!, binding]),
    );
    const toolsByConnection = new Map<string, ToolRow[]>();
    for (const tool of tools) {
      if (!tool.connectionId) continue;
      const values = toolsByConnection.get(tool.connectionId) ?? [];
      values.push(tool);
      toolsByConnection.set(tool.connectionId, values);
    }
    return connections.map((connection) => ({
      connection: publicConnection(connection),
      binding: bindingByConnection.has(connection.id)
        ? publicBinding(bindingByConnection.get(connection.id)!)
        : null,
      tools: (toolsByConnection.get(connection.id) ?? []).map(publicTool),
    }));
  }

  async function upsert(
    orgId: string,
    agentId: string,
    connectionId: string,
    rawInput: UpsertMcpAgentBinding,
    actor: ManagedMcpBindingActor = {},
  ): Promise<McpAgentConnectionSummary> {
    const input = upsertMcpAgentBindingSchema.parse(rawInput);
    await assertAgentInOrg(orgId, agentId);
    const created = await db.transaction(async (tx) => {
      const connection = await tx.select().from(mcpConnections)
        .where(and(
          eq(mcpConnections.orgId, orgId),
          eq(mcpConnections.id, connectionId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!connection) throw notFound("MCP connection not found");
      if (
        !connection.enabled
        || connection.status !== "active"
        || connection.transport === "legacy_manual"
      ) {
        throw unprocessable("Only active managed MCP connections can be bound to agents");
      }
      await tx.execute(sql`
        select pg_advisory_xact_lock(
          hashtextextended(${`managed-mcp-binding:${orgId}:${agentId}:${connectionId}`}, 0)
        )
      `);
      const allTools = await tx.select().from(customIntegrationTools)
        .where(and(
          eq(customIntegrationTools.orgId, orgId),
          eq(customIntegrationTools.connectionId, connectionId),
        ));
      const allToolIds = new Set(allTools.map((tool) => tool.id));
      if (input.enabledToolIds?.some((id) => !allToolIds.has(id))) {
        throw unprocessable("Enabled tools must belong to the selected MCP connection");
      }
      const initialToolIds = allTools
        .filter((tool) => tool.status === "active" && tool.enabled && !tool.removedAt)
        .map((tool) => tool.id);
      const existing = await tx.select().from(agentCustomIntegrationBindings)
        .where(and(
          eq(agentCustomIntegrationBindings.orgId, orgId),
          eq(agentCustomIntegrationBindings.agentId, agentId),
          eq(agentCustomIntegrationBindings.connectionId, connectionId),
        ))
        .then((rows) => rows[0] ?? null);
      const now = new Date();
      const enabledToolIds = input.enabledToolIds
        ?? existing?.enabledToolIds
        ?? initialToolIds;
      const updated = existing
        ? await tx.update(agentCustomIntegrationBindings)
          .set({
            status: input.status ?? existing.status,
            enabledToolIds,
            revokedAt: input.status === undefined
              ? existing.revokedAt
              : input.status === "revoked"
                ? now
                : null,
            updatedAt: now,
          })
          .where(eq(agentCustomIntegrationBindings.id, existing.id))
          .returning()
          .then((rows) => rows[0]!)
        : await tx.insert(agentCustomIntegrationBindings)
          .values({
            orgId,
            agentId,
            connectionId,
            status: input.status ?? "active",
            enabledToolIds,
            revokedAt: input.status === "revoked" ? now : null,
          })
          .returning()
          .then((rows) => rows[0]!);
      await tx.insert(activityLog).values(activityValues({
        orgId,
        agentId,
        connectionId,
        bindingId: updated.id,
        action: existing
          ? "mcp_agent_binding.updated"
          : "mcp_agent_binding.created",
        actor,
        details: {
          status: updated.status,
          enabledToolCount: updated.enabledToolIds.length,
        },
      }));
      return { binding: updated, connection };
    });
    return summarize(created.connection, created.binding);
  }

  async function revoke(
    orgId: string,
    agentId: string,
    connectionId: string,
    actor: ManagedMcpBindingActor = {},
  ): Promise<McpAgentConnectionSummary | null> {
    await assertAgentInOrg(orgId, agentId);
    const revoked = await db.transaction(async (tx) => {
      const connection = await tx.select().from(mcpConnections)
        .where(and(
          eq(mcpConnections.orgId, orgId),
          eq(mcpConnections.id, connectionId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!connection) throw notFound("MCP connection not found");
      if (connection.transport === "legacy_manual") {
        throw unprocessable("Legacy manual MCP connections cannot be bound to agents");
      }
      const existing = await tx.select().from(agentCustomIntegrationBindings)
        .where(and(
          eq(agentCustomIntegrationBindings.orgId, orgId),
          eq(agentCustomIntegrationBindings.agentId, agentId),
          eq(agentCustomIntegrationBindings.connectionId, connectionId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;
      const now = new Date();
      const binding = await tx.update(agentCustomIntegrationBindings)
        .set({ status: "revoked", revokedAt: now, updatedAt: now })
        .where(eq(agentCustomIntegrationBindings.id, existing.id))
        .returning()
        .then((rows) => rows[0]!);
      await tx.insert(activityLog).values(activityValues({
        orgId,
        agentId,
        connectionId,
        bindingId: binding.id,
        action: "mcp_agent_binding.revoked",
        actor,
        details: { status: binding.status },
      }));
      return { binding, connection };
    });
    return revoked ? summarize(revoked.connection, revoked.binding) : null;
  }

  async function listRuntimeBindings(
    orgId: string,
    agentId: string,
  ): Promise<ManagedExternalMcpBinding[]> {
    await assertAgentInOrg(orgId, agentId);
    const rows = await db.select({
      binding: agentCustomIntegrationBindings,
      connection: mcpConnections,
    })
      .from(agentCustomIntegrationBindings)
      .innerJoin(
        mcpConnections,
        eq(agentCustomIntegrationBindings.connectionId, mcpConnections.id),
      )
      .where(and(
        eq(agentCustomIntegrationBindings.orgId, orgId),
        eq(agentCustomIntegrationBindings.agentId, agentId),
        eq(agentCustomIntegrationBindings.status, "active"),
        eq(mcpConnections.orgId, orgId),
      ))
      .orderBy(asc(mcpConnections.name));

    const connectionIds = rows.map((row) => row.connection.id);
    const [tools, grants] = await Promise.all([
      connectionIds.length > 0
        ? db.select().from(customIntegrationTools).where(and(
          eq(customIntegrationTools.orgId, orgId),
          inArray(customIntegrationTools.connectionId, connectionIds),
        ))
        : Promise.resolve([] as ToolRow[]),
      connectionIds.length > 0
        ? db.select({
          connectionId: mcpOAuthGrants.connectionId,
          status: mcpOAuthGrants.status,
          credentialSecretId: mcpOAuthGrants.credentialSecretId,
        }).from(mcpOAuthGrants).where(and(
          eq(mcpOAuthGrants.orgId, orgId),
          inArray(mcpOAuthGrants.connectionId, connectionIds),
        ))
        : Promise.resolve([]),
    ]);
    const grantByConnection = new Map(
      grants.map((grant) => [grant.connectionId, grant]),
    );
    const toolsByConnection = new Map<string, ToolRow[]>();
    for (const tool of tools) {
      if (!tool.connectionId) continue;
      const values = toolsByConnection.get(tool.connectionId) ?? [];
      values.push(tool);
      toolsByConnection.set(tool.connectionId, values);
    }

    const runtime: ManagedExternalMcpBinding[] = [];
    for (const { binding, connection } of rows) {
      const grant = grantByConnection.get(connection.id);
      const available = (
        connection.status === "active"
        && connection.enabled
        && connection.transport !== "legacy_manual"
        && (
          connection.provider === "custom"
          || (
            grant?.status === "active"
            && Boolean(grant.credentialSecretId)
          )
        )
      );
      if (!available) {
        if (connection.required) {
          throw new RequiredManagedMcpConnectionUnavailableError(connection.name);
        }
        continue;
      }
      const enabledIds = new Set(binding.enabledToolIds);
      const allowedToolNames = (toolsByConnection.get(connection.id) ?? [])
        .filter((tool) => (
          enabledIds.has(tool.id)
          && tool.status === "active"
          && tool.enabled
          && !tool.removedAt
        ))
        .map((tool) => tool.rudderToolName)
        .sort();
      runtime.push({
        bindingId: binding.id,
        serverName: managedMcpRuntimeServerName(connection.name),
        toolPolicy: {
          mode: "allowlist",
          allowedToolNames,
        },
        required: connection.required,
        startupTimeoutMs: connection.startupTimeoutMs,
        toolTimeoutMs: connection.toolTimeoutMs,
      });
    }
    return runtime;
  }

  return {
    listForAgent,
    upsert,
    revoke,
    listRuntimeBindings,
  };
}
