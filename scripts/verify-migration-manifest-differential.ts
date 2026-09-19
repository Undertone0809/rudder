import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createMigrationManifest,
  validateMigrationManifestCompatibility,
  type MigrationManifest,
} from "../packages/db/src/migration-manifest.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rustManifest = path.join(repoRoot, "native/Cargo.toml");
const rustTargetDir = path.join(repoRoot, "native", "target", "migration-differential");
const rustBinary = path.join(
  rustTargetDir,
  "debug",
  process.platform === "win32"
    ? "migration-manifest-differential.exe"
    : "migration-manifest-differential",
);
const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const schema = "rudder.migration-manifest.differential/v1";
const protocolVersion = 1;
const legacyFileNames = [
  "0055_illegal_sheva_callister.sql",
  "0128_modern_jetstream.sql",
] as const;
const noDatabaseUrl = "postgres://127.0.0.1:1/migration-differential-must-not-connect";
const temporaryRoots: string[] = [];

type Fixture = {
  root: string;
  migrationsFolder: string;
  journalFile: string;
};

type FixtureEntry = {
  tag: string;
  sql: string | Uint8Array;
};

type SourceSpec = {
  migrationsDir: string;
  journalFile?: string;
  limits?: {
    maxJournalBytes?: number;
    maxSqlFileBytes?: number;
    maxTotalSqlBytes?: number;
    maxSqlFiles?: number;
    maxDirectoryEntries?: number;
  };
};

type JournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};

type OrderedEntry = {
  order: number;
  fileName: string;
  sha256: string;
  byteSize: number;
  journalEntry: JournalEntry | null;
};

type ManifestProjection = {
  version: number;
  fingerprint: string;
  canonical: MigrationManifest["canonical"];
  entries: OrderedEntry[];
  legacyTail: OrderedEntry[];
};

type SourceResponse = {
  status: "ok" | "error";
  manifest?: ManifestProjection;
  error?: {
    classification: string;
    code: string;
    message: string;
    path?: string;
  };
};

type DifferentialResponse = {
  schema: string;
  protocolVersion: number;
  status: "ok" | "error" | "protocol_error";
  baseline?: SourceResponse;
  candidate?: SourceResponse;
  compatibility?: {
    classification: string;
    valid: boolean;
    compatible: boolean;
    addedEntries: OrderedEntry[];
    errors: string[];
  };
  error?: {
    classification: string;
    code: string;
    message: string;
  };
};

type RustRun = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function createFixture(entries: readonly FixtureEntry[], legacy: readonly FixtureEntry[] = []): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "rudder-migration-differential-"));
  temporaryRoots.push(root);
  const migrationsFolder = path.join(root, "migrations");
  const metaFolder = path.join(migrationsFolder, "meta");
  mkdirSync(metaFolder, { recursive: true });
  for (const entry of [...entries, ...legacy]) {
    writeFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), entry.sql);
  }
  const journalFile = path.join(metaFolder, "_journal.json");
  writeFileSync(
    journalFile,
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: entries.map((entry, idx) => ({
        idx,
        version: "7",
        when: 1000 + idx,
        tag: entry.tag,
        breakpoints: true,
      })),
    }),
  );
  return { root, migrationsFolder, journalFile };
}

function sourceSpec(fixture: Fixture, overrides: Partial<SourceSpec> = {}): SourceSpec {
  return {
    migrationsDir: fixture.migrationsFolder,
    journalFile: fixture.journalFile,
    ...overrides,
  };
}

function nodeOptions(fixture: Fixture) {
  return {
    migrationsFolder: fixture.migrationsFolder,
    journalFile: fixture.journalFile,
  };
}

type FixtureJournal = {
  version: string;
  dialect: string;
  entries: JournalEntry[];
};

function updateJournal(fixture: Fixture, update: (journal: FixtureJournal) => void): void {
  const journal = JSON.parse(readFileSync(fixture.journalFile, "utf8")) as FixtureJournal;
  update(journal);
  writeFileSync(fixture.journalFile, JSON.stringify(journal));
}

