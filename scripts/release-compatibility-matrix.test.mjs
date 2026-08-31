import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildMigrationManifest,
  migrationCompatibilityMatrix,
  runCompatibilityPreflight,
  validateCompatibilityMatrix,
} from "./release-compatibility-matrix.mjs";

function journal(entries) {
  return JSON.stringify({
    version: "7",
    dialect: "postgresql",
    entries: entries.map((tag, idx) => ({
      idx,
      version: "7",
      when: 1_700_000_000_000 + idx,
      tag,
      breakpoints: true,
    })),
  });
}

function manifest(tags, sqlByTag, label) {
  return buildMigrationManifest({
    label,
    journalRaw: journal(tags),
    readSqlFile: (fileName) => {
      const tag = fileName.replace(/\.sql$/u, "");
      const sql = sqlByTag[tag];
      if (!sql) throw new Error(`missing ${fileName}`);
      return sql;
    },
  });
}

describe("release migration compatibility matrix", () => {
  it("accepts the checked-in 0.7.16 candidate against immutable release fixtures", () => {
    const result = runCompatibilityPreflight({
      candidateVersion: "0.7.16",
      channel: "stable",
    });

    expect(result.candidateFingerprint).toBe(
      "085c15c2a32685dbbddd775ee6fe21aea4ff5c151193f1711ad8c1c52a04a0db",
    );
    expect(result.fixtures.map((fixture) => fixture.version)).toEqual([
      "0.7.15",
      "0.7.14",
      "0.7.13",
      "0.7.12",
      "0.7.11",
      "0.7.10",
      "0.7.9",
      "0.7.1",
      "0.7.0",
      "0.6.5",
    ]);
  }, 60_000);

  it("accepts the checked-in 0.7.15 candidate against immutable release fixtures", () => {
    const result = runCompatibilityPreflight({
      candidateVersion: "0.7.15",
      channel: "stable",
    });

    expect(result.candidateMigrations).toBe(163);
    expect(result.candidateSqlFiles).toBe(165);
    expect(result.fixtures.map((fixture) => fixture.version)).toEqual([
      "0.7.14",
      "0.7.13",
      "0.7.12",
      "0.7.11",
      "0.7.10",
      "0.7.9",
      "0.7.1",
      "0.7.0",
      "0.6.5",
    ]);
  }, 60_000);

  it("accepts the checked-in 0.7.14 candidate against immutable release fixtures", () => {
    const result = runCompatibilityPreflight({
      candidateVersion: "0.7.14",
      channel: "stable",
    });

    expect(result.candidateMigrations).toBe(163);
    expect(result.candidateSqlFiles).toBe(165);
    expect(result.fixtures.map((fixture) => fixture.version)).toEqual([
      "0.7.13",
      "0.7.12",
      "0.7.11",
      "0.7.10",
      "0.7.9",
      "0.7.1",
      "0.7.0",
      "0.6.5",
    ]);
  }, 60_000);

  it("accepts the checked-in 0.7.13 candidate against immutable release fixtures", () => {
    const result = runCompatibilityPreflight({
      candidateVersion: "0.7.13",
      channel: "stable",
    });

    expect(result.candidateMigrations).toBe(163);
    expect(result.candidateSqlFiles).toBe(165);
    expect(result.fixtures.map((fixture) => fixture.version)).toEqual([
      "0.7.12",
      "0.7.11",
      "0.7.10",
      "0.7.9",
      "0.7.1",
      "0.7.0",
      "0.6.5",
    ]);
  }, 60_000);

  it("retains the 0.7.11 compatibility declaration", () => {
    const declaration = migrationCompatibilityMatrix["0.7.11"];

    expect(declaration.candidateFingerprint).toBe(
      "d9d8397a27fbe3bfc48452d1b8bddabda45098666983db656f2119e59fa09cd0",
    );
    expect(declaration.fixtures.map((fixture) => fixture.version)).toEqual([
      "0.7.10",
      "0.7.9",
      "0.7.1",
      "0.7.0",
      "0.6.5",
    ]);
  });

  it("fails closed when a candidate version has no declared old-version matrix", () => {
    const candidate = manifest(["0000_base"], { "0000_base": "SELECT 1;" }, "candidate");

    expect(() => validateCompatibilityMatrix({
      candidateManifest: candidate,
      candidateVersion: "9.9.9",
      channel: "stable",
      matrix: {},
      loadFixture: () => {
        throw new Error("fixture loading must not start");
      },
    })).toThrow("has no old-version matrix declaration");
  });

  it("rejects a candidate that rewrites an old fixture migration", () => {
    const fixture = manifest(["0000_base"], { "0000_base": "SELECT 1;" }, "fixture");
    const candidate = manifest(
      ["0000_base", "0001_next"],
      { "0000_base": "SELECT 2;", "0001_next": "SELECT 3;" },
      "candidate",
    );
    const matrix = {
      "1.1.0": {
        candidateFingerprint: candidate.fingerprint,
        fixtures: [{
          version: "1.0.0",
          ref: "v1.0.0",
          fingerprint: fixture.fingerprint,
        }],
      },
    };

    expect(() => validateCompatibilityMatrix({
      candidateManifest: candidate,
      candidateVersion: "1.1.0",
      channel: "stable",
      matrix,
      loadFixture: () => fixture,
    })).toThrow("published migration history must remain immutable");
  });

  it("rejects same-version and newer-version fixtures", () => {
    const fixture = manifest(["0000_base"], { "0000_base": "SELECT 1;" }, "fixture");
    const candidate = manifest(
      ["0000_base", "0001_next"],
      { "0000_base": "SELECT 1;", "0001_next": "SELECT 2;" },
      "candidate",
    );

    for (const fixtureVersion of ["1.1.0", "1.2.0"]) {
      expect(() => validateCompatibilityMatrix({
        candidateManifest: candidate,
        candidateVersion: "1.1.0",
        channel: "stable",
        matrix: {
          "1.1.0": {
            candidateFingerprint: candidate.fingerprint,
            fixtures: [{ version: fixtureVersion, ref: `v${fixtureVersion}`, fingerprint: fixture.fingerprint }],
          },
        },
        loadFixture: () => fixture,
      })).toThrow(`must be newer than fixture ${fixtureVersion}`);
    }
  });

  it("fingerprints compatibility SQL files that are intentionally outside the journal", () => {
    const fixture = buildMigrationManifest({
      label: "fixture",
      journalRaw: journal(["0000_base"]),
      listSqlFiles: () => ["0000_base.sql", "0055_legacy_compat.sql"],
      readSqlFile: (fileName) => ({
        "0000_base.sql": "SELECT 1;",
        "0055_legacy_compat.sql": "SELECT 2;",
      })[fileName],
    });
    const candidate = buildMigrationManifest({
      label: "candidate",
      journalRaw: journal(["0000_base"]),
      listSqlFiles: () => ["0000_base.sql", "0055_legacy_compat.sql"],
      readSqlFile: (fileName) => ({
        "0000_base.sql": "SELECT 1;",
        "0055_legacy_compat.sql": "SELECT 3;",
      })[fileName],
    });

    expect(() => validateCompatibilityMatrix({
      candidateManifest: candidate,
      candidateVersion: "1.1.0",
      channel: "stable",
      matrix: {
        "1.1.0": {
          candidateFingerprint: candidate.fingerprint,
          fixtures: [{
            version: "1.0.0",
            ref: "v1.0.0",
            fingerprint: fixture.fingerprint,
          }],
        },
      },
      loadFixture: () => fixture,
    })).toThrow("rewrites migration file 0055_legacy_compat.sql");
  });

  it("exits nonzero before release work when the CLI matrix declaration is missing", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/release-compatibility-matrix.mjs",
        "--channel",
        "stable",
        "--candidate-version",
        "9.9.9",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("has no old-version matrix declaration");
  });
});
