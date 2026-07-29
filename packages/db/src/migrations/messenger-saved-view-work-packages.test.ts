import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = fs.readFileSync(
  new URL("./0109_many_carmella_unuscione.sql", import.meta.url),
  "utf8",
);
const mutationLedgerMigration = fs.readFileSync(
  new URL("./0110_supreme_mathemanic.sql", import.meta.url),
  "utf8",
);
const migrationsDirectory = new URL(".", import.meta.url);
const loosePlacementMigrationName = fs.readdirSync(migrationsDirectory)
  .find((name) => /^0117_.*\.sql$/.test(name));
const loosePlacementMigration = loosePlacementMigrationName
  ? fs.readFileSync(path.join(migrationsDirectory.pathname, loosePlacementMigrationName), "utf8")
  : "";

describe("Messenger Saved View work-package migration", () => {
  it("backfills multi-instance identity without rewriting compatibility resource keys", () => {
    expect(migration).toContain('"instance_id" = "id"::text');
    expect(migration).toContain('"canonical_resource_key" = "resource_key"');
    expect(migration).toContain("jsonb_build_object('viewInstanceId', \"id\"::text)");
    expect(migration).toContain('"hidden_at" = NULL');
    expect(migration).toContain('ALTER COLUMN "instance_id" SET NOT NULL');
    expect(migration).toContain('messenger_saved_views_org_user_instance_uq');
    expect(migration).toContain('messenger_saved_views_org_user_client_mutation_uq');
    expect(migration).not.toContain('SET "resource_key"');
  });

  it("recovers only owner-matched loose Saved Views into one ordered group per owner", () => {
    expect(migration).toContain("'Recovered items'");
    expect(migration).toContain('PARTITION BY "saved_view"."org_id", "saved_view"."user_id"');
    expect(migration).toContain('"entry"."org_id" = "saved_view"."org_id"');
    expect(migration).toContain('"entry"."user_id" = "saved_view"."user_id"');
    expect(migration).toContain('INNER JOIN "created_groups" "group"');
    expect(migration).toContain("'saved-view:' || \"saved_view\".\"id\"::text");
  });

  it("persists owner-scoped mutation receipts independently of Saved View lifecycle", () => {
    expect(mutationLedgerMigration).toContain('CREATE TABLE "messenger_saved_view_mutations"');
    expect(mutationLedgerMigration).toContain('"request_fingerprint" text NOT NULL');
    expect(mutationLedgerMigration).toContain('messenger_saved_view_mutations_org_user_mutation_uq');
    expect(mutationLedgerMigration).not.toContain('FOREIGN KEY ("saved_view_id")');
    expect(mutationLedgerMigration).not.toContain('FOREIGN KEY ("group_id")');
  });

  it("allows loose Keep receipts to persist without a custom group", () => {
    expect(loosePlacementMigrationName).toBeDefined();
    expect(loosePlacementMigration).toContain(
      'ALTER TABLE "messenger_saved_view_mutations" ALTER COLUMN "group_id" DROP NOT NULL',
    );
  });
});