async function assertNodeRejects(
  fixture: Fixture,
  label: string,
  expected: RegExp | { code?: string },
): Promise<void> {
  await assert.rejects(createMigrationManifest(nodeOptions(fixture)), expected, label);
}

function spawnProcess(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<RustRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
    child.stdin.end();
  });
}

async function buildRustBinary(): Promise<void> {
  const build = await spawnProcess(
    "cargo",
    [
      "build",
      "--quiet",
      "--locked",
      "--manifest-path",
      rustManifest,
      "--package",
      "rudder-migration-core",
      "--bin",
      "migration-manifest-differential",
      "--target-dir",
      rustTargetDir,
    ],
    { ...process.env, CARGO_TARGET_DIR: rustTargetDir, DATABASE_URL: noDatabaseUrl },
  );
  if (build.exitCode !== 0) {
    throw new Error(`Rust differential binary build failed:\n${build.stderr || build.stdout}`);
  }
  assert.equal(build.signal, null);
  assert.equal(existsSync(rustBinary), true, "cargo build did not produce the differential binary");
}

async function buildDbPackage(): Promise<void> {
  const build = await spawnProcess(
    packageManager,
    ["--filter", "@rudderhq/db", "build"],
    { ...process.env, DATABASE_URL: noDatabaseUrl },
  );
  if (build.exitCode !== 0) {
    throw new Error(`DB package build failed:\n${build.stderr || build.stdout}`);
  }
  assert.equal(build.signal, null);
}

async function runRustWithInput(input: string, expectedExitCode = 0): Promise<DifferentialResponse> {
  const run = await new Promise<RustRun>((resolve, reject) => {
    const child = spawn(rustBinary, [], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: noDatabaseUrl },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
    child.stdin.end(input);
  });
  assert.equal(run.exitCode, expectedExitCode, run.stderr || run.stdout);
  assert.equal(run.signal, null);
  return parseRustResponse(run.stdout);
}

function parseRustResponse(stdout: string): DifferentialResponse {
  assert.notEqual(stdout.trim(), "", "Rust differential binary produced no JSON");
  const response = JSON.parse(stdout) as DifferentialResponse;
  assert.equal(response.schema, schema);
  assert.equal(response.protocolVersion, protocolVersion);
  return response;
}

async function nodeProjection(fixture: Fixture, manifest: MigrationManifest): Promise<ManifestProjection> {
  const journal = JSON.parse(await readFile(fixture.journalFile, "utf8")) as {
    entries: JournalEntry[];
  };
  const entries = await Promise.all(manifest.entries.map(async (entry, index) => {
    const content = await readFile(path.join(fixture.migrationsFolder, entry.fileName));
    return {
      order: entry.order,
      fileName: entry.fileName,
      sha256: entry.sha256,
      byteSize: content.byteLength,
      journalEntry: journal.entries[index] ?? null,
    } satisfies OrderedEntry;
  }));
  return {
    version: manifest.version,
    fingerprint: manifest.fingerprint,
    canonical: manifest.canonical,
    entries,
    legacyTail: entries.slice(manifest.canonical.entries.length),
  };
}

