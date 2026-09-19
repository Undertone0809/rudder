import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));
const DEFAULT_JOURNAL_FILE = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));
const LEGACY_UNJOURNALED_MIGRATIONS = new Set([
  "0055_illegal_sheva_callister.sql",
  "0128_modern_jetstream.sql",
]);
const MIGRATION_JOURNAL_VERSION = "7";
const MIGRATION_DIALECT = "postgresql";
const SAFE_MIGRATION_TAG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export const MIGRATION_MANIFEST_VERSION = 1 as const;

export type MigrationManifestEntry = Readonly<{
  order: number;
  fileName: string;
  sha256: string;
}>;

export type MigrationManifest = Readonly<{
  version: typeof MIGRATION_MANIFEST_VERSION;
  fingerprint: string;
  entries: readonly MigrationManifestEntry[];
  canonical: Readonly<{
    version: string;
    dialect: string;
    entries: readonly Readonly<{
      idx: number;
      version: string;
      when: number;
      tag: string;
      breakpoints: boolean;
      sqlFingerprint: string;
    }>[];
    sqlFiles: readonly Readonly<{ fileName: string; fingerprint: string }>[];
  }>;
}>;

export type MigrationManifestValidation = Readonly<{
  valid: boolean;
  errors: readonly string[];
  addedEntries: readonly MigrationManifestEntry[];
}>;

type MigrationJournal = {
  version?: string | number;
  dialect?: string;
  entries?: Array<{
    idx?: number;
    version?: string;
    when?: number;
    tag?: string;
    breakpoints?: boolean;
  }>;
};

export type CreateMigrationManifestOptions = {
  migrationsFolder?: string;
  journalFile?: string;
};

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function compareMigrationFileNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSafeMigrationTag(value: string): boolean {
  return SAFE_MIGRATION_TAG.test(value);
}

