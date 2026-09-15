import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
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

test("reports the existing legacy-tail blocker without treating it as readiness", async (t) => {
  const source = await fixture(t, legacyNames);
  const before = await snapshot(source.migrationsFolder);
  const report = await probeMigrationAppend(source);
  assert.equal(report.status, "blocked");
  assert.equal(report.sourceUnchanged, true);
  assert.deepEqual(report.legacyUnjournaledFiles, legacyNames);
  assert.deepEqual(report.reportedAddedFiles, [legacyNames[1]]);
  assert.ok(report.errors.some((error) => error.includes("changed published migration order")));
  assert.ok(report.errors.some((error) => error.includes("Append classification must report only")));
  assert.deepEqual(await snapshot(source.migrationsFolder), before);
  assert.deepEqual(await readdir(source.temporaryParent), []);
});

test("one unchanged legacy file is sufficient to expose the blocker", async (t) => {
  const source = await fixture(t, legacyNames.slice(0, 1));
  assert.equal((await probeMigrationAppend(source)).status, "blocked");
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

test("the real command returns 0 for ready, 1 for blocked, and 2 for invalid assets", async (t) => {
  const extension = path.extname(fileURLToPath(import.meta.url));
  const command = fileURLToPath(new URL(`./rust-d1-migration-append-preflight${extension}`, import.meta.url));
  const clean = await fixture(t);
  const blocked = await fixture(t, legacyNames);
  const invalid = await fixture(t);
  await writeFile(invalid.journalFile, "{}");
  for (const [source, expectedCode, expectedStatus] of [
    [clean, 0, "ready"], [blocked, 1, "blocked"], [invalid, 2, "error"],
  ] as const) {
    const result = spawnSync(process.execPath, [...process.execArgv, command, source.migrationsFolder], { encoding: "utf8" });
    assert.equal(result.error, undefined);
    assert.equal(result.status, expectedCode, result.stderr);
    const output = expectedCode === 2 ? result.stderr.trim().split("\n").at(-1)! : result.stdout;
    assert.equal(JSON.parse(output).status, expectedStatus);
  }
});
