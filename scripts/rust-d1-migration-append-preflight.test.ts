import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createMigrationManifest,
  validateMigrationManifestCompatibility,
  validateMigrationManifestIntegrity,
} from "../packages/db/src/migration-manifest.js";
import { probeMigrationAppend } from "./rust-d1-migration-append-preflight.js";

const legacyNames = ["0055_illegal_sheva_callister.sql", "0128_modern_jetstream.sql"];

async function fixture(t: TestContext, legacyFiles: readonly string[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rudder-d1-preflight-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const migrationsFolder = path.join(root, "migrations");
  const temporaryParent = path.join(root, "scratch");
  await mkdir(path.join(migrationsFolder, "meta"), { recursive: true });
  await mkdir(temporaryParent);
  const journalFile = path.join(migrationsFolder, "meta", "_journal.json");
  await writeFile(journalFile, JSON.stringify({
    version: "7", dialect: "postgresql",
    entries: [{ idx: 0, version: "7", when: 1000, tag: "0000_first", breakpoints: true }],
  }));
  await writeFile(path.join(migrationsFolder, "0000_first.sql"), "CREATE TABLE first_table (id integer);\n");
  for (const name of legacyFiles) await writeFile(path.join(migrationsFolder, name), "SELECT 1;\n");
  return { migrationsFolder, temporaryParent, journalFile };
}

async function snapshot(migrationsFolder: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await readdir(migrationsFolder)).sort()) {
    if (name.endsWith(".sql")) result[name] = await readFile(path.join(migrationsFolder, name), "utf8");
  }
  result["meta/_journal.json"] = await readFile(path.join(migrationsFolder, "meta", "_journal.json"), "utf8");
  return result;
}

test("a plain journal append is ready and leaves every source byte unchanged", async (t) => {
  const source = await fixture(t);
  const before = await snapshot(source.migrationsFolder);
  const report = await probeMigrationAppend(source);
  assert.equal(report.status, "ready");
  assert.equal(report.sourceUnchanged, true);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.reportedAddedFiles, ["0001_rust_d1_append_probe.sql"]);
  assert.deepEqual(await snapshot(source.migrationsFolder), before);
  assert.deepEqual(await readdir(source.temporaryParent), []);
});

test("accepts an append with both historical legacy files without moving their identities", async (t) => {
  const source = await fixture(t, legacyNames);
  const before = await snapshot(source.migrationsFolder);
  const report = await probeMigrationAppend(source);
  assert.equal(report.status, "ready");
  assert.equal(report.sourceUnchanged, true);
  assert.deepEqual(report.legacyUnjournaledFiles, legacyNames);
  assert.deepEqual(report.reportedAddedFiles, ["0001_rust_d1_append_probe.sql"]);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(await snapshot(source.migrationsFolder), before);
  assert.deepEqual(await readdir(source.temporaryParent), []);
});

test("an unchanged single legacy file also permits a journal append", async (t) => {
  const source = await fixture(t, legacyNames.slice(0, 1));
  assert.equal((await probeMigrationAppend(source)).status, "ready");
  assert.deepEqual(await readdir(source.temporaryParent), []);
});

test("unknown unjournaled SQL fails closed before a temporary append is made", async (t) => {
  const source = await fixture(t, ["9999_unknown.sql"]);
  await assert.rejects(probeMigrationAppend(source), /missing from the journal/);
  assert.deepEqual(await readdir(source.temporaryParent), []);
});

test("an invalid journal fails closed without modifying source", async (t) => {
  const source = await fixture(t);
  await writeFile(source.journalFile, "{}");
  await assert.rejects(probeMigrationAppend(source), /no entries array/);
  assert.equal(await readFile(source.journalFile, "utf8"), "{}");
  assert.deepEqual(await readdir(source.temporaryParent), []);
});

test("an unsafe next timestamp is rejected, not wrapped or rounded", async (t) => {
  const source = await fixture(t);
  const journal = JSON.parse(await readFile(source.journalFile, "utf8"));
  journal.entries[0].when = Number.MAX_SAFE_INTEGER;
  await writeFile(source.journalFile, JSON.stringify(journal));
  await assert.rejects(probeMigrationAppend(source), /final safe journal timestamp/);
  assert.deepEqual(await readdir(source.temporaryParent), []);
});

