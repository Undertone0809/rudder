import type { Db } from "@rudderhq/db";
import {
  activityLog,
  agentCustomIntegrationBindings,
  agents,
  customIntegrationTools,
  heartbeatRuns,
  mcpConnections,
  mcpOAuthGrants,
} from "@rudderhq/db";
import {
  upsertMcpAgentBindingSchema,
  type ManagedExternalMcpBinding,
  type McpAgentAccessMode,
  type McpAgentBinding,
  type McpAgentConnectionSummary,
  type McpConnectionAccessMode,
  type McpConnectionProvider,
  type McpConnectionSummary,
  type McpDiscoveredTool,
  type McpProviderAvailability,
  type UpsertMcpAgentBinding,
} from "@rudderhq/shared";
import { and, asc, eq, inArray, isNotNull, ne, notInArray, or, sql } from "drizzle-orm";
import { conflict, notFound, unprocessable } from "../../errors.js";
import {
  isManagedMcpToolCapabilityAllowed,
  managedMcpRuntimeServerName,
} from "./tool-discovery.js";

type ConnectionRow = typeof mcpConnections.$inferSelect;
type BindingRow = typeof agentCustomIntegrationBindings.$inferSelect;
type ToolRow = typeof customIntegrationTools.$inferSelect;
type ManagedMcpBindingWriter = Pick<Db, "insert" | "select">;

function isEligibleAutomaticMcpAgent(
  agent: Pick<typeof agents.$inferSelect, "status" | "metadata">,
): boolean {
  if (agent.status === "terminated") return false;
  const metadata = agent.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return true;
  const record = metadata as Record<string, unknown>;
  return record.hidden !== true && record.systemManaged !== "rudder_copilot";
}

export function effectiveManagedMcpAccess(
  bindingAccess: McpAgentAccessMode,
  provider: McpConnectionProvider,
  organizationAccess: McpConnectionAccessMode,
): McpAgentAccessMode {
  if (bindingAccess === "none") return "none";
  if (provider === "custom") return bindingAccess === "full" ? "full" : "none";
  if (provider === "notion") {
    return bindingAccess === "provider_granted" ? "provider_granted" : "none";
  }
  if (organizationAccess === "read_only") return "read_only";
  return bindingAccess === "read_only" ? "read_only" : bindingAccess;
}

export interface ManagedMcpBindingActor {
  userId?: string | null;
  agentId?: string | null;
}

function publicConnection(row: ConnectionRow): McpConnectionSummary {
  return {
    id: row.id,
    orgId: row.orgId,
    scope: row.scope as McpConnectionSummary["scope"],
    ownerAgentId: row.ownerAgentId,
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
    accessMode: row.accessMode as McpAgentBinding["accessMode"],
    policyRevision: row.policyRevision,
    enabledToolIds: row.enabledToolIds,
  };
}

function customCatalogReviewRequired(
  connection: ConnectionRow,
  binding: BindingRow | null,
  tools: ToolRow[],
): boolean {
  if (
    connection.provider !== "custom"
    || !binding
    || binding.status !== "active"
    || binding.accessMode !== "full"
  ) return false;
  const accepted = new Set(binding.enabledToolIds);
  const current = tools
    .filter((tool) => tool.status === "active" && tool.enabled && !tool.removedAt)
    .map((tool) => tool.id);
  return current.length !== accepted.size
    || current.some((toolId) => !accepted.has(toolId));
}

function defaultAgentAccess(connection: ConnectionRow): NonNullable<McpAgentBinding["accessMode"]> {
  if (connection.provider === "custom") return "full";
  if (connection.provider === "notion") return "provider_granted";
  return connection.accessMode === "read_only" ? "read_only" : "read_write";
}

async function activeToolIdsForConnection(
  db: ManagedMcpBindingWriter,
  connectionId: string,
): Promise<string[]> {
  return db.select({ id: customIntegrationTools.id })
    .from(customIntegrationTools)
    .where(and(
      eq(customIntegrationTools.connectionId, connectionId),
      eq(customIntegrationTools.status, "active"),
      eq(customIntegrationTools.enabled, true),
    ))
    .then((rows) => rows.map((row) => row.id));
}

