import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { issues } from "./issues.js";
import { documents } from "./documents.js";

export const issueDocuments = pgTable(
  "issue_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueKeyUq: uniqueIndex("issue_documents_company_issue_key_uq").on(
      table.orgId,
      table.issueId,
      table.key,
    ),
    documentUq: uniqueIndex("issue_documents_document_uq").on(table.documentId),
    companyIssueUpdatedIdx: index("issue_documents_company_issue_updated_idx").on(
      table.orgId,
      table.issueId,
      table.updatedAt,
    ),
  }),
);
