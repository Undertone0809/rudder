/**
 * Read-only R6Z-120 migration preparation. Never connects to PostgreSQL or
 * changes source migrations: the hypothetical append exists only in a temp dir.
 * Run: node cli/node_modules/tsx/dist/cli.mjs scripts/rust-d1-migration-append-preflight.ts
 * Test: node cli/node_modules/tsx/dist/cli.mjs --test scripts/rust-d1-migration-append-preflight.test.ts
 * A ready result proves only manifest append classification, not SQL safety.
 */
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createMigrationManifest,
  validateMigrationManifestCompatibility,
} from "../packages/db/src/migration-manifest.js";

export type AppendPreflightOptions = {
  migrationsFolder: string;
  temporaryParent?: string;
};

export type AppendPreflightReport = {
  status: "ready" | "blocked";
  sourceFingerprint: string;
  sourceUnchanged: boolean;
  journaledCount: number;
  legacyUnjournaledFiles: string[];
  probeFileName: string;
  reportedAddedFiles: string[];
  errors: string[];
};

export async function probeMigrationAppend(
  options: AppendPreflightOptions,
): Promise<AppendPreflightReport> {
  const source = {
    migrationsFolder: options.migrationsFolder,
    journalFile: path.join(options.migrationsFolder, "meta", "_journal.json"),
  };
  const baseline = await createMigrationManifest(source);
  const index = baseline.canonical.entries.length;
  const tag = `${String(index).padStart(4, "0")}_rust_d1_append_probe`;
  const probeFileName = `${tag}.sql`;
  const nextTimestamp = Math.max(0, ...baseline.canonical.entries.map((entry) => entry.when)) + 1;
  if (!Number.isSafeInteger(nextTimestamp)) {
    throw new Error("Cannot construct an append probe after the final safe journal timestamp");
  }
  if (baseline.canonical.sqlFiles.some((entry) => entry.fileName === probeFileName)) {
    throw new Error("Append probe filename already exists; source was not changed");
  }

  const temporaryRoot = await mkdtemp(path.join(options.temporaryParent ?? os.tmpdir(), "rudder-d1-append-"));
  try {
    const migrationsFolder = path.join(temporaryRoot, "migrations");
    await mkdir(path.join(migrationsFolder, "meta"), { recursive: true });
    // Copy only enumerated migration SQL, never profiles, .env files, or a DB.
    for (const entry of baseline.canonical.sqlFiles) {
      await copyFile(path.join(source.migrationsFolder, entry.fileName), path.join(migrationsFolder, entry.fileName));
    }
    const journal = JSON.parse(await readFile(source.journalFile, "utf8"));
    journal.entries.push({ idx: index, version: String(journal.version), when: nextTimestamp, tag, breakpoints: true });
    const journalFile = path.join(migrationsFolder, "meta", "_journal.json");
    await writeFile(journalFile, JSON.stringify(journal), "utf8");
    await writeFile(path.join(migrationsFolder, probeFileName), "-- Read-only D1 append probe; never apply to a database.\n", "utf8");
    const candidate = await createMigrationManifest({ migrationsFolder, journalFile });
    const comparison = validateMigrationManifestCompatibility(baseline, candidate);
    const reportedAddedFiles = comparison.addedEntries.map((entry) => entry.fileName);
    const errors = [...comparison.errors];
    if (reportedAddedFiles.length !== 1 || reportedAddedFiles[0] !== probeFileName) {
      errors.push(`Append classification must report only ${probeFileName}`);
    }
    const current = await createMigrationManifest(source);
    const sourceUnchanged = current.fingerprint === baseline.fingerprint;
    if (!sourceUnchanged) errors.push("Source migration assets changed during the probe; retry on a frozen candidate");
    const journaledNames = new Set(baseline.canonical.entries.map((entry) => `${entry.tag}.sql`));
    return {
      status: comparison.valid && errors.length === 0 ? "ready" : "blocked",
      sourceFingerprint: baseline.fingerprint,
      sourceUnchanged,
      journaledCount: index,
      legacyUnjournaledFiles: baseline.canonical.sqlFiles
        .filter((entry) => !journaledNames.has(entry.fileName))
        .map((entry) => entry.fileName),
      probeFileName,
      reportedAddedFiles,
      errors,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (process.argv.length > 3) {
    throw new Error("Usage: rust-d1-migration-append-preflight.ts [migrations-directory]");
  }
  const migrationsFolder = process.argv[2] ?? fileURLToPath(new URL("../packages/db/src/migrations", import.meta.url));
  const report = await probeMigrationAppend({ migrationsFolder });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === "ready" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({ status: "error", error: error instanceof Error ? error.message : "Preflight failed" }));
    process.exitCode = 2;
  });
}