async function insertAutomaticBinding(
  db: ManagedMcpBindingWriter,
  connection: ConnectionRow,
  agentId: string,
  source: "connection_activation" | "agent_creation",
): Promise<void> {
  const enabledToolIds = await activeToolIdsForConnection(db, connection.id);
  const created = await db.insert(agentCustomIntegrationBindings)
    .values({
      orgId: connection.orgId,
      agentId,
      connectionId: connection.id,
      status: "active",
      accessMode: defaultAgentAccess(connection),
      enabledToolIds,
    })
    .onConflictDoNothing()
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!created) return;
  await db.insert(activityLog).values(activityValues({
    orgId: connection.orgId,
    agentId,
    connectionId: connection.id,
    bindingId: created.id,
    action: "mcp_agent_binding.created",
    actor: {},
    details: {
      status: created.status,
      accessMode: created.accessMode,
      policyRevision: created.policyRevision,
      enabledToolCount: created.enabledToolIds.length,
      source,
    },
  }));
}

/**
 * Creates only missing bindings at the connection's immutable ownership boundary.
 * Existing bindings, including explicit No access, are never overwritten.
 */
export async function ensureDefaultManagedMcpBindingsForConnection(
  db: ManagedMcpBindingWriter,
  connection: ConnectionRow,
): Promise<void> {
  if (
    connection.status !== "active"
    || !connection.enabled
    || connection.transport === "legacy_manual"
    || connection.canonicalState !== "canonical"
  ) return;
  if (connection.scope === "agent") {
    if (!connection.ownerAgentId) return;
    await insertAutomaticBinding(db, connection, connection.ownerAgentId, "connection_activation");
    return;
  }
  const organizationAgents = await db.select({
    id: agents.id,
    status: agents.status,
    metadata: agents.metadata,
  }).from(agents).where(eq(agents.orgId, connection.orgId));
  for (const agent of organizationAgents.filter(isEligibleAutomaticMcpAgent)) {
    await insertAutomaticBinding(db, connection, agent.id, "connection_activation");
  }
}

export async function ensureOrganizationManagedMcpBindingsForAgent(
  db: ManagedMcpBindingWriter,
  orgId: string,
  agentId: string,
): Promise<void> {
  const agent = await db.select({
    id: agents.id,
    status: agents.status,
    metadata: agents.metadata,
  }).from(agents).where(and(
    eq(agents.orgId, orgId),
    eq(agents.id, agentId),
  )).then((rows) => rows[0] ?? null);
  if (!agent || !isEligibleAutomaticMcpAgent(agent)) return;
  const organizationConnections = await db.select().from(mcpConnections)
    .where(and(
      eq(mcpConnections.orgId, orgId),
      eq(mcpConnections.scope, "organization"),
      eq(mcpConnections.status, "active"),
      eq(mcpConnections.enabled, true),
      eq(mcpConnections.canonicalState, "canonical"),
      ne(mcpConnections.transport, "legacy_manual"),
    ));
  for (const connection of organizationConnections) {
    await insertAutomaticBinding(db, connection, agentId, "agent_creation");
  }
}

function assertAgentAccessAllowed(
  connection: ConnectionRow,
  accessMode: NonNullable<McpAgentBinding["accessMode"]>,
): void {
  if (accessMode === "none") return;
  if (connection.provider === "custom") {
    if (accessMode !== "full") {
      throw unprocessable("Custom MCP access must be no access or full server access");
    }
    return;
  }
  if (connection.provider === "notion") {
    if (accessMode !== "provider_granted") {
      throw unprocessable("Notion access is controlled by provider-granted permissions");
    }
    return;
  }
  if (accessMode !== "read_only" && accessMode !== "read_write") {
    throw unprocessable("Managed MCP agent access must be read only or read and write");
  }
  if (connection.accessMode === "read_only" && accessMode === "read_write") {
    throw unprocessable("Agent access cannot exceed the organization read-only limit");
  }
}

