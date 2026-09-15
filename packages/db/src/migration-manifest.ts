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

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
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
  if (parsed.dialect !== "postgresql") {
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
    if (typeof tag !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(tag)) {
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
    const content = await readFile(path.join(migrationsFolder, fileName), "utf8");
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
    .sort((left, right) => left.localeCompare(right));
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
    const content = await readFile(path.join(migrationsFolder, fileName), "utf8");
    const contentSha256 = sha256(content);
    entries.push({ order: entries.length, fileName, sha256: contentSha256 });
  }

  for (const fileName of sqlFileNames) {
    const content = await readFile(path.join(migrationsFolder, fileName), "utf8");
    sqlFiles.push({ fileName, fingerprint: sha256(content) });
  }

  return freezeManifest(entries, buildCanonicalPayload(journalMetadata, journalManifestEntries, sqlFiles));
}

export function validateMigrationManifestIntegrity(
  manifest: MigrationManifest,
): MigrationManifestValidation {
  const errors: string[] = [];
  const seenFiles = new Set<string>();

  if (manifest.version !== MIGRATION_MANIFEST_VERSION) {
    errors.push(`Unsupported migration manifest version: ${String(manifest.version)}`);
  }
  manifest.entries.forEach((entry, position) => {
    if (entry.order !== position) {
      errors.push(`Migration manifest entry ${position} has order ${entry.order}`);
    }
    if (!entry.fileName.endsWith(".sql") || seenFiles.has(entry.fileName)) {
      errors.push(`Migration manifest has an invalid or duplicate file: ${entry.fileName}`);
    }
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) {
      errors.push(`Migration manifest has an invalid SHA256 for ${entry.fileName}`);
    }
    seenFiles.add(entry.fileName);
  });

  // Bind the flattened convenience view to the canonical, fingerprinted assets.
  // Legacy files follow the journal in that view; their offsets are not identities.
  const journalNames = new Set(manifest.canonical.entries.map((entry) => `${entry.tag}.sql`));
  const sqlByName = new Map<string, string>();
  for (const entry of manifest.canonical.sqlFiles) {
    if (sqlByName.has(entry.fileName) || !/^[0-9a-f]{64}$/.test(entry.fingerprint)) {
      errors.push(`Invalid canonical SQL identity for ${entry.fileName}`);
    }
    sqlByName.set(entry.fileName, entry.fingerprint);
  }
  const canonicalEntries: Array<{ fileName: string; sha256: string }> = [];
  manifest.canonical.entries.forEach((entry, position) => {
    const fileName = `${entry.tag}.sql`;
    if (entry.idx !== position || sqlByName.get(fileName) !== entry.sqlFingerprint) {
      errors.push(`Canonical journal does not match SQL identity for ${fileName}`);
    }
    canonicalEntries.push({ fileName, sha256: entry.sqlFingerprint });
  });
  for (const entry of manifest.canonical.sqlFiles) {
    if (journalNames.has(entry.fileName)) continue;
    if (!LEGACY_UNJOURNALED_MIGRATIONS.has(entry.fileName)) {
      errors.push(`Unknown canonical unjournaled SQL file ${entry.fileName}`);
    }
    canonicalEntries.push({ fileName: entry.fileName, sha256: entry.fingerprint });
  }
  if (canonicalEntries.length !== manifest.entries.length) {
    errors.push("Manifest entries do not match canonical SQL and journal assets");
  }
  canonicalEntries.forEach((expected, position) => {
    const actual = manifest.entries[position];
    if (actual?.fileName !== expected.fileName || actual?.sha256 !== expected.sha256) {
      errors.push(`Manifest entry ${position} does not match its canonical identity`);
    }
  });

  const expectedFingerprint = manifestFingerprint(manifest.canonical);
  if (manifest.fingerprint !== expectedFingerprint) {
    errors.push(
      `Migration manifest fingerprint mismatch: expected ${expectedFingerprint}, received ${manifest.fingerprint}`,
    );
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

  const baseJournal = baseline.canonical.entries;
  const nextJournal = candidate.canonical.entries;
  if (baseline.canonical.version !== candidate.canonical.version
    || baseline.canonical.dialect !== candidate.canonical.dialect) {
    errors.push("Candidate changed published journal format");
  }
  if (nextJournal.length < baseJournal.length) {
    errors.push("Candidate removed published journal entries");
  }
  baseJournal.forEach((expected, index) => {
    const actual = nextJournal[index];
    if (!actual) return;
    if (expected.idx !== actual.idx || expected.tag !== actual.tag
      || expected.version !== actual.version || expected.when !== actual.when
      || expected.breakpoints !== actual.breakpoints) {
      errors.push(`Candidate changed published journal entry ${index}: ${expected.tag}`);
    }
  });

  // Compare published SQL by immutable name/hash, not a shifted legacy-tail index.
  const baseSql = new Map(baseline.canonical.sqlFiles.map((entry) => [entry.fileName, entry.fingerprint]));
  const nextSql = new Map(candidate.canonical.sqlFiles.map((entry) => [entry.fileName, entry.fingerprint]));
  for (const [fileName, hash] of baseSql) {
    if (!nextSql.has(fileName)) errors.push(`Candidate removed published migration ${fileName}`);
    else if (nextSql.get(fileName) !== hash) errors.push(`Candidate changed published migration ${fileName}`);
  }
  const nextJournalNames = new Set(nextJournal.map((entry) => `${entry.tag}.sql`));
  for (const fileName of nextSql.keys()) {
    if (!baseSql.has(fileName) && !nextJournalNames.has(fileName)) {
      errors.push(`Candidate added unjournaled migration ${fileName}`);
    }
  }
  for (const entry of nextJournal.slice(baseJournal.length)) {
    if (baseSql.has(`${entry.tag}.sql`)) {
      errors.push(`Candidate journaled historical SQL again: ${entry.tag}.sql`);
    }
  }

  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    addedEntries: Object.freeze(candidate.entries.slice(baseJournal.length, nextJournal.length)),
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