test("a probe filename collision is rejected without overwriting historical SQL", async (t) => {
  const source = await fixture(t);
  const journal = JSON.parse(await readFile(source.journalFile, "utf8"));
  journal.entries[0].tag = "0001_rust_d1_append_probe";
  await writeFile(source.journalFile, JSON.stringify(journal));
  await rm(path.join(source.migrationsFolder, "0000_first.sql"));
  await writeFile(path.join(source.migrationsFolder, "0001_rust_d1_append_probe.sql"), "SELECT 42;");
  const before = await snapshot(source.migrationsFolder);
  await assert.rejects(probeMigrationAppend(source), /filename already exists/);
  assert.deepEqual(await snapshot(source.migrationsFolder), before);
  assert.deepEqual(await readdir(source.temporaryParent), []);
});

test("the real command returns 0 for clean or legacy-compatible assets and 2 for invalid assets", async (t) => {
  const extension = path.extname(fileURLToPath(import.meta.url));
  const command = fileURLToPath(new URL(`./rust-d1-migration-append-preflight${extension}`, import.meta.url));
  const clean = await fixture(t);
  const legacy = await fixture(t, legacyNames);
  const invalid = await fixture(t);
  await writeFile(invalid.journalFile, "{}");
  for (const [source, expectedCode, expectedStatus] of [
    [clean, 0, "ready"], [legacy, 0, "ready"], [invalid, 2, "error"],
  ] as const) {
    const result = spawnSync(process.execPath, [...process.execArgv, command, source.migrationsFolder], { encoding: "utf8" });
    assert.equal(result.error, undefined);
    assert.equal(result.status, expectedCode, result.stderr);
    const output = expectedCode === 2 ? result.stderr.trim().split("\n").at(-1)! : result.stdout;
    assert.equal(JSON.parse(output).status, expectedStatus);
  }
});


async function appendMigration(source: Awaited<ReturnType<typeof fixture>>) {
  const journal = JSON.parse(await readFile(source.journalFile, "utf8"));
  const idx = journal.entries.length;
  const tag = `${String(idx).padStart(4, "0")}_next`;
  journal.entries.push({ idx, version: "7", when: 1000 + idx, tag, breakpoints: true });
  await writeFile(source.journalFile, JSON.stringify(journal));
  await writeFile(path.join(source.migrationsFolder, `${tag}.sql`), "SELECT 9;\n");
  return `${tag}.sql`;
}

test("compatibility reports only new journaled files when legacy positions shift", async (t) => {
  const source = await fixture(t, legacyNames);
  const baseline = await createMigrationManifest(source);
  const first = await appendMigration(source);
  const second = await appendMigration(source);
  const candidate = await createMigrationManifest(source);
  const result = validateMigrationManifestCompatibility(baseline, candidate);
  assert.equal(result.valid, true, result.errors.join("; "));
  assert.deepEqual(result.addedEntries.map((entry) => entry.fileName), [first, second]);
  assert.deepEqual(validateMigrationManifestCompatibility(baseline, baseline).addedEntries, []);
});

for (const fileName of ["0000_first.sql", ...legacyNames]) {
  for (const change of ["edit", "remove"] as const) {
    test(`rejects ${change} of published ${fileName} even when a new entry is appended`, async (t) => {
      const source = await fixture(t, legacyNames);
      const baseline = await createMigrationManifest(source);
      await appendMigration(source);
      const file = path.join(source.migrationsFolder, fileName);
      if (change === "edit") await writeFile(file, "SELECT 999;\n");
      else await rm(file);
      if (fileName === "0000_first.sql" && change === "remove") {
        await assert.rejects(createMigrationManifest(source), /ENOENT/);
        return;
      }
      const result = validateMigrationManifestCompatibility(baseline, await createMigrationManifest(source));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((error) => error.includes(fileName)), result.errors.join("; "));
    });
  }
}

