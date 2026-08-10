#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDirectory, "..");
const journalPath = "packages/db/src/migrations/meta/_journal.json";
const migrationsPath = "packages/db/src/migrations";

export const migrationCompatibilityMatrix = {
  "0.7.2": {
    candidateFingerprint: "3981cf5823990285da190cc2ad8172e85683d79e1790c2b582c3a0d614ec84e8",
    fixtures: [
      {
        version: "0.7.1",
        ref: "v0.7.1",
        fingerprint: "a30e16cfafac9884e9239af03f0c9c4200b958f0ae0c14f31a5b5198f65a9444",
      },
      {
        version: "0.7.0",
        ref: "v0.7.0",
        fingerprint: "2efffbc9abd94c1a29818e11086119978c9385cf250e44c42eb4901083307fc6",
      },
      {
        version: "0.6.5",
        ref: "v0.6.5",
        fingerprint: "0328b4ffb5dcc557b50072e449ee2d5ab8b8770b24010e664f9ae86ecd86366b",
      },
    ],
  },
};

function fail(message) {
  throw new Error(`Migration compatibility preflight failed: ${message}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeSqlLineEndings(sql) {
  return sql.replace(/\r\n?/g, "\n");
}

function parseJournal(raw, label) {
  let journal;
  try {
    journal = JSON.parse(raw);
  } catch (error) {
    fail(`${label} migration journal is not valid JSON: ${error.message}`);
  }

  if (journal?.dialect !== "postgresql") {
    fail(`${label} migration journal must use the postgresql dialect.`);
  }
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    fail(`${label} migration journal must contain at least one entry.`);
  }

  const seenTags = new Set();
  const entries = journal.entries.map((entry, position) => {
    if (!Number.isInteger(entry?.idx) || entry.idx !== position) {
      fail(`${label} migration journal entry ${position} must have idx ${position}.`);
    }
    if (typeof entry.version !== "string" || entry.version.length === 0) {
      fail(`${label} migration journal entry ${position} has no version.`);
    }
    if (!Number.isSafeInteger(entry.when) || entry.when <= 0) {
      fail(`${label} migration journal entry ${position} has an invalid timestamp.`);
    }
    if (typeof entry.tag !== "string" || !/^\d{4}_[a-z0-9_]+$/.test(entry.tag)) {
      fail(`${label} migration journal entry ${position} has an invalid tag.`);
    }
    if (seenTags.has(entry.tag)) {
      fail(`${label} migration journal repeats tag ${entry.tag}.`);
    }
    seenTags.add(entry.tag);
    if (typeof entry.breakpoints !== "boolean") {
      fail(`${label} migration journal entry ${position} has no breakpoints flag.`);
    }

    return {
      idx: entry.idx,
      version: entry.version,
      when: entry.when,
      tag: entry.tag,
      breakpoints: entry.breakpoints,
    };
  });

  return {
    version: String(journal.version),
    dialect: journal.dialect,
    entries,
  };
}

export function buildMigrationManifest({ journalRaw, listSqlFiles, readSqlFile, label }) {
  const journal = parseJournal(journalRaw, label);
  const sqlFileNames = (listSqlFiles?.() ?? journal.entries.map((entry) => `${entry.tag}.sql`))
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();
  if (new Set(sqlFileNames).size !== sqlFileNames.length) {
    fail(`${label} fixture contains duplicate migration SQL file names.`);
  }
  const sqlFiles = sqlFileNames.map((fileName) => {
    let sql;
    try {
      sql = readSqlFile(fileName);
    } catch (error) {
      fail(`${label} fixture is missing ${fileName}: ${error.message}`);
    }
    if (typeof sql !== "string" || sql.trim().length === 0) {
      fail(`${label} fixture has an empty ${fileName}.`);
    }
    return { fileName, fingerprint: sha256(normalizeSqlLineEndings(sql)) };
  });
  const fingerprintByFileName = new Map(
    sqlFiles.map((file) => [file.fileName, file.fingerprint]),
  );
  const entries = journal.entries.map((entry) => {
    const sqlFingerprint = fingerprintByFileName.get(`${entry.tag}.sql`);
    if (!sqlFingerprint) fail(`${label} fixture is missing ${entry.tag}.sql.`);
    return { ...entry, sqlFingerprint };
  });

  const fingerprint = sha256(JSON.stringify({
    version: journal.version,
    dialect: journal.dialect,
    entries,
    sqlFiles,
  }));

  return { ...journal, entries, sqlFiles, fingerprint };
}

function readCandidateManifest(repoRoot) {
  return buildMigrationManifest({
    label: "candidate",
    journalRaw: readFileSync(join(repoRoot, journalPath), "utf8"),
    listSqlFiles: () => readdirSync(join(repoRoot, migrationsPath)),
    readSqlFile: (fileName) => readFileSync(join(repoRoot, migrationsPath, fileName), "utf8"),
  });
}

function listGitMigrationSqlFiles(repoRoot, ref) {
  const output = execFileSync(
    "git",
    ["-C", repoRoot, "ls-tree", "-r", "--name-only", ref, "--", migrationsPath],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const prefix = `${migrationsPath}/`;
  return output
    .split("\n")
    .filter((path) => path.startsWith(prefix) && path.endsWith(".sql"))
    .map((path) => path.slice(prefix.length))
    .filter((fileName) => !fileName.includes("/"));
}

function readGitFiles(repoRoot, ref, paths) {
  const specs = paths.map((path) => `${ref}:${path}`);
  const output = execFileSync("git", ["-C", repoRoot, "cat-file", "--batch"], {
    input: `${specs.join("\n")}\n`,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const files = new Map();
  let offset = 0;

  for (let index = 0; index < specs.length; index += 1) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd < 0) fail(`fixture ${ref} returned an incomplete git object header.`);
    const header = output.subarray(offset, headerEnd).toString("utf8");
    if (header.endsWith(" missing")) fail(`fixture ${ref} is missing ${paths[index]}.`);

    const parts = header.split(" ");
    const objectType = parts.at(-2);
    const size = Number(parts.at(-1));
    if (objectType !== "blob" || !Number.isSafeInteger(size) || size < 0) {
      fail(`fixture ${ref} returned an invalid git object for ${paths[index]}.`);
    }

    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= output.length) fail(`fixture ${ref} returned incomplete content for ${paths[index]}.`);
    files.set(paths[index], output.subarray(contentStart, contentEnd).toString("utf8"));
    offset = contentEnd + 1;
  }

  return files;
}

function readFixtureManifest(repoRoot, fixture) {
  try {
    execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", `${fixture.ref}^{commit}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    fail(`fixture ${fixture.version} is unavailable at ${fixture.ref}: ${error.stderr?.trim() || error.message}`);
  }

  try {
    const sqlFileNames = listGitMigrationSqlFiles(repoRoot, fixture.ref);
    const sqlPaths = sqlFileNames.map((fileName) => `${migrationsPath}/${fileName}`);
    const files = readGitFiles(repoRoot, fixture.ref, [journalPath, ...sqlPaths]);
    const journalRaw = files.get(journalPath);

    return buildMigrationManifest({
      label: `fixture ${fixture.version} (${fixture.ref})`,
      journalRaw,
      listSqlFiles: () => sqlFileNames,
      readSqlFile: (fileName) => files.get(`${migrationsPath}/${fileName}`),
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Migration compatibility preflight failed:")) {
      throw error;
    }
    fail(`fixture ${fixture.version} cannot read ${journalPath} at ${fixture.ref}: ${error.stderr?.trim() || error.message}`);
  }
}

function assertFixturePrefix(candidate, fixtureManifest, fixture) {
  if (candidate.dialect !== fixtureManifest.dialect) {
    fail(`candidate dialect differs from fixture ${fixture.version}.`);
  }
  if (candidate.entries.length < fixtureManifest.entries.length) {
    fail(`candidate has fewer migrations than fixture ${fixture.version}.`);
  }

  for (let index = 0; index < fixtureManifest.entries.length; index += 1) {
    const candidateEntry = candidate.entries[index];
    const fixtureEntry = fixtureManifest.entries[index];
    if (JSON.stringify(candidateEntry) !== JSON.stringify(fixtureEntry)) {
      fail(
        `candidate rewrites migration ${fixtureEntry.tag} from fixture ${fixture.version}; `
        + "published migration history must remain immutable.",
      );
    }
  }

  const candidateSqlFiles = new Map(
    candidate.sqlFiles.map((file) => [file.fileName, file.fingerprint]),
  );
  for (const fixtureFile of fixtureManifest.sqlFiles) {
    if (candidateSqlFiles.get(fixtureFile.fileName) !== fixtureFile.fingerprint) {
      fail(
        `candidate rewrites migration file ${fixtureFile.fileName} from fixture ${fixture.version}; `
        + "published migration history must remain immutable.",
      );
    }
  }
}

function normalizeCandidateVersion(candidateVersion, channel) {
  const match = /^(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(candidateVersion);
  if (!match) fail(`candidate version ${candidateVersion} is not valid semver.`);

  const [, baseVersion, prerelease] = match;
  if (channel === "stable" && prerelease) {
    fail(`stable candidate ${candidateVersion} must not have a prerelease suffix.`);
  }
  if (channel === "canary" && !/^canary\.\d+$/.test(prerelease ?? "")) {
    fail(`canary candidate ${candidateVersion} must end in -canary.N.`);
  }
  return baseVersion;
}

function compareBaseVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

export function validateCompatibilityMatrix({
  candidateManifest,
  candidateVersion,
  channel,
  matrix = migrationCompatibilityMatrix,
  loadFixture,
}) {
  const baseVersion = normalizeCandidateVersion(candidateVersion, channel);
  const declaration = matrix[baseVersion];
  if (!declaration) {
    fail(
      `candidate ${candidateVersion} has no old-version matrix declaration. `
      + `Add an explicit ${baseVersion} entry before release.`,
    );
  }
  if (!/^[a-f0-9]{64}$/.test(declaration.candidateFingerprint)) {
    fail(`candidate ${baseVersion} has no valid migration manifest fingerprint declaration.`);
  }
  if (candidateManifest.fingerprint !== declaration.candidateFingerprint) {
    fail(
      `candidate migration fingerprint is ${candidateManifest.fingerprint}, `
      + `but ${baseVersion} declares ${declaration.candidateFingerprint}.`,
    );
  }
  if (!Array.isArray(declaration.fixtures) || declaration.fixtures.length === 0) {
    fail(`candidate ${baseVersion} must declare at least one old-version fixture.`);
  }

  const seenVersions = new Set();
  const verifiedFixtures = [];
  for (const fixture of declaration.fixtures) {
    if (typeof fixture?.version !== "string" || typeof fixture.ref !== "string") {
      fail(`candidate ${baseVersion} has an invalid fixture declaration.`);
    }
    if (!/^\d+\.\d+\.\d+$/.test(fixture.version)) {
      fail(`candidate ${baseVersion} has an invalid fixture version ${fixture.version}.`);
    }
    if (compareBaseVersions(baseVersion, fixture.version) <= 0) {
      fail(
        `candidate ${baseVersion} must be newer than fixture ${fixture.version}; `
        + "a release cannot reuse its own schema identity as an old-version fixture.",
      );
    }
    if (seenVersions.has(fixture.version)) {
      fail(`candidate ${baseVersion} declares fixture ${fixture.version} more than once.`);
    }
    seenVersions.add(fixture.version);
    if (!/^[a-f0-9]{64}$/.test(fixture.fingerprint)) {
      fail(`fixture ${fixture.version} has no valid migration fingerprint declaration.`);
    }

    const fixtureManifest = loadFixture(fixture);
    if (fixtureManifest.fingerprint !== fixture.fingerprint) {
      fail(
        `fixture ${fixture.version} fingerprint is ${fixtureManifest.fingerprint}, `
        + `but the matrix declares ${fixture.fingerprint}.`,
      );
    }
    assertFixturePrefix(candidateManifest, fixtureManifest, fixture);
    verifiedFixtures.push({
      version: fixture.version,
      ref: fixture.ref,
      migrations: fixtureManifest.entries.length,
      fingerprint: fixtureManifest.fingerprint,
    });
  }

  return {
    baseVersion,
    candidateVersion,
    channel,
    candidateMigrations: candidateManifest.entries.length,
    candidateSqlFiles: candidateManifest.sqlFiles.length,
    candidateFingerprint: candidateManifest.fingerprint,
    fixtures: verifiedFixtures,
  };
}

export function runCompatibilityPreflight({
  candidateVersion,
  channel,
  repoRoot = defaultRepoRoot,
  matrix = migrationCompatibilityMatrix,
}) {
  const normalizedRoot = resolve(repoRoot);
  const candidateManifest = readCandidateManifest(normalizedRoot);
  return validateCompatibilityMatrix({
    candidateManifest,
    candidateVersion,
    channel,
    matrix,
    loadFixture: (fixture) => readFixtureManifest(normalizedRoot, fixture),
  });
}

function parseArguments(argv) {
  const options = { candidateVersion: "", channel: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--candidate-version") {
      options.candidateVersion = argv[index + 1] ?? "";
      index += 1;
    } else if (argument === "--channel") {
      options.channel = argv[index + 1] ?? "";
      index += 1;
    } else {
      fail(`unexpected argument ${argument}.`);
    }
  }

  if (!options.candidateVersion) fail("--candidate-version is required.");
  if (!new Set(["canary", "stable"]).has(options.channel)) {
    fail("--channel must be canary or stable.");
  }
  return options;
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    const result = runCompatibilityPreflight(parseArguments(process.argv.slice(2)));
    process.stderr.write(
      `Verified migration compatibility for ${result.channel} ${result.candidateVersion}: `
      + `${result.candidateMigrations} journal entries, ${result.candidateSqlFiles} SQL files, `
      + `${result.fixtures.length} old-version fixtures, `
      + `fingerprint ${result.candidateFingerprint}.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
