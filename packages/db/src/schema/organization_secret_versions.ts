import { pgTable, uuid, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { organizationSecrets } from "./organization_secrets.js";

export const organizationSecretVersions = pgTable(
  "organization_secret_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    secretId: uuid("secret_id").notNull().references(() => organizationSecrets.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    material: jsonb("material").$type<Record<string, unknown>>().notNull(),
    valueSha256: text("value_sha256").notNull(),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    secretIdx: index("organization_secret_versions_secret_idx").on(table.secretId, table.createdAt),
    valueHashIdx: index("organization_secret_versions_value_sha256_idx").on(table.valueSha256),
    secretVersionUq: uniqueIndex("organization_secret_versions_secret_version_uq").on(table.secretId, table.version),
  }),
);
