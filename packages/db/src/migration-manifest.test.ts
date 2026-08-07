import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMigrationManifest,
  validateMigrationManifestCompatibility,
  validateMigrationManifestIntegrity,
} from "./migration-manifest.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createFixture(entries: Array<{ tag: string; sql: string }>): {
  journalFile: string;
  migrationsFolder: string;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), "rudder-migration-manifest-"));
  tempRoots.push(root);
  const migrationsFolder = path.join(root, "migrations");
  const metaFolder = path.join(migrationsFolder, "meta");
  mkdirSync(metaFolder, { recursive: true });

  entries.forEach((entry, index) => {
    writeFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), entry.sql, "utf8");
  });
  const journalFile = path.join(metaFolder, "_journal.json");
  writeFileSync(
    journalFile,
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: entries.map((entry, index) => ({
        idx: index,
        version: "7",
        when: 1000 + index,
        tag: entry.tag,
        breakpoints: true,
      })),
    }),
    "utf8",
  );
  return { journalFile, migrationsFolder };
}

describe("migration manifest", () => {
  it("builds a stable fingerprint from journal order, file names, and SQL hashes", async () => {
    const first = createFixture([
      { tag: "0000_first", sql: "CREATE TABLE first_table (id integer);" },
      { tag: "0001_second", sql: "CREATE TABLE second_table (id integer);" },
    ]);
    const second = createFixture([
      { tag: "0000_first", sql: "CREATE TABLE first_table (id integer);" },
      { tag: "0001_second", sql: "CREATE TABLE second_table (id integer);" },
    ]);

    const firstManifest = await createMigrationManifest(first);
    const secondManifest = await createMigrationManifest(second);

    expect(firstManifest.fingerprint).toBe(secondManifest.fingerprint);
    expect(validateMigrationManifestIntegrity(firstManifest)).toMatchObject({ valid: true, errors: [] });
    expect(Object.isFrozen(firstManifest)).toBe(true);
    expect(Object.isFrozen(firstManifest.entries)).toBe(true);
  });

  it("allows appended migrations and rejects edits to a published prefix", async () => {
    const baselineFixture = createFixture([
      { tag: "0000_first", sql: "CREATE TABLE first_table (id integer);" },
      { tag: "0001_second", sql: "CREATE TABLE second_table (id integer);" },
    ]);
    const appendedFixture = createFixture([
      { tag: "0000_first", sql: "CREATE TABLE first_table (id integer);" },
      { tag: "0001_second", sql: "CREATE TABLE second_table (id integer);" },
      { tag: "0002_third", sql: "CREATE TABLE third_table (id integer);" },
    ]);
    const editedFixture = createFixture([
      { tag: "0000_first", sql: "CREATE TABLE first_table (id bigint);" },
      { tag: "0001_second", sql: "CREATE TABLE second_table (id integer);" },
      { tag: "0002_third", sql: "CREATE TABLE third_table (id integer);" },
    ]);

    const baseline = await createMigrationManifest(baselineFixture);
    const appended = await createMigrationManifest(appendedFixture);
    const edited = await createMigrationManifest(editedFixture);

    expect(validateMigrationManifestCompatibility(baseline, appended)).toMatchObject({
      valid: true,
      errors: [],
      addedEntries: [{ order: 2, fileName: "0002_third.sql" }],
    });
    expect(validateMigrationManifestCompatibility(baseline, edited)).toMatchObject({
      valid: false,
      errors: ["Candidate changed published migration 0000_first.sql"],
    });
  });

  it("rejects SQL files that are not represented in the journal", async () => {
    const fixture = createFixture([
      { tag: "0000_first", sql: "CREATE TABLE first_table (id integer);" },
    ]);
    writeFileSync(
      path.join(fixture.migrationsFolder, "0001_unjournaled.sql"),
      "CREATE TABLE unjournaled (id integer);",
      "utf8",
    );

    await expect(createMigrationManifest(fixture)).rejects.toThrow(
      "Migration SQL files are missing from the journal: 0001_unjournaled.sql",
    );
  });
});
