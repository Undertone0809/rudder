import type { Db } from "@rudderhq/db";
import {
  agentCustomIntegrationBindings,
  agents,
  customIntegrationToolCalls,
  customIntegrationTools,
  customIntegrations,
} from "@rudderhq/db";
import type {
  AgentCustomIntegrationBinding,
  CreateCustomIntegration,
  CreateCustomIntegrationToolCall,
  CustomIntegration,
  CustomIntegrationSummary,
  CustomIntegrationTool,
  CustomIntegrationToolSummary,
  UpdateCustomIntegrationBinding,
} from "@rudderhq/shared";
import {
  createCustomIntegrationSchema,
  createCustomIntegrationToolCallSchema,
  updateCustomIntegrationBindingSchema,
} from "@rudderhq/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { conflict, forbidden, notFound, unprocessable } from "../../errors.js";
import { logActivity } from "../activity-log.js";
import { secretService } from "../secrets.js";

type Actor = {
  userId?: string | null;
  agentId?: string | null;
};

type CustomIntegrationRow = typeof customIntegrations.$inferSelect;
type CustomIntegrationToolRow = typeof customIntegrationTools.$inferSelect;
type AgentCustomIntegrationBindingRow = typeof agentCustomIntegrationBindings.$inferSelect;

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 54)
    || "custom-integration";
}

function toolSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64)
    || "tool";
}

function toIntegration(row: CustomIntegrationRow): CustomIntegration {
  return {
    ...row,
    scope: row.scope as CustomIntegration["scope"],
    kind: row.kind as CustomIntegration["kind"],
    status: row.status as CustomIntegration["status"],
  };
}

function toTool(row: CustomIntegrationToolRow): CustomIntegrationTool {
  if (!row.integrationId) {
    throw new Error("Legacy custom integration tool is missing its integration ID");
  }
  return {
    ...row,
    integrationId: row.integrationId,
    status: row.status as CustomIntegrationTool["status"],
  };
}

function toBinding(row: AgentCustomIntegrationBindingRow): AgentCustomIntegrationBinding {
  if (!row.integrationId) {
    throw new Error("Legacy custom integration binding is missing its integration ID");
  }
  return {
    ...row,
    integrationId: row.integrationId,
    status: row.status as AgentCustomIntegrationBinding["status"],
  };
}

export function summarizeCustomIntegration(
  integration: CustomIntegrationRow,
  binding: AgentCustomIntegrationBindingRow | null,
  tools: CustomIntegrationToolRow[],
): CustomIntegrationSummary {
  const enabled = new Set(binding?.enabledToolIds ?? []);
  const summarizedTools: CustomIntegrationToolSummary[] = tools.map((tool) => ({
    ...toTool(tool),
    enabled: binding?.status === "active" && tool.status === "active" && enabled.has(tool.id),
  }));
  const { credentialSecretId: _credentialSecretId, ...rest } = toIntegration(integration);
  return {
    ...rest,
    hasCredentialSecret: Boolean(_credentialSecretId),
    binding: binding ? toBinding(binding) : null,
    tools: summarizedTools,
  };
}

