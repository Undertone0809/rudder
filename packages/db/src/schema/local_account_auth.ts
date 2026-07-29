import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";

export const externalUserBindings = pgTable(
  "external_user_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    localUserId: text("local_user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issuerSubjectUniqueIdx: uniqueIndex("external_user_bindings_issuer_subject_uq").on(table.issuer, table.subject),
    localUserIdx: index("external_user_bindings_local_user_idx").on(table.localUserId),
  }),
);

export const installationAccountBindings = pgTable(
  "installation_account_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: text("installation_id").notNull(),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    localUserId: text("local_user_id").notNull().references(() => authUsers.id, { onDelete: "restrict" }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    installationUniqueIdx: uniqueIndex("installation_account_bindings_installation_uq").on(table.installationId),
    issuerSubjectIdx: index("installation_account_bindings_issuer_subject_idx").on(table.issuer, table.subject),
  }),
);

export const serverExchangeRedemptions = pgTable(
  "server_exchange_redemptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issuer: text("issuer").notNull(),
    jti: text("jti").notNull(),
    audience: text("audience").notNull(),
    subject: text("subject").notNull(),
    localUserId: text("local_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issuerJtiUniqueIdx: uniqueIndex("server_exchange_redemptions_issuer_jti_uq").on(table.issuer, table.jti),
    expiryIdx: index("server_exchange_redemptions_expiry_idx").on(table.expiresAt),
  }),
);