async function assertCompatibilityParity(
  label: string,
  baselineFixture: Fixture,
  candidateFixture: Fixture,
): Promise<void> {
  const [baselineNode, candidateNode] = await Promise.all([
    createMigrationManifest(nodeOptions(baselineFixture)),
    createMigrationManifest(nodeOptions(candidateFixture)),
  ]);
  const response = await runRustWithInput(
    requestFor(sourceSpec(baselineFixture), sourceSpec(candidateFixture)),
  );
  assert.equal(response.status, "ok", label);
  const baselineExpected = await nodeProjection(baselineFixture, baselineNode);
  const candidateExpected = await nodeProjection(candidateFixture, candidateNode);
  assertSourceMatches(response.baseline, baselineExpected, `${label} baseline`);
  assertSourceMatches(response.candidate, candidateExpected, `${label} candidate`);

  const nodeCompatibility = validateMigrationManifestCompatibility(baselineNode, candidateNode);
  assert.ok(response.compatibility, `${label} compatibility is missing`);
  assert.equal(response.compatibility.valid, nodeCompatibility.valid, label);
  assert.equal(response.compatibility.compatible, nodeCompatibility.valid, label);
  assert.equal(response.compatibility.errors.length, nodeCompatibility.errors.length, label);
  assert.deepEqual(
    response.compatibility.addedEntries,
    candidateExpected.entries.slice(
      baselineNode.canonical.entries.length,
      candidateNode.canonical.entries.length,
    ),
    label,
  );
}

function assertSourceMatches(
  source: SourceResponse | undefined,
  expected: ManifestProjection,
  label: string,
): asserts source is SourceResponse & { status: "ok"; manifest: ManifestProjection } {
  assert.ok(source, `${label} source response is missing`);
  assert.equal(source.status, "ok", `${label} source was not accepted: ${JSON.stringify(source)}`);
  assert.deepEqual(source.manifest, expected, `${label} Rust projection diverged from Node`);
}

function requestFor(baseline: SourceSpec, candidate: SourceSpec) {
  return JSON.stringify({
    schema,
    protocolVersion,
    baseline,
    candidate,
  });
}

async function assertRegularFixtureParity(): Promise<void> {
  const rawBytes = new Uint8Array([0x53, 0x45, 0x4c, 0x45, 0x43, 0x54, 0x20, 0xc3, 0xa9, 0x0d, 0x0a]);
  const baselineFixture = createFixture(
    [
      { tag: "0000_first", sql: "CREATE TABLE first_table (id integer);" },
      { tag: "0001_second", sql: rawBytes },
    ],
    [{ tag: legacyFileNames[0].slice(0, -4), sql: "SELECT legacy;\n" }],
  );
  const candidateFixture = createFixture(
    [
      { tag: "0000_first", sql: "CREATE TABLE first_table (id integer);" },
      { tag: "0001_second", sql: rawBytes },
      { tag: "0002_third", sql: "SELECT 2;\n" },
    ],
    [{ tag: legacyFileNames[0].slice(0, -4), sql: "SELECT legacy;\n" }],
  );
  const [baselineNode, candidateNode] = await Promise.all([
    createMigrationManifest(nodeOptions(baselineFixture)),
    createMigrationManifest(nodeOptions(candidateFixture)),
  ]);
  const response = await runRustWithInput(
    requestFor(sourceSpec(baselineFixture), sourceSpec(candidateFixture)),
  );
  assert.equal(response.status, "ok");
  const baselineExpected = await nodeProjection(baselineFixture, baselineNode);
  const candidateExpected = await nodeProjection(candidateFixture, candidateNode);
  assertSourceMatches(response.baseline, baselineExpected, "baseline fixture");
  assertSourceMatches(response.candidate, candidateExpected, "candidate fixture");

  const nodeCompatibility = validateMigrationManifestCompatibility(baselineNode, candidateNode);
  assert.ok(response.compatibility);
  assert.equal(response.compatibility.classification, "compatible_append");
  assert.equal(response.compatibility.valid, nodeCompatibility.valid);
  assert.equal(response.compatibility.compatible, nodeCompatibility.valid);
  assert.deepEqual(
    response.compatibility.addedEntries,
    candidateExpected.entries.slice(baselineNode.canonical.entries.length, candidateNode.canonical.entries.length),
  );
  assert.deepEqual(response.compatibility.errors, nodeCompatibility.errors);

  const editedFixture = createFixture([
    { tag: "0000_first", sql: "CREATE TABLE first_table (id bigint);" },
    { tag: "0001_second", sql: "SELECT 1;\n" },
    { tag: "0002_third", sql: "SELECT 2;\n" },
  ], [{ tag: legacyFileNames[0].slice(0, -4), sql: "SELECT legacy;\n" }]);
  const editedNode = await createMigrationManifest(nodeOptions(editedFixture));
  const editedResponse = await runRustWithInput(
    requestFor(sourceSpec(baselineFixture), sourceSpec(editedFixture)),
    0,
  );
  assert.equal(editedResponse.status, "ok");
  assert.equal(editedResponse.compatibility?.classification, "incompatible");
  assert.equal(editedResponse.compatibility?.valid, false);
  const editedNodeCompatibility = validateMigrationManifestCompatibility(baselineNode, editedNode);
  assert.equal(editedNodeCompatibility.valid, false);
  assert.equal(editedResponse.compatibility?.errors.length, editedNodeCompatibility.errors.length);

  const byteDistinctFixture = createFixture([
    { tag: "0000_raw", sql: new Uint8Array([0x43, 0x52, 0x4c, 0x46, 0x0d, 0x0a, 0x00, 0xff]) },
  ]);
  const byteDistinctNode = await createMigrationManifest(nodeOptions(byteDistinctFixture));
  const byteDistinctResponse = await runRustWithInput(
    requestFor(sourceSpec(byteDistinctFixture), sourceSpec(byteDistinctFixture)),
  );
  const byteDistinctExpected = await nodeProjection(byteDistinctFixture, byteDistinctNode);
  assertSourceMatches(byteDistinctResponse.baseline, byteDistinctExpected, "raw-byte baseline");
  assertSourceMatches(byteDistinctResponse.candidate, byteDistinctExpected, "raw-byte candidate");
  assert.equal(byteDistinctResponse.compatibility?.classification, "compatible_noop");
}