export function customIntegrationService(db: Db) {
  const secrets = secretService(db);

  async function getAgentInOrg(orgId: string, agentId: string) {
    const agent = await db
      .select({ id: agents.id, orgId: agents.orgId, name: agents.name })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");
    if (agent.orgId !== orgId) throw unprocessable("Agent must belong to same organization");
    return agent;
  }

  async function getIntegrationInOrg(orgId: string, integrationId: string) {
    const integration = await db
      .select()
      .from(customIntegrations)
      .where(and(eq(customIntegrations.orgId, orgId), eq(customIntegrations.id, integrationId)))
      .then((rows) => rows[0] ?? null);
    if (!integration) throw notFound("Custom integration not found");
    return integration;
  }

  async function assertSecretInOrg(orgId: string, secretId: string) {
    const secret = await secrets.getById(secretId);
    if (!secret) throw notFound("Custom integration credential secret not found");
    if (secret.orgId !== orgId) {
      throw unprocessable("Custom integration credential secret must belong to same organization");
    }
    return secret;
  }

  async function resolveUniqueSlug(orgId: string, requested: string) {
    const base = slugify(requested);
    for (let i = 0; i < 100; i += 1) {
      const candidate = i === 0 ? base : `${base}-${i + 1}`;
      const existing = await db
        .select({ id: customIntegrations.id })
        .from(customIntegrations)
        .where(and(eq(customIntegrations.orgId, orgId), eq(customIntegrations.slug, candidate)))
        .then((rows) => rows[0] ?? null);
      if (!existing) return candidate;
    }
    throw conflict("Could not allocate a unique integration slug");
  }

  async function buildToolName(orgId: string, integrationSlug: string, externalToolName: string) {
    const base = `custom.${integrationSlug}.${toolSlug(externalToolName)}`;
    for (let i = 0; i < 100; i += 1) {
      const candidate = i === 0 ? base : `${base}_${i + 1}`;
      const existing = await db
        .select({ id: customIntegrationTools.id })
        .from(customIntegrationTools)
        .where(and(eq(customIntegrationTools.orgId, orgId), eq(customIntegrationTools.rudderToolName, candidate)))
        .then((rows) => rows[0] ?? null);
      if (!existing) return candidate;
    }
    throw conflict("Could not allocate a unique Rudder tool name");
  }

  async function loadSummariesForBindings(rows: Array<{
    integration: CustomIntegrationRow;
    binding: AgentCustomIntegrationBindingRow;
  }>) {
    const integrationIds = rows.map((row) => row.integration.id);
    const toolRows = integrationIds.length > 0
      ? await db
        .select()
        .from(customIntegrationTools)
        .where(inArray(customIntegrationTools.integrationId, integrationIds))
      : [];
    const toolsByIntegration = new Map<string, CustomIntegrationToolRow[]>();
    toolRows.forEach((tool) => {
      const integrationId = tool.integrationId;
      if (!integrationId) return;
      const list = toolsByIntegration.get(integrationId) ?? [];
      list.push(tool);
      toolsByIntegration.set(integrationId, list);
    });
    return rows.map((row) => summarizeCustomIntegration(
      row.integration,
      row.binding,
      toolsByIntegration.get(row.integration.id) ?? [],
    ));
  }

  async function assertBindableToAgent(orgId: string, agentId: string, integration: CustomIntegrationRow) {
    if (integration.orgId !== orgId) throw forbidden("Custom integration belongs to another organization");
    if (integration.scope === "agent" && integration.ownerAgentId !== agentId) {
      throw forbidden("Agent-scoped custom integrations can only be used by their owner agent");
    }
    if (integration.status === "revoked") {
      throw unprocessable("Custom integration is revoked");
    }
  }

  async function listForAgent(orgId: string, agentId: string) {
    await getAgentInOrg(orgId, agentId);
    const rows = await db
      .select({
        integration: customIntegrations,
        binding: agentCustomIntegrationBindings,
      })
      .from(agentCustomIntegrationBindings)
      .innerJoin(
        customIntegrations,
        eq(agentCustomIntegrationBindings.integrationId, customIntegrations.id),
      )
      .where(and(
        eq(agentCustomIntegrationBindings.orgId, orgId),
        eq(agentCustomIntegrationBindings.agentId, agentId),
      ))
      .orderBy(desc(agentCustomIntegrationBindings.updatedAt));
    return loadSummariesForBindings(rows);
  }

  return {
    listForAgent,

    createForAgent: async (
      orgId: string,
      agentId: string,
      input: CreateCustomIntegration,
      actor?: Actor,
    ) => {
      const parsed = createCustomIntegrationSchema.parse(input);
      const agent = await getAgentInOrg(orgId, agentId);
      if (parsed.credential && parsed.credentialSecretId) {
        throw unprocessable("Provide credential or credentialSecretId, not both");
      }
      if (parsed.credentialSecretId) {
        await assertSecretInOrg(orgId, parsed.credentialSecretId);
      }

      const slug = await resolveUniqueSlug(orgId, parsed.slug ?? parsed.displayName);
      const credentialSecretId = parsed.credential
        ? (await secrets.create(orgId, {
          name: parsed.credential.name?.trim() || `Custom integration credential - ${agent.name} - ${slug}`,
          provider: "local_encrypted",
          value: parsed.credential.value,
          description: `Credential for custom integration ${parsed.displayName}`,
          externalRef: null,
        }, actor)).id
        : parsed.credentialSecretId ?? null;

      const ownerAgentId = parsed.scope === "agent" ? agentId : null;
      const toolInputs = await Promise.all(parsed.tools.map(async (tool) => ({
        ...tool,
        rudderToolName: tool.rudderToolName ?? await buildToolName(orgId, slug, tool.externalToolName),
      })));

      const created = await db.transaction(async (tx) => {
        const integration = await tx
          .insert(customIntegrations)
          .values({
            orgId,
            ownerAgentId,
            scope: parsed.scope,
            kind: parsed.kind,
            slug,
            displayName: parsed.displayName,
            description: parsed.description ?? null,
            config: parsed.config ?? {},
            credentialSecretId,
          })
          .returning()
          .then((rows) => rows[0]);

        const tools = await tx
          .insert(customIntegrationTools)
          .values(toolInputs.map((tool) => ({
            orgId,
            integrationId: integration.id,
            externalToolName: tool.externalToolName,
            rudderToolName: tool.rudderToolName,
            description: tool.description ?? null,
            inputSchema: tool.inputSchema ?? {},
            config: tool.config ?? {},
          })))
          .returning();

        const enabledNameSet = new Set(parsed.enabledToolNames ?? parsed.tools.map((tool) => tool.externalToolName));
        const enabledToolIds = tools
          .filter((tool) => enabledNameSet.has(tool.externalToolName) || enabledNameSet.has(tool.rudderToolName))
          .map((tool) => tool.id);

        const binding = await tx
          .insert(agentCustomIntegrationBindings)
          .values({
            orgId,
            agentId,
            integrationId: integration.id,
            enabledToolIds,
          })
          .returning()
          .then((rows) => rows[0]);

        return { integration, tools, binding };
      });

      await logActivity(db, {
        orgId,
        actorType: actor?.agentId ? "agent" : "user",
        actorId: actor?.agentId ?? actor?.userId ?? "board",
        action: "custom_integration.created",
        entityType: "custom_integration",
        entityId: created.integration.id,
        details: {
          agentId,
          kind: parsed.kind,
          scope: parsed.scope,
          toolCount: created.tools.length,
        },
      });

      return summarizeCustomIntegration(created.integration, created.binding, created.tools);
    },

    updateBindingForAgent: async (
      orgId: string,
      agentId: string,
      integrationId: string,
      input: UpdateCustomIntegrationBinding,
    ) => {
      const parsed = updateCustomIntegrationBindingSchema.parse(input);
      await getAgentInOrg(orgId, agentId);
      const integration = await getIntegrationInOrg(orgId, integrationId);
      await assertBindableToAgent(orgId, agentId, integration);

      if (parsed.enabledToolIds.length > 0) {
        const tools = await db
          .select({ id: customIntegrationTools.id })
          .from(customIntegrationTools)
          .where(and(
            eq(customIntegrationTools.orgId, orgId),
            eq(customIntegrationTools.integrationId, integrationId),
            inArray(customIntegrationTools.id, parsed.enabledToolIds),
          ));
        if (tools.length !== parsed.enabledToolIds.length) {
          throw unprocessable("Enabled tools must belong to the selected custom integration");
        }
      }

      const existing = await db
        .select()
        .from(agentCustomIntegrationBindings)
        .where(and(
          eq(agentCustomIntegrationBindings.orgId, orgId),
          eq(agentCustomIntegrationBindings.agentId, agentId),
          eq(agentCustomIntegrationBindings.integrationId, integrationId),
        ))
        .then((rows) => rows[0] ?? null);

      const binding = existing
        ? await db
          .update(agentCustomIntegrationBindings)
          .set({
            status: "active",
            enabledToolIds: parsed.enabledToolIds,
            revokedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(agentCustomIntegrationBindings.id, existing.id))
          .returning()
          .then((rows) => rows[0] ?? null)
        : await db
          .insert(agentCustomIntegrationBindings)
          .values({
            orgId,
            agentId,
            integrationId,
            enabledToolIds: parsed.enabledToolIds,
          })
          .returning()
          .then((rows) => rows[0] ?? null);

      if (!binding) throw notFound("Custom integration binding not found");
      const tools = await db
        .select()
        .from(customIntegrationTools)
        .where(and(eq(customIntegrationTools.orgId, orgId), eq(customIntegrationTools.integrationId, integrationId)));
      return summarizeCustomIntegration(integration, binding, tools);
    },

    revokeForAgent: async (orgId: string, agentId: string, integrationId: string, actor?: Actor) => {
      await getAgentInOrg(orgId, agentId);
      const integration = await getIntegrationInOrg(orgId, integrationId);
      if (integration.scope === "agent" && integration.ownerAgentId !== agentId) {
        throw forbidden("Agent-scoped custom integrations can only be revoked by their owner agent");
      }

      const now = new Date();
      const revokedBinding = await db
        .update(agentCustomIntegrationBindings)
        .set({ status: "revoked", revokedAt: now, updatedAt: now })
        .where(and(
          eq(agentCustomIntegrationBindings.orgId, orgId),
          eq(agentCustomIntegrationBindings.agentId, agentId),
          eq(agentCustomIntegrationBindings.integrationId, integrationId),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!revokedBinding) return null;

      let nextIntegration = integration;
      if (integration.scope === "agent") {
        nextIntegration = await db
          .update(customIntegrations)
          .set({ status: "revoked", revokedAt: now, updatedAt: now })
          .where(and(eq(customIntegrations.orgId, orgId), eq(customIntegrations.id, integrationId)))
          .returning()
          .then((rows) => rows[0] ?? integration);
      }

      await logActivity(db, {
        orgId,
        actorType: actor?.agentId ? "agent" : "user",
        actorId: actor?.agentId ?? actor?.userId ?? "board",
        action: "custom_integration.revoked",
        entityType: "custom_integration",
        entityId: integrationId,
        details: { agentId, scope: integration.scope },
      });

      const tools = await db
        .select()
        .from(customIntegrationTools)
        .where(and(eq(customIntegrationTools.orgId, orgId), eq(customIntegrationTools.integrationId, integrationId)));
      return summarizeCustomIntegration(nextIntegration, revokedBinding, tools);
    },

    listRuntimeToolsForAgent: async (orgId: string, agentId: string) => {
      const summaries = await listForAgent(orgId, agentId);
      return summaries
        .filter((integration) =>
          integration.status === "active"
          && integration.binding?.status === "active"
        )
        .flatMap((integration) =>
          integration.tools
            .filter((tool) => tool.enabled && tool.status === "active")
            .map((tool) => ({
              integrationId: integration.id,
              integrationName: integration.displayName,
              kind: integration.kind,
              scope: integration.scope,
              toolName: tool.rudderToolName,
              externalToolName: tool.externalToolName,
              description: tool.description,
            })),
        );
    },

    recordToolCall: async (
      orgId: string,
      agentId: string,
      integrationId: string,
      input: CreateCustomIntegrationToolCall,
    ) => {
      const parsed = createCustomIntegrationToolCallSchema.parse(input);
      await getAgentInOrg(orgId, agentId);
      const tool = await db
        .select({
          tool: customIntegrationTools,
          integration: customIntegrations,
        })
        .from(customIntegrationTools)
        .innerJoin(customIntegrations, eq(customIntegrationTools.integrationId, customIntegrations.id))
        .where(and(eq(customIntegrationTools.orgId, orgId), eq(customIntegrationTools.id, parsed.toolId)))
        .then((rows) => rows[0] ?? null);
      if (!tool) throw notFound("Custom integration tool not found");
      if (tool.integration.id !== integrationId) {
        throw notFound("Custom integration tool not found");
      }
      await assertBindableToAgent(orgId, agentId, tool.integration);

      const binding = await db
        .select()
        .from(agentCustomIntegrationBindings)
        .where(and(
          eq(agentCustomIntegrationBindings.orgId, orgId),
          eq(agentCustomIntegrationBindings.agentId, agentId),
          eq(agentCustomIntegrationBindings.integrationId, tool.integration.id),
        ))
        .then((rows) => rows[0] ?? null);
      if (!binding || binding.status !== "active" || !binding.enabledToolIds.includes(tool.tool.id)) {
        throw forbidden("Custom integration tool is not enabled for this agent");
      }

      return db
        .insert(customIntegrationToolCalls)
        .values({
          orgId,
          agentId,
          integrationId: tool.integration.id,
          toolId: tool.tool.id,
          runId: parsed.runId ?? null,
          conversationId: parsed.conversationId ?? null,
          issueId: parsed.issueId ?? null,
          status: "blocked",
          sanitizedInput: parsed.input ?? {},
          errorCode: "dispatch_not_implemented",
          errorMessage: "Custom integration dispatch is not implemented in this Rudder build.",
          completedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]);
    },
  };
}