function accessRank(accessMode: NonNullable<McpAgentBinding["accessMode"]>): number {
  if (accessMode === "none") return 0;
  if (accessMode === "read_only") return 1;
  return 2;
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
    capabilityClass: row.capabilityClass as McpDiscoveredTool["capabilityClass"],
    policyRevision: row.policyRevision,
    catalogRevision: row.catalogRevision,
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
      reviewRequired: customCatalogReviewRequired(connection, binding, tools),
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
          or(
            eq(mcpConnections.scope, "organization"),
            and(
              eq(mcpConnections.scope, "agent"),
              eq(mcpConnections.ownerAgentId, agentId),
            ),
          ),
          or(
            eq(mcpConnections.provider, "custom"),
            eq(mcpConnections.canonicalState, "canonical"),
          ),
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
    return connections.map((connection) => {
      const binding = bindingByConnection.get(connection.id) ?? null;
      const connectionTools = toolsByConnection.get(connection.id) ?? [];
      return {
        connection: publicConnection(connection),
        binding: binding ? publicBinding(binding) : null,
        tools: connectionTools.map(publicTool),
        reviewRequired: customCatalogReviewRequired(
          connection,
          binding,
          connectionTools,
        ),
      };
    });
  }

  async function listProviderAvailability(
    orgId: string,
    agentId?: string,
  ): Promise<McpProviderAvailability[]> {
    if (agentId) await assertAgentInOrg(orgId, agentId);
    const providers = ["supabase", "linear", "notion", "github"] as const;
    const oauthProviders = ["supabase", "linear", "notion"] as const;
    const [connections, bindings, runningRuns, historicalGrants] = await Promise.all([
      db.select().from(mcpConnections)
        .where(and(
          eq(mcpConnections.orgId, orgId),
          inArray(mcpConnections.provider, [...providers]),
          eq(mcpConnections.canonicalState, "canonical"),
        )),
      db.select().from(agentCustomIntegrationBindings).where(
        eq(agentCustomIntegrationBindings.orgId, orgId),
      ),
      agentId
        ? db.select({
            startedAt: heartbeatRuns.startedAt,
          }).from(heartbeatRuns).where(and(
            eq(heartbeatRuns.orgId, orgId),
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "running"),
          ))
        : Promise.resolve([]),
      db.select({
        connectionId: mcpConnections.id,
        provider: mcpConnections.provider,
      }).from(mcpConnections)
        .innerJoin(
          mcpOAuthGrants,
          eq(mcpOAuthGrants.connectionId, mcpConnections.id),
        )
        .where(and(
          eq(mcpConnections.orgId, orgId),
          inArray(mcpConnections.provider, [...oauthProviders]),
          eq(mcpConnections.canonicalState, "superseded"),
          eq(mcpOAuthGrants.orgId, orgId),
          eq(mcpOAuthGrants.status, "active"),
          isNotNull(mcpOAuthGrants.credentialSecretId),
        )),
    ]);
    const organizationConnectionByProvider = new Map(
      connections
        .filter((connection) => connection.scope === "organization")
        .map((connection) => [connection.provider, connection]),
    );
    const agentConnectionsByProvider = new Map<string, ConnectionRow[]>();
    for (const connection of connections.filter((candidate) => candidate.scope === "agent")) {
      const values = agentConnectionsByProvider.get(connection.provider) ?? [];
      values.push(connection);
      agentConnectionsByProvider.set(connection.provider, values);
    }
    const bindingByConnection = new Map(
      bindings
        .filter((binding) => binding.connectionId && binding.agentId === agentId)
        .map((binding) => [binding.connectionId!, binding]),
    );
    const affectedAgentsByConnection = new Map<string, Set<string>>();
    const historicalGrantIdsByProvider = new Map<string, string[]>();
    for (const grant of historicalGrants) {
      const ids = historicalGrantIdsByProvider.get(grant.provider) ?? [];
      ids.push(grant.connectionId);
      historicalGrantIdsByProvider.set(grant.provider, ids);
    }
    for (const binding of bindings) {
      if (
        !binding.connectionId
        || binding.status !== "active"
        || binding.accessMode === "none"
      ) continue;
      const agentsForConnection = affectedAgentsByConnection.get(binding.connectionId)
        ?? new Set<string>();
      agentsForConnection.add(binding.agentId);
      affectedAgentsByConnection.set(binding.connectionId, agentsForConnection);
    }
    const connectionState = (connection: ConnectionRow | undefined) => {
      if (!connection) return "not_connected" as const;
      if (connection.status === "active" && connection.enabled) {
        if (connection.provider === "github" && !connection.credentialSecretId) {
          return "needs_attention" as const;
        }
        return "connected" as const;
      }
      if (connection.status === "authorizing" || connection.status === "draft") {
        return "connecting" as const;
      }
      if (connection.status === "needs_reauth" || connection.status === "error") {
        return "needs_attention" as const;
      }
      return "disconnected" as const;
    };
    const maxAccess = (connection: ConnectionRow) => (
      connection.provider === "notion"
        ? "provider_granted" as const
        : connection.accessMode as "read_only" | "read_write"
    );
    return providers.map((provider) => {
      const organizationConnection = organizationConnectionByProvider.get(provider);
      const agentConnections = agentConnectionsByProvider.get(provider) ?? [];
      const ownedConnection = agentId
        ? agentConnections.find((connection) => connection.ownerAgentId === agentId)
        : undefined;
      const ownedShadowsOrganization = Boolean(
        ownedConnection
        && ownedConnection.status !== "revoked"
        && ownedConnection.status !== "disabled",
      );
      const effectiveConnection = ownedShadowsOrganization
        ? connectionState(ownedConnection) === "connected"
          ? ownedConnection
          : undefined
        : connectionState(organizationConnection) === "connected"
          ? organizationConnection
          : undefined;
      const binding = effectiveConnection
        ? bindingByConnection.get(effectiveConnection.id)
        : undefined;
      const access = binding?.status === "active"
        ? effectiveManagedMcpAccess(
            binding.accessMode as McpAgentAccessMode,
            effectiveConnection!.provider as McpConnectionProvider,
            effectiveConnection!.accessMode as McpConnectionAccessMode,
          ) as NonNullable<McpProviderAvailability["agent"]>["access"]
        : "none";
      return {
        provider,
        organization: {
          state: connectionState(organizationConnection),
          connectionId: organizationConnection?.id ?? null,
          maxAccess: organizationConnection ? maxAccess(organizationConnection) : null,
          scopeMode: organizationConnection
            ? organizationConnection.scopeMode as McpProviderAvailability["organization"]["scopeMode"]
            : null,
          revision: organizationConnection?.revision ?? null,
          affectedAgentCount: organizationConnection
            ? affectedAgentsByConnection.get(organizationConnection.id)?.size ?? 0
            : 0,
          agentConnectionCount: agentConnections.filter(
            (connection) => connection.status !== "revoked",
          ).length,
          historicalGrantConnectionIds: [
            ...(historicalGrantIdsByProvider.get(provider) ?? []),
          ].sort(),
        },
        ...(agentId
          ? {
              agent: {
                access,
                connection: ownedConnection
                  ? {
                      state: connectionState(ownedConnection),
                      connectionId: ownedConnection.id,
                      maxAccess: maxAccess(ownedConnection),
                      revision: ownedConnection.revision,
                    }
                  : null,
                effectiveSource: effectiveConnection
                  ? effectiveConnection.scope === "agent" ? "agent" : "organization"
                  : "none",
                effectiveConnectionId: effectiveConnection?.id ?? null,
                explicitlyDisabled: Boolean(
                  ownedShadowsOrganization
                  && binding
                  && (binding.status !== "active" || binding.accessMode === "none"),
                ),
                activeRunUsesOlderPolicy: Boolean(
                  binding
                  && runningRuns.some((run) =>
                    run.startedAt && binding.updatedAt > run.startedAt),
                ),
              },
            }
          : {}),
      };
    });
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
      if (connection.scope === "agent" && connection.ownerAgentId !== agentId) {
        throw notFound("MCP connection not found");
      }
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
      if (
        existing
        && input.expectedRevision !== undefined
        && existing.policyRevision !== input.expectedRevision
      ) {
        throw conflict("Managed MCP access changed elsewhere; reload the latest settings");
      }
      if (
        existing
        && (input.accessMode !== undefined || input.status !== undefined)
        && input.expectedRevision === undefined
      ) {
        throw conflict(
          "Managed MCP access revision is required; reload the latest settings",
        );
      }
      if (
        existing
        && input.enabledToolIds !== undefined
        && input.enabledToolIds.some((id) => !existing.enabledToolIds.includes(id))
      ) {
        throw unprocessable("Legacy MCP tool identifiers may only narrow access");
      }
      if (connection.canonicalState !== "canonical") {
        if (!existing) {
          throw unprocessable("Superseded MCP connections cannot be newly bound");
        }
        if (
          input.accessMode !== undefined
          && accessRank(input.accessMode) > accessRank(
            existing.accessMode as NonNullable<McpAgentBinding["accessMode"]>,
          )
        ) {
          throw unprocessable("Superseded MCP access can only be reduced");
        }
        if (
          input.enabledToolIds !== undefined
          && input.enabledToolIds.some((id) => !existing.enabledToolIds.includes(id))
        ) {
          throw unprocessable("Superseded MCP tool access can only be reduced");
        }
        if (
          existing.status !== "active"
          && input.accessMode !== undefined
          && input.accessMode !== "none"
        ) {
          throw unprocessable("Superseded MCP bindings cannot be re-enabled");
        }
      }
      const now = new Date();
      const accessMode = input.accessMode
        ?? (existing?.accessMode as McpAgentBinding["accessMode"] | undefined)
        ?? defaultAgentAccess(connection);
      assertAgentAccessAllowed(
        connection,
        accessMode as NonNullable<McpAgentBinding["accessMode"]>,
      );
      const status = input.accessMode !== undefined
        ? input.accessMode === "none" ? "disabled" : "active"
        : input.status ?? existing?.status ?? "active";
      const enabledToolIds = input.enabledToolIds
        ?? (
          connection.provider === "custom" && input.accessMode === "full"
            ? initialToolIds
            : existing?.enabledToolIds ?? initialToolIds
        );
      const updated = existing
        ? await tx.update(agentCustomIntegrationBindings)
          .set({
            status,
            accessMode,
            policyRevision: existing.policyRevision + 1,
            enabledToolIds,
            revokedAt: input.status !== undefined
              ? input.status === "revoked"
                ? now
                : null
              : input.accessMode !== undefined
                ? null
                : existing.revokedAt,
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
            status,
            accessMode,
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
          accessMode: updated.accessMode,
          policyRevision: updated.policyRevision,
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
        .set({
          status: "revoked",
          accessMode: "none",
          policyRevision: existing.policyRevision + 1,
          revokedAt: now,
          updatedAt: now,
        })
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
        or(
          eq(mcpConnections.scope, "organization"),
          and(
            eq(mcpConnections.scope, "agent"),
            eq(mcpConnections.ownerAgentId, agentId),
          ),
        ),
        or(
          eq(mcpConnections.provider, "custom"),
          eq(mcpConnections.canonicalState, "canonical"),
        ),
      ))
      .orderBy(asc(mcpConnections.name));

    const shadowedOfficialProviders = new Set(
      (await db.select({ provider: mcpConnections.provider })
        .from(mcpConnections)
        .where(and(
          eq(mcpConnections.orgId, orgId),
          eq(mcpConnections.scope, "agent"),
          eq(mcpConnections.ownerAgentId, agentId),
          eq(mcpConnections.canonicalState, "canonical"),
          notInArray(mcpConnections.status, ["disabled", "revoked"]),
          inArray(mcpConnections.provider, ["supabase", "linear", "notion", "github"]),
        ))).map((row) => row.provider),
    );

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
      if (
        connection.scope === "organization"
        && connection.provider !== "custom"
        && shadowedOfficialProviders.has(connection.provider)
      ) continue;
      if (binding.accessMode === "none") continue;
      const effectiveAccess = effectiveManagedMcpAccess(
        binding.accessMode as McpAgentAccessMode,
        connection.provider as McpConnectionProvider,
        connection.accessMode as McpConnectionAccessMode,
      );
      if (effectiveAccess === "none") continue;
      const grant = grantByConnection.get(connection.id);
      const available = (
        connection.status === "active"
        && connection.enabled
        && connection.transport !== "legacy_manual"
        && (
          connection.provider === "custom"
          || (
            connection.provider === "github"
            && Boolean(connection.credentialSecretId)
          )
          || (
            grant?.status === "active"
            && Boolean(grant.credentialSecretId)
          )
        )
      );
      if (!available) {
        continue;
      }
      const enabledIds = new Set(binding.enabledToolIds);
      const allowedToolNames = (toolsByConnection.get(connection.id) ?? [])
        .filter((tool) => (
          enabledIds.has(tool.id)
          && isManagedMcpToolCapabilityAllowed(
            effectiveAccess,
            tool.capabilityClass as Parameters<typeof isManagedMcpToolCapabilityAllowed>[1],
          )
          && tool.status === "active"
          && tool.enabled
          && !tool.removedAt
        ))
        .map((tool) => tool.rudderToolName)
        .sort();
      runtime.push({
        bindingId: binding.id,
        serverName: managedMcpRuntimeServerName(connection.name),
        accessMode: effectiveAccess,
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
    listProviderAvailability,
    upsert,
    revoke,
    listRuntimeBindings,
  };
}