async function assertLegacyTailCompatibility(): Promise<void> {
  const baselineFixture = createFixture(
    [{ tag: "0000_first", sql: "SELECT 1;\n" }],
    [{ tag: legacyFileNames[0].slice(0, -4), sql: "SELECT legacy;\n" }],
  );
  const appendedFixture = createFixture(
    [
      { tag: "0000_first", sql: "SELECT 1;\n" },
      { tag: "0001_second", sql: "SELECT 2;\n" },
    ],
    [{ tag: legacyFileNames[0].slice(0, -4), sql: "SELECT legacy;\n" }],
  );
  const removedFixture = createFixture([{ tag: "0000_first", sql: "SELECT 1;\n" }]);
  const editedFixture = createFixture(
    [{ tag: "0000_first", sql: "SELECT 1;\n" }],
    [{ tag: legacyFileNames[0].slice(0, -4), sql: "SELECT edited-legacy;\n" }],
  );
  const addedLegacyFixture = createFixture(
    [{ tag: "0000_first", sql: "SELECT 1;\n" }],
    [
      { tag: legacyFileNames[0].slice(0, -4), sql: "SELECT legacy;\n" },
      { tag: legacyFileNames[1].slice(0, -4), sql: "SELECT second-legacy;\n" },
    ],
  );

  await assertCompatibilityParity("canonical append with legacy tail", baselineFixture, appendedFixture);
  await assertCompatibilityParity("legacy tail removal", baselineFixture, removedFixture);
  await assertCompatibilityParity("legacy tail edit", baselineFixture, editedFixture);
  await assertCompatibilityParity("legacy tail addition", baselineFixture, addedLegacyFixture);
}