function isSafeMigrationFileName(value: string): boolean {
  return value.endsWith(".sql") && isSafeMigrationTag(value.slice(0, -4));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function buildCanonicalPayload(
  journal: { version: string; dialect: string },
  journalEntries: readonly { idx: number; version: string; when: number; tag: string; breakpoints: boolean; sqlFingerprint: string }[],
  sqlFiles: readonly { fileName: string; fingerprint: string }[],
) {
  return {
    version: String(journal.version),
    dialect: journal.dialect,
    entries: journalEntries,
    sqlFiles,
  } as const;
}

function manifestFingerprint(canonical: ReturnType<typeof buildCanonicalPayload>): string {
  return sha256(JSON.stringify(canonical));
}

function freezeManifest(
  entries: MigrationManifestEntry[],
  canonical: ReturnType<typeof buildCanonicalPayload>,
): MigrationManifest {
  const frozenEntries = Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
  const frozenCanonical = Object.freeze({
    ...canonical,
    entries: Object.freeze(canonical.entries.map((entry) => Object.freeze({ ...entry }))),
    sqlFiles: Object.freeze(canonical.sqlFiles.map((entry) => Object.freeze({ ...entry }))),
  });
  return Object.freeze({
    version: MIGRATION_MANIFEST_VERSION,
    fingerprint: manifestFingerprint(frozenCanonical),
    entries: frozenEntries,
    canonical: frozenCanonical,
  });
}

export async function createMigrationManifest(
  options: CreateMigrationManifestOptions = {},
): Promise<MigrationManifest> {
  const migrationsFolder = options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER;
  const journalFile = options.journalFile ?? DEFAULT_JOURNAL_FILE;
  const parsed = JSON.parse(await readFile(journalFile, "utf8")) as MigrationJournal;
  if (!Array.isArray(parsed.entries)) {
    throw new Error(`Migration journal has no entries array: ${journalFile}`);
  }
  if (String(parsed.version) !== MIGRATION_JOURNAL_VERSION) {
    throw new Error(`Migration journal must use version ${MIGRATION_JOURNAL_VERSION}: ${journalFile}`);
  }
  if (parsed.dialect !== MIGRATION_DIALECT) {
    throw new Error(`Migration journal must use the postgresql dialect: ${journalFile}`);
  }
  const journalMetadata = {
    version: String(parsed.version),
    dialect: parsed.dialect,
  };

  const entries: MigrationManifestEntry[] = [];
  const journalManifestEntries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
    sqlFingerprint: string;
  }> = [];
  const seenOrders = new Set<number>();
  const seenFiles = new Set<string>();

  for (const [journalPosition, journalEntry] of parsed.entries.entries()) {
    const order = journalEntry.idx;
    const tag = journalEntry.tag;
    if (!Number.isInteger(order) || (order ?? -1) < 0) {
      throw new Error(`Migration journal entry ${journalPosition} has an invalid idx`);
    }
    if (typeof tag !== "string" || !isSafeMigrationTag(tag)) {
      throw new Error(`Migration journal entry ${journalPosition} has an invalid tag`);
    }
    if (typeof journalEntry.version !== "string" || journalEntry.version.length === 0) {
      throw new Error(`Migration journal entry ${journalPosition} has an invalid version`);
    }
    if (!Number.isSafeInteger(journalEntry.when) || (journalEntry.when ?? 0) <= 0) {
      throw new Error(`Migration journal entry ${journalPosition} has an invalid timestamp`);
    }
    if (typeof journalEntry.breakpoints !== "boolean") {
      throw new Error(`Migration journal entry ${journalPosition} has an invalid breakpoints flag`);
    }
    if (order !== journalPosition) {
      throw new Error(
        `Migration journal order is not contiguous at position ${journalPosition}: received idx ${order}`,
      );
    }

    const fileName = `${tag}.sql`;
    if (seenOrders.has(order)) throw new Error(`Migration journal repeats idx ${order}`);
    if (seenFiles.has(fileName)) throw new Error(`Migration journal repeats ${fileName}`);
    seenOrders.add(order);
    seenFiles.add(fileName);

    const version = journalEntry.version;
    const when = Number(journalEntry.when);
    const breakpoints = journalEntry.breakpoints;
    const content = await readFile(path.join(migrationsFolder, fileName));
    const contentSha256 = sha256(content);
    entries.push({ order, fileName, sha256: contentSha256 });
    journalManifestEntries.push({
      idx: order,
      version,
      when,
      tag,
      breakpoints,
      sqlFingerprint: contentSha256,
    });
  }

  const sqlFileNames = (await readdir(migrationsFolder, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort(compareMigrationFileNames);
  const unjournaledFiles = sqlFileNames.filter((fileName) => !seenFiles.has(fileName));
  const unexpectedUnjournaledFiles = unjournaledFiles.filter(
    (fileName) => !LEGACY_UNJOURNALED_MIGRATIONS.has(fileName),
  );
  if (unexpectedUnjournaledFiles.length > 0) {
    throw new Error(
      `Migration SQL files are missing from the journal: ${unexpectedUnjournaledFiles.join(", ")}`,
    );
  }
  const sqlFiles: Array<{ fileName: string; fingerprint: string }> = [];
  for (const fileName of unjournaledFiles) {
    const content = await readFile(path.join(migrationsFolder, fileName));
    const contentSha256 = sha256(content);
    entries.push({ order: entries.length, fileName, sha256: contentSha256 });
  }

  for (const fileName of sqlFileNames) {
    const content = await readFile(path.join(migrationsFolder, fileName));
    sqlFiles.push({ fileName, fingerprint: sha256(content) });
  }

  return freezeManifest(entries, buildCanonicalPayload(journalMetadata, journalManifestEntries, sqlFiles));
}

export function validateMigrationManifestIntegrity(
  manifest: MigrationManifest,
): MigrationManifestValidation {
  const errors: string[] = [];
  const seenFiles = new Set<string>();

  if (!isRecord(manifest)) {
    return Object.freeze({
      valid: false,
      errors: Object.freeze(["Migration manifest must be an object"]),
      addedEntries: Object.freeze([]),
    });
  }
  const manifestEntries = manifest.entries;
  const canonical = manifest.canonical;
  if (!Array.isArray(manifestEntries)) {
    errors.push("Migration manifest entries must be an array");
  }
  if (!isRecord(canonical)) {
    errors.push("Migration manifest canonical payload must be an object");
  }
  if (!Array.isArray(manifestEntries) || !isRecord(canonical)) {
    return Object.freeze({
      valid: false,
      errors: Object.freeze(errors),
      addedEntries: Object.freeze([]),
    });
  }
  const canonicalEntries = canonical.entries;
  const canonicalSqlFiles = canonical.sqlFiles;
  if (!Array.isArray(canonicalEntries)) {
    errors.push("Migration manifest canonical entries must be an array");
  }
  if (!Array.isArray(canonicalSqlFiles)) {
    errors.push("Migration manifest canonical SQL files must be an array");
  }
  if (!Array.isArray(canonicalEntries) || !Array.isArray(canonicalSqlFiles)) {
    return Object.freeze({
      valid: false,
      errors: Object.freeze(errors),
      addedEntries: Object.freeze([]),
    });
  }

  if (manifest.version !== MIGRATION_MANIFEST_VERSION) {
    errors.push(`Unsupported migration manifest version: ${String(manifest.version)}`);
  }
  manifestEntries.forEach((entry, position) => {
    if (!isRecord(entry)) {
      errors.push(`Migration manifest entry ${position} must be an object`);
      return;
    }
    const order = entry.order;
    const fileName = entry.fileName;
    const fingerprint = entry.sha256;
    if (order !== position) {
      errors.push(`Migration manifest entry ${position} has order ${String(order)}`);
    }
    if (
      typeof fileName !== "string"
      || !isSafeMigrationFileName(fileName)
      || seenFiles.has(fileName)
    ) {
      errors.push(`Migration manifest has an invalid or duplicate file: ${String(fileName)}`);
    }
    if (typeof fingerprint !== "string" || !SHA256_HEX.test(fingerprint)) {
      errors.push(`Migration manifest has an invalid SHA256 for ${String(fileName)}`);
    }
    if (typeof fileName === "string") {
      seenFiles.add(fileName);
    }
  });

  if (canonical.version !== MIGRATION_JOURNAL_VERSION) {
    errors.push(`Migration manifest has an unsupported journal version: ${String(canonical.version)}`);
  }
  if (canonical.dialect !== MIGRATION_DIALECT) {
    errors.push(`Migration manifest has an unsupported journal dialect: ${String(canonical.dialect)}`);
  }

  canonicalEntries.forEach((entry, position) => {
    if (!isRecord(entry)) {
      errors.push(`Migration manifest journal entry ${position} must be an object`);
      return;
    }
    const idx = entry.idx;
    const version = entry.version;
    const when = entry.when;
    const tag = entry.tag;
    const breakpoints = entry.breakpoints;
    const sqlFingerprint = entry.sqlFingerprint;
    const expected = manifestEntries[position];
    if (idx !== position) {
      errors.push(`Migration manifest journal entry ${position} has idx ${String(idx)}`);
    }
    if (typeof tag !== "string" || !isSafeMigrationTag(tag)) {
      errors.push(`Migration manifest journal entry ${position} has an invalid tag: ${String(tag)}`);
    }
    if (
      typeof version !== "string"
      || version.length === 0
      || typeof when !== "number"
      || !Number.isSafeInteger(when)
      || when <= 0
    ) {
      errors.push(`Migration manifest journal entry ${position} has invalid metadata`);
    }
    if (typeof breakpoints !== "boolean" || typeof sqlFingerprint !== "string" || !SHA256_HEX.test(sqlFingerprint)) {
      errors.push(`Migration manifest journal entry ${position} has invalid identity data`);
    }
    const expectedFileName = isRecord(expected) && typeof expected.fileName === "string"
      ? expected.fileName
      : undefined;
    const expectedFingerprint = isRecord(expected) && typeof expected.sha256 === "string"
      ? expected.sha256
      : undefined;
    if (
      !expected
      || expectedFileName !== `${String(tag)}.sql`
      || expectedFingerprint !== sqlFingerprint
      || (isRecord(expected) && expected.order !== idx)
    ) {
      errors.push(`Migration manifest journal entry ${position} is not bound to its SQL entry`);
    }
  });
  const expectedJournalEntryCount = manifestEntries.filter((entry) => {
    if (!isRecord(entry) || typeof entry.fileName !== "string") return false;
    return !LEGACY_UNJOURNALED_MIGRATIONS.has(entry.fileName);
  }).length;
  if (canonicalEntries.length !== expectedJournalEntryCount) {
    errors.push("Migration manifest canonical journal entry list does not match entries");
  }
  if (canonicalEntries.length > manifestEntries.length) {
    errors.push("Migration manifest has more journal entries than SQL entries");
  }

  const expectedSqlFiles = manifestEntries
    .filter((entry): entry is MigrationManifestEntry =>
      isRecord(entry)
      && typeof entry.fileName === "string"
      && typeof entry.sha256 === "string",
    )
    .sort((left, right) => compareMigrationFileNames(left.fileName, right.fileName))
    .map((entry) => ({ fileName: entry.fileName, fingerprint: entry.sha256 }));
  if (canonicalSqlFiles.length !== expectedSqlFiles.length) {
    errors.push("Migration manifest canonical SQL file list does not match entries");
  }
  const sharedSqlFileLength = Math.min(
    canonicalSqlFiles.length,
    expectedSqlFiles.length,
  );
  for (let index = 0; index < sharedSqlFileLength; index += 1) {
    const actual = canonicalSqlFiles[index];
    const expected = expectedSqlFiles[index];
    if (
      !isRecord(actual)
      || !expected
      || actual.fileName !== expected.fileName
      || actual.fingerprint !== expected.fingerprint
    ) {
      errors.push(`Migration manifest canonical SQL file ${index} is not bound to entries`);
    }
  }

  try {
    const expectedFingerprint = manifestFingerprint(canonical as MigrationManifest["canonical"]);
    if (manifest.fingerprint !== expectedFingerprint) {
      errors.push(
        `Migration manifest fingerprint mismatch: expected ${expectedFingerprint}, received ${String(manifest.fingerprint)}`,
      );
    }
  } catch {
    errors.push("Migration manifest canonical payload cannot be fingerprinted");
  }

  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    addedEntries: Object.freeze([]),
  });
}

