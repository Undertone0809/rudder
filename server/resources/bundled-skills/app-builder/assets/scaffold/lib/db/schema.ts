import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const contacts = sqliteTable("contacts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  company: text("company").notNull().default(""),
  status: text("status", { enum: ["new", "contacted", "replied", "paused"] })
    .notNull()
    .default("new"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("contacts_email_uq").on(table.email),
]);

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  status: text("status", { enum: ["pending", "running", "completed", "failed", "missed"] })
    .notNull()
    .default("pending"),
  catchUpPolicy: text("catch_up_policy", { enum: ["run", "skip", "prompt"] })
    .notNull()
    .default("prompt"),
  scheduledFor: integer("scheduled_for", { mode: "timestamp_ms" }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("jobs_idempotency_key_uq").on(table.idempotencyKey),
]);