async function assertRealMigrationTreeParity(): Promise<void> {
  const sourceMigrationsFolder = path.join(repoRoot, "packages/db/src/migrations");
  const sourceJournalFile = path.join(sourceMigrationsFolder, "meta/_journal.json");
  const distMigrationsFolder = path.join(repoRoot, "packages/db/dist/migrations");
  const distJournalFile = path.join(distMigrationsFolder, "meta/_journal.json");
  assert.equal(existsSync(distJournalFile), true, "DB package build did not produce dist journal");
  const sourceNodeManifest = await createMigrationManifest({
    migrationsFolder: sourceMigrationsFolder,
    journalFile: sourceJournalFile,
  });
  const distNodeManifest = await createMigrationManifest({
    migrationsFolder: distMigrationsFolder,
    journalFile: distJournalFile,
  });
  assert.deepEqual(distNodeManifest, sourceNodeManifest, "source and dist manifests diverged");

  const sourceResponse = await runRustWithInput(requestFor(
    { migrationsDir: sourceMigrationsFolder, journalFile: sourceJournalFile },
    { migrationsDir: sourceMigrationsFolder, journalFile: sourceJournalFile },
  ));
  assert.equal(sourceResponse.status, "ok");
  const sourceExpected = await nodeProjection(
    { root: repoRoot, migrationsFolder: sourceMigrationsFolder, journalFile: sourceJournalFile },
    sourceNodeManifest,
  );
  assertSourceMatches(sourceResponse.baseline, sourceExpected, "real source baseline");
  assertSourceMatches(sourceResponse.candidate, sourceExpected, "real source candidate");
  assert.equal(sourceResponse.compatibility?.classification, "compatible_noop");
  assert.deepEqual(sourceResponse.compatibility?.errors, []);

  const distResponse = await runRustWithInput(requestFor(
    { migrationsDir: distMigrationsFolder, journalFile: distJournalFile },
    { migrationsDir: distMigrationsFolder, journalFile: distJournalFile },
  ));
  assert.equal(distResponse.status, "ok");
  const distExpected = await nodeProjection(
    { root: repoRoot, migrationsFolder: distMigrationsFolder, journalFile: distJournalFile },
    distNodeManifest,
  );
  assertSourceMatches(distResponse.baseline, distExpected, "real dist baseline");
  assertSourceMatches(distResponse.candidate, distExpected, "real dist candidate");
  assert.equal(distResponse.compatibility?.classification, "compatible_noop");
  assert.deepEqual(distResponse.compatibility?.errors, []);
}

async function assertMalformedInputFailsClosed(): Promise<void> {
  const response = await runRustWithInput("{not-json\n", 2);
  assert.equal(response.status, "protocol_error");
  assert.equal(response.error?.classification, "protocol");
  assert.equal(response.error?.code, "invalid_json");
}

async function assertSourceFailure(
  label: string,
  candidate: SourceSpec,
  classification: string,
  code: string,
): Promise<void> {
  const fixture = createFixture([{ tag: "0000_first", sql: "SELECT 1;\n" }]);
  const response = await runRustWithInput(
    requestFor(sourceSpec(fixture), candidate),
    1,
  );
  assert.equal(response.status, "error", label);
  assert.equal(response.baseline?.status, "ok", label);
  assert.equal(response.candidate?.status, "error", label);
  assert.equal(response.candidate?.error?.classification, classification, label);
  assert.equal(response.candidate?.error?.code, code, label);
}

async function assertRustSourceFailureAgainstFixture(
  label: string,
  baselineFixture: Fixture,
  candidateFixture: Fixture,
  classification: string,
  code: string,
): Promise<void> {
  const response = await runRustWithInput(
    requestFor(sourceSpec(baselineFixture), sourceSpec(candidateFixture)),
    1,
  );
  assert.equal(response.status, "error", label);
  assert.equal(response.baseline?.status, "ok", label);
  assert.equal(response.candidate?.status, "error", label);
  assert.equal(response.candidate?.error?.classification, classification, label);
  assert.equal(response.candidate?.error?.code, code, label);
}