export function validateMigrationManifestCompatibility(
  baseline: MigrationManifest,
  candidate: MigrationManifest,
): MigrationManifestValidation {
  const baselineIntegrity = validateMigrationManifestIntegrity(baseline);
  const candidateIntegrity = validateMigrationManifestIntegrity(candidate);
  const errors = [
    ...baselineIntegrity.errors.map((error) => `Baseline: ${error}`),
    ...candidateIntegrity.errors.map((error) => `Candidate: ${error}`),
  ];
  if (!baselineIntegrity.valid || !candidateIntegrity.valid) {
    return Object.freeze({
      valid: false,
      errors: Object.freeze(errors),
      addedEntries: Object.freeze([]),
    });
  }

  const baselineJournalLength = baseline.canonical.entries.length;
  const candidateJournalLength = candidate.canonical.entries.length;
  if (candidateJournalLength < baselineJournalLength) {
    errors.push(
      `Candidate removed ${baselineJournalLength - candidateJournalLength} published migration(s)`,
    );
  }

  const sharedJournalLength = Math.min(baselineJournalLength, candidateJournalLength);
  for (let index = 0; index < sharedJournalLength; index += 1) {
    const expectedJournal = baseline.canonical.entries[index];
    const actualJournal = candidate.canonical.entries[index];
    const expected = baseline.entries[index];
    const actual = candidate.entries[index];
    if (!expectedJournal || !actualJournal || !expected || !actual) continue;
    if (
      expectedJournal.idx !== actualJournal.idx ||
      expectedJournal.version !== actualJournal.version ||
      expectedJournal.when !== actualJournal.when ||
      expectedJournal.tag !== actualJournal.tag ||
      expectedJournal.breakpoints !== actualJournal.breakpoints ||
      expectedJournal.sqlFingerprint !== actualJournal.sqlFingerprint
    ) {
      errors.push(
        `Candidate changed published journal migration ${expected.fileName}`,
      );
    }
  }

  const baselineLegacy = baseline.entries.slice(baselineJournalLength);
  const candidateLegacy = candidate.entries.slice(candidateJournalLength);
  if (candidateLegacy.length !== baselineLegacy.length) {
    if (candidateLegacy.length < baselineLegacy.length) {
      errors.push(
        `Candidate removed ${baselineLegacy.length - candidateLegacy.length} published legacy migration(s)`,
      );
    } else {
      errors.push(
        `Candidate added ${candidateLegacy.length - baselineLegacy.length} unpublished legacy migration(s)`,
      );
    }
  }
  for (let index = 0; index < baselineLegacy.length; index += 1) {
    const expected = baselineLegacy[index];
    const actual = candidateLegacy[index];
    if (!expected || !actual) continue;
    if (expected.fileName !== actual.fileName || expected.sha256 !== actual.sha256) {
      errors.push(`Candidate changed published migration ${expected.fileName}`);
    }
  }

  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    addedEntries: Object.freeze(
      candidate.entries.slice(baselineJournalLength, candidateJournalLength),
    ),
  });
}

export function assertMigrationManifestCompatible(
  baseline: MigrationManifest,
  candidate: MigrationManifest,
): void {
  const validation = validateMigrationManifestCompatibility(baseline, candidate);
  if (!validation.valid) {
    throw new Error(`Migration manifest is not append-only: ${validation.errors.join("; ")}`);
  }
}
