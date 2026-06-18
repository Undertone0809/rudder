import type { Db } from "@rudderhq/db";
import { agentIntegrations, agents } from "@rudderhq/db";
import type { AgentIntegrationSummary, CreateAgentIntegration } from "@rudderhq/shared";
import { createAgentIntegrationSchema } from "@rudderhq/shared";
import { and, desc, eq } from "drizzle-orm";
import { conflict, notFound, unprocessable } from "../../errors.js";
import { secretService } from "../secrets.js";

export function summarizeAgentIntegration(row: typeof agentIntegrations.$inferSelect): AgentIntegrationSummary {
  const { appCredentialSecretId: _appCredentialSecretId, ...rest } = row;
  return {
    ...rest,
    provider: rest.provider as AgentIntegrationSummary["provider"],
    status: rest.status as AgentIntegrationSummary["status"],
    transport: rest.transport as AgentIntegrationSummary["transport"],
    providerRegion: rest.providerRegion as AgentIntegrationSummary["providerRegion"],
    hasCredentialSecret: Boolean(_appCredentialSecretId),
  };
}

export function agentIntegrationService(db: Db) {
  const secrets = secretService(db);

  async function assertAgentInOrg(orgId: string, agentId: string) {
    const agent = await db
      .select({ id: agents.id, orgId: agents.orgId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);

    if (!agent) throw notFound("Agent not found");
    if (agent.orgId !== orgId) throw unprocessable("Agent integration must belong to same organization");
  }

  async function assertSecretInOrg(orgId: string, secretId: string) {
    const secret = await secrets.getById(secretId);
    if (!secret) throw notFound("Integration credential secret not found");
    if (secret.orgId !== orgId) {
      throw unprocessable("Integration credential secret must belong to same organization");
    }
  }

  return {
    listForAgent: (orgId: string, agentId: string) =>
      db
        .select()
        .from(agentIntegrations)
        .where(and(eq(agentIntegrations.orgId, orgId), eq(agentIntegrations.agentId, agentId)))
        .orderBy(desc(agentIntegrations.updatedAt))
        .then((rows) => rows.map(summarizeAgentIntegration)),

    getAgentProvider: (orgId: string, agentId: string, provider: CreateAgentIntegration["provider"]) =>
      db
        .select()
        .from(agentIntegrations)
        .where(
          and(
            eq(agentIntegrations.orgId, orgId),
            eq(agentIntegrations.agentId, agentId),
            eq(agentIntegrations.provider, provider),
          ),
        )
        .then((rows) => rows[0] ?? null),

    create: async (orgId: string, input: CreateAgentIntegration) => {
      const parsed = createAgentIntegrationSchema.parse(input);
      await assertAgentInOrg(orgId, parsed.agentId);
      await assertSecretInOrg(orgId, parsed.appCredentialSecretId);

      const existing = await db
        .select()
        .from(agentIntegrations)
        .where(
          and(
            eq(agentIntegrations.orgId, orgId),
            eq(agentIntegrations.agentId, parsed.agentId),
            eq(agentIntegrations.provider, parsed.provider),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (existing && existing.status === "active") {
        throw conflict("Agent already has an active integration for this provider");
      }

      return db
        .insert(agentIntegrations)
        .values({
          orgId,
          agentId: parsed.agentId,
          provider: parsed.provider,
          transport: parsed.transport,
          providerRegion: parsed.providerRegion,
          appCredentialSecretId: parsed.appCredentialSecretId,
          externalAppId: parsed.externalAppId,
          externalBotOpenId: parsed.externalBotOpenId ?? null,
          externalTenantKey: parsed.externalTenantKey ?? null,
          installerUserId: parsed.installerUserId ?? null,
          manageUrl: parsed.manageUrl ?? null,
        })
        .returning()
        .then((rows) => rows[0]);
    },

    revoke: async (orgId: string, integrationId: string) =>
      db
        .update(agentIntegrations)
        .set({
          status: "revoked",
          revokedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(agentIntegrations.orgId, orgId), eq(agentIntegrations.id, integrationId)))
        .returning()
        .then((rows) => rows[0] ?? null),

    revokeForAgent: async (orgId: string, agentId: string, integrationId: string) =>
      db
        .update(agentIntegrations)
        .set({
          status: "revoked",
          revokedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentIntegrations.orgId, orgId),
            eq(agentIntegrations.agentId, agentId),
            eq(agentIntegrations.id, integrationId),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}