async function assertFailClosedSourceCases(): Promise<void> {
  const validBaseline = createFixture([{ tag: "0000_first", sql: "SELECT 1;\n" }]);

  const unsupportedVersionFixture = createFixture([{ tag: "0000_first", sql: "SELECT 1;\n" }]);
  updateJournal(unsupportedVersionFixture, (journal) => { journal.version = "6"; });
  await assertNodeRejects(unsupportedVersionFixture, "unsupported version fixture", /version 7/);
  await assertRustSourceFailureAgainstFixture(
    "unsupported version fixture",
    validBaseline,
    unsupportedVersionFixture,
    "source",
    "migration_journal_invalid",
  );

  const unsupportedDialectFixture = createFixture([{ tag: "0000_first", sql: "SELECT 1;\n" }]);
  updateJournal(unsupportedDialectFixture, (journal) => { journal.dialect = "sqlite"; });
  await assertNodeRejects(unsupportedDialectFixture, "unsupported dialect fixture", /postgresql dialect/);
  await assertRustSourceFailureAgainstFixture(
    "unsupported dialect fixture",
    validBaseline,
    unsupportedDialectFixture,
    "source",
    "migration_journal_invalid",
  );

  const malformedJournalFixture = createFixture([{ tag: "0000_first", sql: "SELECT 1;\n" }]);
  writeFileSync(
    malformedJournalFixture.journalFile,
    JSON.stringify({ version: "7", dialect: "postgresql", entries: null }),
  );
  await assertNodeRejects(malformedJournalFixture, "malformed journal fixture", /no entries array/);
  await assertRustSourceFailureAgainstFixture(
    "malformed journal fixture",
    validBaseline,
    malformedJournalFixture,
    "source",
    "migration_journal_invalid",
  );

  const reorderedFixture = createFixture([
    { tag: "0000_first", sql: "SELECT 1;\n" },
    { tag: "0001_second", sql: "SELECT 2;\n" },
  ]);
  updateJournal(reorderedFixture, (journal) => { journal.entries[1].idx = 0; });
  await assertNodeRejects(reorderedFixture, "reordered journal fixture", /not contiguous/);
  await assertRustSourceFailureAgainstFixture(
    "reordered journal fixture",
    validBaseline,
    reorderedFixture,
    "source",
    "migration_journal_reordered",
  );

  const duplicateFixture = createFixture([
    { tag: "0000_first", sql: "SELECT 1;\n" },
    { tag: "0001_second", sql: "SELECT 2;\n" },
  ]);
  updateJournal(duplicateFixture, (journal) => { journal.entries[1].tag = journal.entries[0].tag; });
  await assertNodeRejects(duplicateFixture, "duplicate journal fixture", /repeats/);
  await assertRustSourceFailureAgainstFixture(
    "duplicate journal fixture",
    validBaseline,
    duplicateFixture,
    "source",
    "migration_journal_duplicate",
  );

  const unsafeJournalFixture = createFixture([{ tag: "0000_first", sql: "SELECT 1;\n" }]);
  updateJournal(unsafeJournalFixture, (journal) => { journal.entries[0].tag = "../escape"; });
  await assertNodeRejects(unsafeJournalFixture, "unsafe journal fixture", /invalid tag/);
  await assertRustSourceFailureAgainstFixture(
    "unsafe journal fixture",
    validBaseline,
    unsafeJournalFixture,
    "source",
    "migration_journal_path_invalid",
  );

  const symlinkFixture = createFixture([{ tag: "0000_first", sql: "SELECT 1;\n" }]);
  if (process.platform !== "win32") {
    const target = path.join(symlinkFixture.root, "outside.sql");
    writeFileSync(target, "SELECT outside;\n");
    symlinkSync(target, path.join(symlinkFixture.migrationsFolder, "0001_link.sql"));
    await assertSourceFailure(
      "symlink fixture",
      sourceSpec(symlinkFixture),
      "symlink",
      "migration_symlink_rejected",
    );
  }

  const nonRegularFixture = createFixture([{ tag: "0000_first", sql: "SELECT 1;\n" }]);
  mkdirSync(path.join(nonRegularFixture.migrationsFolder, "0001_directory.sql"));
  await assertSourceFailure(
    "non-regular fixture",
    sourceSpec(nonRegularFixture),
    "non_regular",
    "migration_sql_not_regular",
  );

  const unknownFixture = createFixture([{ tag: "0000_first", sql: "SELECT 1;\n" }]);
  writeFileSync(path.join(unknownFixture.migrationsFolder, "0001_unknown.sql"), "SELECT unknown;\n");
  await assertNodeRejects(unknownFixture, "unknown SQL fixture", /missing from the journal/);
  await assertSourceFailure(
    "unknown fixture",
    sourceSpec(unknownFixture),
    "unknown",
    "migration_sql_unknown",
  );

  const sizeFixture = createFixture([{ tag: "0000_first", sql: "SELECT 123456789;\n" }]);
  await assertSourceFailure(
    "size fixture",
    sourceSpec(sizeFixture, { limits: { maxSqlFileBytes: 8 } }),
    "size_limit",
    "migration_sql_size_limit",
  );

  const journalSizeFixture = createFixture([{ tag: "0000_first", sql: "SELECT 1;\n" }]);
  await assertSourceFailure(
    "journal size fixture",
    sourceSpec(journalSizeFixture, { limits: { maxJournalBytes: 1 } }),
    "size_limit",
    "migration_journal_size_limit",
  );

  const totalSizeFixture = createFixture([{ tag: "0000_first", sql: "SELECT 123456789;\n" }]);
  await assertSourceFailure(
    "total SQL size fixture",
    sourceSpec(totalSizeFixture, { limits: { maxTotalSqlBytes: 8 } }),
    "size_limit",
    "migration_sql_total_size_limit",
  );

  const directoryEntriesFixture = createFixture([{ tag: "0000_first", sql: "SELECT 1;\n" }]);
  await assertSourceFailure(
    "directory entries fixture",
    sourceSpec(directoryEntriesFixture, { limits: { maxDirectoryEntries: 1 } }),
    "source",
    "migration_directory_entries_limit",
  );

  const sqlFilesLimitFixture = createFixture([{ tag: "0000_first", sql: "SELECT 1;\n" }]);
  await assertSourceFailure(
    "SQL files limit fixture",
    sourceSpec(sqlFilesLimitFixture, { limits: { maxSqlFiles: 0 } }),
    "source",
    "migration_sql_files_limit",
  );

  const unsafeFileFixture = createFixture([{ tag: "0000_first", sql: "SELECT 1;\n" }]);
  writeFileSync(path.join(unsafeFileFixture.migrationsFolder, "bad name.sql"), "SELECT unsafe;\n");
  await assertNodeRejects(unsafeFileFixture, "unsafe SQL filename fixture", /missing from the journal/);
  await assertSourceFailure(
    "unsafe SQL filename fixture",
    sourceSpec(unsafeFileFixture),
    "source",
    "migration_sql_path_invalid",
  );

  const outsideRootFixture = createFixture([{ tag: "0000_first", sql: "SELECT 1;\n" }]);
  const outsideJournal = path.join(outsideRootFixture.root, "outside-journal.json");
  writeFileSync(outsideJournal, readFileSync(outsideRootFixture.journalFile));
  await createMigrationManifest({
    migrationsFolder: outsideRootFixture.migrationsFolder,
    journalFile: outsideJournal,
  });
  await assertSourceFailure(
    "outside-root fixture",
    {
      migrationsDir: outsideRootFixture.migrationsFolder,
      journalFile: outsideJournal,
    },
    "outside_root",
    "migration_journal_outside_root",
  );
}

async function main(): Promise<void> {
  await buildRustBinary();
  await buildDbPackage();
  await assertMalformedInputFailsClosed();
  await assertRegularFixtureParity();
  await assertLegacyTailCompatibility();
  await assertRealMigrationTreeParity();
  await assertFailClosedSourceCases();
  console.log("PASS Node -> Rust migration manifest differential");
}

try {
  await main();
} finally {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false, `temporary fixture was not cleaned up: ${root}`);
  }
}
