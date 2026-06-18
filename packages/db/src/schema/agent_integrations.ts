import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { organizationSecrets } from "./organization_secrets.js";
import { organizations } from "./organizations.js";

export const agentIntegrations = pgTable(
  "agent_integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    status: text("status").notNull().default("active"),
    transport: text("transport").notNull().default("long_connection"),
    providerRegion: text("provider_region").notNull().default("feishu_cn"),
    appCredentialSecretId: uuid("app_credential_secret_id")
      .notNull()
      .references(() => organizationSecrets.id, { onDelete: "restrict" }),
    externalAppId: text("external_app_id").notNull(),
    externalBotOpenId: text("external_bot_open_id"),
    externalTenantKey: text("external_tenant_key"),
    installerUserId: text("installer_user_id"),
    manageUrl: text("manage_url"),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgProviderIdx: index("agent_integrations_org_provider_idx").on(table.orgId, table.provider),
    agentProviderUq: uniqueIndex("agent_integrations_org_agent_provider_uq").on(
      table.orgId,
      table.agentId,
      table.provider,
    ),
    externalAppUq: uniqueIndex("agent_integrations_org_provider_external_app_uq").on(
      table.orgId,
      table.provider,
      table.externalAppId,
    ),
    secretIdx: index("agent_integrations_secret_idx").on(table.appCredentialSecretId),
  }),
);
