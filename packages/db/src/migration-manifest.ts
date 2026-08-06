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

  if (candidate.entries.length < baseline.entries.length) {
    errors.push(
      `Candidate removed ${baseline.entries.length - candidate.entries.length} published migration(s)`,
    );
  }

  const sharedLength = Math.min(baseline.entries.length, candidate.entries.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const expected = baseline.entries[index];
    const actual = candidate.entries[index];
    if (!expected || !actual) continue;
    if (expected.order !== actual.order || expected.fileName !== actual.fileName) {
      errors.push(
        `Candidate changed published migration order ${index}: expected ${expected.fileName}, received ${actual.fileName}`,
      );
      continue;
    }
    if (expected.sha256 !== actual.sha256) {
      errors.push(`Candidate changed published migration ${expected.fileName}`);
    }
  }

  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    addedEntries: Object.freeze(candidate.entries.slice(baseline.entries.length)),
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
