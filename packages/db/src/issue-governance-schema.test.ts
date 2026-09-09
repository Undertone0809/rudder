import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { createMigrationManifest, validateMigrationManifestIntegrity } from "./migration-manifest.js";
import * as schema from "./schema/index.js";

function columns(table: PgTable): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

function indexNames(table: PgTable): string[] {
  return getTableConfig(table).indexes
    .map((index) => index.config.name)
    .filter((name): name is string => name !== undefined);
}

describe("issue governance schema contract", () => {
  it("persists issue checkout revision and lease state without changing legacy fields", () => {
    expect(columns(schema.issues)).toEqual(expect.arrayContaining([
      "revision",
      "fencing_token",
      "checkout_run_id",
      "checkout_lease_owner",
      "checkout_lease_expires_at",
    ]));
    expect(columns(schema.issues)).toContain("execution_run_id");

    const issueConfig = getTableConfig(schema.issues);
    expect(issueConfig.columns.find((column) => column.name === "revision")?.notNull).toBe(true);
    expect(issueConfig.columns.find((column) => column.name === "fencing_token")?.notNull).toBe(true);
    expect(issueConfig.columns.find((column) => column.name === "checkout_lease_owner")?.notNull).toBe(false);
    expect(issueConfig.columns.find((column) => column.name === "checkout_lease_expires_at")?.notNull).toBe(false);
    expect(indexNames(schema.issues)).toEqual(expect.arrayContaining([
      "issues_org_id_id_uq",
      "issues_org_checkout_lease_idx",
    ]));
  });

  it("persists approval revisions and nullable decision idempotency for legacy pending rows", () => {
    expect(columns(schema.approvals)).toEqual(expect.arrayContaining([
      "revision",
      "decision",
      "decision_idempotency_key",
    ]));

    const approvalConfig = getTableConfig(schema.approvals);
    expect(approvalConfig.columns.find((column) => column.name === "revision")?.notNull).toBe(true);
    expect(approvalConfig.columns.find((column) => column.name === "decision")?.notNull).toBe(false);
    expect(approvalConfig.columns.find((column) => column.name === "decision_idempotency_key")?.notNull).toBe(false);
    expect(indexNames(schema.approvals)).toEqual(expect.arrayContaining([
      "approvals_org_id_id_uq",
      "approvals_org_decision_idempotency_uq",
    ]));
  });

  it("fences the mutation ledger by organization and deduplicates command receipts", () => {
    const table = schema.issueMutationCommands;
    expect(getTableConfig(table).name).toBe("issue_mutation_commands");
    expect(columns(table)).toEqual(expect.arrayContaining([
      "org_id",
      "issue_id",
      "approval_id",
      "command_type",
      "idempotency_key",
      "command_fingerprint",
      "outcome",
      "activity_id",
      "created_at",
    ]));
    expect(indexNames(table)).toEqual(expect.arrayContaining([
      "issue_mutation_commands_org_idempotency_uq",
      "issue_mutation_commands_org_created_idx",
      "issue_mutation_commands_approval_created_idx",
    ]));
    const foreignKeyPairs = getTableConfig(table).foreignKeys.map((foreignKey) => {
      const reference = foreignKey.reference();
      return `${reference.columns.map((column) => column.name).join(",")}=>${reference.foreignColumns.map((column) => column.name).join(",")}`;
    });
    expect(foreignKeyPairs).toEqual(expect.arrayContaining([
      "org_id,issue_id=>org_id,id",
      "org_id,approval_id=>org_id,id",
      "org_id,activity_id=>org_id,id",
    ]));
  });

  it("keeps the generated migration append-only and represented in the journal manifest", async () => {
    const migrationsFolder = fileURLToPath(new URL("./migrations/", import.meta.url));
    const journalFile = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));
    const journal = JSON.parse(readFileSync(journalFile, "utf8")) as {
      entries: Array<{ idx: number; tag: string; version: string; breakpoints: boolean }>;
    };
    const latest = journal.entries.at(-1);
    expect(latest).toMatchObject({
      idx: 163,
      tag: "0163_issue_governance_mutations",
      version: "7",
      breakpoints: true,
    });
    expect(journal.entries[162]).toMatchObject({
      idx: 162,
      tag: "0162_run_debug_issue_origin",
    });

    const sql = readFileSync(
      fileURLToPath(new URL("./migrations/0163_issue_governance_mutations.sql", import.meta.url)),
      "utf8",
    );
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "issue_mutation_commands"');
    expect(sql).toMatch(/FOREIGN KEY \("org_id", "issue_id"\)[\s\S]*REFERENCES "public"\."issues"\("org_id", "id"\)/);
    expect(sql).toMatch(/FOREIGN KEY \("org_id", "approval_id"\)[\s\S]*REFERENCES "public"\."approvals"\("org_id", "id"\)/);
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "issue_mutation_commands_org_idempotency_uq"');

    const manifest = await createMigrationManifest({ migrationsFolder, journalFile });
    expect(validateMigrationManifestIntegrity(manifest)).toMatchObject({ valid: true, errors: [] });
    expect(manifest.entries).toContainEqual(expect.objectContaining({
      order: 163,
      fileName: "0163_issue_governance_mutations.sql",
    }));
  });
});
