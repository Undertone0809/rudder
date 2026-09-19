import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMigrationManifest,
  validateMigrationManifestCompatibility,
  validateMigrationManifestIntegrity,
  type MigrationManifest,
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

  it("rejects journals from an unsupported version", async () => {
    const fixture = createFixture([
      { tag: "0000_first", sql: "CREATE TABLE first_table (id integer);" },
    ]);
    const journal = JSON.parse(readFileSync(fixture.journalFile, "utf8")) as Record<string, unknown>;
    journal.version = "6";
    writeFileSync(fixture.journalFile, JSON.stringify(journal), "utf8");

    await expect(createMigrationManifest(fixture)).rejects.toThrow("version 7");
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
      errors: ["Candidate changed published journal migration 0000_first.sql"],
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

  it("uses a locale-independent canonical file order", async () => {
    const fixture = createFixture([
      { tag: "a_foo", sql: "SELECT underscore;" },
      { tag: "a-foo", sql: "SELECT hyphen;" },
    ]);

    const manifest = await createMigrationManifest(fixture);

    expect(manifest.canonical.sqlFiles.map((entry) => entry.fileName)).toEqual([
      "a-foo.sql",
      "a_foo.sql",
    ]);
  });

  it("keeps legacy SQL outside the journal prefix for append compatibility", async () => {
    const baselineFixture = createFixture([
      { tag: "0000_first", sql: "CREATE TABLE first_table (id integer);" },
      { tag: "0001_second", sql: "CREATE TABLE second_table (id integer);" },
    ]);
    const appendedFixture = createFixture([
      { tag: "0000_first", sql: "CREATE TABLE first_table (id integer);" },
      { tag: "0001_second", sql: "CREATE TABLE second_table (id integer);" },
      { tag: "0002_third", sql: "CREATE TABLE third_table (id integer);" },
    ]);
    for (const fixture of [baselineFixture, appendedFixture]) {
      writeFileSync(
        path.join(fixture.migrationsFolder, "0055_illegal_sheva_callister.sql"),
        "SELECT legacy;",
        "utf8",
      );
    }

    const baseline = await createMigrationManifest(baselineFixture);
    const appended = await createMigrationManifest(appendedFixture);

    expect(validateMigrationManifestCompatibility(baseline, appended)).toMatchObject({
      valid: true,
      errors: [],
      addedEntries: [{ order: 2, fileName: "0002_third.sql" }],
    });
  });

  it("rejects a newly introduced allowlisted legacy migration", async () => {
    const baselineFixture = createFixture([
      { tag: "0000_first", sql: "CREATE TABLE first_table (id integer);" },
    ]);
    const candidateFixture = createFixture([
      { tag: "0000_first", sql: "CREATE TABLE first_table (id integer);" },
    ]);
    writeFileSync(
      path.join(candidateFixture.migrationsFolder, "0055_illegal_sheva_callister.sql"),
      "SELECT legacy;",
      "utf8",
    );

    const baseline = await createMigrationManifest(baselineFixture);
    const candidate = await createMigrationManifest(candidateFixture);
    const validation = validateMigrationManifestCompatibility(baseline, candidate);

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain("Candidate added 1 unpublished legacy migration(s)");
  });

  it("binds canonical entries and SQL files to the flattened manifest", async () => {
    const fixture = createFixture([
      { tag: "0000_first", sql: "CREATE TABLE first_table (id integer);" },
    ]);
    const manifest = await createMigrationManifest(fixture);
    const canonical = {
      ...manifest.canonical,
      sqlFiles: manifest.canonical.sqlFiles.map((entry, index) =>
        index === 0 ? { ...entry, fingerprint: "0".repeat(64) } : entry,
      ),
    };
    const forged = {
      ...manifest,
      canonical,
      fingerprint: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
    } as typeof manifest;

    const validation = validateMigrationManifestIntegrity(forged);

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain(
      "Migration manifest canonical SQL file 0 is not bound to entries",
    );
  });

  it("rejects a canonical journal prefix that does not cover flattened entries", async () => {
    const fixture = createFixture([
      { tag: "0000_first", sql: "CREATE TABLE first_table (id integer);" },
      { tag: "0001_second", sql: "CREATE TABLE second_table (id integer);" },
    ]);
    const manifest = await createMigrationManifest(fixture);
    const canonical = {
      ...manifest.canonical,
      entries: manifest.canonical.entries.slice(0, -1),
    };
    const forged = {
      ...manifest,
      canonical,
      fingerprint: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
    } as MigrationManifest;

    const validation = validateMigrationManifestIntegrity(forged);

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain(
      "Migration manifest canonical journal entry list does not match entries",
    );
  });

  it("returns invalid for malformed manifest shapes instead of throwing", async () => {
    const fixture = createFixture([
      { tag: "0000_first", sql: "CREATE TABLE first_table (id integer);" },
    ]);
    const manifest = await createMigrationManifest(fixture);
    const missingCanonical = { ...manifest, canonical: undefined } as unknown as MigrationManifest;
    const nullVersion = {
      ...manifest,
      canonical: { ...manifest.canonical, version: null },
    } as unknown as MigrationManifest;

    expect(() => validateMigrationManifestIntegrity(missingCanonical)).not.toThrow();
    expect(validateMigrationManifestIntegrity(missingCanonical).valid).toBe(false);
    expect(() => validateMigrationManifestIntegrity(nullVersion)).not.toThrow();
    expect(validateMigrationManifestIntegrity(nullVersion).valid).toBe(false);
  });
});