for (const [field, changedValue] of [["when", 999], ["version", "8"], ["breakpoints", false]] as const) {
  test(`rejects changed published journal ${field} with unchanged SQL`, async (t) => {
    const source = await fixture(t, legacyNames);
    const baseline = await createMigrationManifest(source);
    const journal = JSON.parse(await readFile(source.journalFile, "utf8"));
    journal.entries[0][field] = changedValue;
    await writeFile(source.journalFile, JSON.stringify(journal));
    const result = validateMigrationManifestCompatibility(baseline, await createMigrationManifest(source));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes("journal")), result.errors.join("; "));
  });
}

test("rejects reordered and removed journal entries without relying on SQL changes", async (t) => {
  const source = await fixture(t, legacyNames);
  await appendMigration(source);
  const baseline = await createMigrationManifest(source);
  const journal = JSON.parse(await readFile(source.journalFile, "utf8"));
  journal.entries.reverse().forEach((entry: { idx: number }, idx: number) => { entry.idx = idx; });
  await writeFile(source.journalFile, JSON.stringify(journal));
  assert.equal(validateMigrationManifestCompatibility(baseline, await createMigrationManifest(source)).valid, false);
  const removed = journal.entries.pop();
  await rm(path.join(source.migrationsFolder, `${removed.tag}.sql`));
  await writeFile(source.journalFile, JSON.stringify(journal));
  assert.equal(validateMigrationManifestCompatibility(baseline, await createMigrationManifest(source)).valid, false);
});

test("rejects promotion of historical legacy SQL into the execution journal", async (t) => {
  const source = await fixture(t, legacyNames);
  const baseline = await createMigrationManifest(source);
  const journal = JSON.parse(await readFile(source.journalFile, "utf8"));
  journal.entries.push({ idx: 1, version: "7", when: 1001, tag: legacyNames[0].slice(0, -4), breakpoints: true });
  await writeFile(source.journalFile, JSON.stringify(journal));
  assert.equal(validateMigrationManifestCompatibility(baseline, await createMigrationManifest(source)).valid, false);
});

test("rejects newly introduced unjournaled SQL even when it is allowlisted", async (t) => {
  const source = await fixture(t);
  const baseline = await createMigrationManifest(source);
  await writeFile(path.join(source.migrationsFolder, legacyNames[0]), "SELECT 1;\n");
  const result = validateMigrationManifestCompatibility(baseline, await createMigrationManifest(source));
  assert.equal(result.valid, false);
  assert.deepEqual(result.addedEntries, []);
});

test("integrity binds flattened entries to the fingerprinted canonical SQL and journal", async (t) => {
  const source = await fixture(t, legacyNames);
  const manifest = await createMigrationManifest(source);
  const forged = { ...manifest, entries: manifest.entries.map((entry, idx) => (
    idx === 0 ? { ...entry, sha256: "a".repeat(64) } : entry
  )) };
  assert.equal(validateMigrationManifestIntegrity(forged).valid, false);
  assert.equal(validateMigrationManifestCompatibility(manifest, forged).valid, false);
});

test("integrity rejects a forged aggregate fingerprint", async (t) => {
  const source = await fixture(t);
  const manifest = await createMigrationManifest(source);
  assert.equal(validateMigrationManifestIntegrity({ ...manifest, fingerprint: "0".repeat(64) }).valid, false);
});

test("canonical journal metadata object key order is not an immutability violation", async (t) => {
  const source = await fixture(t, legacyNames);
  const baseline = await createMigrationManifest(source);
  const journal = JSON.parse(await readFile(source.journalFile, "utf8"));
  const entry = journal.entries[0];
  journal.entries[0] = { tag: entry.tag, when: entry.when, breakpoints: entry.breakpoints, version: entry.version, idx: entry.idx };
  await writeFile(source.journalFile, JSON.stringify(journal));
  const candidate = await createMigrationManifest(source);
  assert.equal(baseline.fingerprint, candidate.fingerprint);
  assert.equal(validateMigrationManifestCompatibility(baseline, candidate).valid, true);
});
